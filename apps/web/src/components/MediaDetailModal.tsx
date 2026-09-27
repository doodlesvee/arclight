import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/lib/useMediaQuery";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark as BookmarkIcon,
  Cast,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Gauge,
  GripHorizontal,
  Heart,
  Lightbulb,
  Trophy,
  Maximize,
  PictureInPicture2,
  Maximize2,
  MonitorPlay,
  Move,
  Pencil,
  Play,
  ListPlus,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { PerformerEditor } from "./PerformerEditor";
import { AmbientLight } from "./AmbientLight";
import { ClampedText } from "./ClampedText";
import { DescriptionEditor } from "./DescriptionEditor";
import { EditableTitle } from "./EditableTitle";
import { FolderPicker } from "./FolderPicker";
import { GalleryStrip } from "./GalleryStrip";
import { Portal } from "./Portal";
import { RelatedItems } from "./RelatedItems";
import { StudioEditor } from "./StudioEditor";
import { TagEditor } from "./TagEditor";
import { TechnicalInfoPanel } from "./TechnicalInfoPanel";
import { ThumbnailPicker } from "./ThumbnailPicker";
import { FramingEditor, type FramingValue } from "./FramingEditor";
import { useAppearance } from "@/lib/appearance";
import { useAccentColor } from "@/lib/dominantColor";
import { fetchCategories } from "@/lib/categoryApi";
import {
  fetchItem,
  savePlaybackPosition,
  setWatched,
  updateItem,
} from "@/lib/mediaItemApi";
import {
  PLAYBACK_RATES,
  readRate,
  readVolume,
  writeRate,
  writeVolume,
} from "@/lib/playerPrefs";
import { framingStyle, thumbnailUrl } from "@/lib/mediaItemApi";
import { cardChrome, TILE_SHAPES } from "@/lib/layout";
import { cn, formatDuration } from "@/lib/utils";
import { useUndoable } from "@/lib/undo";
import { QueuePanel } from "./QueuePanel";
import { useQueue } from "@/lib/queue";
import { StarRating } from "./StarRating";
import { SeekStrip } from "./SeekStrip";
import { BookmarkList } from "./BookmarkList";
import { PlayerGestures } from "./PlayerGestures";
import {
  formatTimestamp,
  useBookmarkMutations,
  useBookmarks,
  useScrubSprite,
} from "@/lib/bookmarkApi";
import { useToast } from "@/lib/toast";
import { useCast } from "@/lib/useCast";
import { SeriesAssignment } from "./SeriesAssignment";

// Only offer "Continue Watching" for meaningful progress: not basically the
// start (nothing to resume) or basically the end (same as starting over).
const MIN_RESUMABLE_SECONDS = 15;

/**
 * The hero banner's shape, so reframing can preview it alongside the tiles.
 *
 * Derived from the viewport rather than a constant: the hero spans the full
 * width and a chosen fraction of the viewport height, so its ratio is a
 * property of the window and the setting, not of the card system. Falls back
 * to a typical wide banner when there is no window to measure, which keeps
 * this usable under test.
 */
function heroAspect(heroHeightPercent: number): string {
  if (typeof window === "undefined") return "16 / 5";
  const height = (window.innerHeight * heroHeightPercent) / 100;
  return height > 0 && window.innerWidth > 0
    ? `${window.innerWidth} / ${height}`
    : "16 / 5";
}

function FieldLabel({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent?: string | null;
}) {
  return (
    <span
      className="block text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors duration-500"
      style={{ color: accent ?? undefined }}
    >
      {children}
    </span>
  );
}

// Throttle for position saves — `timeupdate` fires several times a second.
const SAVE_INTERVAL_MS = 8000;

/** How far the arrow keys and the skip buttons jump. */
const SKIP_SECONDS = 10;

/**
 * Whether a keystroke belongs to something the user is typing into.
 *
 * The header search box sits on the page behind the modal, and the title,
 * description, tag, performer and studio editors all render inside it — so
 * without this, typing a space into any of them would pause the video
 * instead of typing a space.
 */
/** The bare 0–9 row keys. Numpad digits report the same `key`, so they count too. */
function isDigitKey(key: string): boolean {
  return key.length === 1 && key >= "0" && key <= "9";
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches(
    "input, textarea, select, [contenteditable], [contenteditable=true]",
  );
}

