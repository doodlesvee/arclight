/**
 * A small force-directed layout for the performer network.
 *
 * Written here rather than pulled in from d3-force: the graph needs four
 * forces and nothing else, and a dependency would also have to be installed
 * into the dev containers' separate node_modules volume. Repulsion is the
 * plain all-pairs version, which is fine into the low thousands of nodes —
 * a personal library's cast list, not a social network.
 */

export type SimNode = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Pinned position while being dragged; the forces leave it alone. */
  fx?: number | null;
  fy?: number | null;
};

export type SimLink = { source: number; target: number; weight: number };

export type Simulation = {
  nodes: SimNode[];
  links: SimLink[];
  /** Cools towards zero; the layout is settled once it drops below `ALPHA_MIN`. */
  alpha: number;
};

export const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 0.0228; // ~300 ticks from 1 to ALPHA_MIN, as d3 does
const VELOCITY_DECAY = 0.4;
const CHARGE = 300;
const GRAVITY = 0.02;
const LINK_STRENGTH = 0.5;

/**
 * Seeds positions on a phyllotaxis spiral, so the start is spread out and
 * deterministic — the same library settles into the same picture each load
 * instead of a different random one.
 */
export function createSimulation(
  nodes: Omit<SimNode, "x" | "y" | "vx" | "vy">[],
  links: SimLink[],
): Simulation {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return {
    nodes: nodes.map((node, i) => {
      const r = 30 * Math.sqrt(i + 0.5);
      return { ...node, x: r * Math.cos(i * golden), y: r * Math.sin(i * golden), vx: 0, vy: 0 };
    }),
    links,
    alpha: 1,
  };
}

export function tick(sim: Simulation): void {
  const { nodes, links } = sim;
  const alpha = sim.alpha;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Links pull pairs towards a rest length that shrinks as they share more,
  // so frequent partners sit close together.
  for (const link of links) {
    const a = byId.get(link.source);
    const b = byId.get(link.target);
    if (!a || !b) continue;
    const dx = b.x + b.vx - (a.x + a.vx);
    const dy = b.y + b.vy - (a.y + a.vy);
    const dist = Math.hypot(dx, dy) || 1;
    const rest = a.radius + b.radius + 36 / Math.sqrt(link.weight);
    const pull = ((dist - rest) / dist) * alpha * LINK_STRENGTH * Math.min(3, link.weight);
    a.vx += dx * pull * 0.5;
    a.vy += dy * pull * 0.5;
    b.vx -= dx * pull * 0.5;
    b.vy -= dy * pull * 0.5;
  }

  // Everyone pushes everyone apart, and overlapping circles are separated
  // outright so avatars never sit on top of each other.
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 === 0) {
        dx = (i - j) * 0.01;
        dy = 0.01;
        d2 = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(d2);
      // Falls off as 1/distance, as d3's many-body force does.
      const push = (CHARGE * alpha) / Math.max(d2, 100);
      const minDist = a.radius + b.radius + 6;
      const overlap = dist < minDist ? ((minDist - dist) / dist) * 0.5 : 0;
      const fx = dx * (push + overlap);
      const fy = dy * (push + overlap);
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (const node of nodes) {
    // Weak pull to the centre, so separate clusters stay on screen rather
    // than drifting off to the edges.
    node.vx -= node.x * GRAVITY * alpha;
    node.vy -= node.y * GRAVITY * alpha;
    if (node.fx != null && node.fy != null) {
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= 1 - VELOCITY_DECAY;
    node.vy *= 1 - VELOCITY_DECAY;
    node.x += node.vx;
    node.y += node.vy;
  }

  sim.alpha += (0 - sim.alpha) * ALPHA_DECAY;
}

/** Runs the layout to rest in one go, for reduced motion and for tests. */
export function settle(sim: Simulation, maxTicks = 400): void {
  for (let i = 0; i < maxTicks && sim.alpha > ALPHA_MIN; i++) tick(sim);
}

export function bounds(nodes: SimNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.radius);
    minY = Math.min(minY, n.y - n.radius);
    maxX = Math.max(maxX, n.x + n.radius);
    maxY = Math.max(maxY, n.y + n.radius);
  }
  return { minX, minY, maxX, maxY };
}
