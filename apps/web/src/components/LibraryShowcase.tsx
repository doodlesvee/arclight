import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { MediaCardItem } from "./MediaCard";
import { thumbnailUrl, framingStyle } from "@/lib/mediaItemApi";
import { formatBytes, useLibraryStats } from "@/lib/statsApi";

function PhoneMockup({ items, totalItems }: { items: MediaCardItem[]; totalItems: number }) {
  const hero = items[0];
  const grid = items.slice(1, 7);
  if (!hero || grid.length < 4) return null;

  return (
    <div className="relative w-[200px] xl:w-[220px]">
      {/* Phone body — silver bezel */}
      <div className="relative rounded-[2.2rem] border-[3px] border-neutral-400/60 bg-neutral-300 p-[3px] shadow-2xl shadow-black/80">
        {/* Inner bezel */}
        <div className="overflow-hidden rounded-[1.9rem] bg-black">
          {/* Notch area */}
          <div className="relative">
            <div className="absolute left-1/2 top-0 z-10 h-[18px] w-[70px] -translate-x-1/2 rounded-b-xl bg-black" />
          </div>

          {/* Screen */}
          <div className="bg-neutral-950">
            {/* Status bar */}
            <div className="flex items-center justify-between px-6 pb-0.5 pt-5">
              <span className="text-[9px] font-semibold text-white">1:47</span>
              <div className="flex items-center gap-1.5">
                {/* Signal */}
                <div className="flex items-end gap-[1.5px]">
                  {[3, 5, 7, 9].map((h) => (
                    <div key={h} className="w-[2px] rounded-sm bg-white/80" style={{ height: h }} />
                  ))}
                </div>
                {/* Wifi */}
                <svg viewBox="0 0 16 12" className="size-2.5 fill-white/80">
                  <path d="M8 10.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM8 6c2.2 0 4.2.9 5.7 2.3l-1.4 1.4C11.1 8.6 9.6 8 8 8s-3.1.6-4.3 1.7L2.3 8.3C3.8 6.9 5.8 6 8 6zm0-4c3.3 0 6.3 1.3 8.5 3.5l-1.4 1.4C13.2 5 10.7 4 8 4S2.8 5 .9 6.9L-.5 5.5C1.7 3.3 4.7 2 8 2z" />
                </svg>
                {/* Battery */}
                <div className="flex items-center">
                  <div className="h-[8px] w-[16px] rounded-[2px] border border-white/60 p-[1px]">
                    <div className="h-full w-3/4 rounded-[1px] bg-white/80" />
                  </div>
                  <div className="h-[4px] w-[1.5px] rounded-r-sm bg-white/40" />
                </div>
              </div>
            </div>

            {/* App header */}
            <div className="flex items-center justify-between px-4 py-2">
              <span className="text-[11px] font-semibold text-white">All Videos</span>
              <span className="text-[10px] font-medium text-amber-400">Select</span>
            </div>

            {/* Featured card */}
            <div className="mx-3 mb-2 overflow-hidden rounded-xl">
              <div className="relative aspect-[16/10]">
                <img
                  src={thumbnailUrl(hero)}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  style={framingStyle(hero)}
                  draggable={false}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
                <div className="absolute bottom-2 left-2.5">
                  <p className="text-[11px] font-bold text-white">Videos</p>
                  <p className="text-[8px] text-white/60">{totalItems} Items</p>
                </div>
              </div>
            </div>

            {/* Thumbnail grid */}
            <div className="grid grid-cols-2 gap-[2px] px-[2px]">
              {grid.map((item) => (
                <div key={item.id} className="relative overflow-hidden">
                  <img
                    src={thumbnailUrl(item)}
                    alt=""
                    className="aspect-square w-full object-cover"
                    style={framingStyle(item)}
                    draggable={false}
                  />
                </div>
              ))}
            </div>

            {/* Bottom nav */}
            <div className="flex justify-around border-t border-white/10 px-3 py-2">
              {[
                { label: "All Photos", active: true },
                { label: "For You", active: false },
                { label: "Albums", active: false },
                { label: "Search", active: false },
              ].map((tab) => (
                <div key={tab.label} className="flex flex-col items-center gap-0.5">
                  <div className={`size-3 rounded-sm ${tab.active ? "bg-amber-400/80" : "bg-white/20"}`} />
                  <span className={`text-[7px] ${tab.active ? "text-amber-400" : "text-white/30"}`}>
                    {tab.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Home indicator */}
            <div className="flex justify-center pb-1.5 pt-1">
              <div className="h-[3px] w-[60px] rounded-full bg-white/30" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LibraryShowcase() {
  const { data: stats } = useLibraryStats();
  const { data: recent } = useQuery({
    queryKey: ["media-items", "recent"],
    queryFn: async () => {
      const res = await fetch("/api/media-items");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ items: MediaCardItem[] }>;
    },
  });

  const items = (recent?.items ?? []).filter((i) => i.itemType !== "folder");
  const featured = items.find((i) => i.itemType === "video") ?? items[0];

  if (!featured || !stats) return null;

  const totalItems = stats.videos + stats.photos;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-black">
      <div className="absolute -left-32 -top-32 size-96 rounded-full bg-amber-500/[0.07] blur-3xl" />

      <div className="relative flex flex-col gap-8 px-6 py-10 md:flex-row md:items-center md:gap-10 md:px-12 md:py-14">
        {/* Left: tagline */}
        <div className="flex shrink-0 flex-col md:w-[25%] animate-[showcaseFadeIn_0.8s_ease-out_both]">
          <p className="text-sm italic text-white/50">
            Own what you love
          </p>
          <h2 className="mt-2 text-2xl font-extrabold uppercase leading-tight text-white md:text-3xl lg:text-4xl">
            Stream &amp; watch anytime, anywhere
          </h2>
          <p className="mt-3 text-sm text-white/40">
            {stats.videos} videos{stats.photos > 0 ? `, ${stats.photos} photos` : ""} &middot; {formatBytes(stats.totalBytes)}
          </p>
          <Link
            to="/browse"
            className="group/btn mt-6 inline-flex w-fit items-center gap-2 rounded-md bg-white px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-black transition-all duration-300 hover:bg-amber-400 hover:shadow-lg hover:shadow-amber-400/25"
          >
            Explore Library
            <ChevronRight className="size-4 transition-transform group-hover/btn:translate-x-0.5" />
          </Link>
        </div>

        {/* Center + Right: overlapping devices */}
        <div className="relative flex-1 animate-[showcaseSlideUp_0.8s_ease-out_0.2s_both]">
          <div className="relative flex items-center justify-center">
            {/* Tablet / laptop frame */}
            <div className="relative z-0 max-w-[480px] flex-1">
              <div className="overflow-hidden rounded-[1.5rem] border-[3px] border-neutral-700 bg-neutral-800 p-1 shadow-2xl shadow-black/60">
                <div className="overflow-hidden rounded-[1.1rem]">
                  <div className="relative aspect-video">
                    {featured.itemType === "video" ? (
                      <video
                        key={featured.id}
                        src={`/api/media-items/${featured.id}/preview`}
                        autoPlay
                        loop
                        muted
                        playsInline
                        poster={thumbnailUrl(featured)}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <img
                        src={thumbnailUrl(featured)}
                        alt={featured.title}
                        className="absolute inset-0 h-full w-full object-cover"
                        style={framingStyle(featured)}
                        draggable={false}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Phone — overlapping the tablet's right edge */}
            <div className="relative z-10 -ml-12 hidden shrink-0 self-start lg:block animate-[showcaseSlideUp_0.8s_ease-out_0.4s_both]">
              <PhoneMockup items={items} totalItems={totalItems} />
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes showcaseFadeIn {
          from { opacity: 0; transform: translateX(-20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes showcaseSlideUp {
          from { opacity: 0; transform: translateY(30px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
