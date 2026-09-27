import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Crosshair, ExternalLink, EyeOff, Play, Route, X } from "lucide-react";
import { thumbnailUrl } from "@/lib/mediaItemApi";
import {
  fetchLatestVideos,
  fetchSharedVideos,
  fetchVideosWhere,
  togetherLabel,
  unit,
  type NetworkEdge,
  type NetworkMode,
  type NetworkNode,
  type SharedVideo,
} from "@/lib/performerApi";
import { cn } from "@/lib/utils";

/**
 * The overlays the performer network draws over its canvas: the card that
 * follows a hovered line, and the side panels for a selected performer or a
 * selected pair. Kept apart from the canvas component, which is all layout
 * and gestures, so each file reads as one job.
 */

function useSharedVideos(a: NetworkNode | undefined, b: NetworkNode | undefined) {
  return useQuery({
    queryKey: ["performers", "shared-videos", a?.name, b?.name],
    queryFn: () => fetchSharedVideos(a!.name, b!.name),
    enabled: a != null && b != null,
    staleTime: 60_000,
  });
}

function sharedBrowseSearch(a: NetworkNode, b: NetworkNode) {
  return { performers: `${a.name},${b.name}` };
}

/** Studios as chips that open the browse view for that one. */
function SharedChips({
  shared,
  limit,
}: {
  shared: string[];
  limit?: number;
}) {
  const navigate = useNavigate();
  const shown = limit ? shared.slice(0, limit) : shared;
  return (
    <ul className="flex flex-wrap gap-1">
      {shown.map((name) => (
        <li key={name}>
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/browse",
                search: { studio: name },
              })
            }
            className="rounded-full bg-secondary px-2 py-0.5 text-xs hover:bg-accent"
          >
            {name}
          </button>
        </li>
      ))}
      {shown.length < shared.length && (
        <li className="px-1 py-0.5 text-xs text-muted-foreground">
          +{shared.length - shown.length} more
        </li>
      )}
    </ul>
  );
}

