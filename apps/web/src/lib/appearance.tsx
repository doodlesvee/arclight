import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SCREENSAVER_SOURCES, type ScreensaverSource } from "./screensaver";
import { fetchAppearance, saveAppearance } from "./appearanceApi";
import {
  DENSITIES,
  TILE_SHAPES,
  VIEW_MODES,
  type Density,
  type TileInfo,
  type TileShape,
  type ViewMode,
} from "./layout";

/**
 * The homepage's sections, in their default order.
 *
 * `collections` and `tags` are groups rather than single rows — one row is
 * rendered per collection and per tag — so hiding either hides the whole
 * family. Keys are stored, not indexes, so inserting a section later doesn't
 * silently reshuffle somebody's saved order.
 */
export const HOME_ROWS = [
  { key: "categories", label: "Categories" },
  { key: "continue", label: "Continue watching" },
  { key: "favourites", label: "Favourites" },
  { key: "performers", label: "Performers" },
  { key: "studios", label: "Studios" },
  { key: "recent", label: "Recently added" },
  { key: "recentlyWatched", label: "Recently watched" },
  { key: "mostPlayed", label: "Most played" },
  { key: "unwatched", label: "Unwatched" },
  { key: "recentlyBrowsed", label: "Recently browsed" },
  { key: "recentlyInteracted", label: "Recently interacted" },
  { key: "randomPicks", label: "Random picks" },
  { key: "pinned", label: "Pinned" },
  { key: "collections", label: "Collections" },
  { key: "tags", label: "Tags" },
] as const;

export type HomeRowKey = (typeof HOME_ROWS)[number]["key"];

/** An ordered list; anything missing from it is hidden. */
export type HomeRowSetting = { key: HomeRowKey; visible: boolean };

const DEFAULT_HOME_ROWS: HomeRowSetting[] = HOME_ROWS.map((row) => ({
  key: row.key,
  visible: true,
}));

/**
 * Reconciles a stored order against the rows this build actually has.
 *
 * Keeps the saved order and visibility, drops keys that no longer exist, and
 * slots any new section in at the position this build gives it — relative to
 * the rows the stored order already has.
 *
 * New rows used to be appended to the end, which was meant to stop a shipped
 * row being invisible and achieved the opposite. `collections` and `tags`
 * each render one row *per* collection and per tag, so the end of the list is
 * below twenty rows of content on a real library — far enough down that
 * Pinned, a row of navigation shortcuts, was reported as simply not there.
 *
 * Inserting by position keeps the two things that matter about a stored
 * order: the rows you arranged stay in the order you arranged them, and the
 * ones you hid stay hidden. Only the rows you have never seen move, and they
 * move to where they were designed to sit.
 */
export function readHomeRows(value: unknown): HomeRowSetting[] {
  if (!Array.isArray(value)) return DEFAULT_HOME_ROWS;

  const known = new Set<string>(HOME_ROWS.map((row) => row.key));
  const seen = new Set<string>();
  const out: HomeRowSetting[] = [];

  for (const entry of value) {
    const key = (entry as HomeRowSetting)?.key;
    if (typeof key !== "string" || !known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key: key as HomeRowKey,
      visible: (entry as HomeRowSetting).visible !== false,
    });
  }

  const order = HOME_ROWS.map((row) => row.key as string);
  for (const row of HOME_ROWS) {
    if (seen.has(row.key)) continue;

    // Land after the last row that this build puts ahead of it. Searching
    // from the end rather than the start matters when the stored order has
    // been rearranged: what decides the spot is the nearest preceding
    // neighbour as it actually sits now, not as this build lists it.
    //
    // Rows inserted earlier in this loop count as neighbours too, which is
    // what keeps several new rows in their own relative order.
    const precedes = new Set(order.slice(0, order.indexOf(row.key)));
    let at = 0;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (precedes.has(out[i].key)) {
        at = i + 1;
        break;
      }
    }
    out.splice(at, 0, { key: row.key, visible: true });
  }

  return out;
}

/**
 * Validates a stored override map.
 *
 * Same discipline as every other key: a hand-edited entry, or one written by
 * a build that had a view mode this one doesn't, must not be able to render
 * a page with `viewMode: undefined`. Unknown values are dropped rather than
 * corrected, so the page falls back to the global setting.
 */
