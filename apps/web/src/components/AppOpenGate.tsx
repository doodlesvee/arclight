import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clapperboard, Loader2 } from "lucide-react";
import { fetchPasskeys } from "@/lib/webauthnApi";
import { fetchPrivacyStatus } from "@/lib/privacyApi";
import { PrivacyUnlockForm } from "./PrivacyUnlockForm";

const UNLOCK_KEY = "media-server:app-open-unlocked";

function readUnlocked(): boolean {
  try {
    return window.sessionStorage.getItem(UNLOCK_KEY) === "true";
  } catch {
    return false;
  }
}

export function clearAppOpenUnlock(): void {
  try {
    window.sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    // Storage may be disabled; the next app mount will ask again.
  }
}

export function AppOpenGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(readUnlocked);
  const privacy = useQuery({ queryKey: ["privacy"], queryFn: fetchPrivacyStatus });
  const passkeys = useQuery({ queryKey: ["passkeys"], queryFn: fetchPasskeys });

  if (privacy.isPending || passkeys.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (privacy.isError || passkeys.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm space-y-3 text-center">
          <h1 className="text-lg font-semibold">Couldn’t check app lock</h1>
          <p className="text-sm text-muted-foreground">
            The privacy settings couldn’t be loaded. Check the connection and try again.
          </p>
          <button
            type="button"
            onClick={() => {
              void privacy.refetch();
              void passkeys.refetch();
            }}
            className="rounded-md bg-secondary px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const guarded = privacy.data.hasPassword || passkeys.data.length > 0;
  if (!guarded || unlocked) return <>{children}</>;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 md:px-6">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center gap-2">
          <Clapperboard className="size-6" />
          <span className="text-xl font-bold tracking-tight">Arc Light</span>
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Unlock Arc Light</h1>
          <p className="text-sm text-muted-foreground">
            Use your fingerprint or privacy password to open the app.
          </p>
        </div>
        <PrivacyUnlockForm
          onUnlocked={() => {
            try {
              window.sessionStorage.setItem(UNLOCK_KEY, "true");
            } catch {
              // Keep this mount usable even when browser storage is disabled.
            }
            setUnlocked(true);
          }}
        />
      </div>
    </div>
  );
}