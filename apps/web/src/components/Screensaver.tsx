import { useEffect, useRef, useState } from "react";
import type React from "react";
import { useAppearance } from "@/lib/appearance";
import { PREVIEW_SCREENSAVER, type ScreensaverSource } from "@/lib/screensaver";
import { thumbnailUrl } from "@/lib/mediaItemApi";

/**
 * A slow, drifting slideshow of posters when the app has sat idle.
 *
 * Never over playback: a video that's playing with sound is someone watching,
 * however still the mouse is. Muted clips don't count — those are hover
 * previews, which play on their own.
 *
 * Posters are ordinary <img>s, so discreet mode blurs them like every other
 * picture in the app. Waking it swallows the key or click that did it, so
 * the keypress that brings you back doesn't also trigger a shortcut.
 */
/** Input ignored this long after it starts, so a preview isn't dismissed by the hand leaving the button. */
const GRACE_MS = 1500;

/** The browse filters behind each "Show" choice. */
const SOURCE_FILTERS: Record<ScreensaverSource, string> = {
  all: "",
  favourites: "&favorite=true",
  unwatched: "&watched=false",
  topRated: "&minRating=4",
};

type Poster = { id: number; thumbnailFile: string | null };

function somethingPlaying(): boolean {
  return Array.from(document.querySelectorAll("video")).some(
    (video) => !video.paused && !video.ended && !video.muted,
  );
}

export function Screensaver() {
  const {
    screensaver,
    motion,
    screensaverMinutes,
    screensaverSeconds,
    screensaverSource,
    screensaverClock,
  } = useAppearance();
  const idleMs = screensaverMinutes * 60 * 1000;
  const slideMs = screensaverSeconds * 1000;
  const startedAt = useRef(0);
  const [active, setActive] = useState(false);
  const [posters, setPosters] = useState<Poster[]>([]);
  const [index, setIndex] = useState(0);
  const [now, setNow] = useState(() => new Date());
  // Set when the idle watch starts, not during render.
  const lastInput = useRef(0);
  const activeRef = useRef(false);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Idle watch: any input resets the clock, and while showing, dismisses it.
  useEffect(() => {
    if (!screensaver) return;
    lastInput.current = Date.now();
    const onInput = (event: Event) => {
      lastInput.current = Date.now();
      if (activeRef.current && Date.now() - startedAt.current > GRACE_MS) {
        // Don't let the wake-up key or click reach the page underneath.
        if (event.type === "keydown" || event.type === "pointerdown") {
          event.preventDefault();
          event.stopPropagation();
        }
        setActive(false);
      }
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const type of events) window.addEventListener(type, onInput, { capture: true, passive: type !== "keydown" && type !== "pointerdown" });
    const timer = setInterval(() => {
      if (activeRef.current || document.hidden) return;
      if (Date.now() - lastInput.current < idleMs) return;
      if (somethingPlaying()) {
        lastInput.current = Date.now();
        return;
      }
      startedAt.current = Date.now();
      setActive(true);
    }, 5000);
    const onPreview = () => {
      startedAt.current = Date.now();
      setActive(true);
    };
    window.addEventListener(PREVIEW_SCREENSAVER, onPreview);
    return () => {
      for (const type of events) window.removeEventListener(type, onInput, { capture: true });
      window.removeEventListener(PREVIEW_SCREENSAVER, onPreview);
      clearInterval(timer);
    };
  }, [screensaver, idleMs]);

  // A fresh random set each time it starts.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetch(`/api/media-items?sort=random${SOURCE_FILTERS[screensaverSource]}`)
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((body: { items: (Poster & { itemType?: string })[] }) => {
        if (cancelled) return;
        setPosters(body.items.filter((item) => item.itemType === undefined || item.itemType === "video"));
        setIndex(0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, screensaverSource]);

  useEffect(() => {
    if (!active) return;
    const slide = setInterval(() => setIndex((i) => i + 1), slideMs);
    const clock = setInterval(() => setNow(new Date()), 15_000);
    return () => {
      clearInterval(slide);
      clearInterval(clock);
    };
  }, [active, slideMs]);

  if (!screensaver || !active) return null;

  // The current poster and the one fading out behind it.
  const shown = posters.length > 0 ? [index - 1, index].filter((i) => i >= 0) : [];
  return (
    <div
      className="fixed inset-0 z-[200] cursor-none overflow-hidden bg-black"
      aria-label="Screensaver — move the mouse or press any key"
      role="presentation"
    >
      {shown.map((i) => {
        const poster = posters[i % posters.length];
        // Alternating drift directions, so consecutive posters don't all
        // slide the same way.
        const dx = i % 2 === 0 ? "-3%" : "3%";
        const dy = i % 3 === 0 ? "-2%" : "2%";
        return (
          <img
            key={i}
            src={thumbnailUrl(poster)}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={
              motion === "full"
                ? ({
                    animation: `${i === index ? "screensaver-in 1.6s ease-out forwards, " : ""}screensaver-drift ${slideMs + 2000}ms linear forwards`,
                    "--dx": dx,
                    "--dy": dy,
                  } as React.CSSProperties)
                : i === index
                  ? { animation: "screensaver-in 1.6s ease-out forwards" }
                  : undefined
            }
          />
        );
      })}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20" />
      {posters.length === 0 && (
        <p className="absolute inset-0 grid place-items-center text-sm text-white/50">
          No posters to show for this choice.
        </p>
      )}
      {screensaverClock && (
      <div className="pointer-events-none absolute bottom-8 left-8 text-white">
        <p className="text-6xl font-light tabular-nums tracking-tight drop-shadow">
          {now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </p>
        <p className="mt-1 text-sm text-white/70">
          {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
        </p>
      </div>
      )}
      <p className="pointer-events-none absolute bottom-8 right-8 text-xs text-white/40">
        Move the mouse or press any key
      </p>
    </div>
  );
}
