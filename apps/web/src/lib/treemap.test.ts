import { describe, expect, it } from "vitest";
import { squarify, type Rect } from "./treemap";

const bounds: Rect = { x: 0, y: 0, w: 100, h: 50 };
const item = (name: string, value: number) => ({ name, value });

function overlaps(a: Rect, b: Rect): boolean {
  const e = 1e-6;
  return a.x < b.x + b.w - e && b.x < a.x + a.w - e && a.y < b.y + b.h - e && b.y < a.y + a.h - e;
}

describe("squarify", () => {
  it("returns nothing for empty or zero-valued input", () => {
    expect(squarify([], bounds)).toEqual([]);
    expect(squarify([item("a", 0)], bounds)).toEqual([]);
    expect(squarify([item("a", 5)], { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
  });

  it("gives a single item the whole area", () => {
    const [only] = squarify([item("a", 7)], bounds);
    expect(only).toMatchObject({ x: 0, y: 0, w: 100, h: 50 });
  });

  it("fills the bounds exactly, with areas proportional to value", () => {
    const items = [item("a", 600), item("b", 300), item("c", 200), item("d", 100), item("e", 50)];
    const placed = squarify(items, bounds);
    const totalArea = placed.reduce((s, p) => s + p.w * p.h, 0);
    expect(totalArea).toBeCloseTo(100 * 50);

    const total = items.reduce((s, i) => s + i.value, 0);
    for (const p of placed) {
      expect((p.w * p.h) / (100 * 50)).toBeCloseTo(p.item.value / total);
    }
  });

  it("keeps every rectangle inside the bounds and apart from the others", () => {
    const items = Array.from({ length: 25 }, (_, i) => item(`n${i}`, (i + 1) * 13));
    const placed = squarify(items, bounds);
    expect(placed).toHaveLength(25);
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x + p.w).toBeLessThanOrEqual(100 + 1e-9);
      expect(p.y + p.h).toBeLessThanOrEqual(50 + 1e-9);
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i], placed[j])).toBe(false);
      }
    }
  });

  it("places the largest first", () => {
    const placed = squarify([item("small", 1), item("big", 90), item("mid", 9)], bounds);
    expect(placed.map((p) => p.item.name)).toEqual(["big", "mid", "small"]);
  });
});
