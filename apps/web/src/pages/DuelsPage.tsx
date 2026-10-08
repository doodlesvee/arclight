import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Star, SkipForward, Swords, Trophy, Undo2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { openDetails } from "@/lib/appEvents";
import {
  applyRatings,
  fetchLeaderboard,
  fetchPair,
  recordDuel,
  undoDuel,
  type DuelCard,
} from "@/lib/duelsApi";
import { framingStyle, thumbnailUrl } from "@/lib/mediaItemApi";
import { cn, formatDuration } from "@/lib/utils";

type Tab = "duel" | "leaderboard";

function Card({
  item,
  side,
  disabled,
  onPick,
}: {
  item: DuelCard;
  side: "left" | "right";
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-label={`Pick ${item.title}`}
      className="group relative flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/60 text-left transition-all hover:border-primary/60 hover:shadow-lg disabled:opacity-60"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-secondary">
        <img
          src={thumbnailUrl(item)}
          alt=""
          style={framingStyle(item)}
          className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <kbd className="absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs font-semibold text-white">
          {side === "left" ? "←" : "→"}
        </kbd>
        {item.durationSeconds ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
            {formatDuration(item.durationSeconds)}
          </span>
        ) : null}
      </div>
      <div className="space-y-1 p-3">
        <h3 className="line-clamp-2 text-sm font-semibold">{item.title}</h3>
        <p className="truncate text-xs text-muted-foreground">
          {[item.studioName, item.performers.map((p) => p.name).join(", ")]
            .filter(Boolean)
            .join(" · ") || "—"}
        </p>
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {item.rating !== null && (
            <span className="flex items-center gap-0.5">
              <Star className="size-3 fill-current" />
              {item.rating}
            </span>
          )}
          <span>
            {item.duelCount === 0 ? "No duels yet" : `${item.duelCount} duel${item.duelCount === 1 ? "" : "s"}`}
          </span>
        </p>
      </div>
    </button>
  );
}

function DuelArena() {
  const queryClient = useQueryClient();
  const exclude = useRef<number[]>([]);
  const lastPair = useRef<DuelCard[] | null>(null);
  const [sessionDuels, setSessionDuels] = useState(0);

  const { data: pair, isLoading, isFetching, error } = useQuery({
    queryKey: ["duel-pair"],
    queryFn: () => fetchPair(exclude.current),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const refreshStandings = () => queryClient.invalidateQueries({ queryKey: ["duel-leaderboard"] });

  const pick = useMutation({
    mutationFn: ({ winner, loser }: { winner: DuelCard; loser: DuelCard }) =>
      recordDuel(winner.id, loser.id),
    onSuccess: () => {
      lastPair.current = pair ?? null;
      exclude.current = [];
      setSessionDuels((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey: ["duel-pair"] });
      void refreshStandings();
    },
  });

  const undo = useMutation({
    mutationFn: undoDuel,
    onSuccess: () => {
      setSessionDuels((n) => Math.max(0, n - 1));
      if (lastPair.current) {
        queryClient.setQueryData(["duel-pair"], lastPair.current);
        lastPair.current = null;
      } else {
        void queryClient.invalidateQueries({ queryKey: ["duel-pair"] });
      }
      void refreshStandings();
    },
  });

  const busy = pick.isPending || undo.isPending || isFetching;

  const choose = useCallback(
    (index: 0 | 1) => {
      if (!pair || busy) return;
      pick.mutate({ winner: pair[index], loser: pair[1 - index] });
    },
    [pair, busy, pick],
  );

  const skip = useCallback(() => {
    if (!pair || busy) return;
    exclude.current = pair.map((p) => p.id);
    void queryClient.invalidateQueries({ queryKey: ["duel-pair"] });
  }, [pair, busy, queryClient]);

  const takeBack = useCallback(() => {
    if (sessionDuels > 0 && !busy) undo.mutate();
  }, [sessionDuels, busy, undo]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.metaKey ||
        e.ctrlKey
      )
        return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          choose(0);
          break;
        case "ArrowRight":
          e.preventDefault();
          choose(1);
          break;
        case "ArrowDown":
        case "s":
          e.preventDefault();
          skip();
          break;
        case "u":
        case "Backspace":
          e.preventDefault();
          takeBack();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choose, skip, takeBack]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
      </div>
    );
  }

  if (error) {
    return <p className="py-12 text-center text-sm text-destructive">{error.message}</p>;
  }

  if (!pair) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
        <Swords className="size-14 opacity-30" />
        <p className="text-lg font-medium">Not enough videos to compare</p>
        <p className="text-sm">Duels need at least two videos in your library.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-center text-sm text-muted-foreground">Which do you prefer?</p>
      <div className={cn("flex flex-col gap-4 sm:flex-row", busy && "pointer-events-none")}>
        <Card item={pair[0]} side="left" disabled={busy} onPick={() => choose(0)} />
        <Card item={pair[1]} side="right" disabled={busy} onPick={() => choose(1)} />
      </div>
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={skip}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/80 disabled:opacity-50"
        >
          <SkipForward className="size-3.5" />
          Skip <kbd className="opacity-60">↓</kbd>
        </button>
        <button
          type="button"
          onClick={takeBack}
          disabled={busy || sessionDuels === 0}
          className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/80 disabled:opacity-40"
        >
          <Undo2 className="size-3.5" />
          Undo <kbd className="opacity-60">U</kbd>
        </button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {sessionDuels} this session
        </span>
      </div>
      {pick.error && <p className="text-center text-xs text-destructive">{pick.error.message}</p>}
    </div>
  );
}

