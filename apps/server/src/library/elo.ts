export const START_SCORE = 1000;
export const K_FACTOR = 32;

/** Chance, from 0 to 1, that a player scored `a` beats one scored `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/**
 * Both new scores after a duel.
 *
 * Rounded to whole points, and the loser's change is the winner's mirrored, so
 * a duel never creates or destroys points between two items.
 */
export function applyDuel(
  winner: number,
  loser: number,
  k = K_FACTOR,
): { winner: number; loser: number } {
  const gain = Math.round(k * (1 - expectedScore(winner, loser)));
  return { winner: winner + gain, loser: loser - gain };
}
