/**
 * Links performers by what they have in common — such as studios — rather
 * than by videos they appear in together.
 *
 * Shared attributes connect far more people than shared videos do: one
 * studio links everyone who has worked for it, so drawn naively a big studio
 * becomes a solid block of lines. Two things keep the graph readable:
 *
 * - Rarer in common counts for more. Each shared attribute adds
 *   1 / log2(1 + holders), so a tag three performers have bonds them far
 *   more than one three hundred have. Attributes held by more than
 *   `maxHolders` are skipped outright — they say nothing about anyone, and
 *   their pairs are quadratic in the number of holders.
 * - Each performer keeps only their `perPerformer` strongest links. A pair
 *   survives if it is in the top list of either end, so nobody loses their
 *   one real connection to a popular partner's cut-off.
 */

export type Holding = { performerId: number; key: number; label: string };

export type AffinityEdge = {
  source: number;
  target: number;
  /** How many attributes the pair share. */
  together: number;
  /** Their names, rarest first — the most telling ones lead. */
  shared: string[];
};

type Pair = { source: number; target: number; score: number; shared: { label: string; holders: number }[] };

export function affinityEdges(
  holdings: Holding[],
  { perPerformer = 10, maxHolders = 200 }: { perPerformer?: number; maxHolders?: number } = {},
): AffinityEdge[] {
  const groups = new Map<number, { label: string; members: Set<number> }>();
  for (const { performerId, key, label } of holdings) {
    const group = groups.get(key) ?? { label, members: new Set<number>() };
    group.members.add(performerId);
    groups.set(key, group);
  }

  const pairs = new Map<string, Pair>();
  for (const { label, members } of groups.values()) {
    if (members.size < 2 || members.size > maxHolders) continue;
    const weight = 1 / Math.log2(1 + members.size);
    const ids = [...members].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const id = `${ids[i]}:${ids[j]}`;
        const pair = pairs.get(id) ?? { source: ids[i], target: ids[j], score: 0, shared: [] };
        pair.score += weight;
        pair.shared.push({ label, holders: members.size });
        pairs.set(id, pair);
      }
    }
  }

  const byPerformer = new Map<number, Pair[]>();
  for (const pair of pairs.values()) {
    for (const end of [pair.source, pair.target]) {
      const list = byPerformer.get(end) ?? [];
      list.push(pair);
      byPerformer.set(end, list);
    }
  }
  const kept = new Set<Pair>();
  for (const list of byPerformer.values()) {
    // Ties broken by the other end's id, so the cut-off is stable between loads.
    list.sort((a, b) => b.score - a.score || a.source + a.target - (b.source + b.target));
    for (const pair of list.slice(0, perPerformer)) kept.add(pair);
  }

  return [...kept].map((pair) => ({
    source: pair.source,
    target: pair.target,
    together: pair.shared.length,
    shared: pair.shared
      .sort((a, b) => a.holders - b.holders || a.label.localeCompare(b.label))
      .map((s) => s.label),
  }));
}
