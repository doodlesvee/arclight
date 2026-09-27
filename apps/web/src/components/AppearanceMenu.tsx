import { useEffect, useRef, useState } from "react";
import { EyeOff, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  activePreset,
  DENSITIES,
  PRESETS,
  TILE_SHAPES,
  VIEW_MODES,
} from "@/lib/layout";
import {
  BANNER_MAX,
  BANNER_MIN,
  BLUR_MAX,
  BLUR_MIN,
  DISCREET_SHORTCUT,
  MOTION_LEVELS,
  RADIUS_MIN,
  RADIUS_MAX,
  TYPE_SCALE_MIN,
  TYPE_SCALE_MAX,
  TILE_INFO_OPTIONS,
  isDefaultAppearance,
  TILE_MAX,
  TILE_MIN,
  useAppearance,
  useAppearanceScope,
} from "@/lib/appearance";
import { PREVIEW_SCREENSAVER, SCREENSAVER_SOURCES } from "@/lib/screensaver";
import { Slider, Toggle } from "./AppearanceControls";
import { PrivacyUnlockForm } from "./PrivacyUnlockForm";
import { Portal } from "./Portal";
import { usePrivacyGuard } from "@/lib/privacyGuard";

/**
 * How the app looks, on a keyboard shortcut.
 *
 * Deliberately not in Site settings: these are choices you can only judge by
 * looking at them. It opens over whatever page you're on, so the tiles behind
 * it resize as you drag — you're choosing against the real thing rather than
 * against a description of it.
 *
 * No button anywhere: it used to sit in the header, but a control you open
 * perhaps twice a week was taking permanent space beside the account menu.
 * The footer carries the shortcut so it's still discoverable.
 */