function Leaderboard() {
  const queryClient = useQueryClient();
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["duel-leaderboard"],
    queryFn: fetchLeaderboard,
  });

  const apply = useMutation({
    mutationFn: (overwrite: boolean) => applyRatings(overwrite),
    onSuccess: ({ updated }) => {
      setConfirmOverwrite(false);
      setMessage(updated === 0 ? "Nothing to change." : `Updated ${updated} star rating${updated === 1 ? "" : "s"}.`);
      void queryClient.invalidateQueries({ queryKey: ["duel-leaderboard"] });
      void queryClient.invalidateQueries({ queryKey: ["media-items"] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-24">
        <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
      </div>
    );
  }

  if (data.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
        <Trophy className="size-14 opacity-30" />
        <p className="text-lg font-medium">No ranking yet</p>
        <p className="text-sm">Pick a few winners and they will show up here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2 rounded-lg border border-border bg-card/40 p-4">
        <p className="text-sm font-medium">Turn the ranking into star ratings</p>
        <p className="text-xs text-muted-foreground">
          {data.canApply
            ? `${data.rankedCount} videos have ${data.minDuels}+ duels. A fifth of them goes to each star level, best first.`
            : `Needs at least 5 videos with ${data.minDuels}+ duels each. ${data.rankedCount} so far.`}
        </p>
        {data.canApply && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => apply.mutate(false)}
              disabled={apply.isPending}
              className="rounded-md bg-secondary px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              Fill unrated videos only
            </button>
            <button
              type="button"
              onClick={() => (confirmOverwrite ? apply.mutate(true) : setConfirmOverwrite(true))}
              disabled={apply.isPending}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                confirmOverwrite
                  ? "bg-destructive/90 text-white hover:bg-destructive"
                  : "bg-secondary hover:bg-accent",
              )}
            >
              {confirmOverwrite ? "Click again to replace existing ratings" : "Replace existing ratings too"}
            </button>
            {confirmOverwrite && (
              <button
                type="button"
                onClick={() => setConfirmOverwrite(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            )}
          </div>
        )}
        {message && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="size-3" />
            {message}
          </p>
        )}
      </div>

      <ol className="divide-y divide-border rounded-lg border border-border bg-card/40">
        {data.items.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => openDetails(entry.id)}
              className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/50"
            >
              <span className="w-8 shrink-0 text-center text-sm font-semibold tabular-nums text-muted-foreground">
                {entry.rank}
              </span>
              <img
                src={thumbnailUrl(entry)}
                alt=""
                style={framingStyle(entry)}
                className="h-10 w-16 shrink-0 rounded object-cover"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{entry.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[entry.studioName, entry.performers.map((p) => p.name).join(", ")]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </span>
              </span>
              {entry.rating !== null && (
                <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                  <Star className="size-3 fill-current" />
                  {entry.rating}
                </span>
              )}
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {entry.duelScore}
                <span className="block text-[10px] opacity-70">{entry.duelCount} duels</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="text-center text-xs text-muted-foreground">
        {data.totalDuels.toLocaleString()} duels across {data.comparedCount.toLocaleString()} videos
      </p>
    </div>
  );
}

export function DuelsPage() {
  const [tab, setTab] = useState<Tab>("duel");

  return (
    <AppShell title="Duels">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <div className="mb-6 flex items-center gap-1 rounded-lg bg-secondary/50 p-1 text-sm font-medium sm:w-fit">
          {(
            [
              ["duel", "Duel", Swords],
              ["leaderboard", "Leaderboard", Trophy],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-4 py-1.5 transition-colors",
                tab === key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
        {tab === "duel" ? <DuelArena /> : <Leaderboard />}
      </div>
    </AppShell>
  );
}
