import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Fingerprint, Loader2, WifiOff } from "lucide-react";
import { LanBlockedError, fetchAuthStatus, login, setupAccount } from "@/lib/authApi";
import { loginWithPasskey } from "@/lib/webauthnApi";
import { AppOpenGate, clearAppOpenUnlock } from "./AppOpenGate";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Decides between the setup screen, the login screen and the app.
 *
 * Wrapping the router rather than guarding each route means a new page is
 * behind auth by default, matching the server's deny-by-default hook.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { data: status, isLoading, error } = useQuery({
    queryKey: ["auth-status"],
    queryFn: fetchAuthStatus,
    // A 401 from anywhere else means the session died; re-checking on focus
    // moves you to the login screen rather than leaving a broken page.
    refetchOnWindowFocus: true,
    // Retrying a refusal just delays the explanation by a few seconds.
    retry: (count, cause) => !(cause instanceof LanBlockedError) && count < 3,
  });

  useEffect(() => {
    if (status && !status.user) clearAppOpenUnlock();
  }, [status]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // The page itself is served by the dev server, which knows nothing about
  // this — so without saying so, a blocked phone would sit on a login form
  // that refuses every attempt for reasons it never explains.
  if (error instanceof LanBlockedError) return <LanBlocked />;

  if (status?.user) return <AppOpenGate>{children}</AppOpenGate>;

  return (
    <AuthForm
      mode={status?.needsSetup ? "setup" : "login"}
      onSuccess={() => {
        clearAppOpenUnlock();
        return queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      }}
    />
  );
}

function LanBlocked() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm space-y-3 text-center">
        <WifiOff className="mx-auto size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold tracking-tight">Not available here</h1>
        <p className="text-sm text-muted-foreground">
          This server is set to answer only on the machine it runs on. Turn on
          local network access in Settings → Privacy there, and reload this page.
        </p>
      </div>
    </div>
  );
}

function AuthForm({ mode, onSuccess }: { mode: "setup" | "login"; onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const isSetup = mode === "setup";

  const submit = useMutation({
    mutationFn: () => (isSetup ? setupAccount(username, password) : login(username, password)),
    onSuccess,
  });
  const passkey = useMutation({
    mutationFn: loginWithPasskey,
    onSuccess,
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);
    passkey.reset();

    if (isSetup) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        return;
      }
      if (password !== confirm) {
        setLocalError("Passwords don’t match");
        return;
      }
    }
    submit.mutate();
  }

  const error = localError
    ?? (passkey.error instanceof Error ? passkey.error.message : null)
    ?? (submit.error instanceof Error ? submit.error.message : null);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 md:px-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
        <div className="flex items-center gap-2">
          <Clapperboard className="size-6" />
          <span className="text-xl font-bold tracking-tight">Arc Light</span>
        </div>

        <div className="space-y-1">
          <h1 className="text-lg font-semibold">
            {isSetup ? "Create your account" : "Sign in"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isSetup
              ? "This is the only account — it's created once and the setup page then closes for good."
              : "Enter your credentials to continue."}
          </p>
        </div>

        <div className="space-y-3">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="username"
            autoFocus
            className="w-full rounded-md border border-border bg-secondary/60 px-3 py-2 text-sm outline-none transition-colors focus:border-ring/60 focus:bg-secondary"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Password"
            autoComplete={isSetup ? "new-password" : "current-password"}
            className="w-full rounded-md border border-border bg-secondary/60 px-3 py-2 text-sm outline-none transition-colors focus:border-ring/60 focus:bg-secondary"
          />
          {isSetup && (
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              type="password"
              placeholder="Confirm password"
              autoComplete="new-password"
              className="w-full rounded-md border border-border bg-secondary/60 px-3 py-2 text-sm outline-none transition-colors focus:border-ring/60 focus:bg-secondary"
            />
          )}
        </div>

        {isSetup && !error && (
          <p className="text-xs text-muted-foreground">
            {password.length > 0 && password.length < MIN_PASSWORD_LENGTH
              ? `${MIN_PASSWORD_LENGTH - password.length} more character${
                  MIN_PASSWORD_LENGTH - password.length === 1 ? "" : "s"
                } needed`
              : confirm.length > 0 && password !== confirm
                ? "Passwords don’t match yet"
                : `At least ${MIN_PASSWORD_LENGTH} characters, and confirm it below.`}
          </p>
        )}

        {error && (
          <p className="rounded-md bg-destructive/15 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        <button
          type="submit"
          disabled={submit.isPending || passkey.isPending || !username || !password || (isSetup && !confirm)}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-2 font-semibold text-black transition-transform hover:scale-[1.01] disabled:opacity-50 disabled:hover:scale-100"
        >
          {submit.isPending && <Loader2 className="size-4 animate-spin" />}
          {isSetup ? "Create account" : "Sign in"}
        </button>
        {!isSetup && (
          <button
            type="button"
            disabled={submit.isPending || passkey.isPending}
            onClick={() => {
              setLocalError(null);
              submit.reset();
              passkey.mutate();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary px-4 py-2 font-semibold transition-colors hover:bg-accent disabled:opacity-50"
          >
            {passkey.isPending ? <Loader2 className="size-4 animate-spin" /> : <Fingerprint className="size-4" />}
            Sign in with passkey
          </button>
        )}
      </form>
    </div>
  );
}
