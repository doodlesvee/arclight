import { describe, expect, it } from "vitest";
import { applyDuel, expectedScore } from "./elo.js";

describe("expectedScore", () => {
  it("is even between equal scores", () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5);
  });

  it("favours the higher score and sums to one", () => {
    const high = expectedScore(1200, 1000);
    expect(high).toBeGreaterThan(0.7);
    expect(high + expectedScore(1000, 1200)).toBeCloseTo(1);
  });
});

describe("applyDuel", () => {
  it("moves 16 points between equal scores", () => {
    expect(applyDuel(1000, 1000)).toEqual({ winner: 1016, loser: 984 });
  });

  it("rewards an upset more than an expected win", () => {
    const upset = applyDuel(1000, 1200);
    const expected = applyDuel(1200, 1000);
    expect(upset.winner - 1000).toBeGreaterThan(expected.winner - 1200);
  });

  it("conserves points across the pair", () => {
    const next = applyDuel(1337, 912);
    expect(next.winner + next.loser).toBe(1337 + 912);
  });
});
