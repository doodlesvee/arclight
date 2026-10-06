import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { BulkActionBar } from "./BulkActionBar";
import { MediaCard, type MediaCardItem } from "./MediaCard";
import { tileWidthPx, useAppearance } from "@/lib/appearance";
import { useIsMobile } from "@/lib/useMediaQuery";
import { cardLayout, MOBILE_MAX_TILE_PX } from "@/lib/layout";
import { MediaDetailModal } from "./MediaDetailModal";
import { useQueue, type QueueItem } from "@/lib/queue";
import {
  Dices,
  Eye,
  EyeOff,
  FolderOpen,
  GripVertical,
  Heart,
  ListPlus,
  ListStart,
  ListVideo,
  Pencil,
  Play,
  ScanEye,
} from "lucide-react";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { Timeline } from "./Timeline";
import { FilterMenu } from "./FilterBar";
import { recordRecent } from "@/lib/recent";
import { setMediaDragData } from "@/lib/dragMedia";
import { reorderCollectionItems } from "@/lib/mediaItemApi";
import { isTypingTarget, playItem } from "@/lib/appEvents";
import { useCardShortcuts } from "@/lib/cardShortcuts";
import { readPins } from "@/lib/pinned";
import { tileShapeEntries, useTileShape } from "@/lib/tileMenu";
import {
  chunkIntoRows,
  columnsForWidth,
  columnWidthFor,
} from "@/lib/gridLayout";
import {
  EMPTY_FILTERS,
  SORT_OPTIONS,
  filterParams,
  type Filters,
  type SortValue,
} from "@/lib/filters";

export type GridSource =
  | {
      type: "library";
      tag: string | null;
      performer: string | null;
      studio: string | null;
      kind: string | null;
      q: string | null;
      parentId: number | null;
      /** The composable filters (§7). Absent on a collection, which is a
          fixed list rather than a query. */
      filters?: Filters;
    }
  | { type: "collection"; id: number };

type MediaItemsResponse = {
  items: MediaCardItem[];
  page: number;
  pageSize: number;
  hasMore?: boolean;
  /** How many rows match in total. Sent on the first page only. */
  total?: number;
};

async function fetchMediaItems(
  source: GridSource,
  sort: SortValue,
  year: string,
  page: number,
  randomSeed: number,
  month?: number,
): Promise<MediaItemsResponse> {
  if (source.type === "collection") {
    const res = await fetch(`/api/collections/${source.id}/items?page=${page}`);
    if (!res.ok) throw new Error(`Failed to load collection: ${res.status}`);
    return res.json();
  }

  // Seeded from the filters so the composable set and the single-value entry
  // points end up in one query string, with the filters written first and
  // the explicit props able to override them.
  const params = filterParams(source.filters ?? EMPTY_FILTERS);
  if (source.tag) params.set("tag", source.tag);
  if (source.performer) params.set("performer", source.performer);
  if (source.studio) params.set("studio", source.studio);
  if (source.kind) params.set("kind", source.kind);
  if (source.q) params.set("q", source.q);
  if (source.parentId !== null) params.set("parentId", String(source.parentId));
  params.set("sort", sort);
  if (year) params.set("year", year);
  if (month !== undefined) params.set("month", String(month));
  // One seed for the life of the grid, so a shuffled view keeps a single
  // order across its pages instead of reshuffling under the scroll.
  if (sort === "random") params.set("seed", String(randomSeed));
  params.set("page", String(page));

  const res = await fetch(`/api/media-items?${params}`);
  if (!res.ok) throw new Error(`Failed to load media items: ${res.status}`);
  return res.json();
}

/**
 * Last measured column count, per tile width.
 *
 * Module scope on purpose: it has to outlive the component, because the whole
 * point is to be right on the *next* mount. Not persisted — a reload has no
 * scroll position to restore either, so a fresh guess costs nothing.
 */
const columnsByTileWidth = new Map<number, number>();

function rememberColumns(tileWidth: number, columns: number): void {
  columnsByTileWidth.set(tileWidth, columns);
}

