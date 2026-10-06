import { Clock, Play } from "lucide-react";
import type { MediaCardItem } from "./MediaCard";
import { thumbnailUrl, framingStyle } from "@/lib/mediaItemApi";
import { formatDuration } from "@/lib/utils";

type OnThisDayItem = MediaCardItem & { completedYear?: number };

function YearGroup({
  year,
  items,
  onPlay,
  onSelect,
}: {
  year: number;
  items: OnThisDayItem[];
  onPlay: (id: number) => void;
  onSelect: (id: number) => void;
}) {
  const yearsAgo = new Date().getFullYear() - year;
  const label = yearsAgo === 1 ? "1 year ago" : `${yearsAgo} years ago`;

  return (
    <div className="space-y-3">
      <span className="inline-block rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-400">
        {label}
      </span>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="group relative overflow-hidden rounded-lg ring-1 ring-white/10 transition-all hover:ring-amber-400/40"
          >
            <div className="relative aspect-video">
              <img
                src={thumbnailUrl(item)}
                alt=""
                className="absolute inset-0 h-full w-full object-cover brightness-75 transition-transform duration-500 group-hover:scale-105"
                style={framingStyle(item)}
                draggable={false}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
              <button
                type="button"
                onClick={() => onPlay(item.id)}
                className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 p-3 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
              >
                <Play className="size-5 fill-white text-white" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              className="w-full px-3 py-2.5 text-left"
            >
              <p className="truncate text-sm font-medium text-white">{item.title}</p>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/50">
                {item.durationSeconds != null && (
                  <span>{formatDuration(item.durationSeconds)}</span>
                )}
                {item.studio && <span>{item.studio}</span>}
              </div>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OnThisDayCard({
  items,
  onPlay,
  onSelect,
}: {
  items: OnThisDayItem[];
  onPlay: (id: number) => void;
  onSelect: (id: number) => void;
}) {
  if (items.length === 0) return null;

  const byYear = new Map<number, OnThisDayItem[]>();
  for (const item of items) {
    const yr = item.completedYear ?? new Date().getFullYear() - 1;
    const group = byYear.get(yr) ?? [];
    group.push(item);
    byYear.set(yr, group);
  }
  const sortedYears = [...byYear.keys()].sort((a, b) => b - a);

  const today = new Date();
  const monthDay = today.toLocaleDateString("en-US", { month: "long", day: "numeric" });

  return (
    <div className="space-y-4 rounded-xl bg-gradient-to-br from-amber-500/[0.06] to-transparent p-5 ring-1 ring-amber-500/10 md:p-6">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-full bg-amber-500/15">
          <Clock className="size-4 text-amber-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">On This Day</h2>
          <p className="text-xs text-white/50">{monthDay}</p>
        </div>
      </div>

      <div className="space-y-5">
        {sortedYears.map((year) => (
          <YearGroup
            key={year}
            year={year}
            items={byYear.get(year)!}
            onPlay={onPlay}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
