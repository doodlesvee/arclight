import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Info, Play } from "lucide-react";
import { useAccentColor } from "@/lib/dominantColor";
import { framingStyle, thumbnailUrl } from "@/lib/mediaItemApi";
import { fetchStudios } from "@/lib/studioApi";
import { useAppearance } from "@/lib/appearance";
import { useIsMobile } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import type { MediaCardItem } from "./MediaCard";

// How long each featured item stays before the hero rotates.
const ROTATE_MS = 14000;

// How far a touch has to travel sideways before it counts as a swipe rather
// than a tap that wandered.
const SWIPE_MIN_PX = 40;
// The trackpad equivalent: sideways wheel travel that counts as one swipe,
// and how long the wheel has to go quiet before the next swipe can register.
// A two-finger flick keeps firing momentum events for a good half second
// after the fingers lift; without the quiet gap one flick would skip several
// slides.
const WHEEL_SWIPE_PX = 60;
const WHEEL_QUIET_MS = 250;

const heroArrowClass =
  "absolute top-1/2 z-20 hidden size-11 md:flex -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/20 backdrop-blur-sm transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

function resolutionBadge(item: MediaCardItem): string | null {
  const height = item.extraMetadata?.height;
  if (typeof height !== "number") return null;
  if (height >= 2000) return "4K";
  if (height >= 1000) return "HD";
  return "SD";
}

