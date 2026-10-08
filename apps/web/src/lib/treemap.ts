export type Rect = { x: number; y: number; w: number; h: number };
export type Placed<T> = Rect & { item: T };

/** Worst aspect ratio among a row of areas laid along a side of this length. */
function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/**
 * Squarified treemap: fills `bounds` with one rectangle per item, each with
 * an area proportional to its value and as close to square as the layout can
 * manage, largest first. Items with no value are left out.
 */
export function squarify<T extends { value: number }>(items: T[], bounds: Rect): Placed<T>[] {
  const data = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (data.length === 0 || total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];

  const scale = (bounds.w * bounds.h) / total;
  const areas = data.map((d) => d.value * scale);
  const placed: Placed<T>[] = [];
  let rect = { ...bounds };
  let i = 0;

  while (i < data.length) {
    const side = Math.min(rect.w, rect.h);
    const row = [areas[i]];
    let j = i + 1;
    while (j < data.length && worst([...row, areas[j]], side) <= worst(row, side)) {
      row.push(areas[j]);
      j++;
    }

    const rowArea = row.reduce((a, b) => a + b, 0);
    if (rect.w >= rect.h) {
      const w = rowArea / rect.h;
      let y = rect.y;
      row.forEach((area, k) => {
        const h = area / w;
        placed.push({ item: data[i + k], x: rect.x, y, w, h });
        y += h;
      });
      rect = { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h };
    } else {
      const h = rowArea / rect.w;
      let x = rect.x;
      row.forEach((area, k) => {
        const w = area / h;
        placed.push({ item: data[i + k], x, y: rect.y, w, h });
        x += w;
      });
      rect = { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h };
    }
    i = j;
  }
  return placed;
}
