import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Toaster } from "@/components/Toaster";

export type ToastVariant = "success" | "error" | "info" | "achievement";

export type Toast = {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  /** An offer to reverse what just happened — rendered as a button. */
  action?: { label: string; onClick: () => void };
  /**
   * Milliseconds until it dismisses itself, or null to stay until dismissed
   * by hand. Long-running work sets null and updates the same toast as it
   * goes, so progress replaces itself in place rather than stacking.
   */
  duration: number | null;
};

export type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  action?: { label: string; onClick: () => void };
  duration?: number | null;
};

type ToastStore = {
  toasts: Toast[];
  /** Shows a toast and returns its id, so progress can be updated in place. */
  toast: (input: ToastInput) => number;
  /** Patches a live toast. A no-op once it has been dismissed. */
  update: (id: number, patch: Partial<ToastInput>) => void;
  dismiss: (id: number) => void;
};

// An error is worth reading and often worth acting on, so it gets noticeably
// longer than a confirmation you only need to glance at.
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 5000,
  error: 9000,
  // Earned, not just confirmed — it can stay a little longer.
  achievement: 7000,
};

// Beyond a handful the oldest are unreadable anyway, and a tall stack starts
// covering the content the toasts are talking about.
const MAX_VISIBLE = 4;

const ToastContext = createContext<ToastStore | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Timers live in a ref rather than state: firing one must not depend on a
  // re-render having happened, and clearing them all on unmount needs a handle
  // that survives every render in between.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // Mirrors `toasts` for event handlers that need the current list without
  // re-subscribing every render.
  const toastsRef = useRef<Toast[]>([]);

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((current) => current.filter((entry) => entry.id !== id));
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (id: number, duration: number | null) => {
      clearTimer(id);
      if (duration === null) return;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    },
    [clearTimer, dismiss],
  );

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const variant = input.variant ?? "info";
      const duration =
        input.duration === undefined ? DEFAULT_DURATION[variant] : input.duration;

      setToasts((current) => [
        ...current.slice(-(MAX_VISIBLE - 1)),
        {
          id,
          title: input.title,
          description: input.description,
          variant,
          action: input.action,
          duration,
        },
      ]);
      schedule(id, duration);
      return id;
    },
    [schedule],
  );

  const update = useCallback(
    (id: number, patch: Partial<ToastInput>) => {
      let exists = false;
      setToasts((current) =>
        current.map((entry) => {
          if (entry.id !== id) return entry;
          exists = true;
          const variant = patch.variant ?? entry.variant;
          return {
            ...entry,
            ...patch,
            variant,
            duration:
              patch.duration === undefined ? entry.duration : patch.duration,
          };
        }),
      );
      // Re-arming a dismissed toast would resurrect it on the next tick.
      if (!exists) return;
      if (patch.duration !== undefined) schedule(id, patch.duration);
      else if (patch.variant !== undefined)
        schedule(id, DEFAULT_DURATION[patch.variant]);
    },
    [schedule],
  );

  // Pausing while the pointer is over the stack: a toast carrying an Undo you
  // are reaching for must not disappear out from under the cursor.
  const pause = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  // Reads the live list from a ref rather than a setToasts updater: StrictMode
  // double-invokes updaters, and arming timers from inside one would run the
  // scheduling twice per resume.
  const resume = useCallback(() => {
    for (const entry of toastsRef.current) schedule(entry.id, entry.duration);
  }, [schedule]);

  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const store = useMemo(
    () => ({ toasts, toast, update, dismiss }),
    [toasts, toast, update, dismiss],
  );

  return (
    <ToastContext.Provider value={store}>
      {children}
      <Toaster
        toasts={toasts}
        onDismiss={dismiss}
        onPause={pause}
        onResume={resume}
      />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastStore {
  const store = useContext(ToastContext);
  if (!store) throw new Error("useToast must be used inside ToastProvider");
  return store;
}
