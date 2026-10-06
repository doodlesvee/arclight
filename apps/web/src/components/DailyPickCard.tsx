import { Calendar, Play, RefreshCw, Star } from "lucide-react";
import type { MediaCardItem } from "./MediaCard";
import { thumbnailUrl, framingStyle } from "@/lib/mediaItemApi";
import { formatDuration } from "@/lib/utils";

export function DailyPickCard({
  item,
  onPlay,
  onSelect,
  onRefresh,
}: {
  item: MediaCardItem;
  onPlay: () => void;
  onSelect: () => void;
  onRefresh?: () => void;
}) {
  const duration = formatDuration(item.durationSeconds);
  const year = item.releaseDate?.slice(0, 4);

  return (
    <div className="group relative overflow-hidden rounded-xl">
      {/* Backdrop: autoplay video for videos, blurred image for photos */}
      {item.itemType === "video" ? (
        <video
          key={item.id}
          src={`/api/media-items/${item.id}/preview`}
          autoPlay
          loop
          muted
          playsInline
          poster={thumbnailUrl(item)}
          className="absolute inset-0 h-full w-full scale-110 object-cover brightness-[0.3] saturate-150 transition-transform duration-[20s] ease-linear group-hover:scale-125"
        />
      ) : (
        <img
          src={thumbnailUrl(item)}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl brightness-[0.3] saturate-150 transition-transform duration-[20s] ease-linear group-hover:scale-125"
          style={framingStyle(item)}
          draggable={false}
        />
      )}
      <div className="absolute inset-0 bg-black/40" />

      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Show a different pick"
          title="Shuffle"
          className="absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-full bg-black/40 text-white/60 backdrop-blur-sm transition-all hover:bg-black/60 hover:text-white hover:rotate-180"
        >
          <RefreshCw className="size-3.5" />
        </button>
      )}

      {/* Content: tile left, details right */}
      <div className="relative flex flex-col gap-5 p-4 sm:flex-row sm:items-center sm:gap-6 md:p-6">
        {/* Thumbnail tile */}
        <button
          type="button"
          onClick={onSelect}
          className="relative shrink-0 overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10 transition-all duration-500 sm:w-[55%] md:w-[50%] group-hover:scale-[1.02] group-hover:shadow-amber-500/20"
        >
          <img
            src={thumbnailUrl(item)}
            alt={item.title}
            className="aspect-video w-full object-cover transition-transform duration-700 group-hover:scale-105"
            style={framingStyle(item)}
            draggable={false}
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
            <div className="translate-y-2 rounded-full bg-white/20 p-3 opacity-0 backdrop-blur-sm transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
              <Play className="size-6 fill-white text-white" />
            </div>
          </div>
        </button>

        {/* Details */}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex items-center gap-2 text-lg font-extrabold uppercase tracking-widest text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.4)] md:text-xl animate-[fadeSlideIn_0.6s_ease-out_both]">
            <Calendar className="size-5 animate-[pulse_3s_ease-in-out_infinite]" />
            Today&rsquo;s pick
          </div>

          <button
            type="button"
            onClick={onSelect}
            className="mt-3 text-left text-2xl font-bold text-white drop-shadow-lg transition-colors duration-300 hover:text-amber-100 md:text-3xl lg:text-4xl animate-[fadeSlideIn_0.6s_ease-out_0.15s_both]"
          >
            {item.title}
          </button>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/60 animate-[fadeSlideIn_0.6s_ease-out_0.3s_both]">
            {duration && <span>{duration}</span>}
            {year && <span>{year}</span>}
            {item.studio && <span>{item.studio}</span>}
            {item.rating != null && (
              <span className="flex items-center gap-0.5">
                <Star className="size-3 fill-amber-400 text-amber-400" />
                {item.rating}
              </span>
            )}
          </div>

          {item.performers && item.performers.length > 0 && (
            <p className="mt-1.5 text-xs text-white/40 animate-[fadeSlideIn_0.6s_ease-out_0.4s_both]">
              {item.performers.map((p) => p.name).join(", ")}
            </p>
          )}

          {item.description && (
            <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-white/60 animate-[fadeSlideIn_0.6s_ease-out_0.45s_both]">
              {item.description}
            </p>
          )}

          <div className="mt-4 flex gap-3 animate-[fadeSlideIn_0.6s_ease-out_0.55s_both]">
            <button
              type="button"
              onClick={onPlay}
              className="flex items-center gap-2 rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition-all duration-300 hover:bg-amber-400 hover:shadow-lg hover:shadow-amber-400/25"
            >
              <Play className="size-4 fill-black" />
              Play
            </button>
            <button
              type="button"
              onClick={onSelect}
              className="flex items-center gap-2 rounded-full bg-white/15 px-5 py-2 text-sm font-medium text-white backdrop-blur-sm transition-all duration-300 hover:bg-white/25"
            >
              More info
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