export function MediaDetailModal({
  itemId,
  autoPlay = false,
  resume = false,
  onClose,
  mini = false,
  onExpand,
}: {
  itemId: number;
  autoPlay?: boolean;
  resume?: boolean;
  onClose: () => void;
  mini?: boolean;
  onExpand?: () => void;
}) {
  // Clicking a "More Like This" card swaps the modal's content in place
  // rather than stacking modals or bouncing back to the grid.
  const [viewingId, setViewingId] = useState(itemId);
  const panelRef = useRef<HTMLDivElement>(null);

  // Without this, focus stays on the page behind: Tab walks the background
  // instead of the dialog, and closing leaves focus nowhere useful.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);
  useEffect(() => setViewingId(itemId), [itemId]);

  const { data: item } = useQuery({
    queryKey: ["media-item", viewingId],
    queryFn: () => fetchItem(viewingId),
  });

  const {
    discreet,
    modalPreview,
    autoplayNext,
    density,
    heroHeight,
    ambientLight: ambient,
    hallOfFamePin,
    set: setAppearance,
  } = useAppearance();
  // The player's own button flips the same Appearance setting.
  const toggleAmbient = () => setAppearance({ ambientLight: !ambient });
  const runUndoable = useUndoable();
  const [mode, setMode] = useState<"preview" | "playing">("preview");

  // Opened, but holding the still with nothing running. Only ever true before
  // real playback starts: once you press Play the mode changes and neither
  // discreet mode nor the preview preference gets a say in it.
  const stillOnly = mode === "preview" && (discreet || !modalPreview);
  const [cinema, setCinema] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [seeked, setSeeked] = useState(false);
  const queryClient = useQueryClient();
  const [muted, setMuted] = useState(true);
  const isMobile = useIsMobile();
  // Read once on mount rather than on every render — these are re-applied to
  // the element imperatively, so React never needs to re-render for them.
  const [rate, setRate] = useState(readRate);
  const [showRates, setShowRates] = useState(false);
  const [reframing, setReframing] = useState(false);
  const volumeRef = useRef(readVolume());
  // Metadata is read-only until you ask to edit it. Showing every editor by
  // default filled the panel with empty "Add tag…" style inputs, which read
  // as unfinished rather than as a record of the video.
  const [editingRequested, setEditing] = useState(false);
  // Read-only on a phone. Derived rather than just hiding the button, so a
  // sheet left in edit mode on a desktop cannot stay that way when the window
  // narrows — every editor below is gated on this one flag.
  const editing = editingRequested && !isMobile;
  const { add, addNext, items: queueItems, remove } = useQueue();
  const autoPlayNext = useRef(false);
  const { toast } = useToast();
  const isVideo = item?.itemType === "video";
  const { data: bookmarks = [] } = useBookmarks(viewingId, isVideo);
  const bookmarkMutations = useBookmarkMutations(viewingId);
  // Asked for as soon as real playback starts, not on hover: the first build
  // takes a few seconds, and by the time you reach for the bar it is there.
  const { data: scrubSprite } = useScrubSprite(
    viewingId,
    isVideo && mode === "playing" && !mini,
  );
  const [miniPosition, setMiniPosition] = useState(() => {
    const width = 384;
    return {
      left: Math.max(20, window.innerWidth - width - 20),
      top: Math.max(20, window.innerHeight - width * (9 / 16) - 20),
    };
  });
  const [miniWidth, setMiniWidth] = useState(384);
  const dragStart = useRef<{
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
  } | null>(null);
  const resizeStart = useRef<{
    pointerX: number;
    width: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (cinema && !mini) root.setAttribute("data-cinema", "true");
    else root.removeAttribute("data-cinema");
    return () => root.removeAttribute("data-cinema");
  }, [cinema, mini]);

  const { data: categoryData } = useQuery({
    queryKey: ["categories"],
    queryFn: fetchCategories,
  });
  const categories = categoryData?.categories ?? [];
  const accent = useAccentColor(item ? thumbnailUrl(item) : null);

  const updateKind = useMutation({
    mutationFn: (kind: string) => updateItem(viewingId, { kind }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-item", viewingId] });
      queryClient.invalidateQueries({ queryKey: ["media-items"] });
      // The home page tiles show per-category counts, and they read
      // ["categories"] — invalidating ["kinds"] refreshed nothing, since no
      // component has used that key since categories became editable data.
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  /**
   * Favourite, with an undo rather than a confirmation (§19).
   *
   * A mis-click on a heart is trivially reversible and a dialog in front of
   * it would be absurd, so this is exactly the case the undo toast exists
   * for. The previous value is captured before the write and handed to the
   * inverse, so undoing restores what was actually there rather than
   * toggling again — which would be the opposite of what the toast says on a
   * double press.
   */
  function toggleFavorite(next: boolean) {
    void runUndoable({
      message: next ? "Added to Favourites" : "Removed from Favourites",
      description: item?.title,
      apply: async () => {
        await updateItem(viewingId, { isFavorite: next });
        return !next;
      },
      revert: (previous) => updateItem(viewingId, { isFavorite: previous }),
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: ["media-item", viewingId] });
        queryClient.invalidateQueries({ queryKey: ["media-items"] });
      },
    });
  }
  const saveFraming = useMutation({
    mutationFn: (next: FramingValue) =>
      updateItem(viewingId, {
        thumbnailPositionX: next.x,
        thumbnailPositionY: next.y,
        thumbnailScale: next.scale,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-item", viewingId] });
      // Every surface showing this thumbnail has to repaint, not just the modal.
      queryClient.invalidateQueries({ queryKey: ["media-items"] });
      queryClient.invalidateQueries({ queryKey: ["hero-items"] });
      queryClient.invalidateQueries({ queryKey: ["continue-watching"] });
      setReframing(false);
    },
  });

  const toggleWatched = useMutation({
    mutationFn: (next: boolean) => setWatched(viewingId, next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-item", viewingId] });
      queryClient.invalidateQueries({ queryKey: ["media-items"] });
      // Marking something watched is exactly what should drop it out of
      // Continue Watching, so that row has to refetch.
      queryClient.invalidateQueries({ queryKey: ["continue-watching"] });
    },
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playerAreaRef = useRef<HTMLDivElement>(null);
  const cast = useCast(videoRef, viewingId, isVideo && mode === "playing", `${mode}-${viewingId}`);
  // The stream this item is playing from while it is being cast, when the TV
  // needed a different URL from the ordinary one. Keyed by item so opening
  // another video goes back to the ordinary stream without a reset.
  const [castSrc, setCastSrc] = useState<{ id: number; url: string } | null>(null);

  /**
   * The queue column, beside the player so the video stays visible while you
   * pick what is next.
   *
   * Always there once something is queued — hiding what plays next while
   * things are waiting to play is not a preference. The Appearance setting
   * only decides whether the empty column keeps its place.
   *
   * Never in cinema mode, where the point is the video filling the screen, or
   * in the mini player, which has no room for it.
   */
  /**
   * null means "follow the rule below". Q replaces it with a real answer, so
   * a queue with things in it can still be put away for a moment without
   * emptying it, and an empty one can be called up to see what is there.
   */
  const [queueChoice, setQueueChoice] = useState<boolean | null>(null);
  const queueOpen = queueChoice ?? queueItems.length > 0;

  const queueBeside =
    !mini && !cinema && item?.itemType === "video" && queueOpen;
  const startPosition = useRef(0);
  const lastSavedAt = useRef(0);
  const autoPlayTriggered = useRef(false);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showPlayerControls, setShowPlayerControls] = useState(true);

  function revealPlayerControls() {
    setShowPlayerControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (mode === "playing") {
      controlsTimer.current = setTimeout(
        () => setShowPlayerControls(false),
        2200,
      );
    }
  }

  useEffect(() => {
    return () => {
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
    };
  }, []);

  useEffect(() => {
    if (mode === "playing") revealPlayerControls();
    else setShowPlayerControls(true);
  }, [mode]);

  function skip(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    const limit = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(
      limit,
      Math.max(0, video.currentTime + seconds),
    );
  }

  function seekTo(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = seconds;
    setCurrentTime(seconds);
    revealPlayerControls();
  }

  /** Marks the current moment. Named later, from the list under the video. */
  function addBookmark() {
    const video = videoRef.current;
    if (!video || mode !== "playing") return;
    const at = video.currentTime;
    bookmarkMutations.add.mutate(
      { positionSeconds: at },
      {
        onSuccess: () =>
          toast({ title: "Bookmarked", description: formatTimestamp(at), variant: "success" }),
      },
    );
  }

  /** From the bookmark list: seek if already playing, otherwise start there. */
  function jumpTo(seconds: number) {
    if (mode === "playing") {
      seekTo(seconds);
      void videoRef.current?.play().catch(() => {});
    } else {
      startPlaying(seconds);
    }
  }

  /**
   * Hands the video to a TV. Everything here stays synchronous up to the
   * picker, which only opens from inside the click itself.
   */
  function startCasting() {
    const video = videoRef.current;
    if (!video || !item) return;
    const url = cast.castSource();
    if (url && castSrc?.url !== url) {
      // Carried across the swap by handleLoadedMetadata, like a resume.
      startPosition.current = video.currentTime;
      video.src = url;
      setCastSrc({ id: item.id, url });
      void video.play().catch(() => {});
    }
    void cast.openPicker();
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }

  function applyRate(next: number) {
    setRate(next);
    writeRate(next);
    setShowRates(false);
    if (videoRef.current) videoRef.current.playbackRate = next;
  }

  function nudgeVolume(delta: number) {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.min(1, Math.max(0, video.volume + delta));
    video.volume = next;
    volumeRef.current = next;
    writeVolume(next);
    // Raising the volume on a muted video should actually be audible.
    if (next > 0 && video.muted) {
      video.muted = false;
      setMuted(false);
    }
  }

  /**
   * Picture-in-Picture (§10).
   *
   * Distinct from the mini player, which is this app's own floating window
   * and only survives while the tab is open. PiP is the browser's, so it
   * keeps playing over other applications and outlives navigating away —
   * which is the reason to offer both rather than treating one as the other.
   *
   * Guarded on support rather than assumed: Firefox exposes the API only
   * behind its own UI, and calling it there throws rather than no-opping.
   */
  const pipSupported =
    typeof document !== "undefined" &&
    "pictureInPictureEnabled" in document &&
    document.pictureInPictureEnabled;

  async function togglePictureInPicture() {
    const video = videoRef.current;
    if (!video || !pipSupported) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      // Denied by the browser (no user gesture, or disabled by policy).
      // There is nothing to recover — the video keeps playing where it is.
    }
  }

  /**
   * Fullscreen for the player area rather than the bare <video>.
   *
   * Fullscreening the element itself hides everything drawn over it — the
   * seek preview, bookmarks, skip buttons, the double-tap zones — so the
   * moment you went fullscreen they all stopped existing. The browser's own
   * fullscreen button still takes the video alone, for anyone who wants that.
   *
   * iPhone Safari has no element fullscreen at all, only the video's own
   * native player, so that is the fallback there.
   *
   * On a phone a wide video is also locked to landscape, so it fills the
   * screen without you having to turn it first. Only where the browser
   * allows it (Android, while fullscreen); elsewhere the call just fails.
   */
  function toggleFullscreen() {
    const video = videoRef.current;
    const area = playerAreaRef.current;
    if (!video) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    const target = area?.requestFullscreen ? area : video;
    if (target.requestFullscreen) {
      void target
        .requestFullscreen()
        .then(() => {
          if (isMobile && video.videoWidth > video.videoHeight) {
            const orientation = screen.orientation as ScreenOrientation & {
              lock?: (orientation: string) => Promise<void>;
            };
            return orientation.lock?.("landscape");
          }
        })
        .catch(() => {});
      return;
    }
    (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
  }

  // Leaving fullscreen by any route — Escape, the system back gesture, the
  // native button — hands orientation back to the phone.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) screen.orientation?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape closes even from inside an input — it's the way out of a
      // field you opened by accident.
      if (e.key === "Escape") {
        if (cinema) {
          setCinema(false);
          return;
        }
        onClose();
        return;
      }
      if (isTypingTarget(e.target)) return;

      // Handled above the guard below because the queue is worth seeing while
      // the preview is still running — that is when you are deciding what to
      // line up next, not once something is already playing.
      if (e.key === "q" || e.key === "Q") {
        if (!mini && !cinema && item?.itemType === "video") {
          e.preventDefault();
          setQueueChoice(!queueOpen);
        }
        return;
      }

      // Every shortcut below drives the video, so there's nothing to do
      // while the muted preview is showing.
      if (mode !== "playing") return;

      // The browser's own controls already handle arrows and space once the
      // video itself has focus. Handling them again here would seek twice
      // per press.
      // The browser's own controls handle arrows and space once the video has
      // focus; these keys have no native binding, so they still have to reach
      // this handler from there.
      if (
        e.target === videoRef.current &&
        e.key !== "f" &&
        e.key !== "m" &&
        e.key !== "c" &&
        e.key !== "i" &&
        e.key !== "b" &&
        !isDigitKey(e.key)
      )
        return;

      switch (e.key) {
        case " ":
        case "k":
          // Space also scrolls this modal's overflow container and re-clicks
          // whichever button was last focused — the modal is full of them.
          e.preventDefault();
          if (e.target instanceof HTMLElement) e.target.blur();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-SKIP_SECONDS);
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(SKIP_SECONDS);
          break;
        case "ArrowUp":
          e.preventDefault();
          nudgeVolume(0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          nudgeVolume(-0.1);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          toggleMuted();
          break;
        case "c":
          if (!mini) setCinema((active) => !active);
          break;
        case "i":
          void togglePictureInPicture();
          break;
        case "b":
          addBookmark();
          break;
        default:
          // 0–9 jump to that tenth of the video, as on YouTube: 5 is
          // halfway, 0 is the start. Read from the element rather than the
          // item, since the element's duration is what a seek is bounded by.
          if (isDigitKey(e.key)) {
            const video = videoRef.current;
            const duration = video?.duration;
            if (video && duration && Number.isFinite(duration)) {
              e.preventDefault();
              seekTo((Number(e.key) / 10) * duration);
            }
          }
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cinema, onClose, mode, mini, item?.itemType, queueOpen]);

  function startPlaying(positionSeconds: number) {
    startPosition.current = positionSeconds;
    setMode("playing");
    setMuted(false);

    const video = videoRef.current;
    if (video) {
      video.currentTime = positionSeconds;
      video.muted = false;
      void video.play().catch(() => {});
    }
  }

  // Hero "Play" arrives with autoPlay set — skip the muted preview entirely.
  useEffect(() => {
    if (autoPlay && item?.itemType === "video" && !autoPlayTriggered.current) {
      autoPlayTriggered.current = true;
      startPlaying(
        resume && item.lastPositionSeconds > MIN_RESUMABLE_SECONDS
          ? item.lastPositionSeconds
          : 0,
      );
    }
  }, [autoPlay, item]);

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video || !item) return;

    // `key={mode}` mounts a brand-new element when the preview gives way to
    // real playback, so anything set imperatively is gone by this point.
    // Re-applying here is what makes volume and speed survive that swap —
    // and carry over to the next video you open.
    video.volume = volumeRef.current;
    video.playbackRate = rate;

    // The preview clip already starts where it should, so only real playback
    // needs to seek (and stays hidden until that seek lands).
    if (mode === "playing") {
      video.currentTime = startPosition.current;
      return; // revealed by onSeeked
    }
    setSeeked(true);
  }

  // The native controls have their own volume slider, so the element is the
  // source of truth — this just records what it settles on.
  function handleVolumeChange() {
    const video = videoRef.current;
    if (!video || mode !== "playing") return;
    if (video.volume !== volumeRef.current) {
      volumeRef.current = video.volume;
      writeVolume(video.volume);
    }
    setMuted(video.muted);
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    // Critical: only real playback counts as progress. Saving during the
    // muted background preview would clobber the actual resume position
    // with wherever the preview happens to be.
    if (!video || !item || mode !== "playing") return;
    setCurrentTime(video.currentTime);

    const now = Date.now();
    if (now - lastSavedAt.current > SAVE_INTERVAL_MS) {
      lastSavedAt.current = now;
      void savePlaybackPosition(item.id, Math.floor(video.currentTime));
    }
  }

  function handlePause() {
    const video = videoRef.current;
    if (!item || !video || mode !== "playing") return;
    void savePlaybackPosition(item.id, Math.floor(video.currentTime));
  }

  function handleEnded() {
    if (!item || mode !== "playing") return;
    // Marking it watched both resets the position and takes it out of
    // Continue Watching — which a bare position reset never did, since that
    // row only ever filtered on having *some* progress.
    toggleWatched.mutate(true);
    const next = queueItems.find((queueItem) => queueItem.id !== item.id);
    // With autoplay off the queue is still consumed — the video is finished
    // either way — but nothing starts on its own. The Up Next card is still
    // on screen at this point, so "next" remains one click away.
    if (next && autoplayNext) {
      remove(item.id);
      remove(next.id);
      autoPlayNext.current = true;
      openRelated(next.id);
    } else {
      remove(item.id);
    }
  }

  function queueCurrent(next: boolean) {
    if (!item || item.itemType !== "video") return;
    const queueItem = {
      id: item.id,
      title: item.title,
      thumbnailFile: item.thumbnailFile,
      durationSeconds: item.durationSeconds,
    };
    if (next) addNext(queueItem);
    else add(queueItem);
  }

  function toggleMuted() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  function playNextQueued() {
    if (!item) return;
    const next = queueItems.find((queueItem) => queueItem.id !== item.id);
    if (!next) return;
    remove(item.id);
    remove(next.id);
    autoPlayNext.current = true;
    openRelated(next.id);
  }

  const nextQueuedItem = item
    ? queueItems.find((queueItem) => queueItem.id !== item.id)
    : undefined;
  const showUpNext =
    mode === "playing" &&
    !!nextQueuedItem &&
    item?.durationSeconds != null &&
    item.durationSeconds - currentTime <= 30;

  function startMiniDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!mini) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: miniPosition.left,
      top: miniPosition.top,
    };
  }

  function moveMini(event: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (!start) return;
    const panelHeight = miniWidth * (9 / 16);
    const maxLeft = Math.max(20, window.innerWidth - miniWidth - 20);
    const maxTop = Math.max(20, window.innerHeight - panelHeight - 20);
    setMiniPosition({
      left: Math.min(
        maxLeft,
        Math.max(20, start.left + (event.clientX - start.pointerX)),
      ),
      top: Math.min(
        maxTop,
        Math.max(20, start.top + (event.clientY - start.pointerY)),
      ),
    });
  }

  function stopMiniDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStart.current)
      event.currentTarget.releasePointerCapture(event.pointerId);
    dragStart.current = null;
  }

  function startMiniResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!mini) return;
    event.preventDefault();
    event.stopPropagation();
    revealPlayerControls();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = {
      pointerX: event.clientX,
      width: miniWidth,
      left: miniPosition.left,
    };
  }

  function moveMiniResize(event: React.PointerEvent<HTMLDivElement>) {
    const start = resizeStart.current;
    if (!start) return;
    const nextWidth = Math.min(
      640,
      Math.max(240, start.width + (event.clientX - start.pointerX)),
    );
    setMiniWidth(nextWidth);
    setMiniPosition((current) => ({ ...current, left: start.left }));
  }

  function stopMiniResize(event: React.PointerEvent<HTMLDivElement>) {
    if (resizeStart.current)
      event.currentTarget.releasePointerCapture(event.pointerId);
    resizeStart.current = null;
  }

  function scheduleHideControls() {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(
      () => setShowPlayerControls(false),
      1200,
    );
  }

  function openRelated(id: number) {
    setViewingId(id);
    // Reset back to the muted preview for the newly-shown item rather than
    // inheriting the previous one's playing state.
    setMode("preview");
    setEditing(false);
    setMuted(true);
    setReframing(false);
    setSeeked(false);
    lastSavedAt.current = 0;
    scrollRef.current?.scrollTo({ top: 0 });
  }

  useEffect(() => {
    if (!item || item.id !== viewingId || !autoPlayNext.current) return;
    autoPlayNext.current = false;
    startPlaying(0);
  }, [item, viewingId]);

  const canResume =
    !!item &&
    item.lastPositionSeconds > MIN_RESUMABLE_SECONDS &&
    (item.durationSeconds == null ||
      item.lastPositionSeconds < item.durationSeconds - MIN_RESUMABLE_SECONDS);

  return (
    <Portal lockPageScroll={!mini}>
      <div
        ref={scrollRef}
        // overscroll-contain stops the scroll continuing into the page
        // behind once this container hits its end.
        className={cn(
          "z-50",
          mini
            ? "pointer-events-none fixed inset-0 overflow-visible bg-transparent"
            : "fixed inset-0 overflow-y-auto overscroll-contain bg-black/80 p-4 backdrop-blur-sm sm:p-8",
        )}
        onClick={onClose}
      >
        {/* Behind the dialog, on the dimmed backdrop. Not in cinema mode,
            where the video already fills the screen; not in the mini player,
            which has no backdrop; and not in discreet mode, where colour
            moving across the room gives away what's playing. */}
        <AmbientLight
          videoRef={videoRef}
          active={ambient && isVideo && mode === "playing" && !mini && !cinema && !discreet}
        />
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          className={cn(
            "relative overflow-hidden bg-card shadow-2xl focus:outline-none",
            mini
              ? "pointer-events-auto fixed z-50 w-[min(24rem,calc(100vw-2rem))] rounded-lg ring-1 ring-border"
              : cinema
                ? "fixed inset-0 z-50 bg-black"
                : "mx-auto w-full max-w-5xl animate-fade-up rounded-xl",
          )}
          style={
            mini
              ? {
                  left: miniPosition.left,
                  top: miniPosition.top,
                  width: miniWidth,
                }
              : undefined
          }
          onMouseEnter={mini ? revealPlayerControls : undefined}
          onMouseMove={mini ? revealPlayerControls : undefined}
          onMouseLeave={mini ? scheduleHideControls : undefined}
          onClick={(e) => e.stopPropagation()}
        >
          {mini && item && (
            <div
              role="slider"
              tabIndex={0}
              aria-label="Move mini-player"
              title="Drag to move mini-player"
              onPointerDown={startMiniDrag}
              onPointerMove={moveMini}
              onPointerUp={stopMiniDrag}
              onPointerCancel={stopMiniDrag}
              className={cn(
                "absolute inset-x-0 top-0 z-20 flex h-4 cursor-grab items-center justify-center text-white/70 transition-opacity active:cursor-grabbing",
                showPlayerControls
                  ? "opacity-100"
                  : "pointer-events-none opacity-0",
              )}
            >
              <GripHorizontal className="size-5 rounded-full bg-black/45 px-0.5" />
            </div>
          )}
          {mini && (
            <div
              aria-label="Resize mini-player"
              title="Resize mini-player"
              onPointerDown={startMiniResize}
              onPointerMove={moveMiniResize}
              onPointerUp={stopMiniResize}
              onPointerCancel={stopMiniResize}
              className={cn(
                "absolute bottom-0 right-0 z-30 size-8 touch-none cursor-nwse-resize transition-opacity",
                showPlayerControls
                  ? "opacity-100"
                  : "pointer-events-none opacity-0",
              )}
            />
          )}
          {/* The player and the queue share a row. The player keeps its
              aspect ratio and so decides the row's height; the queue column
              stretches to match and scrolls inside itself. */}
          {/* The player and the queue share a row; everything below it runs
              the full width again.

              The modal keeps its width and the player gives up the space —
              widening it instead pushed the dialog out towards the edges of
              the screen every time something was queued, so the whole page
              moved because of a list. */}
          {/* Backdrop / player area */}
          <div
            ref={playerAreaRef}
            className={cn(
              "relative w-full overflow-hidden bg-black",
              cinema ? "h-screen" : "aspect-video",
            )}
            onMouseMove={revealPlayerControls}
            onTouchStart={revealPlayerControls}
          >
            {item?.itemType === "video" && (
              <img
                src={thumbnailUrl(item)}
                alt=""
                // Fades out once real playback is actually on screen. It fills
                // the frame (object-cover) while the video letterboxes inside it
                // (object-contain), so for anything not exactly 16:9 the poster
                // stayed visible down the sides — a bright one reads as a white
                // border rather than as bars. Kept until the seek lands, which
                // is what stops the frame flashing black while the stream
                // buffers.
                style={{
                  ...framingStyle(item),
                  opacity: mode === "playing" && seeked ? 0 : 1,
                  transition: "opacity 300ms ease-out",
                }}
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
            {item?.itemType === "video" ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption -- no sidecar subtitles yet
              <video
                ref={videoRef}
                // Preview mode plays the pre-cut clip (instant, already at the
                // poster frame); real playback streams the full file.
                key={mode}
                // With no clip to run, the element is left holding its poster.
                // Two reasons to end up here: discreet mode, where blurred
                // motion still reads as motion across a room, and the
                // appearance panel's "Play preview when opened" turned off.
                src={
                  mode === "playing"
                    ? castSrc?.id === item.id
                      ? castSrc.url
                      : `/api/stream/${item.id}`
                    : stillOnly
                      ? undefined
                      : `/api/media-items/${item.id}/preview`
                }
                poster={thumbnailUrl(item)}
                onLoadedMetadata={handleLoadedMetadata}
                onSeeked={() => setSeeked(true)}
                onTimeUpdate={handleTimeUpdate}
                onPause={handlePause}
                onEnded={handleEnded}
                onVolumeChange={handleVolumeChange}
                muted={mode === "preview"}
                autoPlay={mode === "playing" || !stillOnly}
                loop={mode === "preview"}
                playsInline
                controls={mode === "playing"}
                controlsList={mini ? "nofullscreen" : undefined}
                style={{
                  // Nothing will ever seek when there is no clip loaded, so
                  // the still has to be shown outright or the fade-in would
                  // leave the frame blank.
                  opacity: seeked || stillOnly ? 1 : 0,
                  transition: "opacity 300ms ease-out",
                }}
                className={cn(
                  "absolute inset-0 h-full w-full",
                  // The preview is deliberately cropped to fill the frame, but
                  // cropping actual playback cuts the sides off anything that
                  // isn't 16:9 — letterbox it instead.
                  mode === "playing" ? "object-contain" : "object-cover",
                  // Discreet mode blurs every image and clip in the app, but
                  // blurring something you deliberately pressed play on would
                  // just be broken.
                  mode === "playing" && "discreet-exempt",
                  // SeekStrip replaces the native timeline; see index.css.
                  mode === "playing" && !mini && "custom-seek",
                )}
              />
            ) : item ? (
              <img
                src={`/api/stream/${item.id}`}
                alt={item.title}
                className="h-full w-full object-contain"
              />
            ) : null}

            {mode === "playing" && isVideo && !mini && (
              <>
                <PlayerGestures
                  onSkip={(seconds) => {
                    skip(seconds);
                    revealPlayerControls();
                  }}
                  onTap={revealPlayerControls}
                />
                <SeekStrip
                  duration={item.durationSeconds ?? videoRef.current?.duration ?? 0}
                  currentTime={currentTime}
                  sprite={scrubSprite}
                  bookmarks={bookmarks}
                  visible={showPlayerControls}
                  onSeek={seekTo}
                  besidePanel={queueBeside}
                />
              </>
            )}

            {showUpNext && nextQueuedItem && (
              <div className="absolute bottom-24 right-4 z-20 flex w-[min(20rem,calc(100%-2rem))] items-center gap-3 rounded-lg bg-black/85 p-2.5 text-white shadow-xl ring-1 ring-white/15 backdrop-blur-md">
                <img
                  src={thumbnailUrl(nextQueuedItem)}
                  alt=""
                  className="size-16 shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
                    Up next
                  </p>
                  <p className="mt-1 truncate text-sm font-medium">
                    {nextQueuedItem.title}
                  </p>
                  <button
                    type="button"
                    onClick={playNextQueued}
                    className="mt-2 flex items-center gap-1.5 text-xs font-medium text-white/80 hover:text-white"
                  >
                    <Play className="size-3.5 fill-current" /> Play next
                  </button>
                </div>
              </div>
            )}

            {/* Gradient + overlaid title/actions, hidden once real playback
              starts so they don't sit on top of the video controls.

              Only on a wide screen. On a phone the picture is small enough
              that a title, six controls and a scrim left nothing of it to
              see, so there the frame carries a single play button and
              everything else moves below it. */}
            {mode === "preview" && !mini && !isMobile && (
              <>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-card via-card/30 to-transparent" />

                <div className="absolute bottom-0 left-0 right-0 flex flex-col gap-2 p-3 sm:gap-4 sm:p-6">
                  <h2 className="sensitive line-clamp-2 max-w-2xl pr-12 text-base font-bold tracking-tight drop-shadow-md sm:pr-0 sm:text-2xl md:text-3xl">
                    {item?.title ?? "Loading…"}
                  </h2>

                  {item?.itemType === "video" && (
                    <div
                      // Wraps, and every control keeps its size: unwrapped,
                      // six of them in a phone's width squeezed the round
                      // buttons into each other. The right padding is the
                      // lane the mute button sits in, further down.
                      className="flex flex-wrap items-center gap-1.5 sm:gap-3"
                    >
                      <button
                        type="button"
                        onClick={() => startPlaying(0)}
                        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black transition-transform hover:scale-[1.03] sm:gap-2 sm:px-5 sm:py-2 sm:text-base"
                      >
                        <RotateCcw className="size-4 sm:size-5" />
                        Start Over
                      </button>
                      {canResume && (
                        <button
                          type="button"
                          onClick={() => startPlaying(item.lastPositionSeconds)}
                          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-white/20 px-3 py-1.5 text-xs font-semibold backdrop-blur-sm transition-colors hover:bg-white/30 sm:gap-2 sm:px-5 sm:py-2 sm:text-base"
                        >
                          <Play className="size-4 fill-current sm:size-5" />
                          {/* Shortened on a phone so it shares a line with
                              "Start Over" instead of stacking under it. */}
                          <span className="sm:hidden">Resume</span>
                          <span className="hidden sm:inline">
                            Continue Watching
                          </span>
                        </button>
                      )}
                      {/* Its own line on a phone, so the two labelled
                          buttons keep theirs. The right padding is the lane
                          the mute button sits in, at the corner below. */}
                      <div className="flex w-full items-center gap-1.5 pr-10 sm:w-auto sm:gap-3 sm:pr-0">
                      <button
                        type="button"
                        onClick={() => toggleFavorite(!item.isFavorite)}
                        aria-pressed={item.isFavorite}
                        aria-label={
                          item.isFavorite
                            ? "Remove from favourites"
                            : "Mark as favourite"
                        }
                        title={
                          item.isFavorite ? "Favourited" : "Mark as favourite"
                        }
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/40 backdrop-blur-sm transition-colors hover:border-white disabled:opacity-50 sm:size-10"
                      >
                        <Heart
                          className={cn(
                            "size-4 transition-colors sm:size-5",
                            item.isFavorite && "fill-red-500 text-red-500",
                          )}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleWatched.mutate(!item.watched)}
                        disabled={toggleWatched.isPending}
                        aria-pressed={item.watched}
                        aria-label={
                          item.watched ? "Mark as unwatched" : "Mark as watched"
                        }
                        title={
                          item.watched
                            ? "Watched — click to unmark"
                            : "Mark as watched"
                        }
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/40 backdrop-blur-sm transition-colors hover:border-white disabled:opacity-50 sm:size-10"
                      >
                        {item.watched ? (
                          <Eye className="size-4 text-emerald-400 sm:size-5" />
                        ) : (
                          <EyeOff className="size-4 sm:size-5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => queueCurrent(false)}
                        aria-label="Add to queue"
                        title="Add to queue"
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/40 backdrop-blur-sm transition-colors hover:border-white sm:size-10"
                      >
                        <ListPlus className="size-4 sm:size-5" />
                      </button>
                      {/* Makes this the Hall of fame's headline ("#1 of all time") on the
                          Stats page, in place of the automatic pick. */}
                      <button
                        type="button"
                        onClick={() =>
                          setAppearance({ hallOfFamePin: hallOfFamePin === item.id ? 0 : item.id })
                        }
                        aria-pressed={hallOfFamePin === item.id}
                        aria-label={
                          hallOfFamePin === item.id
                            ? "Unpin from Hall of fame"
                            : "Pin to Hall of fame"
                        }
                        title={
                          hallOfFamePin === item.id
                            ? "Your #1 of all time — click to unpin from Hall of fame"
                            : "Pin to Hall of fame as your #1 of all time"
                        }
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/40 backdrop-blur-sm transition-colors hover:border-white sm:size-10"
                      >
                        <Trophy
                          className={cn(
                            "size-4 transition-colors sm:size-5",
                            hallOfFamePin === item.id && "fill-amber-400 text-amber-400",
                          )}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => queueCurrent(true)}
                        aria-label="Play next"
                        title="Play next"
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/40 backdrop-blur-sm transition-colors hover:border-white sm:size-10"
                      >
                        <ListPlus className="size-4 sm:size-5" />
                      </button>
                      </div>
                    </div>
                  )}
                </div>

                {item?.itemType === "video" && (
                  <button
                    type="button"
                    onClick={toggleMuted}
                    aria-label={muted ? "Unmute" : "Mute"}
                    className="absolute bottom-3 right-3 flex size-8 items-center justify-center rounded-full border border-white/40 bg-black/40 backdrop-blur-sm hover:bg-black/60 sm:bottom-6 sm:right-6 sm:size-10"
                  >
                    {muted ? (
                      <VolumeX className="size-4" />
                    ) : (
                      <Volume2 className="size-4" />
                    )}
                  </button>
                )}
              </>
            )}

            {mode === "preview" && !mini && isMobile && item?.itemType === "video" && (
              <button
                type="button"
                onClick={() => startPlaying(canResume ? item.lastPositionSeconds : 0)}
                aria-label={canResume ? "Resume" : "Play"}
                title={canResume ? "Resume" : "Play"}
                className="absolute inset-0 z-20 flex items-center justify-center"
              >
                <span className="flex size-16 items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/60 backdrop-blur-sm transition-transform active:scale-95">
                  <Play className="size-7 translate-x-0.5 fill-current" />
                </span>
              </button>
            )}

            {/* Sits above the native control bar rather than replacing it —
              the browser's scrubber and fullscreen already work, these are
              only the pieces it doesn't offer. */}
            {mode === "playing" && item?.itemType === "video" && (
              <div
                className={cn(
                  // The wrapper never takes a tap itself, only its buttons
                  // do: wrapped onto two rows on a phone, its box covers the
                  // top half of the frame, and the gaps between buttons are
                  // where the double-tap-to-skip zones have to be reachable.
                  "pointer-events-none absolute left-4 top-4 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-2 transition-opacity duration-300",
                  showPlayerControls
                    ? "opacity-100 [&>*]:pointer-events-auto"
                    : "opacity-0",
                )}
              >
                <button
                  type="button"
                  onClick={() => skip(-SKIP_SECONDS)}
                  aria-label={`Back ${SKIP_SECONDS} seconds`}
                  title={`Back ${SKIP_SECONDS}s (←)`}
                  className="flex size-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm transition-colors hover:bg-black/80"
                >
                  <RotateCcw className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => skip(SKIP_SECONDS)}
                  aria-label={`Forward ${SKIP_SECONDS} seconds`}
                  title={`Forward ${SKIP_SECONDS}s (→)`}
                  className="flex size-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm transition-colors hover:bg-black/80"
                >
                  <RotateCw className="size-4" />
                </button>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowRates((v) => !v)}
                    aria-label="Playback speed"
                    aria-expanded={showRates}
                    title="Playback speed"
                    className="flex h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-medium backdrop-blur-sm transition-colors hover:bg-black/80"
                  >
                    <Gauge className="size-4" />
                    {rate}×
                  </button>
                  {showRates && (
                    <div className="absolute left-0 top-11 z-10 flex flex-col overflow-hidden rounded-md bg-black/90 py-1 backdrop-blur-sm">
                      {PLAYBACK_RATES.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => applyRate(option)}
                          className={cn(
                            "px-4 py-1.5 text-left text-xs transition-colors hover:bg-white/15",
                            option === rate && "font-semibold text-white",
                          )}
                        >
                          {option}×
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={addBookmark}
                  aria-label="Bookmark this moment"
                  title="Bookmark this moment (b)"
                  className="flex size-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm transition-colors hover:bg-black/80"
                >
                  <BookmarkIcon className="size-4" />
                </button>
                {/* Only once the browser has found a device to cast to, so a
                    house with no TV on the network never sees it. */}
                {cast.available && (
                  <button
                    type="button"
                    onClick={startCasting}
                    aria-label={cast.casting ? "Casting — choose a device" : "Cast to a TV"}
                    title={cast.casting ? "Casting" : "Cast to a TV"}
                    className={cn(
                      "flex h-9 items-center gap-1.5 rounded-full px-3 text-xs backdrop-blur-sm transition-colors",
                      cast.casting
                        ? "bg-white text-black hover:bg-white/90"
                        : "bg-black/60 hover:bg-black/80",
                    )}
                  >
                    <Cast className="size-4" />
                    {cast.casting ? "Casting" : "Cast"}
                  </button>
                )}
                {pipSupported && (
                  <button
                    type="button"
                    onClick={() => void togglePictureInPicture()}
                    aria-label="Picture in picture"
                    title="Picture in picture (i)"
                    className="flex size-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm transition-colors hover:bg-black/80"
                  >
                    <PictureInPicture2 className="size-4" />
                  </button>
                )}
                {!mini && !cinema && !discreet && (
                  <button
                    type="button"
                    onClick={toggleAmbient}
                    aria-pressed={ambient}
                    aria-label="Ambient light"
                    title={ambient ? "Turn off ambient light" : "Turn on ambient light"}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-full backdrop-blur-sm transition-colors",
                      ambient ? "bg-white/25 hover:bg-white/35" : "bg-black/60 hover:bg-black/80",
                    )}
                  >
                    <Lightbulb className={cn("size-4", ambient && "fill-current")} />
                  </button>
                )}
                {!mini && (
                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    aria-label="Fullscreen"
                    title="Fullscreen (f)"
                    className="flex size-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm transition-colors hover:bg-black/80"
                  >
                    <Maximize className="size-4" />
                  </button>
                )}
                {mini &&
                  queueItems.some((queueItem) => queueItem.id !== item.id) && (
                    <button
                      type="button"
                      onClick={playNextQueued}
                      aria-label="Play next queued video"
                      title="Play next queued video"
                      className="flex h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs backdrop-blur-sm transition-colors hover:bg-black/80"
                    >
                      Next <ChevronRight className="size-4" />
                    </button>
                  )}
                {!mini && (
                  <button
                    type="button"
                    onClick={() => setCinema((active) => !active)}
                    aria-label={
                      cinema ? "Exit Cinema Mode" : "Enter Cinema Mode"
                    }
                    title={cinema ? "Exit Cinema Mode" : "Cinema Mode (c)"}
                    className="flex h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs backdrop-blur-sm transition-colors hover:bg-black/80"
                  >
                    <MonitorPlay className="size-4" />
                    {cinema ? "Exit" : "Cinema"}
                  </button>
                )}
              </div>
            )}

            {!mini && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className={cn(
                  "absolute top-4 z-40 flex size-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm transition-all hover:bg-black/80",
                  // Steps aside for the queue rather than hiding under it.
                  queueBeside ? "right-[21.25rem]" : "right-4",
                )}
              >
                <X className="size-5" />
              </button>
            )}
            {mini && onExpand && showPlayerControls && (
              <button
                type="button"
                onClick={onExpand}
                aria-label="Expand player"
                title="Expand player"
                className={cn(
                  "absolute top-4 z-40 flex size-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm transition-all hover:bg-black/80",
                  // Steps aside for the queue rather than hiding under it.
                  queueBeside ? "right-[21.25rem]" : "right-4",
                )}
              >
                <Maximize2 className="size-4" />
              </button>
            )}

            {/* Over the video rather than beside it. Taking width from the
                player meant the video either got shorter or grew black bars
                down its sides every time the queue opened; floating it leaves
                the player untouched at every size.

                It covers the right of the frame while open, which is the
                trade — but it is open because you are choosing what is next,
                not because you are watching this one. */}
            {queueBeside && (
              <aside className="absolute inset-y-0 right-0 z-30 w-[min(20rem,85vw)] border-l border-white/10 bg-black/70 backdrop-blur-md">
                <QueuePanel onPlay={openRelated} variant="side" />
              </aside>
            )}
          </div>


          {/* Details */}
          {item && !mini && (
            <div className="grid gap-6 p-4 sm:grid-cols-[1.6fr_1fr] sm:p-6">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>{new Date(item.createdAt).getFullYear()}</span>
                  {item.durationSeconds !== null && (
                    <>
                      <span>·</span>
                      <span>{formatDuration(item.durationSeconds)}</span>
                    </>
                  )}
                  <span>·</span>
                  <StarRating itemId={item.id} rating={item.rating} />
                  {/* Nothing to toggle on a phone — the sheet is read-only
                      there, so the control that turns editing on goes too. */}
                  {!isMobile && (
                    <button
                      type="button"
                      onClick={() => setEditing((e) => !e)}
                      aria-pressed={editing}
                      aria-label={
                        editing ? "Finish editing details" : "Edit details"
                      }
                      title={editing ? "Done editing" : "Edit details"}
                      className={cn(
                        "ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                        editing
                          ? "bg-white text-black hover:bg-white/90"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {editing ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Pencil className="size-3.5" />
                      )}
                      {editing ? "Done" : "Edit"}
                    </button>
                  )}
                </div>

                {editing ? (
                  <>
                    <EditableTitle
                      itemId={item.id}
                      title={item.title}
                      className="cursor-text text-lg font-bold hover:underline"
                    />
                    <DescriptionEditor
                      itemId={item.id}
                      description={item.description}
                    />
                  </>
                ) : (
                  <>
                    <h2 className="text-lg font-bold">{item.title}</h2>
                    {item.description && (
                      <ClampedText
                        text={item.description}
                        className="text-sm leading-relaxed text-muted-foreground"
                      />
                    )}
                  </>
                )}

                <div className="space-y-1.5 pt-1">
                  <FieldLabel accent={accent}>Performers</FieldLabel>
                  <PerformerEditor
                    itemId={item.id}
                    performers={item.performers}
                    source={item.performersSource}
                    readOnly={!editing}
                  />
                </div>

                {item.itemType === "video" && (
                  <div className="space-y-1.5 pt-1">
                    <FieldLabel accent={accent}>
                      Bookmarks{bookmarks.length > 0 && ` · ${bookmarks.length}`}
                    </FieldLabel>
                    <BookmarkList itemId={item.id} bookmarks={bookmarks} onJump={jumpTo} />
                  </div>
                )}

                {item.playbackWarning && (
                  <p className="rounded-md bg-yellow-500/15 px-3 py-2 text-sm text-yellow-500">
                    {item.playbackWarning}
                  </p>
                )}
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <FieldLabel accent={accent}>Category</FieldLabel>
                  {editing ? (
                    <select
                      value={item.kind}
                      onChange={(e) => updateKind.mutate(e.target.value)}
                      disabled={updateKind.isPending}
                      className="w-full rounded-md border border-border bg-secondary/60 px-2 py-1.5 text-sm outline-none focus:border-ring/60 disabled:opacity-50"
                    >
                      {categories.map((category) => (
                        <option key={category.slug} value={category.slug}>
                          {category.label}
                        </option>
                      ))}
                      {/* An item can hold a slug whose category was deleted;
                        without this the select would silently show the first
                        option and misrepresent what's stored. */}
                      {!categories.some((c) => c.slug === item.kind) && (
                        <option value={item.kind}>{item.kind}</option>
                      )}
                    </select>
                  ) : (
                    <span
                      className="text-sm font-medium transition-colors duration-500"
                      style={{ color: accent ?? undefined }}
                    >
                      {categories.find((c) => c.slug === item.kind)?.label ??
                        item.kind}
                    </span>
                  )}
                </div>

                {editing && (
                  <div className="space-y-1.5">
                    <FieldLabel accent={accent}>Thumbnail</FieldLabel>
                    <ThumbnailPicker
                      itemId={item.id}
                      hasCustom={item.thumbnailFile !== null}
                      onUploaded={() => setReframing(true)}
                    />

                    {reframing ? (
                      <FramingEditor
                        src={thumbnailUrl(item)}
                        value={{
                          x: item.thumbnailPositionX,
                          y: item.thumbnailPositionY,
                          scale: item.thumbnailScale,
                        }}
                        aspectClass="aspect-video"
                        // Every shape this one value has to satisfy, rather
                        // than the one tile shape that happens to be selected.
                        // Previewing a single frame was what made the other
                        // shapes unreachable: whichever axis that frame does
                        // not crop cannot be dragged, so the hero's vertical
                        // framing could never be set from either tile.
                        //
                        // Ratios come from cardChrome rather than written out
                        // as classes, so tuning the portrait shape moves these
                        // previews with it.
                        previews={[
                          ...TILE_SHAPES.map((shape) => ({
                            label: shape.label,
                            aspectRatio: cardChrome(density, "none", shape.value)
                              .aspectRatio,
                          })),
                          { label: "Hero", aspectRatio: heroAspect(heroHeight) },
                        ]}
                        saving={saveFraming.isPending}
                        onSave={(next) => saveFraming.mutate(next)}
                        onCancel={() => setReframing(false)}
                        note="Used everywhere this image appears — tile, hover card, search row and the hero banner."
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setReframing(true)}
                        className="flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
                      >
                        <Move className="size-3.5" />
                        Reposition
                      </button>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <FieldLabel accent={accent}>Studio</FieldLabel>
                  <StudioEditor
                    itemId={item.id}
                    studio={item.studio}
                    readOnly={!editing}
                  />
                </div>

                <div className="space-y-1.5">
                  <FieldLabel accent={accent}>Tags</FieldLabel>
                  <TagEditor
                    itemId={item.id}
                    tags={item.tags}
                    readOnly={!editing}
                    accent={accent}
                  />
                </div>

                <div className="space-y-1.5">
                  <FieldLabel accent={accent}>Details</FieldLabel>
                  <TechnicalInfoPanel item={item} />
                </div>

                {editing && (
                  <FolderPicker itemId={item.id} parentId={item.parentId} />
                )}
                {editing && item.itemType === "video" && <SeriesAssignment item={item} />}
              </div>
            </div>
          )}

          {/* Above "More like this": the gallery belongs to this video, while
            related items lead away from it. */}
          {item && !mini && <GalleryStrip itemId={item.id} />}

          {/* Only ever with something in it. An empty queue below the player
              was a heading and a line of instructions taking up the space
              between the video and what is actually under it — the sidebar's
              queue button is where you go looking for an empty one. */}
          {/* Cinema mode has no side column, so a queue with something in it
              falls back to the stack below. Empty, it stays hidden. */}
          {item?.itemType === "video" &&
            !mini &&
            !queueBeside &&
            queueItems.length > 0 && <QueuePanel onPlay={openRelated} />}

          {item && !mini && (
            <RelatedItems itemId={item.id} onSelect={openRelated} />
          )}
        </div>
      </div>
    </Portal>
  );
}