function rememberedColumns(tileWidth: number): number {
  return columnsByTileWidth.get(tileWidth) ?? 1;
}

export function MediaGrid({
  source,
  onOpenFolder,
  sort: initialSort = "newest",
  year: initialYear = "",
  month: initialMonth,
  onFiltersChange,
  onViewStateChange,
}: {
  source: GridSource;
  onOpenFolder: (id: number, title: string) => void;
  sort?: SortValue;
  year?: string;
  /** 1-12, set by the timeline. Only meaningful alongside a year. */
  month?: number;
  /**
   * Lets the toolbar offer the filter menu. Omitted by the surfaces that do
   * not own a filter set — a performer's videos, a studio's — where the
   * button would open a panel whose choices had nowhere to be written.
   */
  onFiltersChange?: (next: Filters) => void;
  onViewStateChange?: (state: {
    sort: SortValue;
    year: string;
    month?: number;
  }) => void;
}) {
  const { tileSizePercent, tileInfo, viewMode, tileShape, density } = useAppearance();
  const isMobile = useIsMobile();
  const setTileShape = useTileShape();
  const { add, addNext, clear } = useQueue();
  // Every length the grid needs comes from here, so the mode and density can
  // change the shape of the page without this component knowing what either
  // of them means.
  const layout = cardLayout(
    tileWidthPx(tileSizePercent),
    viewMode,
    density,
    tileInfo,
    tileShape,
  );
  const tileWidth = isMobile
    ? Math.min(layout.widthPx, MOBILE_MAX_TILE_PX)
    : layout.widthPx;
  const [openItemId, setOpenItemId] = useState<number | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // Which card the keyboard is pointing at, hover or focus. Owned by the
  // shortcut layer so a row and a grid agree about it.
  const { engaged, peek, toggleFavourite, toggleWatched } = useCardShortcuts();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Where a Shift-click range starts: the last card clicked without Shift.
  const anchorIndex = useRef<number | null>(null);
  const [sort, setSort] = useState<SortValue>(initialSort);
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);

  /**
   * Follow the period in the URL when it changes underneath us.
   *
   * Without this the grid keeps whatever it was mounted with. That was not
   * hypothetical: the timeline navigated, the page re-rendered without
   * remounting — AppShell keys its main region on the pathname, and only the
   * search string had changed — and the grid went on requesting the old
   * period. The month reached the server without its year, which the server
   * ignores, so picking a month filtered nothing at all.
   */
  useEffect(() => setYear(initialYear), [initialYear]);
  useEffect(() => setMonth(initialMonth), [initialMonth]);
  /**
   * The shuffle's seed.
   *
   * Held rather than re-rolled per request: every page of a random sort has
   * to be drawn from the *same* shuffle, or paging would show one item twice
   * and skip another. Re-rolled only when the user picks Random again, which
   * is what makes choosing it a second time mean "shuffle again" rather than
   * a no-op.
   */
  const [randomSeed, setRandomSeed] = useState(() =>
    Math.floor(Math.random() * 1_000_000),
  );

  const isCollection = source.type === "collection";
  const collectionId = isCollection ? source.id : undefined;
  const queryClient = useQueryClient();
  const reorderFrom = useRef<number | null>(null);
  const reorderIndicator = useRef<HTMLElement | null>(null);

  const {
    data,
    error,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey:
      source.type === "collection"
        ? ["collection-items", source.id]
        : [
            "media-items",
            source.tag,
            source.performer,
            source.studio,
            source.kind,
            source.q,
            source.parentId,
            sort,
            // Must be in the key: without it React Query serves one year's
            // results for another, which reads as the filter doing nothing.
            year,
            // Same reasoning, and the same failure: serialised rather than
            // spread so adding a filter later cannot silently fall out of
            // the key and start serving another filter's results.
            filterParams(source.filters ?? EMPTY_FILTERS).toString(),
            month ?? null,
            sort === "random" ? randomSeed : null,
          ],
    queryFn: ({ pageParam }) =>
      fetchMediaItems(source, sort, year, pageParam, randomSeed, month),
    initialPageParam: 1,
    // The server returns one row past the page size to answer this, so
    // there's no COUNT(*) behind it. Older responses without `hasMore` fall
    // back to a full page meaning "probably more".
    getNextPageParam: (lastPage) => {
      const more =
        lastPage.hasMore ?? lastPage.items.length === lastPage.pageSize;
      return more ? lastPage.page + 1 : undefined;
    },
  });

  const pinnedFolderIds = new Set(
    readPins()
      .filter((pin) => pin.type === "folder")
      .map((pin) => pin.folderId),
  );
  // The first page carries it; later pages leave it undefined rather than
  // recounting, so read it from where it is sent.
  const totalCount = data?.pages[0]?.total;
  const items = (data?.pages.flatMap((p) => p.items) ?? []).sort(
    (a, b) =>
      Number(b.itemType === "folder" && pinnedFolderIds.has(b.id)) -
      Number(a.itemType === "folder" && pinnedFolderIds.has(a.id)),
  );

  // The space under each row is a row's own padding rather than a grid gap:
  // virtualized rows are absolutely positioned, so a grid row-gap would have
  // nothing to apply to.
  const COLUMN_GAP_PX = layout.columnGapPx;
  const ROW_SPACING_PX = layout.rowGapPx;

  const [gridNode, setGridNode] = useState<HTMLDivElement | null>(null);
  // Seeded from the last measurement at this tile width rather than from 1.
  //
  // The grid cannot know its own width until it has mounted, so the first
  // render has to guess. Guessing one column makes the virtualizer claim a
  // page many times its real height, and scroll restoration returning to that
  // render lands somewhere arbitrary. Coming back to a page you have already
  // seen, at a width you have already measured, the guess is simply right.
  const [columns, setColumns] = useState(() => rememberedColumns(tileWidth));
  const [columnWidth, setColumnWidth] = useState(tileWidth);
  // How far the grid sits down the page. The window is the scroller, so the
  // virtualizer has to discount everything above the grid or every row lands
  // one header too high.
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const node = gridNode;
    if (!node) return;

    // Mirrors repeat(auto-fill, minmax(tileWidth, 1fr)) — the CSS the grid
    // used before it was virtualized — so the tile size chosen in Appearance
    // still decides the column count.
    const measure = () => {
      const width = node.clientWidth;
      const next = columnsForWidth(width, tileWidth, COLUMN_GAP_PX);
      rememberColumns(tileWidth, next);
      setColumns(next);
      setColumnWidth(columnWidthFor(width, next, COLUMN_GAP_PX));
      setScrollMargin(node.offsetTop);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // Also watched because the grid's offsetTop moves when something above it
    // appears — the bulk action bar, most visibly — which never changes the
    // grid's own size and so would not trigger the observer above.
    observer.observe(document.body);
    return () => observer.disconnect();
    // gridNode is a dependency, not a ref read, precisely because the grid is
    // not mounted on the first pass — the skeleton is.
  }, [gridNode, tileWidth, COLUMN_GAP_PX]);

  const rows = chunkIntoRows(items, columns);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    // Only the starting guess: measureElement below replaces it with the real
    // height as each row renders, so mixed card heights settle on their own.
    // Taken from the layout rather than hardcoded here, so the card's shape
    // and this scrollbar cannot drift apart.
    estimateSize: () =>
      Math.round(columnWidth * layout.heightRatio) + 72 + ROW_SPACING_PX,
    overscan: 3,
    scrollMargin,
  });
  const virtualRows = virtualizer.getVirtualItems();

  // One roving tab stop: Tab moves into the grid and straight back out, and
  // the arrows move within it. Without this, tabbing through a virtualized
  // grid would walk to the end of the rendered window and then fall out of
  // the grid entirely, with no way to reach the rest of the library.
  const [tabStop, setTabStop] = useState(0);
  const pendingFocus = useRef(false);
  const safeTabStop = Math.min(tabStop, Math.max(0, items.length - 1));

  useEffect(() => {
    if (!pendingFocus.current) return;
    const node = gridNode?.querySelector<HTMLElement>(
      `[data-grid-index="${safeTabStop}"]`,
    );
    // Missing means the row has not been rendered yet; the scroll below will
    // bring it in and this runs again on the next commit.
    if (node) {
      node.focus();
      pendingFocus.current = false;
    }
  }, [gridNode, safeTabStop, virtualRows]);

  function moveFocus(to: number) {
    const next = Math.max(0, Math.min(items.length - 1, to));
    if (next === safeTabStop) return;
    setTabStop(next);
    pendingFocus.current = true;
    virtualizer.scrollToIndex(Math.floor(next / columns), { align: "auto" });
  }

  function handleGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // Escape leaves selection before it closes anything else, so the way out
    // of a selection you opened by accident is the key you already reach for.
    if (event.key === "Escape" && selectionMode) {
      event.preventDefault();
      exitSelectionMode();
      return;
    }
    // Ctrl/Cmd-A inside the grid means the grid's items, not the page's text.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
      return;
    }

    const moves: Record<string, number> = {
      ArrowRight: safeTabStop + 1,
      ArrowLeft: safeTabStop - 1,
      ArrowDown: safeTabStop + columns,
      ArrowUp: safeTabStop - columns,
      Home: 0,
      End: items.length - 1,
      // J/K walk the list linearly rather than by row, which is what they
      // mean everywhere else they appear — the arrows already do geometry.
      j: safeTabStop + 1,
      k: safeTabStop - 1,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      moveFocus(next);
    }
    // Everything else is handled by the window listener below, which also
    // accepts a hovered card as its target.
  }

  /**
   * The grid-only shortcuts.
   *
   * The card actions — Space, P, F, W, E, Q — live in CardShortcutProvider,
   * because they act on a card and cards are rendered by rows and pickers
   * too. These two are different: R needs the list the grid is showing, and
   * C opens a menu whose entries are grid-specific (open folder, play from
   * here). Both read the engaged card from the shortcut layer so they aim at
   * the same place the rest do.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (!engaged) return;

      const index = items.findIndex((entry) => entry.id === engaged.id);
      const item = items[index];
      if (!item) return;

      if (event.key === "c") {
        event.preventDefault();
        openContextMenuAtCard(item, index);
      } else if (event.key === "r") {
        event.preventDefault();
        const playable = items.filter((entry) => entry.itemType !== "folder");
        const pick = playable[Math.floor(Math.random() * playable.length)];
        if (pick) setOpenItemId(pick.id);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /**
   * The keyboard's way into the context menu.
   *
   * A key press has no cursor to anchor to, so the menu is placed against the
   * focused card's own box — which is where a mouse user would have had to be
   * standing to open it anyway.
   */
  function openContextMenuAtCard(item: MediaCardItem, index: number) {
    const node = gridNode?.querySelector<HTMLElement>(
      `[data-grid-index="${index}"]`,
    );
    const rect = node?.getBoundingClientRect();
    openContextMenu(
      {
        preventDefault: () => {},
        clientX: rect ? rect.left + 16 : 0,
        clientY: rect ? rect.top + 16 : 0,
      } as React.MouseEvent,
      item,
      index,
    );
  }

  // Keeps the tab stop on whatever was last focused, so clicking one card and
  // then using the arrows continues from there rather than jumping to the top.
  function handleGridFocus(event: React.FocusEvent<HTMLDivElement>) {
    const card = (event.target as HTMLElement).closest?.("[data-grid-index]");
    const index = Number(card?.getAttribute("data-grid-index"));
    if (!Number.isNaN(index)) setTabStop(index);
  }

  // Neither call site owns a scroll container — the page itself scrolls — so
  // the observer's default viewport root is the right one and needs no ref
  // plumbing from the parent.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage)
          void fetchNextPage();
      },
      // Start the next page slightly before the sentinel is actually on
      // screen, so scrolling doesn't visibly stall at the boundary.
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
    anchorIndex.current = null;
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectRange(from: number, to: number) {
    const [start, end] = from <= to ? [from, to] : [to, from];
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (let i = start; i <= end; i += 1) {
        const item = items[i];
        if (item) next.add(item.id);
      }
      return next;
    });
  }

  function selectAll() {
    setSelectionMode(true);
    setSelectedIds(new Set(items.map((item) => item.id)));
  }

  /**
   * One click handler for three jobs, decided by the modifier keys (§13).
   *
   * Ctrl/Cmd-click and Shift-click both *enter* selection mode rather than
   * requiring the Select button first: reaching for a modifier is already an
   * unambiguous statement that you mean to select, and making it a no-op
   * until a mode is armed is the thing that makes bulk editing feel like a
   * separate application.
   *
   * `anchorIndex` is the last item touched without Shift, which is what a
   * range extends from. Held in a ref because a range drawn across two
   * renders must not depend on one having happened in between.
   */
  function handleCardClick(
    item: MediaCardItem,
    index: number,
    event: React.MouseEvent | React.KeyboardEvent,
  ) {
    const additive = event.ctrlKey || event.metaKey;
    const ranged = event.shiftKey;

    if (ranged && anchorIndex.current !== null) {
      setSelectionMode(true);
      selectRange(anchorIndex.current, index);
      return;
    }
    if (additive || selectionMode) {
      setSelectionMode(true);
      toggleSelected(item.id);
      anchorIndex.current = index;
      return;
    }

    anchorIndex.current = index;
    if (item.itemType === "folder") {
      onOpenFolder(item.id, item.title);
    } else {
      recordRecent("browsed", item);
      setOpenItemId(item.id);
    }
  }

  /**
   * Begins a drag of one card, or of the whole selection if it is in it.
   *
   * Dragging a selected card carries every selected item, which is what
   * makes bulk drag-and-drop work without a separate gesture. Dragging an
   * *unselected* card carries only that card, and deliberately does not
   * clear the selection — a drag is not a click, and losing a carefully
   * built selection to a stray drag would be worse than the feature is
   * worth.
   */
  function startDrag(event: React.DragEvent, item: MediaCardItem) {
    const dragging =
      selectedIds.has(item.id) && selectedIds.size > 0
        ? [...selectedIds]
        : [item.id];
    setMediaDragData(event.dataTransfer, {
      ids: dragging,
      label: dragging.length === 1 ? item.title : `${dragging.length} items`,
    });
  }

  function startReorderDrag(event: React.DragEvent, item: MediaCardItem) {
    reorderFrom.current = item.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/x-reorder", String(item.id));
  }

  function handleReorderOver(event: React.DragEvent) {
    if (!isCollection || reorderFrom.current === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = (event.currentTarget as HTMLElement);
    if (reorderIndicator.current && reorderIndicator.current !== target) {
      reorderIndicator.current.style.outline = "";
    }
    target.style.outline = "2px solid var(--color-primary, #3b82f6)";
    reorderIndicator.current = target;
  }

  function handleReorderLeave(event: React.DragEvent) {
    const target = event.currentTarget as HTMLElement;
    if (!event.relatedTarget || !target.contains(event.relatedTarget as Node)) {
      target.style.outline = "";
      if (reorderIndicator.current === target) reorderIndicator.current = null;
    }
  }

  function handleReorderDrop(event: React.DragEvent, targetItem: MediaCardItem) {
    event.preventDefault();
    if (reorderIndicator.current) {
      reorderIndicator.current.style.outline = "";
      reorderIndicator.current = null;
    }
    const fromId = reorderFrom.current;
    reorderFrom.current = null;
    if (!fromId || fromId === targetItem.id || !collectionId) return;

    const fromIndex = items.findIndex((i) => i.id === fromId);
    const toIndex = items.findIndex((i) => i.id === targetItem.id);
    if (fromIndex === -1 || toIndex === -1) return;

    const newItems = [...items];
    const [moved] = newItems.splice(fromIndex, 1);
    newItems.splice(toIndex, 0, moved);
    const orderedIds = newItems.map((i) => i.id);

    queryClient.setQueryData(
      ["collection-items", collectionId],
      (old: { pages: { items: MediaCardItem[]; page: number; pageSize: number; hasMore: boolean }[]; pageParams: number[] } | undefined) => {
        if (!old) return old;
        return { ...old, pages: [{ ...old.pages[0], items: newItems }] };
      },
    );

    void reorderCollectionItems(collectionId, orderedIds);
  }

  function handleReorderEnd() {
    reorderFrom.current = null;
    if (reorderIndicator.current) {
      reorderIndicator.current.style.outline = "";
      reorderIndicator.current = null;
    }
  }

  function queueItemFor(item: MediaCardItem): QueueItem {
    return {
      id: item.id,
      title: item.title,
      thumbnailFile: item.thumbnailFile,
      durationSeconds: item.durationSeconds,
    };
  }

  /**
   * The right-click menu for one card (§13).
   *
   * Built per item rather than once, because which entries make sense depends
   * on what the card is: a folder has nothing to play or queue, and a photo
   * has no watch state to toggle. Offering them greyed out would be a longer
   * menu that says less.
   *
   * Nothing here deletes or moves an original — the menu tops out at metadata
   * and navigation, per §29.
   */
  function openContextMenu(
    event: React.MouseEvent,
    item: MediaCardItem,
    index: number,
  ) {
    event.preventDefault();
    anchorIndex.current = index;

    const isVideo = item.itemType === "video";
    const isFolder = item.itemType === "folder";

    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        ...(isFolder
          ? [
              {
                label: "Open folder",
                icon: FolderOpen,
                onSelect: () => onOpenFolder(item.id, item.title),
              },
            ]
          : []),
        ...(isVideo
          ? [
              {
                label: "Play",
                icon: Play,
                onSelect: () => {
                  recordRecent("played", item);
                  playItem(item.id);
                },
              },
              ...(item.lastPositionSeconds
                ? [
                    {
                      label: "Resume",
                      icon: Play,
                      onSelect: () => {
                        recordRecent("played", item);
                        playItem(item.id, { resume: true });
                      },
                    },
                  ]
                : []),
            ]
          : []),
        ...(isFolder
          ? []
          : [
              {
                label: "Peek",
                icon: ScanEye,
                onSelect: () => peek(item),
              },
            ]),
        ...(isVideo
          ? [
              { separator: true as const },
              {
                label: "Add to queue",
                icon: ListPlus,
                onSelect: () => add(queueItemFor(item)),
              },
              {
                label: "Play next",
                icon: ListVideo,
                onSelect: () => addNext(queueItemFor(item)),
              },
              {
                label: "Play from here",
                icon: ListStart,
                onSelect: () => void playFromHere(item.id),
              },
            ]
          : []),
        { separator: true as const },
        // Shared with every other surface that draws tiles, so the same tile
        // offers the same shape entries wherever it is right-clicked.
        ...tileShapeEntries(item, tileShape, setTileShape),
        ...(isFolder
          ? []
          : [
              { separator: true as const },
              {
                label: "Favourite",
                icon: Heart,
                onSelect: () => toggleFavourite(item),
              },
              ...(isVideo
                ? [
                    {
                      label: "Toggle watched",
                      icon: item.lastPositionSeconds ? Eye : EyeOff,
                      onSelect: () => toggleWatched(item),
                    },
                  ]
                : []),
              {
                label: "Edit details",
                icon: Pencil,
                onSelect: () => setOpenItemId(item.id),
              },
            ]),
      ],
    });
  }

  async function fetchAllQueueItems(): Promise<QueueItem[]> {
    const all: QueueItem[] = [];
    let page = 1;
    while (true) {
      const response = await fetchMediaItems(
        source,
        sort,
        year,
        page,
        randomSeed,
        month,
      );
      all.push(
        ...response.items
          .filter((item) => item.itemType === "video")
          .map((item) => ({
            id: item.id,
            title: item.title,
            thumbnailFile: item.thumbnailFile,
            durationSeconds: item.durationSeconds,
          })),
      );
      const hasMore =
        response.hasMore ?? response.items.length === response.pageSize;
      if (!hasMore) return all;
      page += 1;
    }
  }

  async function queueResults(shuffle: boolean) {
    const queueItems = await fetchAllQueueItems();
    if (queueItems.length === 0) return;
    if (shuffle) {
      for (let i = queueItems.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [queueItems[i], queueItems[j]] = [queueItems[j], queueItems[i]];
      }
    }
    clear();
    queueItems.slice(1).forEach(add);
    setOpenItemId(queueItems[0].id);
  }

  /**
   * Play All, but starting at the item you clicked (§10).
   *
   * The distinction from Play All matters on a sorted view: an album or a
   * series in order is exactly the case where you want the rest of the list
   * to follow on from where you are, rather than restarting it from the top
   * or queueing only the one item.
   *
   * It queues every *later* item and none of the earlier ones, which is what
   * "from here" means — wrapping around to the beginning would be Play All
   * with a different starting point, a different feature.
   */
  async function playFromHere(startId: number) {
    const queueItems = await fetchAllQueueItems();
    const start = queueItems.findIndex((entry) => entry.id === startId);
    // Not in the playable list at all — a photo, or a folder. Opening it is
    // still the right response to the click.
    if (start === -1) {
      setOpenItemId(startId);
      return;
    }
    clear();
    queueItems.slice(start + 1).forEach(add);
    setOpenItemId(startId);
  }

  if (isLoading) {
    return (
      // No `stagger` here: it sets the same `animation` property the
      // skeletons need for their shimmer, and the two would fight.
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${tileWidth}px), 1fr))`,
          columnGap: COLUMN_GAP_PX,
          rowGap: ROW_SPACING_PX,
        }}
      >
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="skeleton rounded-md"
            style={{ aspectRatio: layout.aspectRatio }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-destructive">Could not load this view.</p>;
  }

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground">
        {source.type === "collection"
          ? "This collection is empty."
          : "Nothing here yet."}
      </p>
    );
  }

  return (
    <>
      <div
        // Not justified apart on a phone: the right-hand group wrapped as one
        // block, which left "Select" stranded alone on the line above it.
        // Below `md` the group dissolves into this row so everything wraps
        // together as a single run of controls.
        className="flex flex-wrap items-center gap-x-3 gap-y-2 md:justify-between"
      >
        <button
          type="button"
          onClick={() =>
            selectionMode ? exitSelectionMode() : setSelectionMode(true)
          }
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {selectionMode ? "Done selecting" : "Select"}
        </button>

        {/* A collection has its own order; offering to re-sort it would
            imply the choice sticks, which it wouldn't. */}
        <div className="contents md:flex md:flex-wrap md:items-center md:gap-x-3 md:gap-y-2">
          <button
            type="button"
            onClick={() => void queueResults(false)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ListPlus className="size-3.5" /> Play all
          </button>
          <button
            type="button"
            onClick={() => void queueResults(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Dices className="size-3.5" /> Shuffle
          </button>
          {/* Counted by the server on the first page, so it is the size of
              the whole filtered set rather than however much has been scrolled
              into view. Absent inside a collection, which the endpoint does
              not count. */}
          {totalCount !== undefined && (
            <span className="text-xs text-muted-foreground tabular-nums md:mr-auto">
              {totalCount} {totalCount === 1 ? "item" : "items"}
            </span>
          )}

          {source.type === "library" && (
            <>
              {onFiltersChange && (
                <FilterMenu
                  filters={source.filters ?? EMPTY_FILTERS}
                  onChange={onFiltersChange}
                />
              )}

              {/* The period control, and the only one. A plain Year select
                  used to sit here as well as the timeline on the browse page
                  — two controls for one filter, in two places, disagreeing
                  about whether months exist. The timeline is the superset, so
                  it took the slot. */}
              <Timeline
                year={year === "" ? undefined : Number(year)}
                month={month}
                onSelect={(period) => {
                  const nextYear =
                    period.year === undefined ? "" : String(period.year);
                  setYear(nextYear);
                  setMonth(period.month);
                  onViewStateChange?.({
                    sort,
                    year: nextYear,
                    month: period.month,
                  });
                }}
              />

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Sort</span>
                <select
                  value={sort}
                  onChange={(e) => {
                    const next = e.target.value as SortValue;
                    // Picking Random again reshuffles. Without this it is the
                    // one option in the list that does nothing when chosen a
                    // second time.
                    if (next === "random")
                      setRandomSeed(Math.floor(Math.random() * 1_000_000));
                    setSort(next);
                    onViewStateChange?.({ sort: next, year, month });
                  }}
                  className="cursor-pointer rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-foreground/30"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
      </div>

      {selectionMode && selectedIds.size > 0 && (
        <BulkActionBar
          selectedIds={[...selectedIds]}
          onDone={exitSelectionMode}
          onSelectAll={selectAll}
          totalCount={items.length}
          collectionId={source.type === "collection" ? source.id : undefined}
        />
      )}

      {/* Only the rows near the viewport exist in the DOM. A library of
          thousands used to build up that many card nodes as you scrolled and
          never gave any of them back.

          No `stagger` here, unlike the skeletons: rows mount as they are
          scrolled to, so an entry animation would re-run down the whole grid
          instead of playing once. */}
      <div
        ref={setGridNode}
        onKeyDown={handleGridKeyDown}
        onFocusCapture={handleGridFocus}
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 grid w-full"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                columnGap: COLUMN_GAP_PX,
                paddingBottom: ROW_SPACING_PX,
                transform: `translateY(${
                  virtualRow.start - virtualizer.options.scrollMargin
                }px)`,
              }}
            >
              {row.map((item, column) => {
                const index = virtualRow.index * columns + column;
                const card = (
                  <MediaCard
                    item={item}
                    gridIndex={index}
                    tabIndex={index === safeTabStop ? 0 : -1}
                    onClick={(event) => handleCardClick(item, index, event)}
                    onContextMenu={(event) =>
                      openContextMenu(event, item, index)
                    }
                    onDragStart={isCollection
                      ? (event) => startReorderDrag(event, item)
                      : (event) => startDrag(event, item)}
                    selectable={selectionMode}
                    selected={selectedIds.has(item.id)}
                  />
                );
                if (isCollection) {
                  return (
                    <div
                      key={item.id}
                      className="relative rounded-md transition-shadow"
                      onDragOver={handleReorderOver}
                      onDragLeave={handleReorderLeave}
                      onDrop={(e) => handleReorderDrop(e, item)}
                      onDragEnd={handleReorderEnd}
                    >
                      <div className="absolute -left-1 top-1 z-10 flex cursor-grab items-center rounded bg-black/50 p-0.5 text-white opacity-0 backdrop-blur-sm transition-opacity hover:opacity-100 group-hover:opacity-100 [div:hover>&]:opacity-100">
                        <GripVertical className="size-3.5" />
                      </div>
                      {card}
                    </div>
                  );
                }
                return <React.Fragment key={item.id}>{card}</React.Fragment>;
              })}
            </div>
          );
        })}
      </div>

      <div ref={sentinelRef} aria-hidden className="h-px" />

      {isFetchingNextPage && (
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${tileWidth}px), 1fr))`,
            columnGap: COLUMN_GAP_PX,
            rowGap: ROW_SPACING_PX,
          }}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="skeleton rounded-md"
              style={{ aspectRatio: layout.aspectRatio }}
            />
          ))}
        </div>
      )}

      <ContextMenu state={menu} onClose={() => setMenu(null)} />

      {openItemId !== null && (
        <MediaDetailModal
          itemId={openItemId}
          onClose={() => setOpenItemId(null)}
        />
      )}
    </>
  );
}