export function AppearanceMenu() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      // `code` rather than `key`: with modifiers held, some layouts report a
      // different character for the same physical key.
      if (event.code !== "Comma") return;
      event.preventDefault();
      setOpen((o) => !o);
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const appearance = useAppearance();
  const {
    tileSizePercent,
    tileInfo,
    viewMode,
    tileShape,
    density,
    hoverZoom,
    hoverPreview,
    modalPreview,
    ambientLight,
    screensaver,
    screensaverMinutes,
    screensaverSeconds,
    screensaverSource,
    screensaverClock,
    autoplayNext,
    motion,
    cardRadiusRem,
    typeScale,
    discreet,
    discreetBlurPercent,
    discreetText,
    heroHeight,
    bannerHeight,
    set,
    reset,
  } = appearance;
  const preset = activePreset({ viewMode, density, tileInfo, tileSizePercent });
  const [unlocking, setUnlocking] = useState(false);

  const { scope, isOverridden, setForScope, clearScope } = useAppearanceScope();

  /**
   * Where a layout change lands: this page, or everywhere (§1).
   *
   * Derived from whether the page already has overrides rather than held in
   * state, so the switch cannot claim "this page" for a page that is in fact
   * following the globals — which is exactly what a stored flag does the
   * first time the two disagree.
   */
  const scoped = isOverridden;

  function setLayout(patch: Parameters<typeof setForScope>[0]) {
    if (scoped) setForScope(patch);
    else set(patch);
  }

  function setScoped(next: boolean) {
    if (next) {
      // Seeded with what is on screen, so flipping the switch changes nothing
      // visually and the page's first real choice is the next click. Pinning
      // an empty override would leave the page following the globals while
      // the switch says otherwise.
      setForScope({ viewMode, tileShape, density, tileInfo, tileSizePercent });
    } else {
      clearScope();
    }
  }

  const { guarded } = usePrivacyGuard();

  // Closing the panel abandons a half-typed password rather than leaving it
  // sitting in state for the next time it opens.
  useEffect(() => {
    // Closing the panel abandons a half-typed password: the form unmounts
    // with it, so nothing is left waiting for the next time it opens.
    if (!open) setUnlocking(false);
  }, [open]);

  function toggleDiscreet(next: boolean) {
    // Turning it on is always free. Turning it off is the guarded direction —
    // that asymmetry is the entire point. With no password set there is
    // nothing to ask for, and prompting anyway would just trap you.
    if (next || !guarded) {
      set({ discreet: next });
      return;
    }
    setUnlocking(true);
  }

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      // Capture phase and stopped here, so closing this doesn't also close a
      // modal underneath it.
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // Covers the settings on the Settings page too: this is the only Reset in
  // the app, and one that quietly left half the values alone would be worse
  // than none.
  const isDefault = isDefaultAppearance(appearance);

  if (!open) return null;

  return (
    <Portal>
      <div
        // The backdrop closes on click, but only its own — a click that
        // started inside the panel and drifted out (which a slider drag does
        // constantly) must not dismiss it.
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      >
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Appearance"
          // Two columns of settings rather than one long scroll. The panel
          // grew a Layout section with five controls in it, and at 320px wide
          // everything below the fold needed hunting for. Capped so it does
          // not become a full-screen sheet on a wide display.
          className="max-h-[85vh] w-[min(52rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Appearance</h2>
            <div className="flex items-center gap-1">
              {/* Hidden while locked: resetting would otherwise clear discreet
                  mode without ever asking for the password. */}
              {!isDefault && !(discreet && guarded) && (
                <button
                  type="button"
                  onClick={reset}
                  title="Reset to defaults"
                  aria-label="Reset appearance to defaults"
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close appearance panel"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>

          {/* Layout owns a column to itself: it is much the longest section,
              and pairing it with the three short ones keeps the two columns a
              similar height instead of one running far past the other. */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-6">
            <div className="space-y-4">
              <Section label="Discreet mode" />

              <Toggle
                label="Discreet mode"
                hint={
                  discreet && guarded
                    ? "Blurs every image. Unlocking asks for your privacy password."
                    : `Blurs every image. ${DISCREET_SHORTCUT} turns it on from anywhere.`
                }
                checked={discreet}
                onChange={toggleDiscreet}
              />

              {discreet && (
                <div className="space-y-3 rounded-lg bg-secondary/40 p-3">
                  <Slider
                    label="Blur strength"
                    value={discreetBlurPercent}
                    min={BLUR_MIN}
                    max={BLUR_MAX}
                    step={5}
                    suffix="%"
                    hint="Everything behind this panel is blurred at it right now."
                    onChange={(next) => set({ discreetBlurPercent: next })}
                  />
                  <Toggle
                    label="Blur names too"
                    hint="Titles, performers and studios. Navigation stays readable."
                    checked={discreetText}
                    onChange={(next) => set({ discreetText: next })}
                  />
                </div>
              )}

              {unlocking && (
                <div className="space-y-2 rounded-lg bg-secondary/60 p-3">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <EyeOff className="size-3.5" />
                    Privacy password
                  </span>
                  <PrivacyUnlockForm
                    onUnlocked={() => {
                      set({ discreet: false });
                      setUnlocking(false);
                    }}
                    onCancel={() => setUnlocking(false)}
                  />
                </div>
              )}

              <Section label="Playback" />

              <Toggle
                label="Play preview when opened"
                hint={
                  discreet
                    ? "Off while discreet mode is on — nothing autoplays."
                    : "Start the clip as soon as you open an item, instead of opening on the still. Pressing Play always plays."
                }
                checked={!discreet && modalPreview}
                disabled={discreet}
                onChange={(next) => set({ modalPreview: next })}
              />

              <Toggle
                label="Ambient light"
                hint={
                  discreet
                    ? "Off while discreet mode is on — moving colour would give away what's playing."
                    : "A soft glow around the player in the colours on screen. Not shown in cinema mode or the mini player."
                }
                checked={!discreet && ambientLight}
                disabled={discreet}
                onChange={(next) => set({ ambientLight: next })}
              />

              <Toggle
                label="Autoplay next in queue"
                hint="When a video ends, start the next queued one. With this off the queue still advances — the Up next card is there to take it."
                checked={autoplayNext}
                onChange={(next) => set({ autoplayNext: next })}
              />

              <Section label="Interface" />

              <Toggle
                label="Poster screensaver"
                hint="When the app sits idle, a slow slideshow of posters. Never over a video that's playing; any key or movement brings you back."
                checked={screensaver}
                onChange={(next) => set({ screensaver: next })}
              />

              {screensaver && (
                <div className="space-y-3 rounded-md border border-border p-3">
                  <label className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium">Start after</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="number"
                        min={1}
                        max={60}
                        step={1}
                        value={screensaverMinutes}
                        onChange={(e) => {
                          const minutes = Math.round(Number(e.target.value));
                          // Ignores the empty moment while you retype a number.
                          if (Number.isFinite(minutes) && minutes >= 1) {
                            set({ screensaverMinutes: Math.min(60, minutes) });
                          }
                        }}
                        className="h-7 w-16 rounded-md border border-input bg-background px-2 text-right tabular-nums text-foreground"
                      />
                      {screensaverMinutes === 1 ? "minute" : "minutes"} idle
                    </span>
                  </label>
                  <ChoiceRow
                    label="Show"
                    options={SCREENSAVER_SOURCES}
                    value={screensaverSource}
                    onChange={(value) => set({ screensaverSource: value })}
                  />
                  <ChoiceRow
                    label="Each poster"
                    options={[5, 8, 15].map((s) => ({ value: s, label: `${s} s` }))}
                    value={screensaverSeconds}
                    onChange={(value) => set({ screensaverSeconds: value })}
                  />
                  <Toggle
                    label="Show clock"
                    hint="The time and date in the corner."
                    checked={screensaverClock}
                    onChange={(next) => set({ screensaverClock: next })}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      window.dispatchEvent(new Event(PREVIEW_SCREENSAVER));
                    }}
                    className="w-full rounded-md bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-accent"
                  >
                    Preview
                  </button>
                </div>
              )}

              <div className="space-y-1.5">
                <span className="text-xs font-medium">Animation</span>
                <div className="flex gap-1 rounded-md bg-secondary/60 p-0.5">
                  {MOTION_LEVELS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => set({ motion: option.value })}
                      aria-pressed={motion === option.value}
                      title={option.hint}
                      className={cn(
                        "flex-1 rounded px-2 py-1 text-xs transition-colors",
                        motion === option.value
                          ? "bg-background font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="block text-[11px] leading-snug text-muted-foreground/70">
                  {MOTION_LEVELS.find((option) => option.value === motion)?.hint}{" "}
                  Your system&rsquo;s own reduced-motion setting still wins over
                  this.
                </span>
              </div>

              <Slider
                label="Corner rounding"
                value={cardRadiusRem}
                min={RADIUS_MIN}
                max={RADIUS_MAX}
                step={0.125}
                suffix="rem"
                hint="Every card, panel and button at once."
                onChange={(next) => set({ cardRadiusRem: next })}
              />

              <Slider
                label="Text size"
                value={typeScale}
                min={TYPE_SCALE_MIN}
                max={TYPE_SCALE_MAX}
                step={0.05}
                suffix="×"
                hint="Scales the interface text. For making everything bigger, including the artwork, use your browser's zoom."
                onChange={(next) => set({ typeScale: next })}
              />

              <Section label="Banner" />

              <Slider
                label="Hero height"
                value={heroHeight}
                min={BANNER_MIN}
                max={BANNER_MAX}
                suffix="%"
                hint="The homepage hero."
                onChange={(next) => set({ heroHeight: next })}
              />

              <Slider
                label="Banner height"
                value={bannerHeight}
                min={BANNER_MIN}
                max={BANNER_MAX}
                suffix="%"
                hint="The performer and studio headers."
                onChange={(next) => set({ bannerHeight: next })}
              />
              {/* Both are held off while discreet mode is on, and shown that
                  way rather than left looking live but inert. The stored values
                  are untouched, so turning discreet off restores whatever you
                  had before it. */}
            </div>

            <div className="space-y-4">
              <Section label="Layout" />

              {/* Which page a layout change applies to (§1). Only offered
                  inside a PageScope — on a page that hasn't declared one
                  there is no "this page" to pin anything to. */}
              {scope && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium">Applies to</span>
                  <div className="flex gap-1 rounded-md bg-secondary/60 p-0.5">
                    <button
                      type="button"
                      onClick={() => setScoped(false)}
                      aria-pressed={!scoped}
                      className={cn(
                        "flex-1 rounded px-2 py-1 text-xs transition-colors",
                        !scoped
                          ? "bg-background font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Everywhere
                    </button>
                    <button
                      type="button"
                      onClick={() => setScoped(true)}
                      aria-pressed={scoped}
                      className={cn(
                        "flex-1 rounded px-2 py-1 text-xs capitalize transition-colors",
                        scoped
                          ? "bg-background font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      This page
                    </button>
                  </div>
                  <span className="block text-[11px] leading-snug text-muted-foreground/70">
                    {scoped
                      ? `The ${scope} page keeps its own layout. The settings below no longer follow the rest of the app.`
                      : "One layout for every grid in the app."}
                  </span>
                </div>
              )}

              {/* Presets first: most people want a look, not three axes. The
                  individual controls stay underneath for anyone who does. */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Preset</span>
                  {preset === null && (
                    <span className="text-[11px] text-muted-foreground/70">
                      Custom
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {PRESETS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setLayout(option.settings)}
                      aria-pressed={preset === option.value}
                      title={option.hint}
                      className={cn(
                        "rounded-md px-2 py-1.5 text-xs transition-colors",
                        preset === option.value
                          ? "bg-background font-medium text-foreground ring-1 ring-border"
                          : "bg-secondary/60 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="block text-[11px] leading-snug text-muted-foreground/70">
                  {preset === null
                    ? "Your own combination of the three settings below."
                    : PRESETS.find((option) => option.value === preset)?.hint}
                </span>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium">View</span>
                <div className="flex gap-1 rounded-md bg-secondary/60 p-0.5">
                  {VIEW_MODES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setLayout({ viewMode: option.value })}
                      aria-pressed={viewMode === option.value}
                      title={option.hint}
                      className={cn(
                        "flex-1 rounded px-2 py-1 text-xs transition-colors",
                        viewMode === option.value
                          ? "bg-background font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="block text-[11px] leading-snug text-muted-foreground/70">
                  {VIEW_MODES.find((option) => option.value === viewMode)?.hint}
                </span>
              </div>

              {/* Under View because the two are about the card itself, and
                  above Density because the shape is the one people go looking
                  for. Not part of a preset: a preset is a size and a level of
                  detail, and either reads fine in either shape. */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium">Tile shape</span>
                <div className="flex gap-1 rounded-md bg-secondary/60 p-0.5">
                  {TILE_SHAPES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setLayout({ tileShape: option.value })}
                      aria-pressed={tileShape === option.value}
                      title={option.hint}
                      className={cn(
                        "flex-1 rounded px-2 py-1 text-xs transition-colors",
                        tileShape === option.value
                          ? "bg-background font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="block text-[11px] leading-snug text-muted-foreground/70">
                  {tileShape === "portrait"
                    ? "Video stills are wide, so a tall frame crops their sides. Set a poster in a tile's menu to choose what it keeps."
                    : TILE_SHAPES.find((option) => option.value === tileShape)
                        ?.hint}
                </span>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium">Density</span>
                <div className="flex gap-1 rounded-md bg-secondary/60 p-0.5">
                  {DENSITIES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setLayout({ density: option.value })}
                      aria-pressed={density === option.value}
                      className={cn(
                        "flex-1 rounded px-2 py-1 text-[11px] transition-colors",
                        density === option.value
                          ? "bg-background font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="block text-[11px] leading-snug text-muted-foreground/70">
                  Space between and inside cards.
                </span>
              </div>

              <Slider
                label="Tile size"
                value={tileSizePercent}
                min={TILE_MIN}
                max={TILE_MAX}
                step={5}
                suffix="%"
                hint="Applies to every row and grid in the app. A preset sets this too, so moving it yourself makes the preset Custom."
                onChange={(next) => setLayout({ tileSizePercent: next })}
              />

              <div className="space-y-1.5">
                <span className="text-xs font-medium">Tile labels</span>
                <div className="flex gap-1 rounded-md bg-secondary/60 p-0.5">
                  {TILE_INFO_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setLayout({ tileInfo: option.value })}
                      aria-pressed={tileInfo === option.value}
                      className={cn(
                        "flex-1 rounded px-2 py-1 text-xs transition-colors",
                        tileInfo === option.value
                          ? "bg-background font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="block text-[11px] leading-snug text-muted-foreground/70">
                  Performer and title, title alone, or artwork with neither.
                </span>
              </div>


              <Toggle
                label="Zoom on hover"
                hint={
                  discreet
                    ? "Off while discreet mode is on."
                    : "Expand a tile into a preview card when you hover it."
                }
                checked={!discreet && hoverZoom}
                disabled={discreet}
                onChange={(next) => set({ hoverZoom: next })}
              />

              <Toggle
                label="Play preview on hover"
                hint={
                  discreet
                    ? "Off while discreet mode is on — nothing autoplays."
                    : hoverZoom
                      ? "Autoplay the video's clip in that card, instead of holding the still."
                      : "With zoom off, the clip plays in the tile itself."
                }
                checked={!discreet && hoverPreview}
                disabled={discreet}
                onChange={(next) => set({ hoverPreview: next })}
              />
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * A group heading.
 *
 * The panel reached eight controls covering three unrelated things — hiding
 * the library, drawing tiles, and sizing banners — and a flat list of eight
 * makes you read all of them to find one.
 */
function Section({ label }: { label: string }) {
  return (
    <h3 className="border-t border-border pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground first:border-0 first:pt-0">
      {label}
    </h3>
  );
}

/** A labelled row of mutually exclusive options, in the panel's segmented style. */
function ChoiceRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex gap-1 rounded-md bg-secondary/60 p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={cn(
              "flex-1 rounded px-1.5 py-1 text-xs transition-colors",
              value === option.value
                ? "bg-background font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
