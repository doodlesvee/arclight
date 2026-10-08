import { describe, expect, it } from "vitest";
import { bestPartSeconds } from "./heatmap";

const flat = (n = 50) => new Array<number>(n).fill(0);

describe("bestPartSeconds", () => {
  it("returns null with no data, no duration, or no real peak", () => {
    expect(bestPartSeconds(undefined, 100)).toBeNull();
    expect(bestPartSeconds([], 100)).toBeNull();
    expect(bestPartSeconds(flat(), 0)).toBeNull();
    expect(bestPartSeconds(flat(), 100)).toBeNull();
    const once = flat();
    once[10] = 1;
    expect(bestPartSeconds(once, 100)).toBeNull();
  });

  it("points at the start of the hottest bucket", () => {
    const buckets = flat();
    buckets[25] = 6;
    expect(bestPartSeconds(buckets, 100)).toBe(50);
  });

  it("prefers a broad replayed stretch over a lone spike", () => {
    const buckets = flat();
    buckets[5] = 7;
    buckets[30] = 4;
    buckets[31] = 5;
    buckets[32] = 4;
    expect(bestPartSeconds(buckets, 100)).toBe(62);
  });

  it("breaks ties toward the earlier part", () => {
    const buckets = flat();
    buckets[10] = 3;
    buckets[40] = 3;
    expect(bestPartSeconds(buckets, 100)).toBe(20);
  });

  it("handles a peak in the last bucket", () => {
    const buckets = flat();
    buckets[49] = 5;
    expect(bestPartSeconds(buckets, 100)).toBe(98);
  });
});