function readPageOverrides(value: unknown): Record<string, PageOverride> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, PageOverride> = {};

  for (const [scope, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as PageOverride;
    const next: PageOverride = {};

    if (VIEW_MODES.some((option) => option.value === entry.viewMode))
      next.viewMode = entry.viewMode;
    if (TILE_SHAPES.some((option) => option.value === entry.tileShape))
      next.tileShape = entry.tileShape;
    if (DENSITIES.some((option) => option.value === entry.density))
      next.density = entry.density;
    if (TILE_INFO_OPTIONS.some((option) => option.value === entry.tileInfo))
      next.tileInfo = entry.tileInfo;
    if (
      typeof entry.tileSizePercent === "number" &&
      Number.isFinite(entry.tileSizePercent)
    ) {
      next.tileSizePercent = Math.min(
        TILE_MAX,
        Math.max(TILE_MIN, Math.round(entry.tileSizePercent)),
      );
    }

    // An override that survived validation with nothing in it is the same as
    // no override, and keeping it would show the page as "customised".
    if (Object.keys(next).length > 0) out[scope] = next;
  }

  return out;
}

/** How much text a tile carries under its artwork. */
export type { TileInfo };

/** Whether tiles are cropped wide or tall. */
export type { TileShape };

export const TILE_INFO_OPTIONS: { value: TileInfo; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "title", label: "Title" },
  { value: "none", label: "None" },
  // Under the artwork rather than over it: the catalogue look, where the
  // picture is left alone and the text is a caption beneath it.
  { value: "below", label: "Below" },
];

export type MotionLevel = "full" | "reduced" | "none";

export const MOTION_LEVELS: {
  value: MotionLevel;
  label: string;
  hint: string;
}[] = [
  { value: "full", label: "Full", hint: "Entrances, hover lifts, the lot." },
  {
    value: "reduced",
    label: "Reduced",
    hint: "State still changes visibly, but nothing travels.",
  },
  { value: "none", label: "None", hint: "Nothing moves or fades." },
];

/** The rounding range, in rem. Square to noticeably soft. */
export const RADIUS_MIN = 0;
export const RADIUS_MAX = 1.5;

/**
 * The type-scale range.
 *
 * Narrow on purpose: this is a legibility adjustment, not a zoom. The browser
 * already has a zoom and it scales images and layout along with the text,
 * which is what you actually want when everything is too small.
 */
export const TYPE_SCALE_MIN = 0.85;
export const TYPE_SCALE_MAX = 1.3;

