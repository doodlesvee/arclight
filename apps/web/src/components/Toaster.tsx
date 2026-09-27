import { AlertCircle, CheckCircle2, Info, Trophy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Portal } from "./Portal";
import type { Toast, ToastVariant } from "@/lib/toast";

const ICONS: Record<ToastVariant, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  achievement: Trophy,
};

// The page is monochrome by design, so colour is confined to the icon — the
// same way the scan button and the notification bell already signal state.
const ICON_COLOR: Record<ToastVariant, string> = {
  success: "text-emerald-500",
  error: "text-destructive",
  info: "text-muted-foreground",
  // The Stats page's trophy amber, so an unlock reads as the same medal.
  achievement: "text-amber-300 animate-trophy-pop",
};

function ToastRow({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  const Icon = ICONS[toast.variant];

  return (
    <div
      // Errors interrupt; confirmations wait their turn. Assertive on a
      // success toast would talk over whatever the user is reading.
      role={toast.variant === "error" ? "alert" : "status"}
      aria-live={toast.variant === "error" ? "assertive" : "polite"}
      className="animate-toast-in pointer-events-auto flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-lg border border-border bg-card p-3 shadow-2xl"
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", ICON_COLOR[toast.variant])} />

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            // Badge titles can name a performer or studio.
            toast.variant === "achievement" && "sensitive",
          )}
        >
          {toast.title}
        </p>
        {toast.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {toast.description}
          </p>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="mt-2 rounded-md bg-secondary px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * The transient-feedback stack, bottom-right.
 *
 * Distinct from the NotificationCenter, which reports standing library health
 * pulled from the server. This is only ever the result of something the user
 * just did, and it leaves on its own.
 *
 * Bottom-right because the queue panel already owns bottom-left, and the mini
 * player is draggable — the right edge is the one corner nothing else claims.
 * The container ignores pointer events so an empty stack never blocks clicks
 * on the page behind it; the rows themselves take them back.
 */
export function Toaster({
  toasts,
  onDismiss,
  onPause,
  onResume,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  onPause: () => void;
  onResume: () => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <Portal lockPageScroll={false}>
      <div
        onMouseEnter={onPause}
        onMouseLeave={onResume}
        onFocusCapture={onPause}
        onBlurCapture={onResume}
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2"
      >
        {toasts.map((toast) => (
          <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </Portal>
  );
}
