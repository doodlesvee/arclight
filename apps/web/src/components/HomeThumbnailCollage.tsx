import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { MediaCardItem } from "./MediaCard";
import { framingStyle, thumbnailUrl } from "@/lib/mediaItemApi";
import { useAppearance } from "@/lib/appearance";
import { cn } from "@/lib/utils";
import { ArrowRight, Heart } from "lucide-react";

const TILE_COUNT = 48;

async function fetchCollageVideos(): Promise<MediaCardItem[]> {
  const response = await fetch("/api/media-items?type=video");
  if (!response.ok) {
    throw new Error(`Could not load thumbnail collage: ${response.status}`);
  }
  const data: { items: MediaCardItem[] } = await response.json();
  return data.items.slice(0, TILE_COUNT);
}

export function HomeThumbnailCollage() {
  const { tileShape } = useAppearance();
  const sectionRef = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 1200, height: 560 });
  const { data: videos = [], error, isPending, refetch } = useQuery({
    queryKey: ["media-items", "home-collage"],
    queryFn: fetchCollageVideos,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, [isPending, videos.length, error]);

  if (error) {
    return (
      <div role="alert" className="px-4 py-6 text-sm text-muted-foreground md:px-6">
        {error.message}{" "}
        <button type="button" onClick={() => void refetch()} className="underline">
          Try again
        </button>
      </div>
    );
  }
  if (isPending || videos.length === 0) return null;

  // A rotated square covering the section's diagonal cannot leave its corners exposed.
  const side = Math.ceil(Math.hypot(size.width, size.height)) + 280;
  const tileHeight = size.height <= 400 ? 100 : 140;
  const gap = tileHeight === 100 ? 8 : 12;
  const rowCount = Math.ceil(side / (tileHeight + gap)) + 1;
  const rows: MediaCardItem[][] = [];
  let cursor = 0;
  for (let row = 0; row < rowCount; row++) {
    const items: MediaCardItem[] = [];
    let width = 0;
    while (width < side) {
      const video = videos[cursor++ % videos.length];
      items.push(video);
      width += tileHeight * ((video.tileShape ?? tileShape) === "portrait" ? 2 / 3 : 16 / 8.1) + gap;
    }
    rows.push(items);
  }

  return (
    <section
      ref={sectionRef}
      aria-label="Video thumbnail collage"
      className="relative isolate h-[400px] overflow-hidden bg-black md:h-[560px]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 flex flex-col justify-center"
        style={{
          width: side,
          height: side,
          gap,
          transform: "translate(-50%, -50%) rotate(-12deg)",
        }}
      >
        {rows.map((items, row) => (
          <div key={row} className="flex shrink-0" style={{ height: tileHeight, gap }}>
          {items.map((video, index) => (
          <div
            key={`${video.id}-${index}`}
            className={cn(
              "relative h-full shrink-0 overflow-hidden rounded-md bg-zinc-900",
              (video.tileShape ?? tileShape) === "portrait" ? "aspect-[2/3]" : "aspect-[16/8.1]",
            )}
          >
            <img
              src={thumbnailUrl(video)}
              alt=""
              loading="lazy"
              decoding="async"
              className={cn(
                "absolute left-0 top-0 w-full object-cover",
                (video.tileShape ?? tileShape) === "portrait" ? "h-full" : "h-[111.111111%]",
              )}
              style={framingStyle(video)}
            />
          </div>
          ))}
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/80" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/60"
      />
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center text-white">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.3em] text-white/60">
          Made for your downtime
        </p>
        <h2 className="max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
          Your collection. Your cinema.
        </h2>
        <p className="mt-4 max-w-lg text-sm leading-relaxed text-white/70 md:text-base">
          Rediscover an old favourite or find your next watch.
          Everything you love, in one place.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a
            href="/browse"
            className="inline-flex items-center gap-2 rounded-md bg-white px-6 py-3 text-sm font-semibold text-black transition-colors hover:bg-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
          >
            Browse library
            <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <a
            href="/browse?favorite=true"
            className="inline-flex items-center gap-2 rounded-md border border-white/30 bg-white/5 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
          >
            <Heart className="size-4" aria-hidden="true" />
            Open favourites
          </a>
        </div>
      </div>
    </section>
  );
}