export type Appearance = {
  /**
   * Tile size as a percentage of the widest a tile goes — one number drives
   * both the rows and the grid.
   *
   * A percentage rather than a pixel width for the same reason as the blur:
   * the number should mean something without knowing the implementation. The
   * rows need an actual length, so it's converted where it's used.
   */
  tileSizePercent: number;
  /**
   * What a tile writes over its artwork.
   *
   * Pairs with the size slider: at 200px the performer line and title crowd
   * the picture, and at 500px they look sparse — so the label has to be able
   * to move too, not just the box.
   */
  tileInfo: TileInfo;
  /**
   * The card's shape and how much of the chosen width it takes.
   *
   * Separate from the size slider rather than replacing it: the mode says
   * what kind of card this is, the slider says how big your cards are, and
   * folding both into one control makes every preset a compromise between
   * them.
   */
  viewMode: ViewMode;
  /**
   * Whether artwork is cropped to a wide frame or a tall one.
   *
   * Separate from `viewMode` for the same reason the size slider is: the mode
   * is three sizes of one card, and adding a portrait entry to it would mean
   * you could have the shape you wanted or the size you wanted but not both.
   *
   * Affects media tiles only. Performer cards have always been 2:3 and stay
   * that way — they are portraits of people, not artwork whose shape is a
   * preference, and letting this setting turn them landscape would crop every
   * face in the library to a letterbox.
   */
  tileShape: TileShape;
  /** How much air sits between and inside cards. */
  density: Density;
  /** Whether hovering a tile expands it into a preview card. */
  hoverZoom: boolean;
  /** Whether that card plays the video's preview clip, or just holds the still. */
  hoverPreview: boolean;
  /**
   * Whether opening an item starts its preview clip, or opens on the still
   * with nothing running.
   *
   * Separate from `hoverPreview`: a clip under the pointer is glanceable and
   * ends when you move away, but one that starts because you opened something
   * keeps playing until you act. Wanting the first without the second is a
   * reasonable thing to want.
   *
   * Never suppresses deliberate playback — pressing Play, or opening from the
   * hero's Play button, is explicit intent and ignores this.
   */
  modalPreview: boolean;
  /**
   * A soft glow behind the player in the colours on screen, like an
   * Ambilight TV. Never shown in cinema mode, the mini player or discreet
   * mode, whatever this says.
   */
  ambientLight: boolean;
  /** A slideshow of posters after some idle minutes; never over playback. */
  screensaver: boolean;
  /** Idle minutes before the screensaver starts. */
  screensaverMinutes: number;
  /** Seconds each poster stays on screen. */
  screensaverSeconds: number;
  /** Which videos' posters it shows. */
  screensaverSource: ScreensaverSource;
  /** The time and date in the corner. */
  screensaverClock: boolean;
  /** The video pinned as the Hall of fame's main event; 0 lets it pick. */
  hallOfFamePin: number;
  /** Blur every image and clip in the app until you hover one. */
  discreet: boolean;
  /**
   * How hard that blur is, as a percentage of the strongest it goes.
   *
   * A percentage rather than a pixel count because pixels mean nothing here —
   * nobody knows what 18px of blur looks like, but "about half" is a thing
   * you can decide. The stylesheet still needs a length, so this is scaled to
   * one at the point it's applied.
   */
  discreetBlurPercent: number;
  /**
   * Whether names are blurred too.
   *
   * Off by default: a blurred picture with "Little Caprice · BlackedRaw"
   * legible underneath hides less than it looks like it does, but blurring
   * the text costs you the ability to find anything, so it's a choice rather
   * than an assumption about which you'd rather have.
   */
  discreetText: boolean;
  /**
   * Height of the homepage hero, as a percentage of the viewport.
   *
   * This and `bannerHeight` were one setting, on the reasoning that they are
   * the same kind of thing and two controls only offer the chance to make
   * them disagree. In practice they are not: the hero is the first thing on
   * the homepage and competes with the rows under it, while a performer
   * header is a title card you scroll past. Wanting a tall hero and a short
   * header is a coherent preference, and one slider could not express it.
   */
  heroHeight: number;
  /**
   * Height of the performer and studio headers, as a percentage of the
   * viewport. See `heroHeight` for why these are separate.
   */
  bannerHeight: number;
  /**
   * Whether finishing a video starts the next queued one (§10).
   *
   * A setting rather than always-on: autoplay is right when you have built a
   * queue and wrong when you have not, and the app cannot tell which from
   * the fact that something happened to be next in the list.
   */
  autoplayNext: boolean;
  /**
   * How much the interface moves (§24).
   *
   * "full" is the designed behaviour. The OS `prefers-reduced-motion` setting
   * still wins over this where the two disagree — someone who has asked their
   * whole system for less motion has not opted into more of it by leaving an
   * app on its default.
   */
  motion: MotionLevel;
  /** Corner rounding, in rem. Drives every radius in the app at once. */
  cardRadiusRem: number;
  /** Multiplies every font size. 1 is the designed scale. */
  typeScale: number;
  /** Which homepage sections show, and in what order. */
  homeRows: HomeRowSetting[];
  /**
   * Per-context layout overrides, keyed by scope name (§1).
   *
   * Only the four layout settings, not the whole of Appearance. Discreet
   * Mode in particular must never be per-page — a privacy control that holds
   * on the library and not on Favourites is worse than not having it.
   *
   * Sparse: a scope appears here only once it has been given a setting of
   * its own, so "follows the global setting" stays the default and stays
   * free. Clearing a scope deletes its key rather than writing the globals
   * into it, which is what lets a later change to the global setting reach
   * pages that never opted out.
   */
  pageOverrides: Record<string, PageOverride>;
};

/** The settings a single page may pin for itself. */
export type PageOverride = Partial<{
  viewMode: ViewMode;
  tileShape: TileShape;
  density: Density;
  tileInfo: TileInfo;
  tileSizePercent: number;
}>;

