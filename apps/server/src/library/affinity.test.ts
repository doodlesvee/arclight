import { describe, expect, it } from "vitest";
import { affinityEdges, type Holding } from "./affinity.js";

const hold = (performerId: number, key: number, label = `k${key}`): Holding => ({
  performerId,
  key,
  label,
});

const pairOf = (e: { source: number; target: number }) => [e.source, e.target];

describe("affinityEdges", () => {
  it("links everyone who shares an attribute, counting what they share", () => {
    const edges = affinityEdges([hold(1, 10, "Outdoor"), hold(2, 10, "Outdoor"), hold(1, 11, "POV"), hold(2, 11, "POV")]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 1, target: 2, together: 2 });
    expect(edges[0].shared.sort()).toEqual(["Outdoor", "POV"]);
  });

  it("lists the rarest shared attribute first", () => {
    const edges = affinityEdges([
      hold(1, 10, "Common"),
      hold(2, 10, "Common"),
      hold(3, 10, "Common"),
      hold(1, 11, "Rare"),
      hold(2, 11, "Rare"),
    ]);
    const pair = edges.find((e) => e.source === 1 && e.target === 2)!;
    expect(pair.shared).toEqual(["Rare", "Common"]);
  });

  it("keeps only each performer's strongest links", () => {
    // Performer 1 shares a rare attribute with 2, and a common one with everyone.
    const holdings = [hold(1, 99), hold(2, 99)];
    for (let p = 1; p <= 6; p++) holdings.push(hold(p, 1));
    const edges = affinityEdges(holdings, { perPerformer: 1 });
    const fromOne = edges.filter((e) => e.source === 1 || e.target === 1).map(pairOf);
    expect(fromOne).toContainEqual([1, 2]);
    // Every performer still has at least one link.
    const linked = new Set(edges.flatMap(pairOf));
    expect([...linked].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("skips attributes held by too many to mean anything", () => {
    const holdings = [1, 2, 3, 4].map((p) => hold(p, 1));
    expect(affinityEdges(holdings, { maxHolders: 3 })).toEqual([]);
  });
});
