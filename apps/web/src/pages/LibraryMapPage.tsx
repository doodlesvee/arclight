import { useDeferredValue, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Maximize2, Search, ZoomIn, ZoomOut } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import {
  fetchLibraryMap,
  type LibraryMapEdge,
  type LibraryMapKind,
  type LibraryMapNode,
} from "@/lib/libraryMapApi";
import { bounds, createSimulation, settle } from "@/lib/forceLayout";

const KINDS: { value: LibraryMapKind; label: string; color: string }[] = [
  { value: "performer", label: "Performers", color: "#fb7185" },
  { value: "studio", label: "Studios", color: "#34d399" },
  { value: "tag", label: "Tags", color: "#fbbf24" },
  { value: "album", label: "Albums", color: "#38bdf8" },
  { value: "series", label: "Series", color: "#c084fc" },
];

const KIND_COLOR = Object.fromEntries(KINDS.map((kind) => [kind.value, kind.color])) as Record<LibraryMapKind, string>;

type PositionedNode = LibraryMapNode & { x: number; y: number; radius: number };
type MapLayout = "constellation" | "network";

function layoutGraph(nodes: LibraryMapNode[], edges: LibraryMapEdge[], layout: MapLayout): PositionedNode[] {
  if (nodes.length === 0) return [];
  if (layout === "constellation") {
    const groups = KINDS.map((kind) => ({
      kind,
      nodes: nodes.filter((node) => node.kind === kind.value),
    })).filter((group) => group.nodes.length > 0);
    const constellation: PositionedNode[] = [];
    groups.forEach((group, groupIndex) => {
      const sectorStart = -Math.PI / 2 + (groupIndex * Math.PI * 2) / groups.length;
      const sectorWidth = (Math.PI * 2) / groups.length;
      let cursor = 0;
      let ring = 0;
      while (cursor < group.nodes.length) {
        const capacity = 8 + ring * 4;
        const count = Math.min(capacity, group.nodes.length - cursor);
        const orbit = 92 + ring * 58;
        for (let position = 0; position < count; position++) {
          const angle = sectorStart + sectorWidth * (0.1 + 0.8 * ((position + 0.5) / count));
          const node = group.nodes[cursor + position];
          constellation.push({
            ...node,
            x: 500 + Math.cos(angle) * orbit,
            y: 340 + Math.sin(angle) * orbit * 0.78,
            radius: Math.min(14, 7 + Math.sqrt(node.itemCount) * 0.7),
          });
        }
        cursor += count;
        ring++;
      }
    });
    return constellation;
  }

  const indexByKey = new Map(nodes.map((node, index) => [node.key, index]));
  const simulation = createSimulation(
    nodes.map((node, id) => ({
      id,
      radius: Math.min(24, 9 + Math.sqrt(node.itemCount) * 1.4),
    })),
    edges.flatMap((edge) => {
      const source = indexByKey.get(edge.source);
      const target = indexByKey.get(edge.target);
      return source === undefined || target === undefined
        ? []
        : [{ source, target, weight: edge.sharedItems }];
    }),
  );
  settle(simulation, 280);
  const frame = bounds(simulation.nodes);
  const spanX = Math.max(1, frame.maxX - frame.minX);
  const spanY = Math.max(1, frame.maxY - frame.minY);
  const scale = Math.min(900 / spanX, 600 / spanY);
  const centerX = (frame.minX + frame.maxX) / 2;
  const centerY = (frame.minY + frame.maxY) / 2;

  return nodes.map((node, index) => {
    const position = simulation.nodes[index];
    return {
      ...node,
      x: 500 + (position.x - centerX) * scale,
      y: 340 + (position.y - centerY) * scale,
      radius: Math.max(6, Math.min(15, position.radius * scale * 0.82)),
    };
  });
}

function EntityLink({ node }: { node: LibraryMapNode }) {
  const className = "inline-flex rounded-md bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-accent";
  switch (node.kind) {
    case "performer":
      return <Link to="/performer/$performerId" params={{ performerId: String(node.id) }} className={className}>Open performer</Link>;
    case "studio":
      return <Link to="/studio/$studioId" params={{ studioId: String(node.id) }} className={className}>Open studio</Link>;
    case "album":
      return <Link to="/album/$albumId" params={{ albumId: String(node.id) }} className={className}>Open album</Link>;
    case "series":
      return <Link to="/series/$seriesId" params={{ seriesId: String(node.id) }} className={className}>Open series</Link>;
    case "tag":
      return <Link to="/browse" search={{ tag: node.name }} className={className}>Browse tagged items</Link>;
  }
}

