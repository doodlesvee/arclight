import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, UserRound } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { fetchAuthStatus, logout } from "@/lib/authApi";

/**
 * Account avatar in the header, with a sign-out menu.
 *
 * Lives in the sticky header rather than the footer: on the homepage the
 * footer sits below every row, so anything there is effectively invisible.
 */
export function UserMenu() {
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { data: auth } = useQuery({ queryKey: ["auth-status"], queryFn: fetchAuthStatus });

  const signOut = useMutation({
    mutationFn: logout,
    // Drops every cached query along with the session, so no data from the
    // previous login is sitting in memory behind the login screen.
    onSuccess: () => queryClient.clear(),
  });

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!auth?.user) return null;

  const initial = auth.user.username.trim()[0]?.toUpperCase() ?? "?";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        title={auth.user.username}
        className="flex size-9 items-center justify-center rounded-full bg-secondary text-sm font-semibold ring-1 ring-border transition-colors hover:bg-accent hover:text-foreground"
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-md border border-border bg-card shadow-xl"
        >
          <div className="flex items-center gap-2.5 border-b border-border px-3 py-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
              {initial}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{auth.user.username}</p>
              <p className="text-[11px] text-muted-foreground">Signed in</p>
            </div>
          </div>

          <Link
            to="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <UserRound className="size-4" />
            Profile
          </Link>

          <button
            type="button"
            role="menuitem"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50"
          >
            <LogOut className="size-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