function HeroSlide({
  item,
  hovering,
  stacked,
  onPlay,
  onMoreInfo,
}: {
  item: MediaCardItem;
  hovering: boolean;
  /**
   * Phone layout: the picture at its own shape with the copy underneath it,
   * rather than the copy laid over a crop of it.
   *
   * A hero sized as a share of viewport height is a tall box, and a landscape
   * still shown `cover` inside one is mostly cut away — on a phone you were
   * looking at a vertical slice of the frame. Stacked, nothing is cropped and
   * nothing is hidden behind the text.
   */
  stacked: boolean;
  onPlay: (id: number) => void;
  onMoreInfo: (id: number) => void;
}) {
  // The clip only mounts on hover, so a page load never downloads five of
  // them — and the still-to-motion swap is something you asked for rather
  // than something that happens at you, which is what made autoplay here
  // feel wrong every time.
  const [clipReady, setClipReady] = useState(false);
  useEffect(() => {
    if (!hovering) setClipReady(false);
  }, [hovering]);

  const imageSrc = thumbnailUrl(item);
  // Each slide takes its palette from its own artwork, so the accent always
  // belongs to the picture rather than being a brand colour laid over it.
  const accent = useAccentColor(imageSrc);
  const duration = formatDuration(item.durationSeconds);
  const badge = resolutionBadge(item);
  const { hoverPreview, discreet } = useAppearance();

  // The item carries a studio name, but the page is keyed by id — so renaming
  // a studio doesn't break links. Shares the ["studios"] key with the studios
  // page and the detail modal, so this is usually served from cache.
  const { data: studios } = useQuery({
    queryKey: ["studios"],
    queryFn: fetchStudios,
    enabled: Boolean(item.studio),
  });
  const studioId =
    studios?.studios.find((row) => row.name.toLowerCase() === item.studio?.toLowerCase())?.id ??
    null;

  const preview = hovering &&
    hoverPreview &&
    !discreet &&
    item.itemType === "video" && (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- silent ambient preview
      <video
        src={`/api/media-items/${item.id}/preview`}
        onCanPlay={() => setClipReady(true)}
        muted
        loop
        autoPlay
        playsInline
        preload="auto"
        // Fades in only once it can actually play, so the image never blinks
        // to black while the clip buffers.
        style={{ opacity: clipReady ? 1 : 0 }}
        className="absolute inset-0 h-full w-full object-cover transition-opacity duration-500"
      />
    );

  return (
    <>
      {/* The item's thumbnail — your uploaded image when there is one, the
          generated poster otherwise.

          On a phone it sits in the flow and keeps its own aspect, so it is
          the picture that decides how tall the hero is and the whole frame is
          on screen. Everywhere else the hero is a fixed band and the image
          fills it, cropped to the framing chosen for the item. */}
      {stacked ? (
        <img
          src={imageSrc}
          alt=""
          className="block h-auto max-h-[65vh] w-full object-contain"
        />
      ) : (
        <img
          src={imageSrc}
          alt=""
          style={framingStyle(item)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {preview}

      {stacked ? (
        // Nothing but the picture and a way into it. The title, meta and the
        // two buttons are all on the item's own sheet a tap away, and over a
        // frame this size they left no picture to look at.
        //
        // The scrim stays, though nothing is written on it: it is what carries
        // the picture down into the page background instead of ending it on a
        // hard edge, which is the same job it does on the desktop band.
        <>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent" />
        <button
          type="button"
          onClick={() => onPlay(item.id)}
          aria-label={`Play ${item.title}`}
          title={`Play ${item.title}`}
          className="absolute left-1/2 top-1/2 z-10 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/60 backdrop-blur-sm transition-transform active:scale-95"
        >
          <Play className="size-7 translate-x-0.5 fill-current" />
        </button>

        {/* Cast over title, the same order and weighting a tile uses, so the
            hero reads as the largest card on the page rather than as its own
            kind of thing. `sensitive` so Discreet Mode blurs them here too. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4">
          {item.performers && item.performers.length > 0 && (
            <span className="sensitive block truncate text-[11px] font-medium uppercase tracking-wide text-white/70">
              {item.performers.map((performer) => performer.name).join(", ")}
            </span>
          )}
          <h2 className="sensitive line-clamp-2 text-lg font-bold leading-snug tracking-tight text-white drop-shadow">
            {item.title}
          </h2>
        </div>
        </>
      ) : (
        <>
        {/* Scrims, kept light: enough contrast for the title and buttons
            without burying the picture the way the old full-height one did. */}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-background/70 via-transparent to-transparent" />
        {accent && (
          <div
            aria-hidden
            className="absolute inset-0 opacity-25 mix-blend-soft-light transition-opacity duration-500"
            style={{ background: `linear-gradient(to top right, ${accent}, transparent 60%)` }}
          />
        )}

        <div
          className={cn(
            "flex flex-col gap-2 px-4",
            // Over the picture in both layouts. On a phone the image is what
            // gives the section its height, so the copy is pinned to the bottom
            // of it rather than stretched to fill.
            stacked
              ? "absolute inset-x-0 bottom-0 pb-4"
              : "relative h-full justify-end gap-2.5 pb-14 md:gap-4 md:px-6 md:pb-20",
          )}
        >
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.25em] transition-colors duration-500"
            style={{ color: accent ?? undefined }}
          >
            Featured
          </span>

          <h1 className="sensitive line-clamp-3 max-w-2xl text-2xl font-bold leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl">
            {item.title}
          </h1>

          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground sm:text-sm">
            {duration && <span className="font-medium text-foreground/90">{duration}</span>}
            {badge && (
              <span
                className="rounded border px-1.5 py-px text-[11px] tracking-wide transition-colors duration-500"
                style={
                  accent
                    ? { borderColor: accent, color: accent }
                    : undefined
                }
              >
                {badge}
              </span>
            )}
            {item.studio &&
              (studioId != null ? (
                <Link
                  to="/studio/$studioId"
                  params={{ studioId: String(studioId) }}
                  className="font-medium transition-colors duration-500 hover:underline"
                  style={{ color: accent ?? undefined }}
                >
                  {item.studio}
                </Link>
              ) : (
                // Plain text until the id is known — the studios list may not
                // have loaded yet, and a dead link is worse than an unlinked
                // name.
                <span
                  className="font-medium transition-colors duration-500"
                  style={{ color: accent ?? undefined }}
                >
                  {item.studio}
                </span>
              ))}
            {item.tags?.slice(0, 3).map((t) => (
              <span key={t.id} className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs">
                {t.name}
              </span>
            ))}
          </div>

          {item.description && (
            <p className="sensitive line-clamp-2 hidden max-w-xl text-sm text-muted-foreground sm:block">
              {item.description}
            </p>
          )}

          {item.performers && item.performers.length > 0 && (
            <p className="hidden text-sm text-muted-foreground sm:block">
              <span className="text-muted-foreground/60">Starring </span>
              {/* Linked individually rather than as one joined string, so a
                  two-performer video takes you to whichever name you clicked. */}
              {item.performers.map((performer, index) => (
                <span key={performer.id}>
                  {index > 0 && <span className="text-muted-foreground/60">, </span>}
                  <Link
                    to="/performer/$performerId"
                    params={{ performerId: String(performer.id) }}
                    className="font-medium transition-colors duration-500 hover:underline"
                    style={{ color: accent ?? undefined }}
                  >
                    {performer.name}
                  </Link>
                </span>
              ))}
            </p>
          )}

          <div className="mt-1 flex items-center gap-2 md:gap-3">
            <button
              type="button"
              onClick={() => onPlay(item.id)}
              style={{ backgroundColor: accent ?? undefined }}
              className="flex items-center gap-2 rounded-md bg-white px-5 py-2 text-sm font-semibold text-black transition-[transform,background-color] duration-500 hover:scale-[1.03] md:px-6 md:py-2.5 md:text-base"
            >
              <Play className="size-4 fill-black md:size-5" />
              Play
            </button>
            <button
              type="button"
              onClick={() => onMoreInfo(item.id)}
              className="flex items-center gap-2 rounded-md bg-white/15 px-4 py-2 text-sm font-semibold backdrop-blur-sm transition-colors hover:bg-white/25 md:px-5 md:py-2.5 md:text-base"
            >
              <Info className="size-4 md:size-5" />
              More Info
            </button>
          </div>
        </div>
        </>
      )}
    </>
  );
}

export function HeroBanner({
  items,
  onPlay,
  onMoreInfo,
}: {
  items: MediaCardItem[];
  onPlay: (id: number) => void;
  onMoreInfo: (id: number) => void;
}) {
  const [index, setIndex] = useState(0);
  const [hovering, setHovering] = useState(false);

  // Keyed on `index` so the countdown restarts after a manual jump too —
  // otherwise clicking an arrow mid-cycle could auto-advance a moment later.
  useEffect(() => {
    if (items.length < 2) return;
    // Rotation pauses while you're hovering: being yanked to the next item
    // part-way through a preview you deliberately started is worse than the
    // carousel simply waiting.
    if (hovering) return;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % items.length), ROTATE_MS);
    return () => clearTimeout(timer);
  }, [index, items.length, hovering]);

  const { heroHeight } = useAppearance();
  const stacked = useIsMobile();

  function go(direction: 1 | -1) {
    setIndex((i) => (i + direction + items.length) % items.length);
  }

  // Swipe, for the phone layout where the arrows are gone. Tracked by hand
  // rather than with a scroll-snap track: the hero renders one slide at a
  // time, so there is nothing to scroll — the gesture has to be read and
  // turned into an index change.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  function onTouchStart(event: React.TouchEvent) {
    const touch = event.touches[0];
    swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function onTouchEnd(event: React.TouchEvent) {
    const start = swipeStart.current;
    swipeStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || items.length < 2) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // Far enough to be deliberate, and more sideways than down — otherwise
    // every scroll past the hero would flick it to the next item.
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return;
    go(dx < 0 ? 1 : -1);
  }

  // Sideways scroll on a trackpad (or a tilt wheel). A native listener, not
  // React's onWheel: React registers wheel as passive, and a passive listener
  // cannot preventDefault — which is what stops Chrome and Safari reading
  // the same two-finger swipe as "go back a page".
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || items.length < 2) return;
    let travel = 0;
    // Which way the last swipe went while its momentum is still arriving;
    // 0 once the wheel has gone quiet.
    let locked: 0 | 1 | -1 = 0;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      // Vertical-dominant means the page is being scrolled past the hero;
      // leave that alone entirely.
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        travel = 0;
        locked = 0;
      }, WHEEL_QUIET_MS);
      // Momentum only ever runs the same way as the swipe that caused it, so
      // travel the other way is a new swipe back and goes through at once.
      // Waiting for quiet here swallowed it: the trailing momentum kept the
      // timer from ever firing while you were already swiping back.
      const direction = Math.sign(event.deltaX) as 1 | -1;
      if (locked === direction) return;
      if (locked !== 0) {
        locked = 0;
        travel = 0;
      }
      // A change of mind before the threshold starts the count afresh,
      // rather than having to undo the travel already built up.
      if (Math.sign(travel) === -direction) travel = 0;
      travel += event.deltaX;
      if (Math.abs(travel) < WHEEL_SWIPE_PX) return;
      // Positive deltaX is content moving left — the next slide, the same
      // way round as a touch swipe.
      const swipe = travel > 0 ? 1 : -1;
      go(swipe);
      locked = swipe;
      travel = 0;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearTimeout(quiet);
    };
    // `go` only uses the functional setIndex and items.length, both covered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  if (items.length === 0) return null;

  const item = items[index];

  return (
    <section
      ref={sectionRef}
      // Height in vh rather than a pixel floor: the slider is a percentage of
      // the screen, and a min-height in pixels would quietly ignore it at the
      // low end.
      //
      // Not on a phone, where the height comes from the picture instead — see
      // `stacked` on HeroSlide. The slider still governs the desktop banner.
      style={stacked ? undefined : { height: `${heroHeight}vh` }}
      className="relative w-full overflow-hidden"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Only the current item is rendered — no sliding track, so switching
          featured items is a straight swap. */}
      <HeroSlide
        key={item.id}
        item={item}
        hovering={hovering}
        stacked={stacked}
        onPlay={onPlay}
        onMoreInfo={onMoreInfo}
      />

      {items.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous featured item"
            className={heroArrowClass + " left-4"}
          >
            <ChevronLeft className="size-6" />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next featured item"
            className={heroArrowClass + " right-4"}
          >
            <ChevronRight className="size-6" />
          </button>
        </>
      )}

      {items.length > 1 && (
        <div
          className={cn(
            "absolute z-20 flex items-center gap-1.5",
            // Clear of the copy, which reaches further up the picture on a
            // phone than it does on the desktop band.
            stacked ? "right-4 top-4" : "bottom-6 right-6",
          )}
        >
          {items.map((candidate, i) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Show featured item ${i + 1}`}
              // The bar is the indicator; the padding is the tap target, and
              // is pulled back out so it does not change the spacing.
              className="-my-2 py-2"
            >
              <span
                className={cn(
                  "block h-1 rounded-full transition-all",
                  i === index
                    ? "w-6 bg-white"
                    : "w-2 bg-white/40 hover:bg-white/70",
                )}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