// The slider's range, in percent of TILE_MAX_PX. Starting at 40% rather than
// 0 because everything below about 200px is too small to read a title in, so
// the lower stretch would just be a dead zone.
export const TILE_MIN = 40;
export const TILE_MAX = 100;
const TILE_MAX_PX = 520;

/** Percent of the widest tile, as the length a layout actually needs. */
export function tileWidthPx(percent: number): number {
  return Math.round((percent / 100) * TILE_MAX_PX);
}

// Percent of the viewport height. Percentages rather than pixels because
// these are full-bleed banners — what matters is how much of the screen they
// take, and that should hold on a laptop and on a large display alike.
// The slider's range, in percent. 100% is BLUR_MAX_PX — past that every tile
// is the same grey smear and you lose all sense of where you are; below about
// 10% shapes are still readable.
export const BLUR_MIN = 10;
export const BLUR_MAX = 100;
const BLUR_MAX_PX = 40;

/** Percent of the strongest blur, as the length CSS actually needs. */
export function blurLength(percent: number): string {
  return `${Math.round((percent / 100) * BLUR_MAX_PX)}px`;
}

export const BANNER_MIN = 30;
export const BANNER_MAX = 100;
export const DEFAULTS: Appearance = {
  // 80% is the 416px it sat at before the slider took percentages.
  tileSizePercent: 80,
  tileInfo: "full",
  viewMode: "grid",
  // Landscape, so an install that never opens this picker is drawn exactly as
  // it was before the setting existed.
  tileShape: "landscape",
  density: "comfortable",
  hoverZoom: true,
  hoverPreview: true,
  modalPreview: true,
  ambientLight: true,
  screensaver: true,
  screensaverMinutes: 5,
  screensaverSeconds: 8,
  screensaverSource: "all",
  screensaverClock: true,
  hallOfFamePin: 0,
  discreet: false,
  // 45% ≈ the 18px this was fixed at before the slider existed.
  discreetBlurPercent: 45,
  discreetText: false,
  heroHeight: 70,
  bannerHeight: 70,
  autoplayNext: true,
  motion: "full",
  cardRadiusRem: 0.625,
  typeScale: 1,
  homeRows: DEFAULT_HOME_ROWS,
  pageOverrides: {},
};

const STORAGE_KEY = "appearance";

/**
 * The panic key: Ctrl/Cmd + Shift + H.
 *
 * Chosen because it's reachable one-handed without looking and isn't taken by
 * anything in the app. It only ever turns discreet mode *on* — switching it
 * off is what the privacy password guards, and a key that toggled both ways
 * would undo the protection with the same keystroke that applied it.
 */
export const DISCREET_SHORTCUT = "Ctrl/⌘ + Shift + H";

/**
 * Opens the appearance panel. Comma because every desktop app puts
 * preferences there; with Shift because a bare Ctrl/⌘ + , is the browser's
 * own settings and can't be intercepted.
 */
export const APPEARANCE_SHORTCUT = "Ctrl/⌘ + Shift + ,";

/** Opens search from anywhere. The convention every app with a palette uses. */
export const SEARCH_SHORTCUT = "Ctrl/⌘ + K";

// localStorage throws outright in some privacy configurations, and an
// unguarded read here would white-screen the whole app — the same discipline
// the sidebar's collapsed state already uses.
/**
 * Clamps a stored fractional value into range.
 *
 * Distinct from clampPercent below, which rounds to a whole number — these
 * two are rem and a multiplier, where rounding to an integer would snap
 * 0.625rem to 1rem and a 1.15 scale to 1.
 */
function clampRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampPercent(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(BANNER_MAX, Math.max(BANNER_MIN, Math.round(value)));
}

