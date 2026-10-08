/** A replay count has to reach this before the seek bar draws it as a peak. */
export const HEATMAP_MIN_PEAK = 2;

/**
 * Where the most-replayed part starts, in seconds, or null when there is not
 * enough watching yet to say.
 *
 * Each bucket is scored with its neighbours, so a lone spike does not beat a
 * broad stretch that was replayed again and again. Ties go to the bucket with more replays itself, then the earliest.
 */
export function bestPartSeconds(buckets: number[] | undefined, duration: number): number | null {
  if (!buckets || buckets.length === 0 || !(duration > 0)) return null;
  if (Math.max(...buckets) < HEATMAP_MIN_PEAK) return null;

  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < buckets.length; i++) {
    const score = (buckets[i - 1] ?? 0) + buckets[i] + (buckets[i + 1] ?? 0);
    if (score > bestScore || (score === bestScore && buckets[i] > buckets[bestIndex])) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return Math.floor((bestIndex / buckets.length) * duration);
}
