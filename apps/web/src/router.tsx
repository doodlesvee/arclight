import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { AccountPage } from "@/pages/AccountPage";
import { AlbumPage } from "@/pages/AlbumPage";
import { AlbumsPage } from "@/pages/AlbumsPage";
import { BrowsePage } from "@/pages/BrowsePage";
import { HelpPage } from "@/pages/HelpPage";
import { HomePage } from "@/pages/HomePage";
import { MissingPage } from "@/pages/MissingPage";
import { PerformerPage } from "@/pages/PerformerPage";
import { PerformersPage } from "@/pages/PerformersPage";
import { StudioPage } from "@/pages/StudioPage";
import { StudiosPage } from "@/pages/StudiosPage";
import { StatsPage } from "@/pages/StatsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SeriesPage } from "@/pages/SeriesPage";
import { SeriesPageIndex } from "@/pages/SeriesPageIndex";
import type { NetworkView } from "@/lib/performerApi";

const rootRoute = createRootRoute();

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/browse",
  /**
   * Everything that makes this view what it is lives in the URL.
   *
   * The composable filters (§7) join the sort and the folder here rather
   * than living in component state, so a filtered view survives a reload,
   * pastes as a link, and gets its own remembered scroll position — the
   * router keys those on the full href.
   *
   * `tag`, `performer` and `studio` are the single-value entry points other
   * pages already link to (a tag chip, a performer page). They stay as they
   * are; `tags` and `performers` are the multi-value filters the filter bar
   * writes. Keeping both means no existing link has to be rewritten.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tag?: string;
    performer?: string;
    studio?: string;
    kind?: string;
    collectionId?: number;
    parentId?: number;
    sort?: string;
    year?: number;
    q?: string;
    tags?: string;
    performers?: string;
    watched?: string;
    favorite?: string;
    minDuration?: number;
    maxDuration?: number;
    resolution?: string;
    format?: string;
    addedWithin?: number;
    minRating?: number;
    month?: number;
  } => ({
    tag: typeof search.tag === "string" ? search.tag : undefined,
    performer:
      typeof search.performer === "string" ? search.performer : undefined,
    studio: typeof search.studio === "string" ? search.studio : undefined,
    kind: typeof search.kind === "string" ? search.kind : undefined,
    collectionId:
      search.collectionId != null ? Number(search.collectionId) : undefined,
    parentId: search.parentId != null ? Number(search.parentId) : undefined,
    sort: typeof search.sort === "string" ? search.sort : undefined,
    year: search.year != null ? Number(search.year) : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
    tags: typeof search.tags === "string" ? search.tags : undefined,
    performers:
      typeof search.performers === "string" ? search.performers : undefined,
    watched: typeof search.watched === "string" ? search.watched : undefined,
    favorite: typeof search.favorite === "string" ? search.favorite : undefined,
    minDuration:
      search.minDuration != null ? Number(search.minDuration) : undefined,
    maxDuration:
      search.maxDuration != null ? Number(search.maxDuration) : undefined,
    resolution:
      typeof search.resolution === "string" ? search.resolution : undefined,
    format: typeof search.format === "string" ? search.format : undefined,
    addedWithin:
      search.addedWithin != null ? Number(search.addedWithin) : undefined,
    minRating:
      search.minRating != null ? Number(search.minRating) : undefined,
    month: search.month != null ? Number(search.month) : undefined,
  }),
  component: BrowsePage,
});

const performerRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Keyed by id rather than name so renaming a performer doesn't break links.
  path: "/performer/$performerId",
  component: PerformerPage,
});

const performersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/performers",
  // In the URL rather than state, so the network view survives a reload and
  // the back button returns to it from a profile opened there.
  validateSearch: (search: Record<string, unknown>): { view?: "network" } & NetworkView => {
    const int = (value: unknown) =>
      value != null && Number.isInteger(Number(value)) ? Number(value) : undefined;
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    return {
      view: search.view === "network" ? "network" : undefined,
      // What the network links performers by; absent means shared videos.
      // Studios is the default, so only "videos" needs saying.
      by: search.by === "videos" ? "videos" : undefined,
      focus: int(search.focus),
      depth: int(search.depth) === 2 ? 2 : undefined,
      hidden: text(search.hidden),
      studios: int(search.studios) === 1 ? 1 : undefined,
      path: text(search.path),
    };
  },
  component: PerformersPage,
});

const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: StatsPage,
});

const albumsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/albums",
  component: AlbumsPage,
});

const seriesIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/series",
  component: SeriesPageIndex,
});

const seriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/series/$seriesId",
  component: SeriesPage,
});

const albumRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Keyed by id, like performers: an album's title comes from its folder
  // name, so renaming the folder would otherwise break every link to it.
  path: "/album/$albumId",
  component: AlbumPage,
});

const studiosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studios",
  component: StudiosPage,
});

const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Keyed by id, like performers and albums: a studio's name is derived from
  // filenames, so a rename would otherwise break every link to it.
  path: "/studio/$studioId",
  component: StudioPage,
});

const missingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/missing",
  component: MissingPage,
});

const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/help",
  component: HelpPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  // In the URL rather than component state: settings pages are where you
  // reload after changing something, and coming back to the first tab every
  // time would undo the point of splitting them up.
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  component: SettingsPage,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountPage,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  browseRoute,
  performerRoute,
  performersRoute,
  statsRoute,
  albumsRoute,
  seriesIndexRoute,
  seriesRoute,
  albumRoute,
  studiosRoute,
  studioRoute,
  missingRoute,
  helpRoute,
  settingsRoute,
  accountRoute,
]);

export const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteErrorFallback,
  /**
   * Coming back to a grid returns you to where you were, rather than the top.
   *
   * The window is the scroller — no page owns a scroll container — so the
   * router's own restoration is enough and there is nothing to plumb through
   * AppShell.
   *
   * Keyed on the full href, including the search string, on purpose: the
   * browse page keeps its filters and sort there, so each filtered view
   * remembers its own position instead of every view sharing one. Changing a
   * filter is a different list and correctly starts at the top.
   */
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
