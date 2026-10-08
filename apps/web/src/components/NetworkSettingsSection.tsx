import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, QrCode as QrIcon, Wifi, WifiOff } from "lucide-react";
import { fetchSettings, saveNetworkExposure } from "@/lib/settingsApi";
import { SettingsFeedback, SettingsSection } from "./SettingsSection";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/lib/useMediaQuery";
import { QrCodeDialog } from "./QrCodeDialog";

/**
 * Whether other devices on the wifi can use this server.
 *
 * The switch is judged from the address a request named, not from where it
 * came: under Docker every request reaches the server through the same bridge
 * address, so the connection itself cannot say whether it began on this
 * machine or on a phone. What differs is the name — this machine says
 * localhost, everything else has to say where the host lives.
 *
 * Which makes this a convenience switch rather than a lock: it stops the app
 * being usable from other devices, and someone who knows to forge a Host
 * header would get past it to the login screen. The password is the thing
 * that keeps people out, and it is unchanged either way. Said plainly in the
 * UI below rather than left for someone to discover.
 */
export function NetworkSettingsSection() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });
  const network = data?.network;

  const toggle = useMutation({
    mutationFn: saveNetworkExposure,
    onMutate: () => {
      setError(null);
      setSaved(false);
    },
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const exposed = network?.lanExposed ?? false;
  // Already on the phone, a code pointing at this same page is no use.
  const isMobile = useIsMobile();
  const [showQr, setShowQr] = useState(false);
  const url = network?.addresses[0]
    ? `http://${network.addresses[0]}:${network.port}`
    : null;

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is refused in some contexts; the address is on
      // screen to be typed either way, so there is nothing to report.
    }
  }

  return (
    <SettingsSection
      title="Local network access"
      description="Whether other devices on this wifi — a phone, a tablet — can open this server."
    >
      {isLoading ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <button
            type="button"
            role="switch"
            aria-checked={exposed}
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!exposed)}
            className="flex w-full items-center gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2.5 text-left transition-colors hover:bg-secondary/70 disabled:opacity-60"
          >
            {exposed ? (
              <Wifi className="size-4 shrink-0 text-emerald-400" />
            ) : (
              <WifiOff className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {exposed ? "On — other devices can connect" : "Off — this machine only"}
              </span>
              <span className="block text-xs text-muted-foreground">
                Takes effect straight away. No restart.
              </span>
            </span>
            <span
              aria-hidden
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                exposed ? "bg-emerald-500" : "bg-border",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-white transition-all",
                  exposed ? "left-[1.125rem]" : "left-0.5",
                )}
              />
            </span>
          </button>

          {exposed && (
            <div className="space-y-2">
              {url ? (
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-secondary/60 px-3 py-2 text-sm">
                    {url}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy()}
                    aria-label="Copy address"
                    title="Copy address"
                    className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {copied ? (
                      <Check className="size-4 text-emerald-400" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </button>
                  {!isMobile && (
                    <button
                      type="button"
                      onClick={() => setShowQr(true)}
                      title="Show a QR code to scan with your phone"
                      className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <QrIcon className="size-4" />
                      Show QR
                    </button>
                  )}
                </div>
              ) : null}
              {url && showQr && <QrCodeDialog url={url} onClose={() => setShowQr(false)} />}
              {!url && (
                // Inside a container the interfaces belong to the container,
                // so the only address to be found is its own on the Docker
                // bridge — no use to a phone. Better to say so than to show a
                // confident wrong answer.
                <p className="rounded-md bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                  {network?.containerised
                    ? "Running in Docker, so the server cannot see this machine's address on the network. Find it with "
                    : "No network address found. Find it with "}
                  <code className="text-foreground/80">ipconfig getifaddr en0</code>
                  {network?.containerised ? (
                    <>
                      , or start the containers with{" "}
                      <code className="text-foreground/80">sh docker/with-lan-host.sh docker compose up -d</code>
                      , which looks it up and shows it here. Port <code className="text-foreground/80">{network.port}</code>.
                    </>
                  ) : (
                    "."
                  )}
                </p>
              )}
              <p className="text-xs text-muted-foreground/70">
                Anyone reaching this address still has to sign in. The switch decides
                whether the app answers at all, not who gets in — it is a convenience,
                not a firewall.
              </p>
            </div>
          )}

          <SettingsFeedback error={error} saved={saved} />
        </>
      )}
    </SettingsSection>
  );
}
