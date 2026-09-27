/** When each badge was first unlocked; see `api/achievements.ts`. */
export type AchievementRecord = { unlocked: Record<string, string>; seeded: boolean };

export async function fetchAchievements(): Promise<AchievementRecord> {
  const res = await fetch("/api/achievements");
  if (!res.ok) throw new Error(`Failed to load trophies: ${res.status}`);
  return res.json();
}

export async function unlockAchievements(ids: string[]): Promise<AchievementRecord> {
  const res = await fetch("/api/achievements/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`Failed to save trophies: ${res.status}`);
  return res.json();
}
