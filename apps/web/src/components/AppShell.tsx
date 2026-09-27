import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Menu, Search, X } from "lucide-react";
import { SEARCH_SHORTCUT } from "@/lib/appearance";
import { useIsMobile } from "@/lib/useMediaQuery";
import { AppearanceMenu } from "./AppearanceMenu";
import { Screensaver } from "./Screensaver";
import { DiscreetUnlockDialog } from "./DiscreetUnlockDialog";
import { SpotlightSearch, openSpotlight } from "./SpotlightSearch";
import { AppFooter } from "./AppFooter";
import { Sidebar } from "./Sidebar";
import { UserMenu } from "./UserMenu";
import { cn } from "@/lib/utils";
import { MediaDetailModal } from "./MediaDetailModal";
import { NotificationCenter } from "./NotificationCenter";
import { CardShortcutProvider } from "@/lib/cardShortcuts";
import type { PlayItemDetail } from "@/lib/appEvents";
import { useAchievementWatcher } from "@/lib/useAchievementWatcher";

const SIDEBAR_STORAGE_KEY = "sidebar-collapsed";

// localStorage throws outright in some privacy configurations, so every access
// is guarded — an unhandled throw during the initial render would take down
// the whole app rather than just losing a preference.
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function AppShell({
  children,
  title,
  subtitle,
  centeredHeader = false,
  actions,
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  /** For pages whose content is a centred column, so the two agree. */
  centeredHeader?: boolean;
  actions?: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const isMobile = useIsMobile();
  useAchievementWatcher();
  const [drawerRequested, setDrawerRequested] = useState(false);
  // Derived rather than reset by an effect, so growing past `md` with the
  // drawer open can never leave a stale overlay over the desktop layout.
  const drawerOpen = isMobile && drawerRequested;
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [miniPlayer, setMiniPlayer] = useState(false);
  const [resumePlayer, setResumePlayer] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  // Keying the main region on the path re-runs its entry animation on every
  // navigation, so pages fade in rather than snapping into place.
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  useEffect(() => {
    setDrawerRequested(false);
  }, [pathname]);

  // The drawer sits over the page, so the page behind it must not scroll.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
    } catch {
      // Preference just won't persist — not worth surfacing.
    }
  }, [collapsed]);

  useEffect(() => {
    function resumeItem(event: Event) {
      const detail = (
        event as CustomEvent<number | PlayItemDetail>
      ).detail;
      const id = typeof detail === "number" ? detail : detail?.id;
      if (typeof id !== "number") return;
      const wantsDetails = typeof detail !== "number" && detail.details === true;
      setPlayingId(id);
      // The mini player is the answer to "play this", not to "show me this".
      // Opening one in response to a request for details puts the thing you
      // asked to read about into a thumbnail in the corner.
      setMiniPlayer(!wantsDetails);
      setResumePlayer(typeof detail !== "number" && detail.resume === true);
    }
    window.addEventListener("media-server:play-item", resumeItem);
    return () =>
      window.removeEventListener("media-server:play-item", resumeItem);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && focusMode) {
        event.preventDefault();
        setFocusMode(false);
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey)
        return;
      if (event.code !== "KeyF") return;
      event.preventDefault();
      setFocusMode((active) => !active);
    }
    function onToggle() {
      setFocusMode((active) => !active);
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("media-server:toggle-focus", onToggle);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("media-server:toggle-focus", onToggle);
    };
  }, [focusMode]);

  return (
    <div
      className={cn(
        "flex min-h-dvh bg-background text-foreground",
        focusMode && "focus-mode",
      )}
    >
      <Sidebar
        // The drawer is always full width — an icon-only rail you had to open
        // first would be the worst of both.
        collapsed={isMobile ? false : collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobile={isMobile}
        mobileOpen={drawerOpen}
        onMobileClose={() => setDrawerRequested(false)}
      />

      {isMobile && drawerOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setDrawerRequested(false)}
          className="animate-fade-in fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The search field used to hold the centre column; with search on
            ⌘K there's nothing to centre, so the header is just its actions. */}
        <header className="cinema-hide focus-hide sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-border bg-background/85 px-4 py-3 backdrop-blur-md md:justify-end md:gap-4 md:px-6">
          {/* On phones the sidebar is behind a button, so the header carries
              the only way to reach it — and the page title with it. */}
          <div className="flex min-w-0 items-center gap-2 md:hidden">
            <button
              type="button"
              onClick={() => setDrawerRequested(true)}
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Menu className="size-5" />
            </button>
            <span className="truncate text-sm font-semibold tracking-tight">
              {title ?? "Private Server"}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 md:gap-3">
            {actions}
            <NotificationCenter />
            <button
              type="button"
              onClick={openSpotlight}
              aria-label="Search"
              title={`Search (${SEARCH_SHORTCUT})`}
              className="flex size-9 items-center justify-center rounded-full bg-secondary text-muted-foreground ring-1 ring-border transition-colors hover:bg-accent hover:text-foreground"
            >
              <Search className="size-4" />
            </button>
            <UserMenu />
          </div>
        </header>

        {focusMode && (
          <div className="animate-toolbar-in sticky top-0 z-30 flex items-center gap-2 border-b border-border/70 bg-background/90 px-4 py-2 backdrop-blur-md">
            <button
              type="button"
              onClick={() => window.history.back()}
              aria-label="Go back"
              title="Go back"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1 px-2">
              <p className="truncate text-sm font-medium">
                {title ?? "Library"}
              </p>
              {subtitle && (
                <p className="truncate text-[11px] text-muted-foreground">
                  {subtitle}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={openSpotlight}
              aria-label="Search"
              title={`Search (${SEARCH_SHORTCUT})`}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Search className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setFocusMode(false)}
              aria-label="Exit Focus Mode"
              title="Exit Focus Mode (Esc)"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        {(title || subtitle) && (
          // Centred only where the page beneath it is centred too — a heading
          // on a different axis to its own content reads as a mistake.
          <div
            className={cn(
              "px-4 pt-5 md:px-6 md:pt-6",
              // With the h1 hidden on a phone, a page that has only a title
              // would leave this as bare padding — a gap under the header
              // with nothing in it.
              !subtitle && "hidden md:block",
              centeredHeader && "text-center",
            )}
          >
            {title && (
              <h1 className="hidden text-xl font-bold tracking-tight md:block md:text-2xl">
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
        )}

        <main key={pathname} className="min-w-0 flex-1 animate-fade-in">
          {/* Inside the shell so every page gets the card shortcuts, and
              outside any one page so there is a single listener rather than
              one per grid or row. */}
          <CardShortcutProvider>{children}</CardShortcutProvider>
        </main>

        <div className="cinema-hide focus-hide">
          <AppFooter />
        </div>
      </div>

      {playingId !== null && (
        <MediaDetailModal
          itemId={playingId}
          autoPlay={miniPlayer}
          resume={resumePlayer}
          mini={miniPlayer}
          onExpand={() => setMiniPlayer(false)}
          onClose={() => {
            setPlayingId(null);
            setMiniPlayer(false);
            setResumePlayer(false);
          }}
        />
      )}

      {/* Rendered here rather than in the header: it has no trigger any more,
          and it portals itself, so it only needs to exist somewhere that's on
          every page. */}
      <AppearanceMenu />
      <Screensaver />
      <DiscreetUnlockDialog />
      <SpotlightSearch />
    </div>
  );
}
