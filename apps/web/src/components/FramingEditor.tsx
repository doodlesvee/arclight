import { useCallback, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import {
  focalStyle,
  framingAfterDrag,
  framingTravel,
  visibleBand,
  type Framing,
} from "@/lib/reposition";
import { cn } from "@/lib/utils";

export type FramingValue = Framing & { scale: number };

/**
 * Drag-and-zoom to choose which part of an image is shown.
 *
 * Nothing here is specific to what's being framed — a category cover and a
 * video's thumbnail are the same problem, and forking this for the second one
 * would mean maintaining the travel maths twice. The caller supplies the
 * image, the current value, the aspect ratio to preview at, and what to do on
 * save.
 *
 * `aspectClass` matters: the preview must match the frame the image will
 * actually be cropped to, or you'd choose a band here that gets cropped
 * differently in the real thing.
 */
/** One shape the same image will be cropped to, shown live while choosing. */
export type FramingPreview = { label: string; aspectRatio: string };

export type FramingEditorProps = {
  src: string;
  value: FramingValue;
  aspectClass: string;
  /**
   * A CSS `aspect-ratio`, taking precedence over `aspectClass`.
   *
   * For frames whose shape is a setting rather than a constant: a Tailwind
   * class has to be written out literally to be emitted, so a tile shape that
   * can be tuned cannot be expressed as one, and the class and the tile
   * silently drift the first time the shape changes. Passing the computed
   * ratio makes that impossible.
   */
  aspectRatio?: string;
  saving?: boolean;
  onSave: (next: FramingValue) => void;
  onCancel: () => void;
  note?: string;
  /**
   * Every shape this image is drawn at. Supplying it switches the editor to
   * focal-point mode; leaving it out keeps the single-frame drag.
   */
  previews?: FramingPreview[];
  /** Preview through a circle, for images that are shown round. */
  round?: boolean;
};

/**
 * Drag and zoom to choose which part of an image is shown, or — when the
 * caller names the shapes it will be cropped to — mark where the subject is
 * and satisfy all of them at once.
 */
export function FramingEditor(props: FramingEditorProps) {
  return props.previews && props.previews.length > 0 ? (
    <FocalFraming {...props} previews={props.previews} />
  ) : (
    <ClassicFraming {...props} />
  );
}

function ClassicFraming({
  src,
  value,
  aspectClass,
  aspectRatio,
  saving,
  onSave,
  onCancel,
  note,
  round = false,
}: FramingEditorProps) {
  const [draft, setDraft] = useState<Framing>({ x: value.x, y: value.y });
  const [scale, setScale] = useState(value.scale);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // A ref, not state: the pointermove handler needs the latest values without
  // re-subscribing the listener on every frame.
  const drag = useRef<{ startX: number; startY: number; start: Framing } | null>(null);
  // Which axes actually have hidden image, recomputed whenever the zoom or
  // the loaded image changes — saying so beats a dead drag.
  const [travel, setTravel] = useState<Framing>({ x: 0, y: 0 });
  // The listener is subscribed once, so it can't close over `scale` — a ref
  // keeps it reading the current zoom without re-subscribing on every tick.
  const scaleRef = useRef(value.scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      const state = drag.current;
      const container = containerRef.current;
      const image = imageRef.current;
      if (!state || !container || !image) return;

      setDraft(
        framingAfterDrag(
          {
            containerWidth: container.clientWidth,
            containerHeight: container.clientHeight,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            zoom: scaleRef.current / 100,
          },
          state.start,
          event.clientX - state.startX,
          event.clientY - state.startY
        )
      );
    }

    function endDrag() {
      drag.current = null;
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  // Zoom changes what's pannable, so this can't be a load-time check alone.
  useEffect(() => {
    measure();
  }, [scale]);

  function measure() {
    const container = containerRef.current;
    const image = imageRef.current;
    if (!container || !image || !image.naturalWidth) return;
    setTravel(
      framingTravel({
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        zoom: scale / 100,
      })
    );
  }

  const canPanX = travel.x > 1;
  const canPanY = travel.y > 1;
  const draggable = canPanX || canPanY;
  // Naming the axes matters: a 16:9 poster in a 16:9 frame has nothing hidden
  // in any direction, and a bare "drag to reframe" would read as broken.
  // Saying that zooming unlocks it explains the dead drag instead.
  const hint = !draggable
    ? "This image already fits — zoom in to reframe it"
    : canPanX && canPanY
      ? "Drag any direction to reframe"
      : canPanY
        ? "Drag up or down — zoom in to pan sideways too"
        : "Drag left or right — zoom in to pan vertically too";

  const dirty = Math.round(draft.x) !== value.x || Math.round(draft.y) !== value.y || scale !== value.scale;

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className={cn(
          "relative w-full overflow-hidden ring-1 ring-border",
          // A circle as wide as the tile preview would dwarf the page, and
          // what it previews is a profile picture a fraction of that size.
          round ? "max-w-[15rem] rounded-full" : "max-w-sm rounded-md",
          !aspectRatio && aspectClass
        )}
        style={aspectRatio ? { aspectRatio } : undefined}
      >
        <img
          ref={imageRef}
          src={src}
          alt=""
          draggable={false}
          onLoad={measure}
          onPointerDown={(event) => {
            if (!draggable) return;
            event.preventDefault();
            drag.current = { startX: event.clientX, startY: event.clientY, start: draft };
          }}
          style={{
            objectPosition: `${draft.x}% ${draft.y}%`,
            transform: `scale(${scale / 100})`,
            // Anchoring the zoom to the same percentages is what lets one pair
            // of numbers drive both the crop and the zoom pan: origin at the
            // left keeps the left edge pinned as it grows, revealing the same
            // side object-position is already showing.
            transformOrigin: `${draft.x}% ${draft.y}%`,
          }}
          className={cn(
            "h-full w-full select-none object-cover",
            draggable && "cursor-grab active:cursor-grabbing"
          )}
        />
        <div className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-white/60" />
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/70 px-3 py-1.5 text-center text-xs text-white backdrop-blur-sm">
          {hint}
        </div>
      </div>

      <label className="flex max-w-sm items-center gap-3 text-xs text-muted-foreground">
        <span className="shrink-0">Zoom</span>
        <input
          type="range"
          min={100}
          max={300}
          step={5}
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-white"
        />
        <span className="w-10 shrink-0 text-right tabular-nums">{scale}%</span>
      </label>

      {note && <p className="max-w-sm text-[11px] text-muted-foreground/70">{note}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave({ x: Math.round(draft.x), y: Math.round(draft.y), scale })}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-black transition-transform hover:scale-[1.03] disabled:opacity-50"
        >
          <Check className="size-3.5" />
          Save framing
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
          Cancel
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setDraft({ x: value.x, y: value.y });
              setScale(value.scale);
            }}
            className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A CSS `aspect-ratio` as a number. Accepts `"16 / 10"` and a bare `"1.6"`.
 *
 * Returns 0 for anything unparseable, which `visibleBand` already treats as
 * "show the whole thing" rather than producing NaN geometry.
 */
function ratioOf(aspectRatio: string): number {
  const [width, height] = aspectRatio.split("/");
  const w = Number(width);
  if (height === undefined) return Number.isFinite(w) && w > 0 ? w : 0;
  const h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && h > 0 && w > 0 ? w / h : 0;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Mark where the subject is, instead of nudging the image inside one frame.
 *
 * The single-frame drag cannot express this. `framingAfterDrag` leaves an axis
 * with no travel untouched, and which axis is dead depends on the frame: a
 * wide still overflows horizontally in both tile shapes, so its vertical axis
 * is dead in both and keeps whatever default it started at. Vertical is the
 * only axis that moves a hero banner, which crops the same still taller than
 * it is — so hero framing was unreachable from either tile shape, whichever
 * one you reframed in.
 *
 * Placing a point on the uncropped image keeps both axes live whatever the
 * source shape, and the previews show every frame the one value has to
 * satisfy at the same time.
 */
function FocalFraming({
  src,
  value,
  previews,
  saving,
  onSave,
  onCancel,
  note,
}: FramingEditorProps & { previews: FramingPreview[] }) {
  const [focal, setFocal] = useState<Framing>({ x: value.x, y: value.y });
  const [scale, setScale] = useState(value.scale);
  // The frame is sized to the image's own ratio so `object-cover` crops
  // nothing here — that keeps a pointer position and a percentage of the
  // source the same number, with no letterboxing to subtract.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Stable, so the window listeners below can subscribe once: it reads a ref
  // and calls a setter, and closes over nothing that changes.
  const applyPoint = useCallback((clientX: number, clientY: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    setFocal({
      x: Math.round(clampPercent(((clientX - rect.left) / rect.width) * 100)),
      y: Math.round(clampPercent(((clientY - rect.top) / rect.height) * 100)),
    });
  }, []);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      if (!dragging.current) return;
      event.preventDefault();
      applyPoint(event.clientX, event.clientY);
    }
    function endDrag() {
      dragging.current = false;
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [applyPoint]);

  const imageRatio = natural ? natural.w / natural.h : 0;
  const dirty = focal.x !== value.x || focal.y !== value.y || scale !== value.scale;

  return (
    <div className="space-y-2">
      <div
        ref={frameRef}
        onPointerDown={(event) => {
          event.preventDefault();
          dragging.current = true;
          applyPoint(event.clientX, event.clientY);
        }}
        style={{ aspectRatio: natural ? `${natural.w} / ${natural.h}` : "16 / 9" }}
        className="relative w-full max-w-sm cursor-crosshair overflow-hidden rounded-md ring-1 ring-border"
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth && image.naturalHeight) {
              setNatural({ w: image.naturalWidth, h: image.naturalHeight });
            }
          }}
          className="h-full w-full select-none object-cover"
        />

        {/* What each shape keeps, drawn over the whole image, so the cost of a
            placement is visible before saving rather than after. */}
        {imageRatio > 0 &&
          previews.map((preview) => {
            const band = visibleBand(focal, imageRatio, ratioOf(preview.aspectRatio), scale);
            return (
              <div
                key={preview.label}
                className="pointer-events-none absolute border border-dashed border-white/50"
                style={{
                  left: `${band.x.start * 100}%`,
                  top: `${band.y.start * 100}%`,
                  width: `${(band.x.end - band.x.start) * 100}%`,
                  height: `${(band.y.end - band.y.start) * 100}%`,
                }}
              />
            );
          })}

        <div
          className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          style={{ left: `${focal.x}%`, top: `${focal.y}%` }}
        />
      </div>

      <p className="max-w-sm text-[11px] text-muted-foreground">
        Click or drag to mark the subject. Every shape below keeps it in frame.
      </p>

      <div className="flex max-w-sm flex-wrap items-end gap-2">
        {previews.map((preview) => (
          <div key={preview.label} className="space-y-1">
            <div
              className="relative w-20 overflow-hidden rounded ring-1 ring-border"
              style={{ aspectRatio: preview.aspectRatio }}
            >
              <img
                src={src}
                alt=""
                draggable={false}
                className="h-full w-full select-none object-cover"
                style={focalStyle(focal, scale)}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">{preview.label}</p>
          </div>
        ))}
      </div>

      <label className="flex max-w-sm items-center gap-3 text-xs text-muted-foreground">
        <span className="shrink-0">Zoom</span>
        <input
          type="range"
          min={100}
          max={300}
          step={5}
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-white"
        />
        <span className="w-10 shrink-0 text-right tabular-nums">{scale}%</span>
      </label>

      {note && <p className="max-w-sm text-[11px] text-muted-foreground/70">{note}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave({ x: focal.x, y: focal.y, scale })}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-black transition-transform hover:scale-[1.03] disabled:opacity-50"
        >
          <Check className="size-3.5" />
          Save framing
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
          Cancel
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setFocal({ x: value.x, y: value.y });
              setScale(value.scale);
            }}
            className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