/** Follows a hovered line: who, how strongly, and a peek at what links them. */
export function EdgeHoverCard({
  mode,
  edge,
  a,
  b,
  studioLink = false,
}: {
  mode: NetworkMode;
  edge: NetworkEdge;
  a: NetworkNode | undefined;
  b: NetworkNode | undefined;
  /** A line from a performer to a studio circle, rather than between two people. */
  studioLink?: boolean;
}) {
  // Shared videos only in the mode that is about them; elsewhere the card
  // shows what they have in common instead, which is already in the edge.
  const { data } = useSharedVideos(mode === "videos" ? a : undefined, b);
  if (studioLink) {
    const [performer, studio] = a?.kind === "studio" ? [b, a] : [a, b];
    return (
      <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-lg bg-popover/95 px-3 py-2 text-xs shadow-lg ring-1 ring-border">
        <span className="sensitive font-medium">{performer?.name}</span>{" "}
        <span className="text-muted-foreground">
          · {unit("videos", edge.together)} for {studio?.name} — click to see them
        </span>
      </div>
    );
  }
  const thumbs = data?.items.slice(0, 4) ?? [];

  return (
    <div className="pointer-events-none absolute left-1/2 top-3 w-[min(22rem,calc(100%-6rem))] -translate-x-1/2 rounded-lg bg-popover/95 p-3 text-xs shadow-lg ring-1 ring-border">
      <p>
        <span className="sensitive font-medium">
          {a?.name} &amp; {b?.name}
        </span>{" "}
        <span className="text-muted-foreground">· {togetherLabel(mode, edge.together)}</span>
      </p>
      {mode === "videos" && thumbs.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-1">
          {thumbs.map((item) => (
            <img
              key={item.id}
              src={thumbnailUrl(item)}
              alt=""
              className="aspect-video w-full rounded object-cover"
            />
          ))}
        </div>
      )}
      {mode !== "videos" && edge.shared && (
        <p className="mt-1.5 text-muted-foreground">
          {edge.shared.slice(0, 4).join(", ")}
          {edge.shared.length > 4 && ` +${edge.shared.length - 4}`}
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-muted-foreground/70">Click the line for details</p>
    </div>
  );
}

const panelClass =
  "absolute inset-x-3 bottom-3 max-h-[55%] overflow-y-auto rounded-lg bg-popover/95 p-4 shadow-xl ring-1 ring-border md:inset-x-auto md:bottom-auto md:right-3 md:top-14 md:max-h-[calc(100%-4.5rem)] md:w-80";

function PanelHeader({
  title,
  subtitle,
  onClose,
}: {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="sensitive font-semibold tracking-tight">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="rounded p-1 text-muted-foreground hover:text-foreground"
        aria-label="Close"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

const actionClass =
  "flex flex-1 items-center justify-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-xs font-medium hover:bg-accent";

export function PerformerPanel({
  mode,
  performer,
  neighbours,
  nodesById,
  focused,
  onClose,
  onOpenProfile,
  onFocus,
  onHide,
  onSelectPerformer,
  onSelectPair,
  onPlay,
  connectTo,
  onFindPath,
}: {
  mode: NetworkMode;
  performer: NetworkNode;
  neighbours: { id: number; together: number; shared?: string[] }[];
  nodesById: Map<number, NetworkNode>;
  focused: boolean;
  onClose: () => void;
  onOpenProfile: () => void;
  onFocus: () => void;
  onHide: () => void;
  onSelectPerformer: (id: number) => void;
  onSelectPair: (otherId: number) => void;
  onPlay: (itemId: number) => void;
  /** Everyone a connection could be traced to. */
  connectTo: NetworkNode[];
  onFindPath: (otherId: number) => void;
}) {
  const { data: latest } = useQuery({
    queryKey: ["performers", "latest-videos", performer.name],
    queryFn: () => fetchLatestVideos(performer.name),
    staleTime: 60_000,
  });
  return (
    <aside className={panelClass}>
      <PanelHeader
        title={performer.name}
        subtitle={
          <>
            {unit("videos", performer.videoCount)}
            {performer.topStudio && <> · mostly {performer.topStudio}</>}
          </>
        }
        onClose={onClose}
      />
      <div className="mt-3 flex gap-1.5">
        <button type="button" onClick={onOpenProfile} className={actionClass}>
          <ExternalLink className="size-3.5" />
          Profile
        </button>
        <button
          type="button"
          onClick={onFocus}
          aria-pressed={focused}
          className={cn(actionClass, focused && "bg-foreground text-background hover:bg-foreground/90")}
          title="Show only them and the people they connect to"
        >
          <Crosshair className="size-3.5" />
          Focus
        </button>
        <button
          type="button"
          onClick={onHide}
          className={actionClass}
          title="Take them out of the graph, to see what connects without them"
        >
          <EyeOff className="size-3.5" />
          Hide
        </button>
      </div>

      {(latest?.length ?? 0) > 0 && (
        <section className="mt-4 space-y-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Latest videos
          </h4>
          <div className="grid grid-cols-3 gap-1.5">
            {latest!.slice(0, 6).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onPlay(item.id)}
                title={item.title}
                className="group relative overflow-hidden rounded ring-1 ring-border hover:ring-foreground/40"
              >
                <img src={thumbnailUrl(item)} alt="" className="aspect-video w-full object-cover" />
                <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <Play className="size-4 fill-white text-white" />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {connectTo.length > 0 && (
        <label className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Route className="size-3.5 shrink-0" />
          <select
            value=""
            onChange={(e) => e.target.value && onFindPath(Number(e.target.value))}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-foreground"
          >
            <option value="">How are they connected to…</option>
            {[...connectTo]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((other) => (
                <option key={other.id} value={other.id}>
                  {other.name}
                </option>
              ))}
          </select>
        </label>
      )}

      {neighbours.length > 0 ? (
        <>
          <h4 className="mb-1.5 mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {neighbours.every((n) => n.id < 0)
              ? "Works for"
              : mode === "videos"
                ? "Appears with"
                : "Most in common with"}
          </h4>
          <ul className="space-y-0.5">
            {neighbours.map(({ id, together, shared }) => {
              const other = nodesById.get(id);
              if (!other) return null;
              return (
                <li key={id} className="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => onSelectPerformer(id)}
                    className="sensitive min-w-0 flex-1 truncate text-left hover:underline"
                  >
                    {other.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectPair(id)}
                    className="max-w-[9rem] shrink-0 truncate rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={other.kind === "studio" ? "Their videos for this studio" : "What links them"}
                  >
                    {other.kind === "studio"
                      ? unit("videos", together)
                      : mode === "videos"
                      ? `${together} together`
                      : // One thing in common is clearer named than counted.
                        shared?.length === 1
                        ? shared[0]
                        : `${together} in common`}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          No connections with the current filters.
        </p>
      )}
    </aside>
  );
}

export function PairPanel({
  mode,
  edge,
  a,
  b,
  onClose,
  onSelectPerformer,
  onPlayAll,
}: {
  mode: NetworkMode;
  edge: NetworkEdge;
  a: NetworkNode;
  b: NetworkNode;
  onClose: () => void;
  onSelectPerformer: (id: number) => void;
  /** Plays the first shared video and queues the rest. */
  onPlayAll: (videos: SharedVideo[]) => void;
}) {
  const navigate = useNavigate();
  // Fetched in every mode: two people linked by a studio may also have a
  // scene together, and that is the first thing you'd want to know.
  const { data, isLoading } = useSharedVideos(a, b);
  const total = data?.total ?? data?.items.length ?? 0;
  const openAll = () => void navigate({ to: "/browse", search: sharedBrowseSearch(a, b) });

  return (
    <aside className={panelClass}>
      <PanelHeader
        title={
          <>
            <button type="button" onClick={() => onSelectPerformer(a.id)} className="hover:underline">
              {a.name}
            </button>{" "}
            <span className="text-muted-foreground">&amp;</span>{" "}
            <button type="button" onClick={() => onSelectPerformer(b.id)} className="hover:underline">
              {b.name}
            </button>
          </>
        }
        subtitle={togetherLabel(mode, edge.together)}
        onClose={onClose}
      />

      {mode !== "videos" && edge.shared && edge.shared.length > 0 && (
        <section className="mt-4 space-y-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Studios in common
          </h4>
          <SharedChips shared={edge.shared} limit={16} />
        </section>
      )}

      <section className="mt-4 space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Videos together
        </h4>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : total === 0 ? (
          <p className="text-xs text-muted-foreground">They haven't been in a video together.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              {data!.items.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={openAll}
                  title={item.title}
                  className="overflow-hidden rounded ring-1 ring-border hover:ring-foreground/40"
                >
                  <img
                    src={thumbnailUrl(item)}
                    alt=""
                    className="aspect-video w-full object-cover"
                  />
                </button>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => onPlayAll(data!.items)}
                className={cn(actionClass, "bg-foreground text-background hover:bg-foreground/90")}
              >
                <Play className="size-3.5 fill-current" />
                {total === 1 ? "Play it" : "Play all"}
              </button>
              <button type="button" onClick={openAll} className={actionClass}>
                See {total === 1 ? "it" : `all ${total}`} in Browse
              </button>
            </div>
          </>
        )}
      </section>
    </aside>
  );
}

export function StudioPanel({
  studio,
  members,
  nodesById,
  focused,
  onClose,
  onOpenPage,
  onFocus,
  onHide,
  onSelectPerformer,
  onOpenVideos,
  onPlayAll,
}: {
  studio: NetworkNode;
  members: { id: number; together: number }[];
  nodesById: Map<number, NetworkNode>;
  focused: boolean;
  onClose: () => void;
  onOpenPage: () => void;
  onFocus: () => void;
  onHide: () => void;
  onSelectPerformer: (id: number) => void;
  onOpenVideos: (performerId: number) => void;
  onPlayAll: (videos: SharedVideo[]) => void;
}) {
  const { data: studioVideos } = useQuery({
    queryKey: ["studios", "videos", studio.name],
    queryFn: () => fetchVideosWhere({ studio: studio.name }),
    staleTime: 60_000,
  });
  return (
    <aside className={panelClass}>
      <PanelHeader
        title={studio.name}
        subtitle={
          <>
            {unit("videos", studio.videoCount)} · {members.length}{" "}
            {members.length === 1 ? "performer" : "performers"}
          </>
        }
        onClose={onClose}
      />
      <div className="mt-3 flex gap-1.5">
        <button type="button" onClick={onOpenPage} className={actionClass}>
          <ExternalLink className="size-3.5" />
          Studio
        </button>
        <button
          type="button"
          onClick={onFocus}
          aria-pressed={focused}
          className={cn(actionClass, focused && "bg-foreground text-background hover:bg-foreground/90")}
          title="Show only this studio and who works for it"
        >
          <Crosshair className="size-3.5" />
          Focus
        </button>
        <button type="button" onClick={onHide} className={actionClass} title="Take this studio out of the graph">
          <EyeOff className="size-3.5" />
          Hide
        </button>
      </div>
      {(studioVideos?.length ?? 0) > 0 && (
        <button
          type="button"
          onClick={() => onPlayAll(studioVideos!)}
          className={cn(actionClass, "mt-1.5 w-full bg-foreground text-background hover:bg-foreground/90")}
          title="Play the studio's newest video and queue the rest"
        >
          <Play className="size-3.5 fill-current" />
          Play {studio.name}
        </button>
      )}
      {members.length > 0 && (
        <>
          <h4 className="mb-1.5 mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Performers
          </h4>
          <ul className="space-y-0.5">
            {members.map(({ id, together }) => {
              const performer = nodesById.get(id);
              if (!performer) return null;
              return (
                <li key={id} className="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => onSelectPerformer(id)}
                    className="sensitive min-w-0 flex-1 truncate text-left hover:underline"
                  >
                    {performer.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenVideos(id)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Their videos for this studio"
                  >
                    {unit("videos", together)}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}

/** Hovering a performer: who, how much, and their latest few videos. */
export function NodeHoverCard({ performer }: { performer: NetworkNode }) {
  const { data: latest } = useQuery({
    queryKey: ["performers", "latest-videos", performer.name],
    queryFn: () => fetchLatestVideos(performer.name),
    staleTime: 60_000,
  });
  const thumbs = latest?.slice(0, 4) ?? [];
  const hours = (performer.watchedSeconds ?? 0) / 3600;
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 w-[min(22rem,calc(100%-6rem))] -translate-x-1/2 rounded-lg bg-popover/95 p-3 text-xs shadow-lg ring-1 ring-border">
      <p>
        <span className="sensitive font-medium">{performer.name}</span>{" "}
        <span className="text-muted-foreground">
          · {unit("videos", performer.videoCount)}
          {performer.averageRating != null && <> · ★ {performer.averageRating}</>}
          {hours >= 0.1 && <> · {hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`} watched</>}
        </span>
      </p>
      {thumbs.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-1">
          {thumbs.map((item) => (
            <img
              key={item.id}
              src={thumbnailUrl(item)}
              alt=""
              className="aspect-video w-full rounded object-cover"
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A row of one-line facts about what's on screen, each a shortcut to the
 * performer it names. Worked out from the drawn graph, so it follows the
 * filters, the focus and the year range.
 */
export function NetworkHighlights({
  mode,
  nodes,
  neighbours,
  onSelect,
}: {
  mode: NetworkMode;
  nodes: NetworkNode[];
  neighbours: Map<number, { id: number; together: number }[]>;
  onSelect: (id: number) => void;
}) {
  const people = nodes.filter((n) => n.kind !== "studio");
  if (people.length < 3) return null;
  const peopleDegree = (id: number) => (neighbours.get(id) ?? []).filter((n) => n.id > 0).length;
  const best = <T,>(score: (n: NetworkNode) => T | null, better: (a: T, b: T) => boolean) => {
    let top: { node: NetworkNode; value: T } | null = null;
    for (const node of people) {
      const value = score(node);
      if (value != null && (!top || better(value, top.value))) top = { node, value };
    }
    return top;
  };
  const mostConnected = best((n) => peopleDegree(n.id) || null, (a, b) => a > b);
  const mostStudios = best((n) => ((n.studioCount ?? 0) > 1 ? n.studioCount! : null), (a, b) => a > b);
  const mostWatched = best((n) => ((n.watchedSeconds ?? 0) > 0 ? n.watchedSeconds! : null), (a, b) => a > b);
  const topRated = best((n) => n.averageRating ?? null, (a, b) => a > b);
  const bridge = findBridge(people, neighbours, mostConnected?.node.id);

  const facts: { label: string; node: NetworkNode; detail: string }[] = [];
  if (mostConnected)
    facts.push({
      label: "Most connected",
      node: mostConnected.node,
      detail: mode === "videos" ? `${mostConnected.value} co-stars` : `${mostConnected.value} links`,
    });
  if (mostStudios) facts.push({ label: "Most studios", node: mostStudios.node, detail: `${mostStudios.value}` });
  if (mostWatched) {
    const hours = mostWatched.value / 3600;
    facts.push({
      label: "Most watched",
      node: mostWatched.node,
      detail: hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`,
    });
  }
  if (topRated) facts.push({ label: "Top rated", node: topRated.node, detail: `★ ${topRated.value}` });
  if (bridge) facts.push({ label: "Links two groups", node: bridge, detail: "remove them and the graph splits" });
  if (facts.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-2 text-xs">
      {facts.map(({ label, node, detail }) => (
        <li key={label}>
          <button
            type="button"
            onClick={() => onSelect(node.id)}
            className="flex items-center gap-1.5 rounded-md bg-secondary/70 px-2.5 py-1 hover:bg-accent"
            title={detail}
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="sensitive font-medium">{node.name}</span>
            <span className="text-muted-foreground">· {detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The best-connected performer whose removal would split the people in the
 * graph into more pieces — a cut vertex, found with Tarjan's low-link walk.
 * The most connected performer is skipped: they're already highlighted, and
 * in a star-shaped library they'd be the answer every time.
 */
function findBridge(
  people: NetworkNode[],
  neighbours: Map<number, { id: number }[]>,
  skip: number | undefined,
): NetworkNode | null {
  const ids = new Set(people.map((p) => p.id));
  const order = new Map<number, number>();
  const low = new Map<number, number>();
  const cuts = new Set<number>();
  let counter = 0;
  const visit = (id: number, parent: number | null) => {
    order.set(id, counter);
    low.set(id, counter);
    counter++;
    let children = 0;
    for (const { id: next } of neighbours.get(id) ?? []) {
      if (!ids.has(next) || next === parent) continue;
      if (order.has(next)) {
        low.set(id, Math.min(low.get(id)!, order.get(next)!));
      } else {
        children++;
        visit(next, id);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
        if (parent != null && low.get(next)! >= order.get(id)!) cuts.add(id);
      }
    }
    if (parent == null && children > 1) cuts.add(id);
  };
  for (const person of people) if (!order.has(person.id)) visit(person.id, null);
  let top: NetworkNode | null = null;
  for (const person of people) {
    if (!cuts.has(person.id) || person.id === skip) continue;
    const degree = (neighbours.get(person.id) ?? []).length;
    if (!top || degree > (neighbours.get(top.id) ?? []).length) top = person;
  }
  return top;
}
