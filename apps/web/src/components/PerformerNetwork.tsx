import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Crosshair,
  ExternalLink,
  EyeOff,
  Expand,
  LayoutGrid,
  Maximize2,
  Pin,
  Play,
  Route,
  Shrink,
  X,
} from "lucide-react";
import { useAppearance } from "@/lib/appearance";
import { MediaDetailModal } from "@/components/MediaDetailModal";
import { ContextMenu, type ContextMenuState } from "@/components/ContextMenu";
import { useQueue } from "@/lib/queue";
import {
  ALPHA_MIN,
  bounds,
  createSimulation,
  settle,
  tick,
  type SimNode,
  type Simulation,
} from "@/lib/forceLayout";
import {
  fetchPerformerNetwork,
  circleFraming,
  fetchLatestVideos,
  fetchVideosWhere,
  unit,
  performerPortraitUrl,
  withStudioCircles,
  type NetworkEdge,
  type NetworkMode,
  type NetworkNode,
  type NetworkView,
  type SharedVideo,
} from "@/lib/performerApi";
import { cn } from "@/lib/utils";
import {
  EdgeHoverCard,
  NetworkHighlights,
  NodeHoverCard,
  PairPanel,
  PerformerPanel,
  StudioPanel,
} from "./PerformerNetworkPanels";

/**
 * Who appears with whom, across the whole library.
 *
 * Drawn on a canvas rather than as DOM nodes: a few hundred avatars and every
 * line between them, re-laid out sixty times a second while the simulation
 * settles, is the one place in the app where elements would be too slow.
 *
 * The canvas sidesteps the discreet-mode stylesheet (which blurs `img`
 * elements), so it honours the setting itself: initials instead of pictures
 * with discreet mode on, and no names drawn when names are blurred too.
 */

/** Studio colours, for the styles that use them; the rest share `OTHER`. */
const STUDIO_COLOURS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#fb923c"];
const OTHER = "#8a8a8a";

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * How the graph is dressed: studio-colour rings and lines, shadows, and a
 * glow on whatever you're looking at. Tune by eye.
 */
type Look = {
  /** Portrait rings in the studio's colour rather than a neutral hairline. */
  studioRings: boolean;
  ringPx: number;
  /** Lines blend between the two ends' studio colours. */
  tintedLines: boolean;
  /** A soft shadow under every portrait, lifting it off the background. */
  shadows: boolean;
  /** Glow strength on whatever you're looking at; 0 for none. */
  glow: number;
  /** A gentle radial gradient instead of a flat background. */
  vignette: boolean;
  /** Soft glows of studio colour behind everything; their strength, 0 for none. */
  glows: number;
  /**
   * A graph-paper grid that pans and zooms with the graph: opacity of the
   * fine lines and of every fourth, brighter one. 0 for none.
   */
  grid: { minor: number; major: number };
  /** Studio chips: plain, with a coloured dot, or tinted all over. */
  chip: "plain" | "dot" | "tinted";
  /** Portrait size multiplier. */
  scale: number;
  /** Screen size (px) of a portrait at which name plates replace plain names. */
  platesAt: number;
};
const LOOK: Look = {
  studioRings: true,
  ringPx: 2.25,
  tintedLines: true,
  shadows: true,
  glow: 24,
  vignette: true,
  platesAt: 30,
  glows: 0.14,
  grid: { minor: 0.045, major: 0.1 },
  chip: "tinted",
  scale: 1.25,
};

/**
 * The shared palette every look draws with. Tune by eye.: the graph is read
 * by its shape and its faces, and colour competed with both. Tune by eye.
 */
const STYLE = {
  background: "#111111",
  /** Lines are hairlines; a stronger link is brighter, not thicker. */
  lineAlpha: { weakest: 0.08, strongest: 0.3, active: 0.7 },
  lineWidthPx: 1,
  /** The hairline round every portrait, and the selected one's outline. */
  ring: "rgba(255,255,255,0.16)",
  ringActive: "rgba(255,255,255,0.9)",
  placeholder: "#1e1e1e",
  initials: "rgba(255,255,255,0.45)",
  label: "rgba(255,255,255,0.72)",
  labelActive: "rgba(255,255,255,0.95)",
  labelPx: 11,
  /** Studios are drawn as chips, like the studio chips on the library page. */
  chip: "#1c1c1c",
  chipBorder: "rgba(255,255,255,0.14)",
  chipText: "rgba(255,255,255,0.85)",
  chipPx: 12,
  /** How faint everything else gets while you're looking at someone. */
  dimmed: 0.14,
  favourite: "#ef4444",
};

type View = { k: number; x: number; y: number };
type Hover = { kind: "node"; id: number } | { kind: "edge"; edge: NetworkEdge } | null;
/** What the side panel is showing: one performer, or the pair on a line. */
type Selection =
  | { kind: "node"; id: number }
  | { kind: "edge"; source: number; target: number }
  | null;
/** Only this performer and whoever is within `depth` links of them. */
type Focus = { id: number; depth: 1 | 2 } | null;

const MODES: { value: NetworkMode; label: string }[] = [
  { value: "studios", label: "Studios" },
  { value: "videos", label: "Videos together" },
];

const sameEdge = (a: { source: number; target: number } | null, b: { source: number; target: number } | null) =>
  a != null &&
  b != null &&
  ((a.source === b.source && a.target === b.target) || (a.source === b.target && a.target === b.source));

const nodeRadius = (node: NetworkNode, scale = 1) =>
  node.kind === "studio"
    ? // A chip is as wide as its name; this is half that, for spacing.
      Math.min(70, 16 + node.name.length * 3.4)
    : // A narrow range, so one prolific performer doesn't dwarf the rest.
      Math.min(26, 12 + 2 * Math.sqrt(node.videoCount)) * scale;

function distanceToSegment(px: number, py: number, a: SimNode, b: SimNode): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/**
 * Where you've dragged people, per view, kept in this browser only — a
 * display preference, not library data. Wrapped in try/catch because
 * private windows can refuse storage outright.
 */
