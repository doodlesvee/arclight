import type { Insights } from "./insights";

/** Everything the Stats page works from; see `api/insights.ts`. */
export async function fetchInsights(): Promise<Insights> {
  const res = await fetch("/api/insights");
  if (!res.ok) throw new Error(`Failed to load stats: ${res.status}`);
  return res.json();
}
