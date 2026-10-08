export type DuelCard = {
  id: number;
  title: string;
  thumbnailFile: string | null;
  thumbnailPositionX: number;
  thumbnailPositionY: number;
  thumbnailScale: number;
  durationSeconds: number | null;
  releaseDate: string | null;
  studioName: string | null;
  rating: number | null;
  duelScore: number;
  duelCount: number;
  performers: { id: number; name: string }[];
};

export type LeaderboardEntry = DuelCard & { rank: number };

export type Leaderboard = {
  items: LeaderboardEntry[];
  totalDuels: number;
  comparedCount: number;
  rankedCount: number;
  minDuels: number;
  canApply: boolean;
};

async function failure(res: Response, fallback: string): Promise<Error> {
  const detail = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(detail?.error ?? `${fallback}: ${res.status}`);
}

export async function fetchPair(exclude: number[] = []): Promise<DuelCard[] | null> {
  const query = exclude.length > 0 ? `?exclude=${exclude.join(",")}` : "";
  const res = await fetch(`/api/duels/pair${query}`);
  if (!res.ok) throw await failure(res, "Failed to load a pair");
  return ((await res.json()) as { pair: DuelCard[] | null }).pair;
}

export async function recordDuel(winnerId: number, loserId: number): Promise<void> {
  const res = await fetch("/api/duels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ winnerId, loserId }),
  });
  if (!res.ok) throw await failure(res, "Failed to record the duel");
}

export async function undoDuel(): Promise<void> {
  const res = await fetch("/api/duels/undo", { method: "POST" });
  if (!res.ok) throw await failure(res, "Nothing to undo");
}

export async function fetchLeaderboard(): Promise<Leaderboard> {
  const res = await fetch("/api/duels/leaderboard?limit=100");
  if (!res.ok) throw await failure(res, "Failed to load the leaderboard");
  return res.json();
}

export async function applyRatings(overwrite: boolean): Promise<{ updated: number }> {
  const res = await fetch("/api/duels/apply-ratings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overwrite }),
  });
  if (!res.ok) throw await failure(res, "Failed to apply ratings");
  return res.json();
}
