import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  Bookmark,
  Clapperboard,
  FolderOpen,
  Globe2,
  Home,
  Inbox,
  Lock,
  Images,
  Layers,
  CheckCircle2,
  TriangleAlert,
  Pin,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Tv,
  Tag,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CreateCollectionModal } from "./CreateCollectionModal";
import {
  isPinned,
  pinsChangedEvent,
  readPins,
  removePin,
  togglePin,
  type Pin as PinnedItem,
} from "@/lib/pinned";
import { useLibraryStats } from "@/lib/statsApi";
import {
  isMediaDrag,
  readMediaDragData,
  type MediaDragPayload,
} from "@/lib/dragMedia";
import {
  addItemsToCollection,
  removeItemsFromCollection,
} from "@/lib/bulkActions";
import { useUndoable } from "@/lib/undo";
import {
  readSavedSearches,
  removeSavedSearch,
  savedSearchesChangedEvent,
} from "@/lib/savedSearches";

type Collection = { id: number; name: string; type: "manual" | "smart" };
type TagRow = { id: number; name: string };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
      {children}
    </div>
  );
}

function InboxLink({
  collapsed,
  navItemClass,
}: {
  collapsed: boolean;
  navItemClass: string;
}) {
  const { data } = useQuery({
    queryKey: ["inbox-count"],
    queryFn: async () => {
      const res = await fetch("/api/inbox/count");
      if (!res.ok) return { count: 0 };
      return res.json() as Promise<{ count: number }>;
    },
    refetchInterval: 60_000,
  });
  const count = data?.count ?? 0;

  return (
    <Link
      to="/inbox"
      className={navItemClass}
      title={collapsed ? "Inbox" : undefined}
      activeProps={{ className: "bg-accent text-foreground font-medium" }}
    >
      <Inbox className="size-4 shrink-0" />
      {!collapsed && "Inbox"}
      {count > 0 && (
        <span className={cn(
          "ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground",
          collapsed && "absolute right-1 top-0.5",
        )}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  mobile = false,
  mobileOpen = false,
  onMobileClose,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Phone width: the sidebar is an off-canvas drawer, not a column. */
  mobile?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [pins, setPins] = useState<PinnedItem[]>(readPins);
  const [saved, setSaved] = useState(readSavedSearches);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const runUndoable = useUndoable();
  const queryClient = useQueryClient();

  useEffect(() => {
    // "storage" covers another tab; the custom events cover this one, which
    // does not fire "storage" for its own writes.
    const refresh = () => {
      setPins(readPins());
      setSaved(readSavedSearches());
    };
    window.addEventListener(pinsChangedEvent(), refresh);
    window.addEventListener(savedSearchesChangedEvent(), refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(pinsChangedEvent(), refresh);
      window.removeEventListener(savedSearchesChangedEvent(), refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const { data: collections } = useQuery({
    queryKey: ["collections"],
    queryFn: () => fetchJson<{ collections: Collection[] }>("/api/collections"),
  });
  const { data: tagData } = useQuery({
    queryKey: ["tags"],
    queryFn: () => fetchJson<{ tags: TagRow[] }>("/api/tags"),
  });
  const { data: health } = useLibraryStats();
  const healthIssues = health
    ? health.videoMissing + health.videoDuplicateGroups
    : 0;
  // Names the actual fault where there is one kind of it, so the row says
  // what to expect on the other side of the click.
  const healthLabel = !health
    ? "Library health"
    : health.videoMissing > 0 && health.videoDuplicateGroups > 0
      ? `${healthIssues} library issues`
      : health.videoMissing > 0
        ? `${health.videoMissing} missing`
        : health.videoDuplicateGroups > 0
          ? `${health.videoDuplicateGroups} duplicate${health.videoDuplicateGroups === 1 ? "" : "s"}`
          : "Library healthy";

  /**
   * Adds dropped items to a collection (§13).
   *
   * Reuses the same bulk helper the action bar uses rather than a second
   * path, so a drop and a menu choice cannot end up behaving differently.
   * The toast carries an undo: a drop is the easiest gesture in the app to
   * make by accident.
   */
  async function dropOnCollection(
    payload: MediaDragPayload,
    collection: Collection,
  ) {
    await runUndoable({
      message: `Added to ${collection.name}`,
      description:
        payload.ids.length === 1 ? payload.label : `${payload.ids.length} items`,
      apply: () => addItemsToCollection(payload.ids, collection.id, () => {}),
      revert: async () => {
        await removeItemsFromCollection(payload.ids, collection.id, () => {});
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: ["collection-items"] });
        queryClient.invalidateQueries({ queryKey: ["media-items"] });
      },
    });
  }

  const deleteCollection = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/collections/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete collection");
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["collections"] }),
  });

  // Collapsed, every row becomes a centred icon with no room for a label.
  const navItemClass = cn(
    "flex items-center rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
    // Roomier rows on touch, where the pointer is a fingertip.
    mobile ? "py-2.5" : "py-2",
    collapsed ? "justify-center px-0" : "gap-2.5 px-3",
  );

  return (
    <aside
      // A drawer on phones: taken out of the flow entirely so the content
      // gets the whole viewport, and slid off-screen rather than unmounted so
      // it animates and keeps its scroll position.
      aria-hidden={mobile && !mobileOpen}
      className={cn(
        "cinema-hide focus-hide flex flex-col border-r border-border",
        // Translucent works beside the page; over it, the content behind
        // shows straight through the nav.
        mobile ? "bg-card" : "bg-card/40",
        mobile
          ? cn(
              "fixed inset-y-0 left-0 z-50 h-dvh w-72 max-w-[85vw] shadow-2xl transition-transform duration-200 ease-out",
              mobileOpen ? "translate-x-0" : "-translate-x-full",
            )
          : cn(
              "sticky top-0 h-screen shrink-0 transition-[width] duration-200 ease-out",
              collapsed ? "w-16" : "w-60",
            ),
      )}
    >
      <div
        className={cn(
          "flex py-5",
          collapsed ? "flex-col items-center gap-3" : "items-center gap-2 px-5",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            !collapsed && "flex-1",
          )}
        >
          <Clapperboard className="size-5 shrink-0" />
          {!collapsed && (
            <span className="truncate text-base font-bold tracking-tight">
              Arc Light
            </span>
          )}
        </div>
        {mobile ? (
          // Collapsing to an icon rail makes no sense in a drawer you dismiss.
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close menu"
            title="Close menu"
            className="-mr-1 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        )}
      </div>

      <nav
        className="flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
        // Following a link should dismiss the drawer, including a link back to
        // the page you are already on, which no route change would catch.
        onClick={
          mobile
            ? (event) => {
                if ((event.target as HTMLElement).closest("a")) onMobileClose?.();
              }
            : undefined
        }
      >
        <Link
          to="/"
          className={navItemClass}
          title={collapsed ? "Home" : undefined}
          activeOptions={{ exact: true }}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <Home className="size-4 shrink-0" />
          {!collapsed && "Home"}
        </Link>
        <Link
          to="/browse"
          className={navItemClass}
          title={collapsed ? "Browse" : undefined}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <FolderOpen className="size-4 shrink-0" />
          {!collapsed && "Browse"}
        </Link>
        <Link
          to="/performers"
          className={navItemClass}
          title={collapsed ? "Performers" : undefined}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <Users className="size-4 shrink-0" />
          {!collapsed && "Performers"}
        </Link>
        <Link
          to="/map"
          className={navItemClass}
          title={collapsed ? "Library Map" : undefined}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <Globe2 className="size-4 shrink-0" />
          {!collapsed && "Library Map"}
        </Link>
        <Link
          to="/albums"
          className={navItemClass}
          title={collapsed ? "Albums" : undefined}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <Images className="size-4 shrink-0" />
          {!collapsed && "Albums"}
        </Link>
        <Link
          to="/series"
          className={navItemClass}
          title={collapsed ? "Series" : undefined}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <Tv className="size-4 shrink-0" />
          {!collapsed && "Series"}
        </Link>
        <InboxLink collapsed={collapsed} navItemClass={navItemClass} />
        <Link
          to="/vault"
          className={navItemClass}
          title={collapsed ? "Vault" : undefined}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <Lock className="size-4 shrink-0" />
          {!collapsed && "Vault"}
        </Link>


        {/* Collections and tags are text-only — collapsed they'd be a column of
            identical, unreadable icons, so the lists hide entirely. The create
            action stays, since it's the one thing that isn't recoverable by
            just expanding again. */}
        {collapsed ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            aria-label="New collection"
            title="New collection"
            className={cn(navItemClass, "mt-4 w-full")}
          >
            <Plus className="size-4 shrink-0" />
          </button>
        ) : (
          <>
            <div className="flex items-center justify-between pr-2">
              <SectionLabel>Collections</SectionLabel>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                aria-label="New collection"
                className="mt-3 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            {collections?.collections.length === 0 && (
              <p className="px-3 text-xs text-muted-foreground/60">None yet</p>
            )}
            {collections?.collections.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "group flex items-center rounded-md",
                  // Only a manual collection is a drop target. A smart one is
                  // a saved query — adding an item to it by hand would either
                  // do nothing or quietly contradict its rule.
                  dropTarget === c.id && "ring-1 ring-foreground/40",
                )}
                onDragOver={(event) => {
                  if (c.type !== "manual" || !isMediaDrag(event.dataTransfer))
                    return;
                  // Both are required: without preventDefault the browser
                  // refuses the drop, and the drop handler never runs.
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  setDropTarget(c.id);
                }}
                onDragLeave={() =>
                  setDropTarget((current) => (current === c.id ? null : current))
                }
                onDrop={(event) => {
                  if (c.type !== "manual") return;
                  event.preventDefault();
                  setDropTarget(null);
                  const payload = readMediaDragData(event.dataTransfer);
                  if (payload) void dropOnCollection(payload, c);
                }}
              >
                <Link
                  to="/browse"
                  search={{ collectionId: c.id }}
                  className={cn(navItemClass, "flex-1 truncate")}
                  activeProps={{ className: "text-foreground" }}
                >
                  <Layers className="size-4 shrink-0" />
                  <span className="truncate">{c.name}</span>
                </Link>
                <button
                  type="button"
                  onClick={() =>
                    togglePin({
                      id: `collection:${c.id}`,
                      type: "collection",
                      label: c.name,
                      collectionId: c.id,
                    })
                  }
                  aria-label={`${isPinned(`collection:${c.id}`) ? "Unpin" : "Pin"} ${c.name}`}
                  className="hidden rounded p-1 text-muted-foreground hover:text-foreground group-hover:block"
                >
                  <Pin
                    className={cn(
                      "size-3.5",
                      isPinned(`collection:${c.id}`) && "fill-current",
                    )}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => deleteCollection.mutate(c.id)}
                  aria-label={`Delete ${c.name}`}
                  className="hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}

            <SectionLabel>Tags</SectionLabel>
            {tagData?.tags.length === 0 && (
              <p className="px-3 text-xs text-muted-foreground/60">
                No tags yet
              </p>
            )}
            {tagData?.tags.map((t) => (
              <Link
                key={t.id}
                to="/browse"
                search={{ tag: t.name }}
                className={cn(navItemClass, "truncate")}
                activeProps={{ className: "text-foreground" }}
              >
                <Tag className="size-4 shrink-0" />
                <span className="truncate">{t.name}</span>
              </Link>
            ))}

            {saved.length > 0 && (
              <>
                <SectionLabel>Saved searches</SectionLabel>
                {saved.map((entry) => (
                  <div key={entry.id} className="group flex items-center">
                    <Link
                      to="/browse"
                      // Parsed back into a search object rather than
                      // navigated to as a raw href: the router owns the
                      // shape of this route's search, and handing it a
                      // string would skip its own validation.
                      search={Object.fromEntries(
                        new URLSearchParams(entry.search),
                      )}
                      className={cn(navItemClass, "min-w-0 flex-1 truncate")}
                      title={entry.name}
                    >
                      <Bookmark className="size-4 shrink-0" />
                      <span className="truncate">{entry.name}</span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => removeSavedSearch(entry.id)}
                      aria-label={`Delete saved search ${entry.name}`}
                      className="hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </>
            )}

            {pins.length > 0 && (
              <>
                <SectionLabel>Pinned</SectionLabel>
                {pins.map((pin) => (
                  <div key={pin.id} className="group flex items-center">
                    {pin.type === "performer" ? (
                      <Link
                        to="/performer/$performerId"
                        params={{ performerId: String(pin.performerId) }}
                        className={cn(navItemClass, "min-w-0 flex-1 truncate")}
                      >
                        <Pin className="size-4 shrink-0" />{" "}
                        <span className="truncate">{pin.label}</span>
                      </Link>
                    ) : pin.type === "studio" ? (
                      <Link
                        to="/studio/$studioId"
                        params={{ studioId: String(pin.studioId) }}
                        className={cn(navItemClass, "min-w-0 flex-1 truncate")}
                      >
                        <Pin className="size-4 shrink-0" />{" "}
                        <span className="truncate">{pin.label}</span>
                      </Link>
                    ) : (
                      <Link
                        to="/browse"
                        search={
                          pin.type === "collection"
                            ? { collectionId: pin.collectionId }
                            : { parentId: pin.folderId }
                        }
                        className={cn(navItemClass, "min-w-0 flex-1 truncate")}
                      >
                        <Pin className="size-4 shrink-0" />{" "}
                        <span className="truncate">{pin.label}</span>
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => removePin(pin.id)}
                      aria-label={`Unpin ${pin.label}`}
                      className="hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </nav>

      <div className="border-t border-border p-2">
        {/* One row, not two. A separate "N missing" entry sat directly above
            this one counting the same problem, so the sidebar reported the
            same fault twice and disagreed with itself about where to go.

            Where it leads follows what is wrong: missing files have a page
            built to act on them, so that is where the row goes when there are
            any. With only duplicates — which have a count but no manager yet —
            the health panel in settings is still the whole story. */}
        <Link
          {...(health && health.videoMissing > 0
            ? { to: "/missing" as const }
            : { to: "/settings" as const, search: { tab: "library" } })}
          title={collapsed ? healthLabel : undefined}
          className={cn(navItemClass, "mb-1")}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          {healthIssues > 0 ? (
            <TriangleAlert className="size-4 shrink-0 text-amber-500" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          )}
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate">{healthLabel}</span>
          )}
          {/* The missing page asks for the privacy credential, so the padlock
              says so before you click rather than after. */}
          {!collapsed && health && health.videoMissing > 0 && (
            <Lock className="size-3 shrink-0 text-muted-foreground/60" />
          )}
        </Link>
        {/* A page you come to browse, so it sits with the other destinations
            here rather than behind the account menu. */}
        <Link
          to="/stats"
          className={cn(navItemClass, "mb-1")}
          title={collapsed ? "Your stats" : undefined}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <BarChart3 className="size-4 shrink-0" />
          {!collapsed && "Your stats"}
        </Link>
        <Link
          to="/settings"
          className={navItemClass}
          title={collapsed ? "Site settings" : undefined}
          activeProps={{ className: "bg-accent text-foreground font-medium" }}
        >
          <Settings className="size-4 shrink-0" />
          {!collapsed && "Site settings"}
        </Link>
      </div>

      {showCreate && (
        <CreateCollectionModal onClose={() => setShowCreate(false)} />
      )}
    </aside>
  );
}