function read(): Appearance {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      // A new key, like the blur: the old one held pixels, and a stored 416
      // would clamp to 100% here — a bigger tile than was chosen. Re-validated
      // either way, so a hand-edited entry can't render tiles 4px wide.
      tileSizePercent:
        typeof parsed.tileSizePercent === "number" &&
        Number.isFinite(parsed.tileSizePercent)
          ? Math.min(
              TILE_MAX,
              Math.max(TILE_MIN, Math.round(parsed.tileSizePercent)),
            )
          : DEFAULTS.tileSizePercent,
      tileInfo: TILE_INFO_OPTIONS.some(
        (option) => option.value === parsed.tileInfo,
      )
        ? (parsed.tileInfo as TileInfo)
        : DEFAULTS.tileInfo,
      viewMode: VIEW_MODES.some((option) => option.value === parsed.viewMode)
        ? (parsed.viewMode as ViewMode)
        : DEFAULTS.viewMode,
      tileShape: TILE_SHAPES.some(
        (option) => option.value === parsed.tileShape,
      )
        ? (parsed.tileShape as TileShape)
        : DEFAULTS.tileShape,
      density: DENSITIES.some((option) => option.value === parsed.density)
        ? (parsed.density as Density)
        : DEFAULTS.density,
      hoverZoom:
        typeof parsed.hoverZoom === "boolean"
          ? parsed.hoverZoom
          : DEFAULTS.hoverZoom,
      hoverPreview:
        typeof parsed.hoverPreview === "boolean"
          ? parsed.hoverPreview
          : DEFAULTS.hoverPreview,
      modalPreview:
        typeof parsed.modalPreview === "boolean"
          ? parsed.modalPreview
          : DEFAULTS.modalPreview,
      ambientLight:
        typeof parsed.ambientLight === "boolean"
          ? parsed.ambientLight
          : DEFAULTS.ambientLight,
      screensaver:
        typeof parsed.screensaver === "boolean"
          ? parsed.screensaver
          : DEFAULTS.screensaver,
      screensaverMinutes: clampRange(parsed.screensaverMinutes, 1, 60, DEFAULTS.screensaverMinutes),
      screensaverSeconds: clampRange(parsed.screensaverSeconds, 3, 60, DEFAULTS.screensaverSeconds),
      screensaverSource: SCREENSAVER_SOURCES.some((o) => o.value === parsed.screensaverSource)
        ? (parsed.screensaverSource as ScreensaverSource)
        : DEFAULTS.screensaverSource,
      screensaverClock:
        typeof parsed.screensaverClock === "boolean"
          ? parsed.screensaverClock
          : DEFAULTS.screensaverClock,
      hallOfFamePin: Number.isInteger(parsed.hallOfFamePin)
        ? clampRange(parsed.hallOfFamePin, 0, 2147483647, 0)
        : DEFAULTS.hallOfFamePin,
      discreet:
        typeof parsed.discreet === "boolean"
          ? parsed.discreet
          : DEFAULTS.discreet,
      // Deliberately a new key: the old one held pixels, and a stored 18
      // would read as 18% here — a much weaker blur than the one that was
      // chosen. Ignoring it falls back to the equivalent default instead.
      discreetBlurPercent:
        typeof parsed.discreetBlurPercent === "number" &&
        Number.isFinite(parsed.discreetBlurPercent)
          ? Math.min(
              BLUR_MAX,
              Math.max(BLUR_MIN, Math.round(parsed.discreetBlurPercent)),
            )
          : DEFAULTS.discreetBlurPercent,
      discreetText:
        typeof parsed.discreetText === "boolean"
          ? parsed.discreetText
          : DEFAULTS.discreetText,
      // Falls back to the old shared value before the default, so a stored
      // banner height carries over to the hero rather than snapping back to
      // 70% the first time someone opens this build.
      heroHeight: clampPercent(
        parsed.heroHeight ?? parsed.bannerHeight,
        DEFAULTS.heroHeight,
      ),
      bannerHeight: clampPercent(parsed.bannerHeight, DEFAULTS.bannerHeight),
      autoplayNext:
        typeof parsed.autoplayNext === "boolean"
          ? parsed.autoplayNext
          : DEFAULTS.autoplayNext,
      motion: MOTION_LEVELS.some((option) => option.value === parsed.motion)
        ? (parsed.motion as MotionLevel)
        : DEFAULTS.motion,
      cardRadiusRem: clampRange(
        parsed.cardRadiusRem,
        RADIUS_MIN,
        RADIUS_MAX,
        DEFAULTS.cardRadiusRem,
      ),
      typeScale: clampRange(
        parsed.typeScale,
        TYPE_SCALE_MIN,
        TYPE_SCALE_MAX,
        DEFAULTS.typeScale,
      ),
      homeRows: readHomeRows(parsed.homeRows),
      pageOverrides: readPageOverrides(parsed.pageOverrides),
    };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Whether anything differs from the defaults — including the settings that
 * live on the Settings page, since Reset in the panel resets all of them.
 * Comparing the whole object means a setting added later is covered without
 * anyone remembering to extend a list of comparisons.
 */
