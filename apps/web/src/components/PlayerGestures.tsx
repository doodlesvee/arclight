import { useRef, useState } from "react";
import { RotateCcw, RotateCw } from "lucide-react";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";

/** Taps closer together than this are one gesture. */
const MULTI_TAP_MS = 320;

type Side = "back" | "forward";

/**
 * Double-tap either side of the video to skip, the way every phone video
 * player does. Each further tap in quick succession skips again, so three
 * taps is twenty seconds.
 *
 * Only the outer thirds, and not the strip along the bottom where the seek
 * bar and the native control bar are. The middle is left to the browser, so
 * a tap there still does what a tap on a video natively does — shows its
 * controls — and nothing learned on other players stops working here.
 *
 * The zones run the full height and carry no z-index on purpose. On a phone
 * the video is barely 200px tall and the overlay buttons fill its top half,
 * so zones that avoided the buttons had almost no height left. Instead the
 * buttons, which come later in the DOM, simply paint over the zones and take
 * their own taps; every gap between them belongs to the gesture.
 *
 * Touch devices only, detected by the pointer rather than the screen width:
 * a narrow desktop window has a mouse, and a double-click there already
 * means fullscreen.
 */
export function PlayerGestures({
  onSkip,
  onTap,
  skipSeconds = 10,
}: {
  onSkip: (seconds: number) => void;
  onTap: () => void;
  skipSeconds?: number;
}) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const last = useRef<{ side: Side; at: number } | null>(null);
  // What the ripple says: the total skipped by this run of taps.
  const [flash, setFlash] = useState<{ side: Side; seconds: number; key: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!coarse) return null;

  function tap(side: Side, event: React.PointerEvent) {
    if (event.pointerType === "mouse") return;
    const now = performance.now();
    const previous = last.current;
    const continuing = previous?.side === side && now - previous.at < MULTI_TAP_MS;
    last.current = { side, at: now };
    onTap();
    if (!continuing) return;

    onSkip(side === "forward" ? skipSeconds : -skipSeconds);
    setFlash((current) => ({
      side,
      seconds: (current?.side === side ? current.seconds : 0) + skipSeconds,
      key: now,
    }));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 700);
  }

  return (
    <>
      {(["back", "forward"] as const).map((side) => (
        <div
          key={side}
          aria-hidden
          onPointerUp={(event) => tap(side, event)}
          // Stops the browser treating the second tap as a zoom.
          style={{ touchAction: "manipulation" }}
          className={cn(
            "absolute bottom-20 top-0 w-1/3",
            side === "back" ? "left-0" : "right-0",
          )}
        >
          {flash?.side === side && (
            <div
              key={flash.key}
              className="pointer-events-none absolute inset-0 flex animate-fade-up items-center justify-center"
            >
              <span className="flex flex-col items-center gap-1 rounded-full bg-black/45 px-4 py-3 text-xs font-semibold text-white backdrop-blur-sm">
                {side === "back" ? <RotateCcw className="size-5" /> : <RotateCw className="size-5" />}
                <span>{`${side === "back" ? "−" : "+"}${flash.seconds}s`}</span>
              </span>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
