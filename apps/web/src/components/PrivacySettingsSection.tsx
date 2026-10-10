import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Fingerprint, Loader2, Trash2 } from "lucide-react";
import { DISCREET_SHORTCUT } from "@/lib/appearance";
import { fetchPrivacyStatus, savePrivacyPassword } from "@/lib/privacyApi";
import { deletePasskey, fetchPasskeys, registerPasskey } from "@/lib/webauthnApi";
import { SettingsSection } from "./SettingsSection";

/**
 * The password that unlocks discreet mode.
 *
 * Lives here rather than in the Appearance panel because it's a one-time
 * setup, and because the panel is what you open in front of somebody — a
 * "change password" field sitting in it would be the obvious thing to attack.
 */
export function PrivacySettingsSection() {
  const [password, setPassword] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Separate from the password error above: a Touch ID failure showing there
  // looked exactly like a rejected account password.
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data } = useQuery({ queryKey: ["privacy"], queryFn: fetchPrivacyStatus });
  const { data: passkeys } = useQuery({ queryKey: ["passkeys"], queryFn: fetchPasskeys });

  const addPasskey = useMutation({
    // Named after the browser it's registered in, since that's what the
    // credential is actually tied to and a Mac may hold several.
    mutationFn: () => registerPasskey(browserName()),
    onSuccess: () => {
      setPasskeyError(null);
      queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    },
    onError: (err: Error) => setPasskeyError(err.message),
  });

  const removePasskey = useMutation({
    mutationFn: (id: string) => deletePasskey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["passkeys"] }),
  });

  const save = useMutation({
    mutationFn: () => savePrivacyPassword(password, accountPassword),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setPassword("");
      setAccountPassword("");
      queryClient.invalidateQueries({ queryKey: ["privacy"] });
    },
    onError: (err: Error) => {
      setSaved(false);
      setError(err.message);
    },
  });

  return (
    <SettingsSection
      title="Privacy"
      description={`Discreet mode blurs every image in the app. ${DISCREET_SHORTCUT} turns it on from any page. Once a privacy password or Touch ID is set, the app asks to unlock when opened in a new tab; reloads stay unlocked.`}
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {data?.hasPassword
            ? "A privacy password is set. Enter a new one to replace it, or leave it blank to remove it."
            : (passkeys?.length ?? 0) > 0
              ? "No password set — Touch ID is currently the only way to leave discreet mode. Set one as a fallback for a browser without your passkey."
              : "No privacy password yet — discreet mode can currently be switched off by anyone at this screen."}
        </p>

        <label className="block space-y-1">
          <span className="text-xs font-medium">
            {data?.hasPassword ? "New privacy password" : "Privacy password"}
          </span>
          <input
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setSaved(false);
            }}
            placeholder={data?.hasPassword ? "Blank to remove" : "At least 8 characters"}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium">Your account password</span>
          <input
            type="password"
            value={accountPassword}
            onChange={(event) => {
              setAccountPassword(event.target.value);
              setSaved(false);
            }}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
          />
          {/* The way out if the privacy password is ever forgotten — without
              this, forgetting it would mean being stuck in discreet mode. */}
          <span className="block text-[11px] text-muted-foreground/70">
            Confirms it's you, and is what lets you reset a privacy password you've forgotten.
          </span>
        </label>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {saved && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5" />
            Saved.
          </p>
        )}

        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || accountPassword.length === 0}
          className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
        >
          {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
          {password ? "Save password" : data?.hasPassword ? "Remove password" : "Save password"}
        </button>

        <div className="space-y-2 border-t border-border pt-4">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <Fingerprint className="size-3.5" />
            Touch ID
          </span>
          <p className="text-[11px] leading-snug text-muted-foreground/70">
            Unlock discreet mode with your fingerprint instead of typing the password. Your
            fingerprint stays on this Mac — the browser only proves to the app that it checked.
            Registered per browser, and the password keeps working either way.
          </p>

          {passkeys?.map((passkey) => (
            <div
              key={passkey.id}
              className="flex items-center justify-between rounded-md bg-secondary/60 px-2.5 py-1.5"
            >
              <span className="text-xs">{passkey.label}</span>
              <button
                type="button"
                onClick={() => removePasskey.mutate(passkey.id)}
                aria-label={`Remove ${passkey.label}`}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => addPasskey.mutate()}
            disabled={addPasskey.isPending}
            className="flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50"
          >
            {addPasskey.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Fingerprint className="size-3.5" />
            )}
            {passkeys && passkeys.length > 0 ? "Add another browser" : "Set up Touch ID"}
          </button>

          {passkeyError && <p className="text-xs text-destructive">{passkeyError}</p>}
        </div>

        <p className="text-[11px] leading-snug text-muted-foreground/60">
          Worth knowing: discreet mode is a blur drawn by your browser. It stops a glance over
          your shoulder — it won't stop someone who opens developer tools or clears site data.
        </p>
      </div>
    </SettingsSection>
  );
}

/** A rough name for the browser being registered, so the list is readable. */
function browserName(): string {
  const agent = navigator.userAgent;
  if (agent.includes("Firefox")) return "Firefox";
  // Chrome's user agent claims Safari too, so the order matters here.
  if (agent.includes("Edg")) return "Edge";
  if (agent.includes("Chrome")) return "Chrome";
  if (agent.includes("Safari")) return "Safari";
  return "This browser";
}