export function isDefaultAppearance(value: Appearance): boolean {
  return JSON.stringify(value) === JSON.stringify(DEFAULTS);
}

type Store = Appearance & {
  set: (patch: Partial<Appearance>) => void;
  reset: () => void;
};

const AppearanceContext = createContext<Store | null>(null);

/**
 * The page currently asking for settings, or null for "the global ones".
 *
 * A context rather than a route lookup, because the scope is not always the
 * route: Favourites and Collections are both rendered by BrowsePage with
 * different search params, and §1 names them as separate contexts. The page
 * says what it is; the router doesn't have to know.
 */
const PageScopeContext = createContext<string | null>(null);

/**
 * Declares which context the subtree's layout settings belong to (§1).
 *
 * Wrapping rather than a hook call so the scope covers everything rendered
 * inside it — the grid, its cards and the appearance menu all have to agree
 * on which page they are on, and a hook in one of them would not reach the
 * other two.
 */
export function PageScope({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  return (
    <PageScopeContext.Provider value={name}>
      {children}
    </PageScopeContext.Provider>
  );
}

/**
 * Display preferences that change how every tile in the app is drawn.
 *
 * Two stores, deliberately. The browser's copy is read synchronously so the
 * first paint is already correct — waiting on a request would flash the
 * defaults on every load. The server's copy is the shared one, so a change
 * made in one browser shows up in the next.
 *
 * Writes are debounced: a slider fires on every pixel of a drag, and a PUT
 * per tick would hammer the API to save a preference nobody has finished
 * choosing yet.
 */
export function AppearanceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [value, setValue] = useState<Appearance>(read);
  // Nothing is sent until the server's copy has been read, or the first
  // change would push this browser's local state over what's stored.
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAppearance()
      .then((stored) => {
        if (cancelled) return;
        // Merged over the defaults rather than replacing state: the server
        // holds only what's been changed, so anything absent keeps its
        // default instead of becoming undefined.
        setValue((current) => {
          const merged = { ...current, ...stored };
          if (stored.homeRows) {
            merged.homeRows = readHomeRows(stored.homeRows);
          }
          // The same migration `read` does, for the server's copy: a install
          // that set a banner height before the hero got its own slider has
          // only the old key, and a browser with no localStorage yet would
          // otherwise show a default-height hero next to the short header.
          if (
            stored.heroHeight === undefined &&
            typeof stored.bannerHeight === "number"
          ) {
            merged.heroHeight = stored.bannerHeight;
          }
          return merged;
        });
      })
      .catch(() => {
        // Offline, or not signed in yet. The local copy is still correct.
      })
      .finally(() => {
        if (!cancelled) loaded.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void saveAppearance(value).catch(() => {}),
      500,
    );
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [value]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      // `code` rather than `key`: with a modifier held some layouts report a
      // different character, and this has to fire every time.
      if (event.code !== "KeyH") return;
      event.preventDefault();
      // The arming half. Pressing the same keys while it's on is handled by
      // DiscreetUnlockDialog, which asks for the password — this handler
      // no-ops in that case rather than the two fighting over one press.
      setValue((current) =>
        current.discreet ? current : { ...current, discreet: true },
      );
    }

    // Capture phase, so it still fires from inside a text field or with a
    // modal open — the moment you need it is not the moment to discover that
    // focus was somewhere unhelpful.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Not being able to remember the choice is survivable; crashing isn't.
    }
  }, [value]);

  /**
   * Motion, rounding and type scale, applied at the document root.
   *
   * The same argument as discreet mode below: these have to reach every
   * component including the ones rendered into portals, and a prop threaded
   * through the tree would miss the modals and the toast stack, which are
   * siblings of the app rather than descendants of it.
   *
   * "full" removes the attribute rather than setting it, so the default
   * costs no selector matching at all.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (value.motion === "full") root.removeAttribute("data-motion");
    else root.setAttribute("data-motion", value.motion);
  }, [value.motion]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--radius", `${value.cardRadiusRem}rem`);
    root.style.setProperty("--type-scale", String(value.typeScale));
  }, [value.cardRadiusRem, value.typeScale]);

  // Discreet mode is a single attribute on <html> rather than a prop threaded
  // through every component that renders an image. There are dozens of those —
  // tiles, hero, portraits, banners, album covers, the lightbox — and any one
  // of them missed would be the one showing at the wrong moment.
  useEffect(() => {
    const root = document.documentElement;
    if (value.discreet) {
      root.setAttribute("data-discreet", "true");
      // A custom property rather than a class per strength: the stylesheet
      // reads one variable and the slider can be any value in the range.
      root.style.setProperty(
        "--discreet-blur",
        blurLength(value.discreetBlurPercent),
      );
      if (value.discreetText) root.setAttribute("data-discreet-text", "true");
      else root.removeAttribute("data-discreet-text");
    } else {
      root.removeAttribute("data-discreet");
      root.removeAttribute("data-discreet-text");
      root.style.removeProperty("--discreet-blur");
    }
  }, [value.discreet, value.discreetBlurPercent, value.discreetText]);

  const set = useCallback((patch: Partial<Appearance>) => {
    setValue((current) => ({ ...current, ...patch }));
  }, []);
  const reset = useCallback(() => setValue(DEFAULTS), []);

  const store = useMemo<Store>(
    () => ({ ...value, set, reset }),
    [value, set, reset],
  );

  return (
    <AppearanceContext.Provider value={store}>
      {children}
    </AppearanceContext.Provider>
  );
}

/**
 * Display settings as the current page should see them.
 *
 * Merges the page's own overrides over the globals, so every existing caller
 * — grids, cards, rows — gets per-page layout for free without knowing that
 * per-page layout exists. `set` stays global on purpose: a component that
 * reaches for it is changing a preference, not a page's exception to one,
 * and the panel uses `useAppearanceScope` below for the scoped half.
 */