type Pins = Record<string, [number, number]>;
const pinsKey = (layout: string) => `performer-network-pins:${layout}`;
function readPins(layout: string): Pins {
  try {
    const parsed = JSON.parse(localStorage.getItem(pinsKey(layout)) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Pins) : {};
  } catch {
    return {};
  }
}
function writePins(layout: string, pins: Pins) {
  try {
    if (Object.keys(pins).length === 0) localStorage.removeItem(pinsKey(layout));
    else localStorage.setItem(pinsKey(layout), JSON.stringify(pins));
  } catch {
    // Forgetting a layout is harmless.
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const FADE_MS = 450;
const CAMERA_MS = 420;

/** Parses the URL's comma-separated id list. */
const idList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n !== 0);

export function PerformerNetwork({
  view,
  onViewChange,
}: {
  view: NetworkView;
  onViewChange: (patch: NetworkView) => void;
}) {
  const navigate = useNavigate();
  const { discreet, discreetText, motion } = useAppearance();
  const mode: NetworkMode = view.by ?? "studios";
  const { data: fetched, isLoading } = useQuery({
    queryKey: ["performers", "network", mode],
    queryFn: () => fetchPerformerNetwork(mode),
    // The old graph stays up while the new mode loads, so switching modes
    // morphs the picture rather than blanking it.
    placeholderData: keepPreviousData,
  });
  // Studio mode can also draw the studios themselves, linked to who works
  // for them, instead of linking performers who share one. Off by default:
  // the graph reads better as faces alone.
  const studioCircles = view.studios === 1;
  const look = LOOK;
  const circles = mode === "studios" && studioCircles;
  // Only trust the edges once they belong to the mode being asked for;
  // until then, the previous mode's counts would be labelled wrongly.
  const data = useMemo(() => {
    if (!fetched) return undefined;
    if (fetched.by !== mode) return { ...fetched, edges: [] };
    return circles ? withStudioCircles(fetched) : fetched;
  }, [fetched, mode, circles]);

  // The view's settings, from the URL. Memoised on the raw strings, so an
  // unchanged URL never looks like a new filter and rebuilds the layout.
  const hiddenKey = view.hidden;
  const hidden = useMemo(() => idList(hiddenKey), [hiddenKey]);
  const focusKey = view.focus;
  const depthKey = view.depth;
  const focus: Focus = useMemo(
    () => (focusKey != null ? { id: focusKey, depth: depthKey === 2 ? 2 : 1 } : null),
    [focusKey, depthKey],
  );
  const pathKey = view.path;
  const pathEnds = useMemo(() => {
    const [a, b] = idList(pathKey);
    return a != null && b != null ? ([a, b] as const) : null;
  }, [pathKey]);

  const setFocus = (next: Focus) =>
    onViewChange({ focus: next?.id, depth: next?.depth === 2 ? 2 : undefined });
  const setHidden = (next: number[]) =>
    onViewChange({ hidden: next.length > 0 ? next.join(",") : undefined });

  const [showIsolated, setShowIsolated] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState<number | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [minimapVisible, setMinimapVisible] = useState(false);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const { add: addToQueue } = useQueue();
  // Each view (studios, videos, studios with chips) has its own arrangement.
  const layoutKey = `${mode}${circles ? "+chips" : ""}`;
  const pinsRef = useRef<{ layout: string; pins: Pins }>({ layout: "", pins: {} });
  if (pinsRef.current.layout !== layoutKey) {
    pinsRef.current = { layout: layoutKey, pins: readPins(layoutKey) };
  }
  const [pinCount, setPinCount] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation | null>(null);
  const viewRef = useRef<View>({ k: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const dirtyRef = useRef(true);
  // Until you pan or zoom, the view keeps re-fitting as the layout settles,
  // so the graph grows into the frame instead of spilling out of it.
  const userMovedRef = useRef(false);
  const imagesRef = useRef(new Map<number, HTMLImageElement | "failed">());

  const allNodes = data?.nodes;
  const allEdges = data?.edges;
  const nodesById = useMemo(
    () => new Map((allNodes ?? []).map((node) => [node.id, node])),
    [allNodes],
  );

  const graph = useMemo(() => {
    const hiddenSet = new Set(hidden);
    let nodes = (allNodes ?? []).filter((node) => !hiddenSet.has(node.id));
    const present = new Set(nodes.map((n) => n.id));
    let edges = (allEdges ?? []).filter(
      (edge) => present.has(edge.source) && present.has(edge.target),
    );

    // Focus: a breadth-first walk out from one performer over the links that
    // survived the filters above, so hiding someone also cuts paths through them.
    const focusId = focus && present.has(focus.id) ? focus.id : null;
    if (focusId != null && focus) {
      const keep = new Set([focusId]);
      let frontier = new Set([focusId]);
      for (let step = 0; step < focus.depth; step++) {
        const next = new Set<number>();
        for (const edge of edges) {
          for (const [from, to] of [
            [edge.source, edge.target],
            [edge.target, edge.source],
          ]) {
            if (frontier.has(from) && !keep.has(to)) {
              keep.add(to);
              next.add(to);
            }
          }
        }
        frontier = next;
      }
      nodes = nodes.filter((node) => keep.has(node.id));
      edges = edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target));
    }

    const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    nodes = nodes.filter((node) => showIsolated || connected.has(node.id) || node.id === focusId);
    const neighbours = new Map<number, { id: number; together: number; shared?: string[] }[]>();
    for (const edge of edges) {
      for (const [from, to] of [
        [edge.source, edge.target],
        [edge.target, edge.source],
      ]) {
        const list = neighbours.get(from) ?? [];
        list.push({ id: to, together: edge.together, shared: edge.shared });
        neighbours.set(from, list);
      }
    }
    for (const list of neighbours.values()) list.sort((a, b) => b.together - a.together);

    // The connection between two performers: the fewest steps between them
    // over what is drawn, found breadth-first. `null` when there is none.
    let path: number[] | null = null;
    if (pathEnds && pathEnds[0] !== pathEnds[1]) {
      const [start, goal] = pathEnds;
      const cameFrom = new Map<number, number>([[start, start]]);
      const queue = [start];
      while (queue.length > 0 && !cameFrom.has(goal)) {
        const at = queue.shift()!;
        for (const { id } of neighbours.get(at) ?? []) {
          if (!cameFrom.has(id)) {
            cameFrom.set(id, at);
            queue.push(id);
          }
        }
      }
      if (cameFrom.has(goal)) {
        path = [goal];
        while (path[0] !== start) path.unshift(cameFrom.get(path[0])!);
      }
    }
    return { nodes, edges, neighbours, focusId, path };
  }, [allNodes, allEdges, showIsolated, hidden, focus, pathEnds]);

  // The selection, resolved against what is currently drawn: a performer who
  // has been hidden or filtered away closes their panel rather than lingering.
  const selectedNode =
    selection?.kind === "node" && graph.nodes.some((n) => n.id === selection.id)
      ? nodesById.get(selection.id)
      : undefined;
  const selectedEdge =
    selection?.kind === "edge" ? graph.edges.find((e) => sameEdge(e, selection)) ?? null : null;
  const selectedId = selectedNode?.id ?? null;

  // Studios ranked by how many performers they colour, over everyone rather
  // than whoever is on screen, so colours stay put as you filter.
  const studioColour = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of allNodes ?? []) {
      if (node.topStudio && node.kind !== "studio") counts.set(node.topStudio, (counts.get(node.topStudio) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return new Map(ranked.slice(0, STUDIO_COLOURS.length).map(([name], i) => [name, STUDIO_COLOURS[i]]));
  }, [allNodes]);
  const colourOf = (node: NetworkNode) =>
    (node.topStudio && studioColour.get(node.topStudio)) || OTHER;

  // Everything the draw loop reads lives in refs, so the loop is started once
  // and never torn down just because a hover changed.
  // Typing a name dims everyone who doesn't match, before one is picked.
  const searchTerm = search.trim().toLowerCase();
  const searchHits = useMemo(() => {
    if (!searchTerm) return null;
    return new Set(graph.nodes.filter((n) => n.name.toLowerCase().includes(searchTerm)).map((n) => n.id));
  }, [graph.nodes, searchTerm]);

  const drawState = useRef({ graph, hover, selectedId, selectedEdge, discreet, discreetText, nodesById, look, colourOf, searchHits });
  drawState.current = { graph, hover, selectedId, selectedEdge, discreet, discreetText, nodesById, look, colourOf, searchHits };
  useEffect(() => {
    dirtyRef.current = true;
  }, [graph, hover, selectedId, selectedEdge, discreet, discreetText, studioColour, searchHits]);

  // A new mode, focus or hidden set is a new picture; frame it afresh.
  const reframe = () => {
    userMovedRef.current = false;
  };

  // Camera moves you ask for (fit, jump to someone) glide rather than cut;
  // the continuous re-fit while the layout settles stays immediate.
  const cameraRef = useRef<{ from: View; to: View; start: number } | null>(null);
  const moveCamera = (to: View, animate: boolean) => {
    if (!animate || motion !== "full") {
      cameraRef.current = null;
      viewRef.current = to;
    } else {
      cameraRef.current = { from: { ...viewRef.current }, to, start: performance.now() };
    }
    dirtyRef.current = true;
  };
  // When each circle first appeared, so newcomers fade in.
  const appearedRef = useRef(new Map<number, number>());

  const fit = (animate = false) => {
    const sim = simRef.current;
    const { w, h } = sizeRef.current;
    if (!sim || sim.nodes.length === 0 || w === 0) return;
    const box = bounds(sim.nodes);
    const pad = 48;
    const k = Math.min(
      2,
      (w - pad * 2) / Math.max(1, box.maxX - box.minX),
      (h - pad * 2) / Math.max(1, box.maxY - box.minY),
    );
    moveCamera(
      {
        k,
        x: w / 2 - ((box.minX + box.maxX) / 2) * k,
        y: h / 2 - ((box.minY + box.maxY) / 2) * k,
      },
      animate,
    );
  };

  // A new simulation whenever the visible set changes. Positions carry over
  // for anyone still on screen, so loosening a filter adds people around the
  // existing picture instead of scrambling it.
  useEffect(() => {
    const previous = new Map((simRef.current?.nodes ?? []).map((n) => [n.id, n]));
    const sim = createSimulation(
      graph.nodes.map((node) => ({ id: node.id, radius: nodeRadius(node, look.scale) })),
      graph.edges.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.together })),
    );
    let reused = 0;
    const now = performance.now();
    for (const node of sim.nodes) {
      const old = previous.get(node.id);
      if (old) {
        node.x = old.x;
        node.y = old.y;
        reused++;
      } else if (motion === "full") {
        appearedRef.current.set(node.id, now);
      }
    }
    // Anyone you've dragged into place stays there.
    const pins = pinsRef.current.pins;
    for (const node of sim.nodes) {
      const pin = pins[node.id];
      if (pin) {
        node.x = node.fx = pin[0];
        node.y = node.fy = pin[1];
      }
    }
    setPinCount(Object.keys(pins).length);
    if (reused > 0) sim.alpha = 0.5;
    if (motion !== "full") settle(sim);
    simRef.current = sim;
    if (!userMovedRef.current || motion !== "full") fit();
    dirtyRef.current = true;
    // `fit` only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, motion]);

  // Portraits load lazily and redraw the frame when each one arrives.
  useEffect(() => {
    if (discreet) return;
    for (const node of graph.nodes) {
      if (node.kind === "studio" || imagesRef.current.has(node.id)) continue;
      const src = performerPortraitUrl(node);
      if (!src) {
        imagesRef.current.set(node.id, "failed");
        continue;
      }
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        dirtyRef.current = true;
      };
      img.onerror = () => {
        imagesRef.current.set(node.id, "failed");
        dirtyRef.current = true;
      };
      img.src = src;
      imagesRef.current.set(node.id, img);
    }
  }, [graph.nodes, discreet]);

  // Keeps the canvas backing store matched to its box and the screen's
  // pixel density, so lines stay crisp on a retina display.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const first = sizeRef.current.w === 0;
      sizeRef.current = { w: width, h: height };
      if (first || !userMovedRef.current) fit();
      dirtyRef.current = true;
    });
    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The one animation loop: advance the layout while it is still moving,
  // and repaint only when something changed.
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const sim = simRef.current;
      if (sim && sim.alpha > ALPHA_MIN) {
        tick(sim);
        if (!userMovedRef.current && !cameraRef.current) fit();
        dirtyRef.current = true;
      }
      const camera = cameraRef.current;
      if (camera) {
        const t = Math.min(1, (performance.now() - camera.start) / CAMERA_MS);
        const e = easeInOut(t);
        viewRef.current = {
          k: camera.from.k + (camera.to.k - camera.from.k) * e,
          x: camera.from.x + (camera.to.x - camera.from.x) * e,
          y: camera.from.y + (camera.to.y - camera.from.y) * e,
        };
        if (t >= 1) cameraRef.current = null;
        dirtyRef.current = true;
      }
      if (appearedRef.current.size > 0) dirtyRef.current = true;
      if (dirtyRef.current) {
        dirtyRef.current = false;
        draw();
      }
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !sim) return;
    const {
      graph,
      hover,
      selectedId,
      selectedEdge,
      discreet,
      discreetText,
      nodesById,
      look,
      colourOf,
      searchHits,
    } = drawState.current;
    const dpr = window.devicePixelRatio || 1;
    const view = viewRef.current;
    const px = (n: number) => n / view.k; // screen pixels → world units

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (look.vignette) {
      const g = ctx.createRadialGradient(
        canvas.width / 2, canvas.height * 0.45, 0,
        canvas.width / 2, canvas.height * 0.45, Math.hypot(canvas.width, canvas.height) * 0.6,
      );
      g.addColorStop(0, "#1b1b1d");
      g.addColorStop(1, "#0c0c0d");
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = STYLE.background;
    }
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Ambient glows, fixed to the frame rather than the graph, so panning
    // moves the graph across them and the space feels deep, not flat.
    if (look.glows > 0) {
      const w = canvas.width;
      const h = canvas.height;
      const spots: [number, number, number, string][] = [
        [0.15, 0.2, 0.55, STUDIO_COLOURS[0]],
        [0.85, 0.8, 0.6, STUDIO_COLOURS[1]],
        [0.8, 0.15, 0.4, STUDIO_COLOURS[6]],
        [0.25, 0.9, 0.45, STUDIO_COLOURS[4]],
      ];
      for (const [fx, fy, size, colour] of spots) {
        const r = Math.max(w, h) * size;
        const glow = ctx.createRadialGradient(w * fx, h * fy, 0, w * fx, h * fy, r);
        glow.addColorStop(0, withAlpha(colour, look.glows));
        glow.addColorStop(1, withAlpha(colour, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
      }
    }

    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);

    // The grid lives in graph space, so it pans and zooms with the graph.
    // Its spacing doubles as you zoom out, so it never turns into a haze.
    if (look.grid.minor > 0 || look.grid.major > 0) {
      let spacing = 40;
      while (spacing * view.k < 22) spacing *= 2;
      const major = spacing * 4;
      const left = -view.x / view.k;
      const top = -view.y / view.k;
      const right = left + canvas.width / dpr / view.k;
      const bottom = top + canvas.height / dpr / view.k;
      ctx.lineWidth = 1 / view.k;
      for (const [step, alpha] of [
        [spacing, look.grid.minor],
        [major, look.grid.major],
      ] as const) {
        if (alpha <= 0) continue;
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.beginPath();
        for (let gx = Math.floor(left / step) * step; gx <= right; gx += step) {
          // The major pass draws these; skipping them here keeps them crisp.
          if (step === spacing && Math.round(gx / major) * major === gx) continue;
          ctx.moveTo(gx, top);
          ctx.lineTo(gx, bottom);
        }
        for (let gy = Math.floor(top / step) * step; gy <= bottom; gy += step) {
          if (step === spacing && Math.round(gy / major) * major === gy) continue;
          ctx.moveTo(left, gy);
          ctx.lineTo(right, gy);
        }
        ctx.stroke();
      }
    }

    const now = performance.now();
    const appear = (id: number) => {
      const at = appearedRef.current.get(id);
      if (at == null) return 1;
      const t = (now - at) / FADE_MS;
      if (t >= 1) {
        appearedRef.current.delete(id);
        return 1;
      }
      return easeInOut(Math.max(0, t));
    };

    const simById = new Map(sim.nodes.map((n) => [n.id, n]));
    const focusId = hover?.kind === "node" ? hover.id : selectedId;
    const focusEdge = hover?.kind === "edge" ? hover.edge : hover ? null : selectedEdge;
    const lit = new Set<number>();
    if (focusId != null) {
      lit.add(focusId);
      for (const n of graph.neighbours.get(focusId) ?? []) lit.add(n.id);
    }
    if (focusEdge) {
      lit.add(focusEdge.source);
      lit.add(focusEdge.target);
    }
    // A traced connection stays lit until it's cleared, whatever you hover.
    const pathEdges = new Set<string>();
    if (graph.path) {
      for (const id of graph.path) lit.add(id);
      for (let i = 1; i < graph.path.length; i++) {
        const [a, b] = [graph.path[i - 1], graph.path[i]].sort((x, y) => x - y);
        pathEdges.add(`${a}:${b}`);
      }
    }
    if (searchHits && lit.size === 0) for (const id of searchHits) lit.add(id);
    // A search with no hits still dims everything, which is the answer.
    const dimming = lit.size > 0 || searchHits != null;

    // Lines: one hairline weight, brighter for pairs who share more.
    const strongest = Math.max(1, ...graph.edges.map((e) => e.together));
    ctx.lineWidth = px(STYLE.lineWidthPx);
    for (const edge of graph.edges) {
      const a = simById.get(edge.source);
      const b = simById.get(edge.target);
      if (!a || !b) continue;
      const [lo, hi] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
      const active =
        pathEdges.has(`${lo}:${hi}`) ||
        sameEdge(edge, focusEdge) ||
        (focusId != null && (edge.source === focusId || edge.target === focusId));
      const strength =
        strongest === 1 ? 0 : Math.log(edge.together) / Math.log(strongest);
      const { weakest, strongest: top, active: activeAlpha } = STYLE.lineAlpha;
      const alpha = active ? activeAlpha : dimming ? weakest * 0.5 : weakest + (top - weakest) * strength;
      const fade = Math.min(appear(a.id), appear(b.id));
      const nodeA = nodesById.get(a.id);
      const nodeB = nodesById.get(b.id);
      if ((look.tintedLines || (active && look.studioRings)) && nodeA && nodeB && graph.edges.length <= 800) {
        const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        const tint = Math.min(1, alpha * (look.tintedLines ? 2.2 : 1.2)) * fade;
        gradient.addColorStop(0, withAlpha(colourOf(nodeA), tint));
        gradient.addColorStop(1, withAlpha(colourOf(nodeB), tint));
        ctx.strokeStyle = gradient;
      } else {
        ctx.strokeStyle = `rgba(255,255,255,${alpha * fade})`;
      }
      ctx.lineWidth = px(STYLE.lineWidthPx * (look.tintedLines ? 1.4 : 1) * (active ? 1.4 : 1));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.textAlign = "center";
    const labels: { node: NetworkNode; x: number; y: number; r: number; lit: boolean }[] = [];
    for (const simNode of sim.nodes) {
      const node = nodesById.get(simNode.id);
      if (!node) continue;
      const { x, y, radius: r } = simNode;
      const faded = dimming && !lit.has(node.id);
      ctx.globalAlpha = (faded ? STYLE.dimmed : 1) * appear(node.id);
      const active = node.id === focusId || node.id === graph.focusId;

      const colour = colourOf(node);
      if (node.kind === "studio") {
        drawStudioChip(ctx, node.name, x, y, r, active, view.k, discreetText, look.chip, colour);
        continue;
      }

      // Shadow and glow are both a filled circle behind the portrait with a
      // canvas shadow; shadowBlur ignores the transform, so it's in device px.
      const glowing = look.glow > 0 && dimming && lit.has(node.id);
      if (look.shadows || glowing) {
        ctx.save();
        ctx.shadowColor = glowing
          ? withAlpha(look.studioRings ? colour : "#ffffff", node.id === focusId ? 0.75 : 0.4)
          : "rgba(0,0,0,0.6)";
        ctx.shadowBlur = (glowing ? (node.id === focusId ? look.glow : look.glow * 0.55) : 10) * dpr;
        ctx.shadowOffsetY = glowing ? 0 : 3 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = STYLE.placeholder;
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = STYLE.placeholder;
      ctx.fill();
      ctx.clip();
      const img = imagesRef.current.get(node.id);
      if (!discreet && img && img !== "failed" && img.complete && img.naturalWidth > 0) {
        drawPortrait(ctx, img, node, x, y, r);
      } else {
        ctx.fillStyle = STYLE.initials;
        ctx.font = `500 ${r * 0.8}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillText(node.name.trim()[0]?.toUpperCase() ?? "?", x, y + r * 0.04);
      }
      ctx.restore();

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = look.studioRings
        ? withAlpha(colour, active ? 1 : 0.75)
        : active
          ? STYLE.ringActive
          : STYLE.ring;
      ctx.lineWidth = px(look.ringPx * (active ? 1.6 : 1));
      ctx.stroke();

      if (node.isFavorite) {
        ctx.beginPath();
        ctx.arc(x + r * 0.7, y - r * 0.7, Math.max(px(3), r * 0.14), 0, Math.PI * 2);
        ctx.fillStyle = STYLE.favourite;
        ctx.fill();
      }

      if (!discreetText && !faded) labels.push({ node, x, y, r, lit: lit.has(node.id) });
    }
    ctx.globalAlpha = 1;

    // Names go on last, greedily: the people you're looking at first, then
    // the biggest. One that would overlap a name or a circle already placed
    // is skipped rather than drawn into it.
    labels.sort((a, b) => Number(b.lit) - Number(a.lit) || b.r - a.r);
    const placed: { l: number; t: number; r: number; b: number }[] = [];
    const fontPx = px(STYLE.labelPx);
    ctx.font = `450 ${fontPx}px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    for (const { node, x, y, r, lit: isLit } of labels) {
      // Zoomed in far enough, a name becomes a plate with their video count,
      // so close up the graph reads like a wall of profile cards.
      const plate = r * view.k >= look.platesAt;
      ctx.font = `${plate ? 600 : 450} ${fontPx}px Inter, ui-sans-serif, system-ui, sans-serif`;
      const detail = plate ? unit("videos", node.videoCount) : "";
      const width =
        Math.max(ctx.measureText(node.name).width, plate ? ctx.measureText(detail).width * 0.9 : 0) +
        (plate ? px(14) : 0);
      const top = y + r + px(plate ? 6 : 5);
      const height = plate ? fontPx * 2.5 + px(6) : fontPx * 1.25;
      const box = { l: x - width / 2, t: top, r: x + width / 2, b: top + height };
      const clashes =
        placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t) ||
        sim.nodes.some(
          (c) =>
            c.id !== node.id &&
            c.x + c.radius > box.l && c.x - c.radius < box.r &&
            c.y + c.radius > box.t && c.y - c.radius < box.b,
        );
      if (clashes && !(isLit && node.id === focusId)) continue;
      placed.push(box);
      if (plate) {
        ctx.beginPath();
        ctx.roundRect(box.l, box.t, width, height, px(7));
        ctx.fillStyle = "rgba(10,10,12,0.72)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.lineWidth = px(1);
        ctx.stroke();
        ctx.fillStyle = STYLE.labelActive;
        ctx.fillText(node.name, x, top + px(4));
        ctx.font = `450 ${fontPx * 0.9}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fillText(detail, x, top + px(4) + fontPx * 1.3);
      } else {
        ctx.fillStyle = isLit ? STYLE.labelActive : STYLE.label;
        ctx.fillText(node.name, x, top);
      }
    }

    drawMinimap(sim, view, graph, nodesById, colourOf);
  }

  // --- Interaction ----------------------------------------------------------

  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const view = viewRef.current;
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };

  const hitTest = (clientX: number, clientY: number): Hover => {
    const sim = simRef.current;
    if (!sim) return null;
    const p = toWorld(clientX, clientY);
    for (let i = sim.nodes.length - 1; i >= 0; i--) {
      const n = sim.nodes[i];
      if (Math.hypot(p.x - n.x, p.y - n.y) <= n.radius) return { kind: "node", id: n.id };
    }
    const simById = new Map(sim.nodes.map((n) => [n.id, n]));
    const tolerance = 5 / viewRef.current.k;
    let best: { edge: NetworkEdge; d: number } | null = null;
    for (const edge of drawState.current.graph.edges) {
      const a = simById.get(edge.source);
      const b = simById.get(edge.target);
      if (!a || !b) continue;
      const d = distanceToSegment(p.x, p.y, a, b);
      if (d <= tolerance && (!best || d < best.d)) best = { edge, d };
    }
    return best ? { kind: "edge", edge: best.edge } : null;
  };

  const sameHover = (a: Hover, b: Hover) =>
    a?.kind === b?.kind &&
    (a?.kind === "node"
      ? a.id === (b as { id: number }).id
      : a?.kind === "edge"
        ? sameEdge(a.edge, (b as { edge: NetworkEdge }).edge)
        : true);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "drag"; id: number; startX: number; startY: number; moved: boolean }
    | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number; moved: boolean }
    | { kind: "pinch"; dist: number; k: number; midX: number; midY: number; viewX: number; viewY: number }
    | null
  >(null);

  const openProfile = (id: number) => {
    const node = nodesById.get(id);
    if (node?.kind === "studio" && node.studioId != null) {
      void navigate({ to: "/studio/$studioId", params: { studioId: String(node.studioId) } });
    } else {
      void navigate({ to: "/performer/$performerId", params: { performerId: String(id) } });
    }
  };
  /** A performer's videos for one studio — what a performer–studio line means. */
  const openStudioVideos = (edge: { source: number; target: number }) => {
    const [performerId, studioNode] = edge.source < 0 ? [edge.target, edge.source] : [edge.source, edge.target];
    const performer = nodesById.get(performerId);
    const studio = nodesById.get(studioNode);
    if (performer && studio) {
      void navigate({ to: "/browse", search: { performer: performer.name, studio: studio.name } });
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // So the arrow keys and shortcuts reach the graph after any click on it.
    containerRef.current?.focus({ preventScroll: true });
    setMenu(null);
    // Only the main button drags, pans and selects; a right-click is the
    // context menu's, and must not also open the side panel.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = e.currentTarget.getBoundingClientRect();

    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      const view = viewRef.current;
      gesture.current = {
        kind: "pinch",
        dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
        k: view.k,
        midX: (p1.x + p2.x) / 2 - rect.left,
        midY: (p1.y + p2.y) / 2 - rect.top,
        viewX: view.x,
        viewY: view.y,
      };
      return;
    }

    const hit = hitTest(e.clientX, e.clientY);
    if (hit?.kind === "node") {
      gesture.current = { kind: "drag", id: hit.id, startX: e.clientX, startY: e.clientY, moved: false };
    } else {
      const view = viewRef.current;
      gesture.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        viewX: view.x,
        viewY: view.y,
        moved: false,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const g = gesture.current;

    if (!g) {
      const hit = hitTest(e.clientX, e.clientY);
      if (!sameHover(hit, hover)) setHover(hit);
      e.currentTarget.style.cursor = hit ? "pointer" : "grab";
      return;
    }

    if (g.kind === "pinch") {
      const [p1, p2] = [...pointers.current.values()];
      if (!p1 || !p2) return;
      const k = Math.min(4, Math.max(0.1, g.k * (Math.hypot(p1.x - p2.x, p1.y - p2.y) / g.dist)));
      viewRef.current = {
        k,
        x: g.midX - ((g.midX - g.viewX) / g.k) * k,
        y: g.midY - ((g.midY - g.viewY) / g.k) * k,
      };
      userMovedRef.current = true;
      dirtyRef.current = true;
      return;
    }

    const moved = Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 4;
    if (!g.moved && !moved) return;
    g.moved = true;

    if (g.kind === "drag") {
      const sim = simRef.current;
      const node = sim?.nodes.find((n) => n.id === g.id);
      if (!sim || !node) return;
      const p = toWorld(e.clientX, e.clientY);
      node.fx = p.x;
      node.fy = p.y;
      sim.alpha = Math.max(sim.alpha, 0.25);
      // Dragging should move the node, not the camera that is following it.
      userMovedRef.current = true;
    } else {
      viewRef.current = {
        ...viewRef.current,
        x: g.viewX + (e.clientX - g.startX),
        y: g.viewY + (e.clientY - g.startY),
      };
      userMovedRef.current = true;
      e.currentTarget.style.cursor = "grabbing";
    }
    dirtyRef.current = true;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.kind === "pinch") return;

    if (g.kind === "drag") {
      const node = simRef.current?.nodes.find((n) => n.id === g.id);
      if (node && g.moved) {
        // Dropped where you put them, and remembered there.
        const pins = { ...pinsRef.current.pins, [node.id]: [node.x, node.y] as [number, number] };
        pinsRef.current.pins = pins;
        writePins(layoutKey, pins);
        setPinCount(Object.keys(pins).length);
      } else if (node && !pinsRef.current.pins[node.id]) {
        node.fx = null;
        node.fy = null;
      }
      if (!g.moved) {
        setSelection((current) =>
          current?.kind === "node" && current.id === g.id ? null : { kind: "node", id: g.id },
        );
      }
    } else if (!g.moved) {
      const hit = hitTest(e.clientX, e.clientY);
      if (hit?.kind === "edge" && (hit.edge.source < 0 || hit.edge.target < 0)) {
        openStudioVideos(hit.edge);
      } else if (hit?.kind === "edge") {
        setSelection({ kind: "edge", source: hit.edge.source, target: hit.edge.target });
      } else setSelection(null);
    }
    e.currentTarget.style.cursor = "grab";
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit?.kind === "node") openProfile(hit.id);
  };

  // Wheel zoom needs a non-passive listener to stop the page scrolling too.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const view = viewRef.current;
      const k = Math.min(4, Math.max(0.1, view.k * Math.exp(-e.deltaY * 0.0015)));
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      viewRef.current = { k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k };
      userMovedRef.current = true;
      dirtyRef.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const centreOn = (id: number) => {
    const node = simRef.current?.nodes.find((n) => n.id === id);
    const { w, h } = sizeRef.current;
    if (!node) return;
    const k = Math.max(viewRef.current.k, 1.2);
    moveCamera({ k, x: w / 2 - node.x * k, y: h / 2 - node.y * k }, true);
    userMovedRef.current = true;
    dirtyRef.current = true;
  };

  const onSearch = (value: string) => {
    setSearch(value);
    const match = graph.nodes.find((n) => n.name.toLowerCase() === value.trim().toLowerCase());
    if (match) {
      setSelection({ kind: "node", id: match.id });
      centreOn(match.id);
    }
  };

  const selectPerformer = (id: number) => {
    setSelection({ kind: "node", id });
    centreOn(id);
  };
  const toggleFocus = (id: number) => {
    setFocus(focus?.id === id ? null : { id, depth: focus?.depth ?? 1 });
    reframe();
  };
  const hide = (id: number) => {
    if (!hidden.includes(id)) setHidden([...hidden, id]);
    setSelection(null);
    reframe();
  };
  const unhide = (id: number) => {
    setHidden(hidden.filter((h) => h !== id));
    reframe();
  };
  const findPath = (from: number, to: number) => {
    onViewChange({ path: `${from},${to}` });
    setSelection(null);
  };

  // Full screen takes the toolbar along, so everything stays usable there.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
    reframe();
  };
  // The player opens over the page, which a full-screen graph would hide, so
  // playing something leaves full screen first.
  const play = (itemId: number) => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setPlaying(itemId);
  };

  const unpin = (id: number) => {
    const { [id]: _removed, ...rest } = pinsRef.current.pins;
    pinsRef.current.pins = rest;
    writePins(layoutKey, rest);
    setPinCount(Object.keys(rest).length);
    const node = simRef.current?.nodes.find((n) => n.id === id);
    const sim = simRef.current;
    if (node && sim) {
      node.fx = null;
      node.fy = null;
      sim.alpha = Math.max(sim.alpha, 0.3);
    }
  };
  const resetLayout = () => {
    pinsRef.current.pins = {};
    writePins(layoutKey, {});
    setPinCount(0);
    const sim = simRef.current;
    if (sim) {
      for (const node of sim.nodes) {
        node.fx = null;
        node.fy = null;
      }
      sim.alpha = 1;
    }
    reframe();
  };

  /** Plays the first video now and queues the rest behind whatever's queued. */
  const playAll = (videos: (SharedVideo & { durationSeconds?: number | null })[]) => {
    if (videos.length === 0) return;
    for (const video of videos.slice(1)) {
      addToQueue({
        id: video.id,
        title: video.title,
        thumbnailFile: video.thumbnailFile,
        durationSeconds: video.durationSeconds ?? null,
      });
    }
    play(videos[0].id);
  };
  const playLatest = async (node: NetworkNode) => {
    const videos =
      node.kind === "studio"
        ? await fetchVideosWhere({ studio: node.name })
        : await fetchLatestVideos(node.name);
    if (videos[0]) play(videos[0].id);
  };

  // Right-click: every action for one performer in one place. Full screen
  // hides anything drawn outside the graph, the menu included, so there a
  // right-click opens their panel instead.
  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit?.kind !== "node") return;
    e.preventDefault();
    const node = nodesById.get(hit.id);
    if (!node) return;
    if (fullscreen) {
      setSelection({ kind: "node", id: node.id });
      return;
    }
    const studio = node.kind === "studio";
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        { label: studio ? "Open studio" : "Open profile", icon: ExternalLink, onSelect: () => openProfile(node.id) },
        { label: studio ? `Play ${node.name}` : "Play latest", icon: Play, onSelect: () => void playLatest(node) },
        { separator: true },
        {
          label: graph.focusId === node.id ? "Stop focusing" : "Focus",
          icon: Crosshair,
          onSelect: () => toggleFocus(node.id),
        },
        { label: "Hide", icon: EyeOff, onSelect: () => hide(node.id) },
        ...(studio
          ? []
          : [
              {
                label: "Find a connection…",
                icon: Route,
                onSelect: () => setSelection({ kind: "node", id: node.id }),
              },
            ]),
        ...(pinsRef.current.pins[node.id]
          ? [{ label: "Let them float again", icon: Pin, onSelect: () => unpin(node.id) }]
          : []),
      ],
    });
  };

  // Keyboard: arrows walk to the neighbour that lies that way, Enter opens,
  // F focuses, H hides, and Escape backs out one step at a time.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const sim = simRef.current;
    const current = selectedNode;
    const directions: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    if (directions[e.key] && sim) {
      e.preventDefault();
      if (!current) {
        // Start from whoever has the most connections.
        const start = [...graph.nodes].sort(
          (a, b) => (graph.neighbours.get(b.id)?.length ?? 0) - (graph.neighbours.get(a.id)?.length ?? 0),
        )[0];
        if (start) selectPerformer(start.id);
        return;
      }
      const from = sim.nodes.find((n) => n.id === current.id);
      if (!from) return;
      const [dx, dy] = directions[e.key];
      let best: { id: number; score: number } | null = null;
      for (const { id } of graph.neighbours.get(current.id) ?? []) {
        const to = sim.nodes.find((n) => n.id === id);
        if (!to) continue;
        const vx = to.x - from.x;
        const vy = to.y - from.y;
        const length = Math.hypot(vx, vy) || 1;
        const alignment = (vx * dx + vy * dy) / length;
        if (alignment < 0.35) continue;
        // Mostly the direction, a little the distance, so a near neighbour
        // slightly off-axis beats a far one dead ahead.
        const score = alignment - length / 4000;
        if (!best || score > best.score) best = { id, score };
      }
      if (best) selectPerformer(best.id);
      return;
    }
    if (e.key === "Escape") {
      if (menu) setMenu(null);
      else if (selection) setSelection(null);
      else if (pathEnds) onViewChange({ path: undefined });
      else if (focus) setFocus(null);
      else if (search) setSearch("");
      return;
    }
    if (!current) return;
    if (e.key === "Enter") openProfile(current.id);
    else if (e.key.toLowerCase() === "f") toggleFocus(current.id);
    else if (e.key.toLowerCase() === "h") hide(current.id);
  };

  // The minimap: the whole graph in miniature, with the part in view boxed.
  // Shown only when zoomed in past the point where you can see everything.
  function drawMinimap(
    sim: Simulation,
    view: View,
    graph: { nodes: NetworkNode[] },
    nodesById: Map<number, NetworkNode>,
    colourOf: (node: NetworkNode) => string,
  ) {
    const { w, h } = sizeRef.current;
    if (sim.nodes.length === 0 || w === 0) return;
    const box = bounds(sim.nodes);
    const seen = {
      l: -view.x / view.k,
      t: -view.y / view.k,
      r: (w - view.x) / view.k,
      b: (h - view.y) / view.k,
    };
    const covered =
      seen.l <= box.minX && seen.t <= box.minY && seen.r >= box.maxX && seen.b >= box.maxY;
    // State only when it flips, so the draw loop doesn't re-render React.
    if (covered !== coveredRef.current) {
      coveredRef.current = covered;
      setMinimapVisible(!covered);
    }
    const canvas = minimapRef.current;
    const ctx = canvas?.getContext("2d");
    if (covered || !canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const mw = canvas.clientWidth;
    const mh = canvas.clientHeight;
    if (canvas.width !== Math.round(mw * dpr)) {
      canvas.width = Math.round(mw * dpr);
      canvas.height = Math.round(mh * dpr);
    }
    const pad = 8;
    const scale = Math.min(
      (mw - pad * 2) / Math.max(1, box.maxX - box.minX),
      (mh - pad * 2) / Math.max(1, box.maxY - box.minY),
    );
    const ox = pad + (mw - pad * 2 - (box.maxX - box.minX) * scale) / 2 - box.minX * scale;
    const oy = pad + (mh - pad * 2 - (box.maxY - box.minY) * scale) / 2 - box.minY * scale;
    minimapTransform.current = { scale, ox, oy };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, mw, mh);
    for (const n of sim.nodes) {
      const node = nodesById.get(n.id);
      if (!node || !graph.nodes.includes(node)) continue;
      ctx.beginPath();
      ctx.arc(ox + n.x * scale, oy + n.y * scale, Math.max(1.5, n.radius * scale), 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(colourOf(node), 0.85);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      ox + seen.l * scale,
      oy + seen.t * scale,
      (seen.r - seen.l) * scale,
      (seen.b - seen.t) * scale,
    );
  }
  const coveredRef = useRef(true);
  const minimapTransform = useRef({ scale: 1, ox: 0, oy: 0 });
  const onMinimapClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { scale, ox, oy } = minimapTransform.current;
    const wx = (e.clientX - rect.left - ox) / scale;
    const wy = (e.clientY - rect.top - oy) / scale;
    const { w, h } = sizeRef.current;
    const k = viewRef.current.k;
    userMovedRef.current = true;
    moveCamera({ k, x: w / 2 - wx * k, y: h / 2 - wy * k }, true);
  };

  // --- Rendering ------------------------------------------------------------

  const studioCount = graph.nodes.filter((n) => n.kind === "studio").length;
  const performerCount = graph.nodes.length - studioCount;
  const hoveredEdge = hover?.kind === "edge" ? hover.edge : null;
  const totalEdges = allEdges?.length ?? 0;
  const focusedNode = graph.focusId != null ? nodesById.get(graph.focusId) : undefined;
  const loadingMode = fetched != null && fetched.by !== mode;

  // Empty when there is nothing to draw — or only a focused performer on their
  // own, which on its own reads as a glitch rather than as "no links".
  const showEmpty =
    graph.nodes.length === 0 || (graph.edges.length === 0 && !showIsolated);
  const emptyMessage =
    totalEdges > 0 && focusedNode
      ? `${focusedNode.name} has no links here with these filters.`
      : totalEdges > 0
        ? "Nobody left to show with these filters."
        : mode === "studios"
          ? "No two performers have worked for the same studio yet."
          : "No two performers share a video yet. Links appear once a file's name credits more than one performer.";

  // No early return while loading: the canvas has to exist on the first
  // render, or the effects that attach to it (sizing, wheel zoom) run against
  // nothing and never run again.
  const pathNames = graph.path?.map((id) => nodesById.get(id)).filter(Boolean) as
    | NetworkNode[]
    | undefined;
  const pathEndNodes = pathEnds ? pathEnds.map((id) => nodesById.get(id)) : null;

  return (
    <div ref={rootRef} className={cn("space-y-3", fullscreen && "overflow-y-auto bg-background p-4")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Connect by</span>
          <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label="Connect by">
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={mode === option.value}
                onClick={() => {
                  if (option.value === mode) return;
                  onViewChange({ by: option.value === "videos" ? "videos" : undefined });
                  setSelection(null);
                  reframe();
                }}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                  mode === option.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <input
          type="search"
          list="performer-network-names"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Find a performer"
          className="h-8 w-48 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        <datalist id="performer-network-names">
          {graph.nodes.map((node) => (
            <option key={node.id} value={node.name} />
          ))}
        </datalist>

        <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
          <input
            type="checkbox"
            checked={showIsolated}
            onChange={(e) => setShowIsolated(e.target.checked)}
            className="accent-foreground"
          />
          Show performers with no connections
        </label>

        {mode === "studios" && (
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              checked={studioCircles}
              onChange={(e) => {
                onViewChange({ studios: e.target.checked ? 1 : undefined });
                setSelection(null);
                reframe();
              }}
              className="accent-foreground"
            />
            Show studios in the graph
          </label>
        )}

        <span className="text-xs text-muted-foreground/70 md:ml-auto">
          {performerCount} {performerCount === 1 ? "performer" : "performers"} ·{" "}
          {studioCount > 0 && <>{studioCount} {studioCount === 1 ? "studio" : "studios"} · </>}
          {graph.edges.length}{" "}
          {graph.edges.length === 1 ? "link" : "links"}
        </span>
      </div>

      <NetworkHighlights
        mode={mode}
        nodes={graph.nodes}
        neighbours={graph.neighbours}
        onSelect={selectPerformer}
      />

      {(focusedNode || hidden.length > 0 || pathEnds) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {pathEnds && (
            <span className="flex flex-wrap items-center gap-1 rounded-full bg-secondary py-0.5 pl-2.5 pr-1">
              {pathNames ? (
                <>
                  Connection:
                  {pathNames.map((node, i) => (
                    <span key={node.id} className="flex items-center gap-1">
                      {i > 0 && <span className="text-muted-foreground">→</span>}
                      <button
                        type="button"
                        onClick={() => selectPerformer(node.id)}
                        className="sensitive font-medium hover:underline"
                      >
                        {node.name}
                      </button>
                    </span>
                  ))}
                  <span className="text-muted-foreground">
                    · {pathNames.length - 1} {pathNames.length === 2 ? "step" : "steps"}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  No connection between{" "}
                  <span className="sensitive text-foreground">{pathEndNodes?.[0]?.name ?? "them"}</span> and{" "}
                  <span className="sensitive text-foreground">{pathEndNodes?.[1]?.name ?? "them"}</span> with these
                  filters
                </span>
              )}
              <button
                type="button"
                onClick={() => onViewChange({ path: undefined })}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear the connection"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {focusedNode && (
            <span className="flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pl-2.5 pr-1">
              Focused on <span className="sensitive font-medium">{focusedNode.name}</span>
              <span className="flex rounded-full bg-background/60 p-0.5">
                {([1, 2] as const).map((depth) => (
                  <button
                    key={depth}
                    type="button"
                    aria-pressed={focus?.depth === depth}
                    onClick={() => {
                      if (focus) setFocus({ ...focus, depth });
                      reframe();
                    }}
                    className={cn(
                      "rounded-full px-1.5",
                      focus?.depth === depth ? "bg-foreground text-background" : "text-muted-foreground",
                    )}
                    title={depth === 1 ? "Their direct connections" : "And their connections' connections"}
                  >
                    {depth === 1 ? "1 step" : "2 steps"}
                  </button>
                ))}
              </span>
              <button
                type="button"
                onClick={() => {
                  setFocus(null);
                  reframe();
                }}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Stop focusing"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {hidden.length > 0 && <span className="text-muted-foreground">Hidden:</span>}
          {hidden.map((id) => (
            <span key={id} className="flex items-center gap-1 rounded-full bg-secondary py-0.5 pl-2.5 pr-1">
              <span className="sensitive">{nodesById.get(id)?.name ?? "Unknown"}</span>
              <button
                type="button"
                onClick={() => unhide(id)}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Show again"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {hidden.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setHidden([]);
                reframe();
              }}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Show everyone
            </button>
          )}
        </div>
      )}

      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={cn(
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "relative overflow-hidden rounded-xl border border-border",
          fullscreen ? "h-[calc(100dvh-13rem)] min-h-[360px]" : "h-[calc(100dvh-17rem)] min-h-[420px]",
        )}
        style={{ background: STYLE.background }}
      >
        <canvas
          ref={canvasRef}
          className="block touch-none select-none"
          style={{ cursor: "grab" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (!gesture.current && hover) setHover(null);
          }}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          aria-label="Graph of how performers connect to each other"
          role="img"
        />

        {(isLoading || loadingMode) && (
          <p className="pointer-events-none absolute left-3 top-3 rounded-md bg-popover/90 px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-border">
            Loading…
          </p>
        )}

        {!isLoading && !loadingMode && showEmpty && (
          // Opaque, so a lone focused performer doesn't show through the text.
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
            style={{ background: STYLE.background }}
          >
            <p className="max-w-sm text-sm text-muted-foreground">{emptyMessage}</p>
            {!showIsolated && (allNodes?.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setShowIsolated(true)}
                className="rounded-md bg-secondary px-3 py-1.5 text-sm hover:bg-accent"
              >
                Show everyone anyway
              </button>
            )}
          </div>
        )}

        {hoveredEdge && !sameEdge(hoveredEdge, selectedEdge) && (
          <EdgeHoverCard
            mode={mode}
            edge={hoveredEdge}
            a={nodesById.get(hoveredEdge.source)}
            b={nodesById.get(hoveredEdge.target)}
            studioLink={hoveredEdge.source < 0 || hoveredEdge.target < 0}
          />
        )}

        <button
          type="button"
          onClick={() => {
            userMovedRef.current = false;
            fit(true);
          }}
          title="Fit everyone in view"
          className="absolute right-3 top-3 grid size-8 place-items-center rounded-md bg-popover/90 text-muted-foreground ring-1 ring-border hover:text-foreground"
        >
          <Maximize2 className="size-4" />
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          title={fullscreen ? "Leave full screen" : "Full screen"}
          className="absolute right-3 top-12 grid size-8 place-items-center rounded-md bg-popover/90 text-muted-foreground ring-1 ring-border hover:text-foreground"
        >
          {fullscreen ? <Shrink className="size-4" /> : <Expand className="size-4" />}
        </button>
        {pinCount > 0 && (
          <button
            type="button"
            onClick={resetLayout}
            title={`Let the ${pinCount} you've placed float again`}
            className="absolute right-3 top-[5.25rem] grid size-8 place-items-center rounded-md bg-popover/90 text-muted-foreground ring-1 ring-border hover:text-foreground"
          >
            <LayoutGrid className="size-4" />
          </button>
        )}

        <canvas
          ref={minimapRef}
          onClick={onMinimapClick}
          title="Click to move there"
          className={cn(
            "absolute bottom-3 right-3 h-[110px] w-[170px] cursor-pointer rounded-md bg-black/55 ring-1 ring-border backdrop-blur-sm transition-opacity",
            minimapVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />

        {hover?.kind === "node" && !selectedNode && nodesById.get(hover.id)?.kind !== "studio" && (
          <NodeHoverCard performer={nodesById.get(hover.id)!} />
        )}

        {selectedNode?.kind === "studio" && (
          <StudioPanel
            studio={selectedNode}
            members={graph.neighbours.get(selectedNode.id) ?? []}
            nodesById={nodesById}
            focused={graph.focusId === selectedNode.id}
            onClose={() => setSelection(null)}
            onOpenPage={() => openProfile(selectedNode.id)}
            onFocus={() => toggleFocus(selectedNode.id)}
            onHide={() => hide(selectedNode.id)}
            onSelectPerformer={selectPerformer}
            onPlayAll={playAll}
            onOpenVideos={(performerId) =>
              openStudioVideos({ source: performerId, target: selectedNode.id })
            }
          />
        )}

        {selectedNode && selectedNode.kind !== "studio" && (
          <PerformerPanel
            mode={mode}
            performer={selectedNode}
            neighbours={graph.neighbours.get(selectedNode.id) ?? []}
            nodesById={nodesById}
            focused={graph.focusId === selectedNode.id}
            onClose={() => setSelection(null)}
            onOpenProfile={() => openProfile(selectedNode.id)}
            onFocus={() => toggleFocus(selectedNode.id)}
            onHide={() => hide(selectedNode.id)}
            onSelectPerformer={selectPerformer}
            onSelectPair={(otherId) =>
              otherId < 0
                ? openStudioVideos({ source: selectedNode.id, target: otherId })
                : setSelection({ kind: "edge", source: selectedNode.id, target: otherId })
            }
            onPlay={play}
            connectTo={graph.nodes.filter((n) => n.kind !== "studio" && n.id !== selectedNode.id)}
            onFindPath={(otherId) => findPath(selectedNode.id, otherId)}
          />
        )}

        {selectedEdge && nodesById.get(selectedEdge.source) && nodesById.get(selectedEdge.target) && (
          <PairPanel
            mode={mode}
            edge={selectedEdge}
            a={nodesById.get(selectedEdge.source)!}
            b={nodesById.get(selectedEdge.target)!}
            onClose={() => setSelection(null)}
            onSelectPerformer={selectPerformer}
            onPlayAll={playAll}
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground/70">
        Drag to pan, scroll or pinch to zoom. Click someone for their panel, double-click for their
        profile, right-click for everything else, and click a line to see what links a pair. Drag
        someone to place them and they stay put. With the graph focused, the arrow keys step between
        neighbours, Enter opens, F focuses, H hides and Esc backs out. A red dot marks a favourite.
      </p>

      {playing != null && (
        <MediaDetailModal itemId={playing} autoPlay onClose={() => setPlaying(null)} />
      )}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

/**
 * A studio, drawn as a chip with its name — the same shape as the studio
 * chips on the library page, so it reads as a place rather than a person.
 */
function drawStudioChip(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  r: number,
  active: boolean,
  k: number,
  hideName: boolean,
  style: Look["chip"],
  colour: string,
) {
  const height = STYLE.chipPx * 2.2 / Math.max(k, 0.4);
  const width = r * 2;
  ctx.beginPath();
  ctx.roundRect(x - width / 2, y - height / 2, width, height, height / 2);
  ctx.fillStyle = STYLE.chip;
  ctx.fill();
  if (style === "tinted") {
    ctx.fillStyle = withAlpha(colour, 0.2);
    ctx.fill();
  }
  ctx.strokeStyle = active
    ? STYLE.ringActive
    : style === "tinted"
      ? withAlpha(colour, 0.7)
      : STYLE.chipBorder;
  ctx.lineWidth = (active ? 1.75 : 1) / k;
  ctx.stroke();
  if (hideName) return;
  ctx.font = `550 ${STYLE.chipPx / Math.max(k, 0.4)}px Inter, ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  const dot = style === "dot" ? (STYLE.chipPx * 0.32) / Math.max(k, 0.4) : 0;
  const textWidth = Math.min(ctx.measureText(name).width, width - 12 / k - dot * 3);
  if (dot) {
    ctx.beginPath();
    ctx.arc(x - textWidth / 2 - dot * 1.6, y, dot, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }
  ctx.fillStyle = style === "tinted" ? "rgba(255,255,255,0.95)" : STYLE.chipText;
  ctx.fillText(name, x + dot * 0.9, y + 0.5 / k, width - 12 / k - dot * 3);
}

/**
 * Paints a portrait into the node's circle with `object-fit: cover`, honouring
 * the performer's saved framing the same way `portraitStyle` does in CSS.
 */
function drawPortrait(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  node: NetworkNode,
  cx: number,
  cy: number,
  r: number,
) {
  const size = r * 2;
  // Round, so it takes the circle's framing rather than the tiles'.
  const framing = circleFraming(node);
  const px = (framing.imagePositionX ?? 50) / 100;
  const py = (framing.imagePositionY ?? 0) / 100;
  const scale = (framing.imageScale ?? 100) / 100;
  const cover = Math.max(size / img.naturalWidth, size / img.naturalHeight);
  const w = img.naturalWidth * cover;
  const h = img.naturalHeight * cover;
  // object-position first, then the zoom about that same point.
  const ox = (size - w) * px;
  const oy = (size - h) * py;
  const left = cx - r;
  const top = cy - r;
  const originX = size * px;
  const originY = size * py;
  ctx.drawImage(
    img,
    left + originX + (ox - originX) * scale,
    top + originY + (oy - originY) * scale,
    w * scale,
    h * scale,
  );
}
