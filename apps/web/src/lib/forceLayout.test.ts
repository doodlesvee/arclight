import { describe, expect, it } from "vitest";
import { createSimulation, settle, ALPHA_MIN } from "./forceLayout";

const node = (id: number) => ({ id, radius: 12 });

describe("forceLayout", () => {
  it("settles, with partners closer together than strangers", () => {
    // 1–2 are a pair, 3–4 are a pair, and nobody links the two pairs.
    const sim = createSimulation(
      [node(1), node(2), node(3), node(4)],
      [
        { source: 1, target: 2, weight: 3 },
        { source: 3, target: 4, weight: 3 },
      ],
    );
    settle(sim, 1000);
    expect(sim.alpha).toBeLessThanOrEqual(ALPHA_MIN);

    const at = (id: number) => sim.nodes.find((n) => n.id === id)!;
    const dist = (a: number, b: number) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    expect(dist(1, 2)).toBeLessThan(dist(1, 3));
    expect(dist(3, 4)).toBeLessThan(dist(2, 4));
  });

  it("never leaves two avatars overlapping", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node(i));
    const links = nodes.slice(1).map((n) => ({ source: 0, target: n.id, weight: 1 }));
    const sim = createSimulation(nodes, links);
    settle(sim, 1000);
    for (const a of sim.nodes) {
      for (const b of sim.nodes) {
        if (a === b) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.radius + b.radius - 1);
      }
    }
  });

  it("lays out the same way every time", () => {
    const build = () => {
      const sim = createSimulation([node(1), node(2), node(3)], [{ source: 1, target: 2, weight: 1 }]);
      settle(sim);
      return sim.nodes.map((n) => [Math.round(n.x), Math.round(n.y)]);
    };
    expect(build()).toEqual(build());
  });
});
