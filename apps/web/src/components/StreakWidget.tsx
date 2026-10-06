import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Flame } from "lucide-react";
import {
  calendarWeeks,
  formatWatchTime,
  localDay,
  secondsByDay,
  streaks,
  type WatchLogEntry,
} from "@/lib/insights";
import { cn } from "@/lib/utils";

const LEVELS = [
  "bg-white/[0.06]",
  "bg-white/25",
  "bg-white/45",
  "bg-white/70",
  "bg-amber-300",
];

export function StreakWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ["streak"],
    queryFn: async () => {
      const res = await fetch("/api/streak");
      if (!res.ok) throw new Error("Failed to fetch streak");
      return res.json() as Promise<{ log: WatchLogEntry[] }>;
    },
  });

  const today = localDay(new Date());
  const days = useMemo(() => secondsByDay(data?.log ?? []), [data]);
  const streak = useMemo(() => streaks(days, today), [days, today]);
  const weeks = useMemo(() => calendarWeeks(days, today, 16), [days, today]);

  if (isLoading || !data || days.size === 0) return null;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Watch Streak</h2>
        <Link
          to="/stats"
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          See full stats
        </Link>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="flex shrink-0 items-center gap-4">
          <div className="flex items-center gap-2">
            <Flame
              className={cn(
                "size-6",
                streak.current > 0
                  ? "text-amber-400"
                  : "text-muted-foreground",
              )}
            />
            <div>
              <p className="text-2xl font-bold tabular-nums leading-none">
                {streak.current}
              </p>
              <p className="text-xs text-muted-foreground">
                day{streak.current !== 1 && "s"}
              </p>
            </div>
          </div>
          <div className="h-8 w-px bg-white/10" />
          <div>
            <p className="text-sm font-medium tabular-nums leading-none">
              {streak.longest}
            </p>
            <p className="text-xs text-muted-foreground">best</p>
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex gap-[2px]">
            {weeks.map((week, w) => (
              <div key={w} className="flex flex-col gap-[2px]">
                {week.map((cell) => (
                  <span
                    key={cell.day}
                    title={`${new Date(cell.day + "T12:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${cell.seconds > 0 ? formatWatchTime(cell.seconds) : "nothing"}`}
                    className={cn(
                      "size-[10px] rounded-[2px]",
                      LEVELS[cell.level],
                      cell.day === today && "ring-1 ring-foreground/70",
                    )}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