export function useAppearance(): Store {
  const store = useContext(AppearanceContext);
  const scope = useContext(PageScopeContext);
  // Falls back to the defaults rather than throwing, so a component rendered
  // outside the provider (a test, a future embed) still draws correctly.
  const base = store ?? { ...DEFAULTS, set: () => {}, reset: () => {} };

  const override = scope ? base.pageOverrides[scope] : undefined;
  return useMemo(
    () => (override ? { ...base, ...override } : base),
    // `base` is rebuilt by the provider's own memo, so comparing it by
    // identity is correct and avoids re-merging on every render.
    [base, override],
  );
}

export type AppearanceScope = {
  /** The current page's name, or null outside any PageScope. */
  scope: string | null;
  /** What this page has pinned for itself. Empty when it follows the globals. */
  override: PageOverride;
  /** True when this page has any setting of its own. */
  isOverridden: boolean;
  /** Pins settings to this page. A no-op outside a PageScope. */
  setForScope: (patch: PageOverride) => void;
  /** Drops this page's overrides, returning it to the global settings. */
  clearScope: () => void;
};

export function useAppearanceScope(): AppearanceScope {
  const store = useContext(AppearanceContext);
  const scope = useContext(PageScopeContext);
  const override = (scope && store?.pageOverrides[scope]) || {};

  const setForScope = useCallback(
    (patch: PageOverride) => {
      if (!scope || !store) return;
      store.set({
        pageOverrides: {
          ...store.pageOverrides,
          [scope]: { ...store.pageOverrides[scope], ...patch },
        },
      });
    },
    [scope, store],
  );

  const clearScope = useCallback(() => {
    if (!scope || !store) return;
    // Deleted rather than emptied: an empty object would still count as an
    // override and keep the page pinned to whatever the globals were when it
    // was cleared.
    const next = { ...store.pageOverrides };
    delete next[scope];
    store.set({ pageOverrides: next });
  }, [scope, store]);

  return {
    scope,
    override,
    isOverridden: Object.keys(override).length > 0,
    setForScope,
    clearScope,
  };
}
