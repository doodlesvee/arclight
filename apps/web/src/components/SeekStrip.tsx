import { useRef, useState } from "react";
import {
  formatTimestamp,
  spriteFrameAt,
  type Bookmark,
  type ScrubSprite,
} from "@/lib/bookmarkApi";
import { cn } from "@/lib/utils";

/** How close, in pixels, a press has to land to a bookmark to snap onto it. */
const SNAP_PX = 8;
/** The preview is drawn at the sheet's own tile width, so it is never upscaled. */
const PREVIEW_MAX_WIDTH = 160;

/**
 * A seek bar that shows where you are going before you get there.
 *
 * Sits above the browser's own control bar rather than replacing it. The
 * native bar cannot be told to draw a preview or a tick — it exposes no
 * hover position at all — and rebuilding play, volume, captions, AirPlay and
 * fullscreen to get one would be a lot of player to own for one feature.
 *
 * Works as a plain seek bar until the sprite arrives, and forever if it never
 * does: the preview is an addition to seeking, not a condition of it.
 *
 * Pointer events rather than mouse events, so dragging a thumb along it on a
 * phone scrubs with the same preview as hovering does on a desktop.
 */
export function SeekStrip({
  duration,
  currentTime,
  sprite,
  bookmarks,
  heatmap,
  visible,
  onSeek,
  besidePanel = false,
}: {
  duration: number;
  currentTime: number;
  sprite: ScrubSprite | undefined;
  bookmarks: Bookmark[];
  heatmap?: number[];
  visible: boolean;
  onSeek: (seconds: number) => void;
  /** The queue is open over the right of the frame; stop short of it. */
  besidePanel?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; width: number; seconds: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const heatmapMax = heatmap ? Math.max(...heatmap) : 0;

  if (!(duration > 0)) return null;

  /** The time under a pointer, snapped to a bookmark when one is that close. */
  function locate(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const near = bookmarks.find(
      (bookmark) => Math.abs((bookmark.positionSeconds / duration) * rect.width - x) <= SNAP_PX,
    );
    const seconds = near ? near.positionSeconds : (x / rect.width) * duration;
    return { x: near ? (near.positionSeconds / duration) * rect.width : x, width: rect.width, seconds, near };
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const spot = locate(event.clientX);
    if (!spot) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setHover(spot);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const spot = locate(event.clientX);
    if (spot) setHover(spot);
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    const spot = locate(event.clientX);
    if (spot) onSeek(spot.seconds);
    // A touch has no hover to leave, so the preview would otherwise stay up.
    if (event.pointerType !== "mouse") setHover(null);
  }

  const shown = visible || dragging || hover !== null;
  const progress = Math.min(100, (currentTime / duration) * 100);
  const hoveredBookmark = hover
    ? bookmarks.find((bookmark) => bookmark.positionSeconds === hover.seconds)
    : undefined;

  const previewWidth = sprite ? Math.min(PREVIEW_MAX_WIDTH, sprite.tileWidth) : 0;
  const previewScale = sprite ? previewWidth / sprite.tileWidth : 1;
  const previewHeight = sprite ? sprite.tileHeight * previewScale : 0;
  // Kept inside the track, so the preview never hangs off the frame at
  // either end of the video.
  const bubbleWidth = Math.max(previewWidth, 56);
  const bubbleLeft = hover
    ? Math.min(hover.width - bubbleWidth / 2, Math.max(bubbleWidth / 2, hover.x))
    : 0;
  const frame = sprite && hover ? spriteFrameAt(sprite, hover.seconds) : null;

  return (
    <div
      className={cn(
        "absolute bottom-14 left-4 z-20 transition-opacity duration-300",
        besidePanel ? "right-[21.25rem]" : "right-4",
        shown ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {hover && (
        <div
          className="pointer-events-none absolute bottom-5 flex -translate-x-1/2 flex-col items-center gap-1"
          style={{ left: bubbleLeft }}
        >
          {sprite && frame && (
            <div
              className="overflow-hidden rounded-md shadow-xl ring-1 ring-white/25"
              style={{
                width: previewWidth,
                height: previewHeight,
                backgroundImage: `url(${sprite.url})`,
                backgroundPosition: `-${frame.x * previewScale}px -${frame.y * previewScale}px`,
                backgroundSize: `${sprite.columns * sprite.tileWidth * previewScale}px auto`,
              }}
            />
          )}
          <span className="max-w-[12rem] truncate rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
            {formatTimestamp(hover.seconds)}
            {hoveredBookmark?.label && ` · ${hoveredBookmark.label}`}
          </span>
        </div>
      )}

      <div
        ref={trackRef}
        role="slider"
        tabIndex={-1}
        aria-label="Seek with preview"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={formatTimestamp(currentTime)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          setDragging(false);
          setHover(null);
        }}
        onPointerLeave={(event) => {
          if (!dragging && event.pointerType === "mouse") setHover(null);
        }}
        // A tall hit area around a thin line: the line is what you see, the
        // padding is what a thumb can actually land on.
        className="group relative flex h-5 cursor-pointer touch-none items-center"
      >
        {heatmapMax > 1 && heatmap && (
          <div className="absolute inset-x-0 bottom-full mb-0.5 flex h-6 items-end gap-px opacity-0 transition-opacity group-hover:opacity-100">
            {heatmap.map((count, i) => (
              <div
                key={i}
                className="flex-1 rounded-t-sm bg-white/30"
                style={{ height: count > 0 ? `${Math.max(8, (count / heatmapMax) * 100)}%` : "0%" }}
              />
            ))}
          </div>
        )}
        <div className="relative h-1 w-full rounded-full bg-white/25 transition-[height] group-hover:h-1.5">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/80"
            style={{ width: `${progress}%` }}
          />
          {hover && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/30"
              style={{ width: `${(hover.seconds / duration) * 100}%` }}
            />
          )}
          {bookmarks.map((bookmark) => (
            <span
              key={bookmark.id}
              className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 shadow ring-1 ring-black/40"
              style={{ left: `${Math.min(100, (bookmark.positionSeconds / duration) * 100)}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
