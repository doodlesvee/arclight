import { useEffect, useRef, useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { unlockPrivacy } from "@/lib/privacyApi";
import { usePrivacyGuard } from "@/lib/privacyGuard";
import { authenticatePasskey } from "@/lib/webauthnApi";

/**
 * The privacy password prompt, wherever it's needed.
 *
 * Two places ask for it — the appearance panel's toggle and the shortcut's
 * own dialog — and the throttle messaging has to read identically in both, so
 * there's one copy of it rather than two that drift.
 */
export function PrivacyUnlockForm({
  onUnlocked,
  onCancel,
  autoFocus = true,
}: {
  onUnlocked: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Only offered where it can work: no passkey registered in this browser
  // means no button, rather than one that fails when pressed.
  const { hasPassword, hasPasskey } = usePrivacyGuard();

  // Asked for straight away rather than waiting for a click. The dialog was
  // opened by a deliberate keypress, so the prompt is expected — making you
  // press a second button to reach the thing you came for is a step for its
  // own sake.
  const prompted = useRef(false);
  useEffect(() => {
    if (!hasPasskey || prompted.current) return;
    prompted.current = true;
    void tryTouchId();
    // Once per mount: a declined prompt must not immediately reappear, or
    // there'd be no way to reach the password underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPasskey]);

  /**
   * Named `tryTouchId` rather than `useTouchId`.
   *
   * It is an ordinary async function, not a hook, and the `use` prefix made
   * it look like one to every reader and to the lint rule — which failed the
   * build over a hook being "called inside a callback" that was never a hook
   * at all. A name that claims a contract this does not keep is worth
   * changing even where the code behind it is correct.
   */
  async function tryTouchId() {
    setChecking(true);
    setProblem(null);
    try {
      if (await authenticatePasskey()) onUnlocked();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That didn't work");
    } finally {
      setChecking(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setChecking(true);
    try {
      const result = await unlockPrivacy(password);
      if (result.ok) {
        onUnlocked();
        return;
      }
      setProblem(
        result.reason === "throttled"
          ? `Too many attempts — wait ${result.retryAfterSeconds}s.`
          : result.attemptsLeft !== undefined
            ? `Wrong password. ${result.attemptsLeft} ${
                result.attemptsLeft === 1 ? "try" : "tries"
              } left.`
            : "Wrong password."
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      {hasPasskey && (
        <>
          <button
            type="button"
            onClick={() => void tryTouchId()}
            disabled={checking}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            <Fingerprint className="size-4" />
            {prompted.current && !checking ? "Try Touch ID again" : "Use Touch ID"}
          </button>

          {/* The password stays underneath rather than being replaced: a
              finger that won't read, or a browser without the passkey, still
              needs a way through. Unless none is set, in which case the field
              would be a dead end. */}
          {hasPassword && (
            <div className="flex items-center gap-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/50">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
        </>
      )}

      {hasPassword && (
        <input
          type="password"
          value={password}
          autoFocus={autoFocus && !hasPasskey}
          placeholder="Privacy password"
          onChange={(event) => {
            setPassword(event.target.value);
            setProblem(null);
          }}
          className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-foreground/40"
        />
      )}

      {problem && <p className="text-[11px] text-destructive">{problem}</p>}

      <div className="flex items-center gap-2">
        {hasPassword && (
          <button
            type="submit"
            disabled={checking || password.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {checking && <Loader2 className="size-3 animate-spin" />}
            Unlock
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