export function LibraryMapPage() {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [layout, setLayout] = useState<MapLayout>("constellation");
  const [enabledKinds, setEnabledKinds] = useState<Set<LibraryMapKind>>(
    () => new Set(KINDS.filter((kind) => kind.value !== "album").map((kind) => kind.value)),
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{
    pointerId: number;
    x: number;
    y: number;
    viewX: number;
    viewY: number;
  } | null>(null);
  const { data, isPending, error } = useQuery({
    queryKey: ["library-map", deferredQuery],
    queryFn: () => fetchLibraryMap(deferredQuery),
    staleTime: 60_000,
  });

  const visibleNodes = useMemo(
    () => (data?.nodes ?? []).filter((node) => enabledKinds.has(node.kind)),
    [data, enabledKinds],
  );
  const visibleKeys = useMemo(() => new Set(visibleNodes.map((node) => node.key)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => (data?.edges ?? []).filter((edge) => visibleKeys.has(edge.source) && visibleKeys.has(edge.target)),
    [data, visibleKeys],
  );
  const positionedNodes = useMemo(
    () => layoutGraph(visibleNodes, visibleEdges, layout),
    [visibleNodes, visibleEdges, layout],
  );
  const selectedNode = visibleNodes.find((node) => node.key === selectedKey) ?? null;
  const activeKey = selectedKey ?? hoveredKey;
  const selectedEdges = activeKey
    ? visibleEdges.filter((edge) => edge.source === activeKey || edge.target === activeKey)
    : [];
  const connectedKeys = new Set(
    selectedEdges.map((edge) => edge.source === activeKey ? edge.target : edge.source),
  );
  const strongestLinks = selectedEdges
    .map((edge) => ({
      node: visibleNodes.find((node) => node.key === (edge.source === activeKey ? edge.target : edge.source)),
      count: edge.sharedItems,
    }))
    .filter((entry): entry is { node: LibraryMapNode; count: number } => entry.node !== undefined)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  function toggleKind(kind: LibraryMapKind) {
    setEnabledKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function beginPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || (event.target as Element).closest("[data-map-node]")) return;
    panStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      viewX: view.x,
      viewY: view.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  }

  function movePan(event: ReactPointerEvent<SVGSVGElement>) {
    const start = panStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setView((current) => ({
      ...current,
      x: start.viewX + (event.clientX - start.x) * (1000 / Math.max(1, rect.width)),
      y: start.viewY + (event.clientY - start.y) * (680 / Math.max(1, rect.height)),
    }));
  }

  function endPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (panStart.current?.pointerId !== event.pointerId) return;
    panStart.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function zoomBy(factor: number) {
    setView((current) => ({
      ...current,
      scale: Math.max(0.65, Math.min(3.25, current.scale * factor)),
    }));
  }

  return (
    <AppShell title="Library Map" subtitle="Explore the people, places, tags, albums, and series connected through your media.">
      <div className="mx-auto grid w-full max-w-[1500px] gap-5 px-4 py-6 md:px-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
        <section className="min-w-0 space-y-4">
          <label className="flex h-10 max-w-lg items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 text-muted-foreground focus-within:border-ring/60">
            <Search className="size-4 shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find an entity to explore…"
              aria-label="Search library map"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Layout</span>
            <div role="group" aria-label="Map layout" className="inline-flex rounded-md border border-border p-1">
              {(["constellation", "network"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={layout === mode}
                  onClick={() => setLayout(mode)}
                  className={`rounded px-3 py-1.5 text-xs transition-colors ${layout === mode ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {mode === "constellation" ? "Constellation" : "Network"}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2" aria-label="Map entity types">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Layers</p>
            <div className="flex flex-wrap gap-2">
            {KINDS.map((kind) => {
              const active = enabledKinds.has(kind.value);
              return (
                <button
                  key={kind.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleKind(kind.value)}
                  className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
                  style={{ opacity: active ? 1 : 0.45 }}
                >
                  <span className="size-2 rounded-full" style={{ backgroundColor: kind.color }} />
                  {kind.label}
                </button>
              );
            })}
            </div>
          </div>

          <div className="relative min-h-[min(68vh,720px)] overflow-hidden rounded-md border border-border bg-[#0b0d0e]">
            {isPending ? (
              <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Mapping the library…</div>
            ) : error ? (
              <div role="alert" className="absolute inset-0 grid place-items-center text-sm text-destructive">Could not load the library map.</div>
            ) : positionedNodes.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
                {data?.totalNodes === 0 ? "Scan media and add some metadata to build your map." : "No matching entities in this view."}
              </div>
            ) : (
              <svg
                viewBox="0 0 1000 680"
                role="img"
                aria-label="Library relationship map"
                className="absolute inset-0 h-full w-full"
                style={{ touchAction: "none", cursor: panning ? "grabbing" : "grab" }}
                onPointerDown={beginPan}
                onPointerMove={movePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
              >
                <defs>
                  <pattern id="library-map-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                    <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#9da8b2" strokeOpacity="0.075" strokeWidth="0.7" />
                    <circle cx="0" cy="0" r="1" fill="#9da8b2" fillOpacity="0.14" />
                  </pattern>
                </defs>
                <rect width="1000" height="680" fill="url(#library-map-grid)" />
                <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
                {layout === "constellation" && KINDS.filter((kind) => visibleNodes.some((node) => node.kind === kind.value)).map((kind) => {
                  const groups = KINDS.filter((entry) => visibleNodes.some((node) => node.kind === entry.value));
                  const groupIndex = groups.findIndex((entry) => entry.value === kind.value);
                  const angle = -Math.PI / 2 + ((groupIndex + 0.5) * Math.PI * 2) / groups.length;
                  return (
                    <text
                      key={kind.value}
                      x={500 + Math.cos(angle) * 335}
                      y={340 + Math.sin(angle) * 275}
                      textAnchor="middle"
                      fill={kind.color}
                      fillOpacity="0.95"
                      fontSize="12"
                      fontWeight="650"
                      letterSpacing="1.2"
                    >
                      {kind.label.toUpperCase()}
                    </text>
                  );
                })}
                <g>
                  {visibleEdges.map((edge) => {
                    const source = positionedNodes.find((node) => node.key === edge.source);
                    const target = positionedNodes.find((node) => node.key === edge.target);
                    if (!source || !target) return null;
                    const highlighted = activeKey === edge.source || activeKey === edge.target;
                    return (
                      <line
                        key={`${edge.source}-${edge.target}`}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        stroke={highlighted ? "#f5f5f5" : "#87919a"}
                        strokeOpacity={highlighted ? 0.9 : activeKey ? 0.025 : 0.055}
                        strokeWidth={highlighted ? 1.8 : Math.min(1.4, 0.8 + Math.log2(edge.sharedItems + 1) * 0.15)}
                      />
                    );
                  })}
                </g>
                <g>
                  {positionedNodes.map((node) => {
                    const color = KIND_COLOR[node.kind];
                    const selected = selectedKey === node.key;
                    const hovered = hoveredKey === node.key;
                    const emphasized = selected || hovered;
                    const connected = connectedKeys.has(node.key);
                    const dim = activeKey != null && !emphasized && !connected;
                    const showLabel = emphasized || (layout === "network" && (node.kind === "performer" || node.kind === "studio"));
                    const shape = node.kind === "studio"
                      ? <rect x={node.x - node.radius * 0.72} y={node.y - node.radius * 0.72} width={node.radius * 1.44} height={node.radius * 1.44} rx={node.radius * 0.2} transform={`rotate(45 ${node.x} ${node.y})`} />
                      : node.kind === "tag"
                        ? <polygon points={Array.from({ length: 6 }, (_, index) => `${node.x + node.radius * Math.cos(index * Math.PI / 3)},${node.y + node.radius * Math.sin(index * Math.PI / 3)}`).join(" ")} />
                        : node.kind === "album"
                          ? <rect x={node.x - node.radius * 0.8} y={node.y - node.radius * 0.8} width={node.radius * 1.6} height={node.radius * 1.6} rx={3} />
                          : <circle cx={node.x} cy={node.y} r={node.radius} />;
                    return (
                      <g
                        key={node.key}
                        role="button"
                        tabIndex={0}
                        aria-label={`${node.name}, ${node.kind}, ${node.itemCount} items`}
                        onClick={() => setSelectedKey(node.key)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedKey(node.key);
                          }
                        }}
                        className="cursor-pointer outline-none"
                        onPointerEnter={() => setHoveredKey(node.key)}
                        onPointerLeave={() => setHoveredKey(null)}
                        onFocus={() => setHoveredKey(node.key)}
                        onBlur={() => setHoveredKey(null)}
                      >
                        <title>{`${node.name} · ${node.itemCount} items`}</title>
                        <g
                          fill={color}
                          fillOpacity={dim ? 0.2 : emphasized ? 1 : 0.82}
                          stroke={selected ? "#ffffff" : color}
                          strokeOpacity={selected ? 1 : 0.85}
                          strokeWidth={selected ? 2.5 : 1}
                          style={{ filter: emphasized ? `drop-shadow(0 0 8px ${color}99)` : undefined }}
                        >
                          {shape}
                          {node.kind === "series" && (
                            <circle cx={node.x} cy={node.y} r={node.radius * 0.56} fill="none" stroke="#0b0d0e" strokeWidth="1.5" />
                          )}
                        </g>
                        {showLabel && (
                          <text
                            x={node.x}
                            y={node.y + node.radius + 13}
                            textAnchor="middle"
                            fill={emphasized ? "#ffffff" : "#e0e6ea"}
                            fontSize={emphasized ? 12 : 10}
                            fontWeight={emphasized ? 650 : 500}
                            paintOrder="stroke"
                            stroke="#0b0d0e"
                            strokeWidth="4"
                            strokeLinejoin="round"
                          >
                            {node.name.length > 22 ? `${node.name.slice(0, 20)}…` : node.name}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
                </g>
              </svg>
            )}
            {positionedNodes.length > 0 && !isPending && !error && (
              <>
                <div className="absolute left-3 top-3 rounded-md border border-white/10 bg-black/70 px-2.5 py-1.5 text-[11px] tabular-nums text-white/70 backdrop-blur-sm">
                  {visibleNodes.length} entities <span className="text-white/35">/</span> {visibleEdges.length} connections
                </div>
                <div className="absolute right-3 top-3 flex items-center gap-1 rounded-md border border-white/10 bg-black/70 p-1 backdrop-blur-sm">
                  <button
                    type="button"
                    onClick={() => zoomBy(1.25)}
                    aria-label="Zoom in"
                    title="Zoom in"
                    className="flex size-8 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  ><ZoomIn className="size-4" /></button>
                  <button
                    type="button"
                    onClick={() => zoomBy(0.8)}
                    aria-label="Zoom out"
                    title="Zoom out"
                    className="flex size-8 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  ><ZoomOut className="size-4" /></button>
                  <button
                    type="button"
                    onClick={() => setView({ scale: 1, x: 0, y: 0 })}
                    aria-label="Fit map"
                    title="Fit map"
                    className="flex size-8 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  ><Maximize2 className="size-4" /></button>
                </div>
              </>
            )}
            {data?.truncated && !deferredQuery && (
              <p className="absolute bottom-3 left-3 rounded bg-black/70 px-2 py-1 text-[11px] text-white/60">
                Showing the most connected {data.nodes.length} of {data.totalNodes}; search to explore others.
              </p>
            )}
          </div>
        </section>

        <aside className="min-w-0 border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
          {selectedNode ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: KIND_COLOR[selectedNode.kind] }}>
                  {selectedNode.kind}
                </p>
                <h2 className="break-words text-lg font-semibold">{selectedNode.name}</h2>
                <p className="text-xs text-muted-foreground">
                  Appears in {selectedNode.itemCount} {selectedNode.itemCount === 1 ? "item" : "items"}
                </p>
              </div>

              <EntityLink node={selectedNode} />

              <div className="space-y-2 border-t border-border pt-4">
                <h3 className="text-xs font-semibold text-muted-foreground">Connected to</h3>
                {strongestLinks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No linked entities in this view.</p>
                ) : (
                  <ul className="space-y-1">
                    {strongestLinks.map(({ node, count }) => (
                      <li key={node.key}>
                        <button
                          type="button"
                          onClick={() => setSelectedKey(node.key)}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                        >
                          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: KIND_COLOR[node.kind] }} />
                          <span className="min-w-0 flex-1 truncate">{node.name}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">Library connections</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Choose a node to reveal its strongest connections. Brighter lines indicate stronger relationships.
              </p>
            </div>
          )}
        </aside>
      </div>
    </AppShell>
  );
}