import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Clock,
  Compass,
  Flame,
  Lock,
  Medal,
  Moon,
  Play,
  Repeat,
  Star,
  Sunrise,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { MediaDetailModal } from "@/components/MediaDetailModal";
import { useAppearance } from "@/lib/appearance";
import { fetchAuthStatus } from "@/lib/authApi";
import {
  achievements,
  calendarMonths,
  formatWatchTime,
  funFacts,
  hallOfFame,
  localDay,
  localMonth,
  monthRecap,
  recapMonths,
  secondsByDay,
  streaks,
  type Achievement,
  type Insights,
  type InsightItem,
  type InsightPerformer,
} from "@/lib/insights";
import { fetchInsights } from "@/lib/insightsApi";
import { fetchItem, thumbnailUrl } from "@/lib/mediaItemApi";
import { circleStyle, performerPortraitUrl } from "@/lib/performerApi";
import { cn } from "@/lib/utils";

/**
 * Your viewing as an editorial "year in review" rather than a dashboard:
 * a cinematic opening built from your #1 video, then four numbered
 * chapters — the podium, your year, your habits, your trophies — set in
 * big type with hairline rules instead of boxes.
 *
 * Everything here reads; nothing on this page writes. The watch log only
 * began when the page was added, so chapters appear as there is something
 * real to put in them.
 */
export function StatsPage() {
  return (
    // No shell title: the opening is the title.
    <AppShell>
      <StatsView />
    </AppShell>
  );
}

/** Your viewing, looked back on. */
function StatsView() {
  const { data, isLoading } = useQuery({ queryKey: ["insights"], queryFn: fetchInsights });
  const { data: auth } = useQuery({ queryKey: ["auth-status"], queryFn: fetchAuthStatus });
  const [open, setOpen] = useState<{ id: number; autoPlay: boolean; resume?: boolean } | null>(null);
  const openItem = (id: number) => setOpen({ id, autoPlay: false });
  const playItem = (id: number, resume = false) => setOpen({ id, autoPlay: true, resume });

  return (
    <>
      {isLoading && <p className="px-6 py-8 text-sm text-muted-foreground">Loading…</p>}
      {data && (
        <StatsStory data={data} name={auth?.user?.username ?? null} onOpenItem={openItem} onPlayItem={playItem} />
      )}
      {open && (
        <MediaDetailModal itemId={open.id} autoPlay={open.autoPlay} resume={open.resume} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

function StatsStory({
  data,
  name,
  onOpenItem,
  onPlayItem,
}: {
  data: Insights;
  name: string | null;
  onOpenItem: (id: number) => void;
  onPlayItem: (id: number, resume?: boolean) => void;
}) {
  const today = localDay(new Date());
  const days = useMemo(() => secondsByDay(data.log), [data]);
  const streak = useMemo(() => streaks(days, today), [days, today]);
  const facts = useMemo(() => funFacts(data.log), [data]);
  const total = useMemo(() => data.log.reduce((sum, e) => sum + e.seconds, 0), [data]);
  const hall = useMemo(() => hallOfFame(data), [data]);
  const headline = useHeadline(data, hall.mainEvent);
  const hasHistory = total >= 60;

  const itemsById = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data]);
  const watchedIds = new Set(data.log.map((e) => e.mediaItemId));
  const performerCount = new Set([...watchedIds].flatMap((id) => itemsById.get(id)?.performerIds ?? [])).size;
  const studioCount = new Set([...watchedIds].map((id) => itemsById.get(id)?.studio).filter(Boolean)).size;
  const activeDays = [...days.values()].filter((s) => s >= 60).length;

  return (
    <div className="pb-16">
      <Opening
        name={name}
        backdrop={headline?.item ?? null}
        total={total}
        videos={facts.videosWatched}
        performers={performerCount}
        studios={studioCount}
        figures={[
          { label: "Current streak", value: `${streak.current} ${streak.current === 1 ? "day" : "days"}` },
          { label: "Longest streak", value: `${streak.longest} ${streak.longest === 1 ? "day" : "days"}` },
          { label: "Active days", value: String(activeDays) },
          { label: "Average day", value: formatWatchTime(facts.averageDaySeconds) },
        ]}
        hasHistory={hasHistory}
      />

      <div className="mx-auto max-w-[1320px] px-4 md:px-8">
        <Chapter number="01" title="The podium" kicker="Hall of fame">
          <Podium data={data} hall={hall} headline={headline} onOpenItem={onOpenItem} onPlayItem={onPlayItem} />
        </Chapter>

        {/* Always shown — an empty calendar is a goal to fill, not a gap. */}
        <Chapter number="02" title="Your year" kicker="Month by month">
          <YourYear data={data} days={days} today={today} onOpenItem={onOpenItem} />
        </Chapter>

        {hasHistory && (
          <Chapter number="03" title="Your habits" kicker="When you watch">
            <Habits data={data} lateShare={facts.lateNightShare} />
          </Chapter>
        )}

        <Chapter number={hasHistory ? "04" : "03"} title="Trophies" kicker="Achievements">
          <Trophies list={achievements(data, today)} />
        </Chapter>
      </div>
    </div>
  );
}

// --- Shared -----------------------------------------------------------------

/** A numbered chapter: a hairline rule, a small kicker, a big title. */
function Chapter({
  number,
  title,
  kicker,
  children,
}: {
  number: string;
  title: string;
  kicker: string;
  children: React.ReactNode;
}) {
  const { motion } = useAppearance();
  return (
    <section className={cn("border-t border-border pt-8 mt-16 first:mt-12", motion === "full" && "animate-fade-up")}>
      <div className="mb-8 flex items-baseline gap-5">
        <span className="font-mono text-sm tabular-nums text-muted-foreground">{number}</span>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">{kicker}</p>
          <h2 className="text-3xl font-black tracking-tight sm:text-4xl">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

/** Counts up from zero to `value`, unless animation is turned down. */
function useCountUp(value: number) {
  const { motion } = useAppearance();
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (motion !== "full") return;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 1200);
      setShown(value * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, motion]);
  return motion === "full" ? shown : value;
}

const MEDALS = [
  "bg-gradient-to-br from-amber-200 to-amber-500 text-amber-950",
  "bg-gradient-to-br from-slate-100 to-slate-400 text-slate-900",
  "bg-gradient-to-br from-orange-300 to-orange-700 text-orange-950",
];

// --- Opening ----------------------------------------------------------------

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The first screen: your #1 video's poster, heavily blurred, as a backdrop,
 * one giant number, a sentence, and four figures in a ruled row.
 */
function Opening({
  name,
  backdrop,
  total,
  videos,
  performers,
  studios,
  figures,
  hasHistory,
}: {
  name: string | null;
  backdrop: InsightItem | null;
  total: number;
  videos: number;
  performers: number;
  studios: number;
  figures: { label: string; value: string }[];
  hasHistory: boolean;
}) {
  const { discreet } = useAppearance();
  const shown = useCountUp(total);
  const hours = total / 3600;
  const big = hours >= 1 ? `${Math.round((shown / 3600) * (hours < 10 ? 10 : 1)) / (hours < 10 ? 10 : 1)}` : `${Math.round(shown / 60)}`;
  const unit = hours >= 1 ? "hours" : "minutes";

  return (
    <header className="relative isolate overflow-hidden">
      {backdrop && !discreet && (
        <img
          src={thumbnailUrl(backdrop)}
          alt=""
          aria-hidden
          className="absolute inset-0 -z-10 h-full w-full scale-110 object-cover opacity-40 blur-2xl"
        />
      )}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-background/40 via-background/70 to-background" />

      <div className="mx-auto max-w-[1320px] px-4 pb-12 pt-14 md:px-8 md:pt-20">
        <p className="text-sm text-muted-foreground">
          {greeting()}
          {name && <span className="sensitive">, {name}</span>} · your viewing, looked back on
        </p>

        {hasHistory ? (
          <>
            <h1 className="mt-4 flex items-baseline gap-4 font-black tracking-tighter">
              <span className="text-7xl tabular-nums sm:text-8xl lg:text-9xl">{big}</span>
              <span className="text-3xl text-muted-foreground sm:text-4xl">{unit}</span>
            </h1>
            <p className="mt-3 max-w-2xl text-lg text-muted-foreground sm:text-xl">
              of watching, across <Em>{videos}</Em> {videos === 1 ? "video" : "videos"}
              {performers > 0 && (
                <>
                  , <Em>{performers}</Em> {performers === 1 ? "performer" : "performers"}
                </>
              )}
              {studios > 0 && (
                <>
                  {" "}and <Em>{studios}</Em> {studios === 1 ? "studio" : "studios"}
                </>
              )}
              .
            </p>
            <dl className="mt-10 grid grid-cols-2 divide-border sm:grid-cols-4 sm:divide-x">
              {figures.map((figure) => (
                <div key={figure.label} className="py-3 sm:px-6 sm:first:pl-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{figure.label}</dt>
                  <dd className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{figure.value}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <>
            <h1 className="mt-4 max-w-3xl text-5xl font-black tracking-tighter sm:text-7xl">Your story starts here.</h1>
            <p className="mt-4 max-w-xl text-lg text-muted-foreground">
              Watch, finish and rate videos and this page writes itself — a podium, a year in squares, your
              habits and a shelf of trophies.
            </p>
          </>
        )}
      </div>
    </header>
  );
}

const Em = ({ children }: { children: React.ReactNode }) => (
  <span className="font-semibold text-foreground tabular-nums">{children}</span>
);

// --- 01 The podium ----------------------------------------------------------

type Headline = { item: InsightItem; seconds: number; names: string; isPinned: boolean } | null;

/** Your #1 video: the one you pinned, otherwise the one you've watched most. */
function useHeadline(data: Insights, auto: ReturnType<typeof hallOfFame>["mainEvent"]): Headline {
  const { hallOfFamePin } = useAppearance();
  const { data: pinned } = useQuery({
    queryKey: ["media-item", hallOfFamePin],
    queryFn: () => fetchItem(hallOfFamePin),
    enabled: hallOfFamePin > 0,
    retry: false,
  });
  if (hallOfFamePin > 0 && pinned) {
    return {
      item: {
        id: pinned.id,
        title: pinned.title,
        thumbnailFile: pinned.thumbnailFile,
        durationSeconds: pinned.durationSeconds,
        rating: pinned.rating,
        studio: pinned.studio,
        playCount: pinned.playCount,
        completedAt: pinned.watchedAt,
        performerIds: [],
      },
      names: pinned.performers.map((p) => p.name).join(", "),
      seconds: data.log.filter((e) => e.mediaItemId === pinned.id).reduce((sum, e) => sum + e.seconds, 0),
      isPinned: true,
    };
  }
  if (!auto) return null;
  return {
    ...auto,
    names: auto.item.performerIds
      .map((id) => data.performers.find((p) => p.id === id)?.name)
      .filter(Boolean)
      .join(", "),
    isPinned: false,
  };
}

function Podium({
  data,
  hall,
  headline,
  onOpenItem,
  onPlayItem,
}: {
  data: Insights;
  hall: ReturnType<typeof hallOfFame>;
  headline: Headline;
  onOpenItem: (id: number) => void;
  onPlayItem: (id: number, resume?: boolean) => void;
}) {
  const { set } = useAppearance();
  // Top three by time watched; while there's too little history to fill
  // the podium, the rest of the places go to whoever has the most videos.
  const byTime = hall.performersByTime.slice(0, 3).map(({ performer, seconds }) => ({
    performer,
    detail: `${formatWatchTime(seconds)} watched`,
  }));
  const taken = new Set(byTime.map((p) => p.performer.id));
  const byVideos = [...data.performers]
    .filter((p) => !taken.has(p.id) && p.videoCount > 0)
    .sort((a, b) => b.videoCount - a.videoCount || a.name.localeCompare(b.name))
    .slice(0, 3 - byTime.length)
    .map((performer) => ({ performer, detail: `${performer.videoCount} ${performer.videoCount === 1 ? "video" : "videos"}` }));
  const top = [...byTime, ...byVideos];
  const played = hall.videosByPlays.slice(0, 5);
  const rated = hall.videosByRating.slice(0, 5);

  if (!headline && top.length === 0 && played.length === 0 && rated.length === 0) {
    return (
      <p className="max-w-xl text-muted-foreground">
        Nobody on the podium yet. Watch and finish videos and your favourites take their places — or pin any
        video as your #1 with the trophy button in its details.
      </p>
    );
  }

  return (
    <div className="space-y-12">
      {/* The #1 video on its own row, full width; the podium and the two
          ranked lists share the row beneath it. */}
      {headline && (
        <div className="flex flex-col gap-2">
          <NumberOne headline={headline} data={data} onPlay={onPlayItem} />
          {headline.isPinned && (
            <button
              type="button"
              onClick={() => set({ hallOfFamePin: 0 })}
              className="self-end text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Unpin — go back to your most-watched video
            </button>
          )}
        </div>
      )}

      <div className="grid gap-10 lg:grid-cols-3">
        {top.length > 0 && <PerformerPodium top={top} />}
        <RankedList title="Most played" icon={Repeat} items={played} detail={(i) => `${i.playCount}×`} onOpen={onOpenItem} />
        <RankedList title="Highest rated" icon={Star} items={rated} detail={(i) => "★".repeat(i.rating ?? 0)} onOpen={onOpenItem} />
      </div>
    </div>
  );
}

/**
 * The #1 video: its preview drifting slowly (Ken Burns) under a black wash,
 * everything centred on top — a shining gold pill, the title, who's in it,
 * its studio, how often and how long you've watched it, and a line of
 * trivia. Clicking it plays, resuming where you left off. A burst of gold confetti
 * greets it once when the page opens. Moving parts all stand down in
 * discreet mode or with animation turned off.
 */
function NumberOne({
  headline,
  data,
  onPlay,
}: {
  headline: NonNullable<Headline>;
  data: Insights;
  onPlay: (id: number, resume?: boolean) => void;
}) {
  const { discreet, motion } = useAppearance();
  const navigate = useNavigate();
  const { item, seconds } = headline;
  const moving = !discreet && motion !== "none";
  const lively = !discreet && motion === "full";
  // The item itself, for who's in it, its studio, year and resume position.
  // Shares its cache entry with the pinned-video lookup.
  const { data: detail } = useQuery({
    queryKey: ["media-item", item.id],
    queryFn: () => fetchItem(item.id),
    retry: false,
  });

  const trivia = useMemo(() => {
    const byItem = new Map<number, number>();
    for (const entry of data.log) {
      byItem.set(entry.mediaItemId, (byItem.get(entry.mediaItemId) ?? 0) + entry.seconds);
    }
    const runnerUp = Math.max(0, ...[...byItem.entries()].filter(([id]) => id !== item.id).map(([, s]) => s));
    // Consecutive months, newest back, in which this was the month's most watched.
    let monthsRunning = 0;
    for (const month of recapMonths(data.log)) {
      if (monthRecap(data, month)?.mostWatched?.item.id !== item.id) break;
      monthsRunning++;
    }
    return { lead: seconds - runnerUp, hasRunnerUp: runnerUp > 0, monthsRunning };
  }, [data, item.id, seconds]);

  const people = (detail?.performers ?? []).map((p) => ({
    ...p,
    known: data.performers.find((known) => known.id === p.id),
  }));
  const canResume = (detail?.lastPositionSeconds ?? 0) > 15 && !detail?.watched;

  const facts: string[] = [];
  if (trivia.hasRunnerUp && trivia.lead >= 60) facts.push(`${formatWatchTime(trivia.lead)} ahead of your #2`);
  if (trivia.monthsRunning >= 2) facts.push(`#1 for ${trivia.monthsRunning} months running`);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPlay(item.id, canResume)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPlay(item.id, canResume);
        }
      }}
      className="group relative block min-h-[26rem] w-full flex-1 cursor-pointer overflow-hidden rounded-3xl text-left shadow-[0_0_60px_-10px_rgba(245,158,11,0.6)] ring-2 ring-amber-400/70 outline-none focus-visible:ring-4 lg:min-h-[38rem]"
    >
      <div className="absolute inset-0" style={lively ? { animation: "kenburns 24s ease-in-out infinite alternate" } : undefined}>
        <img src={thumbnailUrl(item)} alt="" className="absolute inset-0 h-full w-full object-cover" />
        {moving && (
          <video
            src={`/api/media-items/${item.id}/preview`}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
      </div>
      {/* An even black wash, so the centred text reads over any frame. */}
      <div className="absolute inset-0 bg-black/65" />
      {lively && <Confetti />}

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-white sm:p-10">
        <span className="relative inline-flex items-center gap-1.5 overflow-hidden rounded-full bg-gradient-to-r from-amber-200 to-amber-500 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-amber-950 shadow-lg shadow-amber-500/40">
          <Trophy className="size-3.5" />
          #1 of all time
          {lively && (
            <span
              aria-hidden
              className="absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/70 to-transparent"
              style={{ animation: "pill-shine 3.5s ease-in-out infinite" }}
            />
          )}
        </span>

        <h3 className="sensitive line-clamp-2 max-w-4xl text-5xl font-black tracking-tight drop-shadow sm:text-7xl">{item.title}</h3>

        {people.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {people.map((p) => {
              const src = p.known ? performerPortraitUrl(p.known) : null;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigate({ to: "/performer/$performerId", params: { performerId: String(p.id) } });
                  }}
                  className="flex items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 text-sm ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-white/20"
                >
                  <span className="size-7 overflow-hidden rounded-full bg-white/15 ring-1 ring-amber-300/60">
                    {src ? (
                      <img src={src} alt="" style={p.known ? circleStyle(p.known) : undefined} className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full items-center justify-center text-xs font-bold">{p.name[0]}</span>
                    )}
                  </span>
                  <span className="sensitive">{p.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {detail?.studio && (
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/60">{detail.studio}</p>
        )}

        {(seconds >= 60 || item.playCount > 0) && (
          <dl className="mt-1 flex flex-wrap items-end justify-center gap-x-10 gap-y-3">
            {item.playCount > 0 && <BigFigure label="Times played" value={`${item.playCount}×`} />}
            {seconds >= 60 && <BigFigure label="Time watched" value={formatWatchTime(seconds)} />}
          </dl>
        )}


        {facts.length > 0 && <p className="text-sm text-white/70">{facts.join(" · ")}</p>}

      </div>
    </div>
  );
}

function BigFigure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="text-3xl font-black tabular-nums tracking-tight text-amber-200 sm:text-4xl">{value}</dd>
      <dt className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.2em] text-white/60">{label}</dt>
    </div>
  );
}

/** A one-off burst of gold confetti when the tile first appears. */
function Confetti() {
  const [pieces] = useState(() =>
    Array.from({ length: 36 }, (_, i) => ({
      left: 50 + (Math.random() - 0.5) * 70,
      dx: (Math.random() - 0.5) * 520,
      dy: -(140 + Math.random() * 260),
      rotate: Math.random() * 720 - 360,
      delay: Math.random() * 180,
      size: 5 + Math.random() * 6,
      tone: ["#fde68a", "#fbbf24", "#f59e0b", "#fff7d6"][i % 4],
    })),
  );
  const [done, setDone] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDone(true), 2600);
    return () => clearTimeout(timer);
  }, []);
  if (done) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute bottom-1/3 rounded-[2px]"
          style={
            {
              left: `${p.left}%`,
              width: p.size,
              height: p.size * 0.45,
              background: p.tone,
              animation: `confetti-burst 2.2s cubic-bezier(0.2, 0.7, 0.3, 1) ${p.delay}ms forwards`,
              "--dx": `${p.dx}px`,
              "--dy": `${p.dy}px`,
              "--rot": `${p.rotate}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/** Top three performers on an actual podium: 2 · 1 · 3, steps of three heights. */
function PerformerPodium({ top }: { top: { performer: InsightPerformer; detail: string }[] }) {
  const navigate = useNavigate();
  const order = [1, 0, 2].filter((i) => top[i]);
  const heights = ["h-24", "h-16", "h-12"];
  return (
    <div className="flex flex-col">
      <p className="mb-6 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
        <Medal className="size-3.5 text-amber-400" />
        Top performers
      </p>
      <div className="mt-auto flex items-end justify-center gap-1.5">
        {order.map((place) => {
          const { performer, detail } = top[place];
          const src = performerPortraitUrl(performer);
          return (
            <button
              key={performer.id}
              type="button"
              onClick={() => void navigate({ to: "/performer/$performerId", params: { performerId: String(performer.id) } })}
              className="group flex w-1/3 min-w-0 flex-col items-center text-center"
            >
              <span
                className={cn(
                  "mb-2 block overflow-hidden rounded-full bg-secondary ring-[3px] transition-transform group-hover:scale-105",
                  place === 0 ? "size-16 ring-amber-400/80" : "size-12 ring-border",
                )}
              >
                {src && <img src={src} alt="" style={circleStyle(performer)} className="h-full w-full object-cover" />}
              </span>
              <span className="sensitive line-clamp-1 max-w-full text-xs font-semibold">{performer.name}</span>
              <span className="mb-2 text-[10px] text-muted-foreground">{detail}</span>
              <span
                className={cn(
                  "flex w-full items-start justify-center rounded-t-lg pt-1.5 text-lg font-black",
                  heights[place],
                  MEDALS[place],
                )}
              >
                {place + 1}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RankedList({
  title,
  icon: Icon,
  items,
  detail,
  onOpen,
}: {
  title: string;
  icon: LucideIcon;
  items: InsightItem[];
  detail: (item: InsightItem) => string;
  onOpen: (id: number) => void;
}) {
  return (
    <div>
      <p className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
        <Icon className="size-3.5 text-amber-400" />
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">Nothing yet.</p>
      ) : (
        <ol className="divide-y divide-border">
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(item.id)}
                className="group flex w-full items-center gap-4 py-3 text-left"
              >
                <span
                  className={cn(
                    "w-6 text-center font-mono text-lg font-bold tabular-nums",
                    i === 0 ? "text-amber-300" : "text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                <img
                  src={thumbnailUrl(item)}
                  alt=""
                  className="aspect-video w-20 shrink-0 rounded-md object-cover ring-1 ring-border transition-transform group-hover:scale-[1.03]"
                />
                <span className="sensitive min-w-0 flex-1 truncate font-medium group-hover:underline">{item.title}</span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{detail(item)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// --- Bars (shared by the year and habits charts) ----------------------------

/**
 * A single-series bar chart in plain HTML: one neutral colour, the peak in
 * full white, 2px gaps, rounded tops, a hover tooltip per bar. One series,
 * so no legend — the heading names it.
 */
function Bars({
  values,
  labels,
  format,
  height = "h-44",
  selected,
  onSelect,
  labelEvery = 1,
  axisLabels,
  minScale = 0,
}: {
  values: number[];
  labels: string[];
  /** Shorter labels for the axis, when the tooltip's are too long to fit. */
  axisLabels?: string[];
  /** The least the top of the chart stands for, so a few seconds don't fill it. */
  minScale?: number;
  format: (v: number) => string;
  height?: string;
  selected?: number;
  onSelect?: (index: number) => void;
  /** Show every nth axis label, for dense charts. */
  labelEvery?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(...values, minScale, 1);
  const peakIndex = values.indexOf(Math.max(...values));
  return (
    <div>
      <div className={cn("relative flex items-end gap-[2px] border-b border-border", height)}>
        {values.map((value, i) => {
          const active = selected === i || hover === i;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect?.(i)}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              aria-label={`${labels[i]}: ${format(value)}`}
              className={cn("group relative flex h-full flex-1 items-end", !onSelect && "cursor-default")}
            >
              <span
                className={cn(
                  "block w-full rounded-t-[4px] transition-colors",
                  value === 0
                    ? "h-[2px] bg-white/10"
                    : active
                      ? "bg-amber-300"
                      : i === peakIndex
                        ? "bg-white/90"
                        : "bg-white/35",
                )}
                style={value > 0 ? { height: `${Math.max(3, (value / peak) * 100)}%` } : undefined}
              />
              {hover === i && (
                <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs shadow-lg ring-1 ring-border">
                  <span className="text-muted-foreground">{labels[i]} · </span>
                  <span className="font-semibold tabular-nums">{format(value)}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-[2px] text-[11px] text-muted-foreground">
        {(axisLabels ?? labels).map((label, i) => (
          <span key={i} className={cn("flex-1 text-center", selected === i && "font-semibold text-foreground")}>
            {i % labelEvery === 0 ? label : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

// --- 02 Your year -----------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function YourYear({
  data,
  days,
  today,
  onOpenItem,
}: {
  data: Insights;
  days: Map<string, number>;
  today: string;
  onOpenItem: (id: number) => void;
}) {
  // The last twelve months, oldest first, ending with this one.
  const months = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => localMonth(new Date(now.getFullYear(), now.getMonth() - 11 + i, 15)));
  }, []);
  const totals = months.map((m) =>
    [...days.entries()].filter(([day]) => day.startsWith(m)).reduce((sum, [, s]) => sum + s, 0),
  );
  const latestWithTime = [...totals].map((t, i) => (t >= 60 ? i : -1)).filter((i) => i >= 0).pop() ?? 11;
  const [selected, setSelected] = useState(latestWithTime);
  const recap = monthRecap(data, months[selected]);

  return (
    <div className="space-y-12">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
            Hours per month · tap a month for its recap
          </p>
          <Bars
            values={totals}
            labels={months.map((m) => MONTHS[Number(m.slice(5, 7)) - 1])}
            format={(v) => (v > 0 ? formatWatchTime(v) : "nothing")}
            selected={selected}
            onSelect={setSelected}
            height="h-56"
            minScale={3600}
          />
        </div>
        <MonthStory month={months[selected]} recap={recap} onOpenItem={onOpenItem} />
      </div>

      <div>
        <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">Every day, this year</p>
        <DayGrid days={days} today={today} />
      </div>
    </div>
  );
}

/** The month's recap written out as a short story, not a card deck. */
function MonthStory({
  month,
  recap,
  onOpenItem,
}: {
  month: string;
  recap: ReturnType<typeof monthRecap>;
  onOpenItem: (id: number) => void;
}) {
  const name = new Date(`${month}-15T12:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (!recap || recap.seconds < 60) {
    return (
      <div className="flex flex-col justify-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">{name}</p>
        <p className="mt-3 text-2xl font-bold text-muted-foreground">A quiet month — nothing watched yet.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Watch a few minutes and this month's story writes itself here: how long, who and which studio.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col justify-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">{name}</p>
      <p className="mt-3 text-2xl font-bold leading-snug tracking-tight sm:text-3xl">
        You watched <span className="text-amber-300">{formatWatchTime(recap.seconds)}</span> across {recap.videos}{" "}
        {recap.videos === 1 ? "video" : "videos"}
        {recap.topPerformer && (
          <>
            , mostly <span className="sensitive text-amber-300">{recap.topPerformer.performer.name}</span>
          </>
        )}
        {recap.topStudio && (
          <>
            {" "}from <span className="text-amber-300">{recap.topStudio.name}</span>
          </>
        )}
        .
      </p>
      <p className="mt-3 text-muted-foreground">
        {recap.activeDays} active {recap.activeDays === 1 ? "day" : "days"}
        {recap.longestStreak > 1 && <>, a {recap.longestStreak}-day streak</>}
        {recap.busiestDay && recap.busiestDay.seconds >= 60 && (
          <>
            , busiest on{" "}
            {new Date(recap.busiestDay.day + "T12:00").toLocaleDateString(undefined, { day: "numeric", month: "long" })}
          </>
        )}
        .
      </p>
      {recap.mostWatched && (
        <button
          type="button"
          onClick={() => onOpenItem(recap.mostWatched!.item.id)}
          className="group mt-6 flex items-center gap-4 rounded-2xl border border-border p-3 text-left transition-colors hover:bg-secondary/40"
        >
          <img src={thumbnailUrl(recap.mostWatched.item)} alt="" className="aspect-video w-28 shrink-0 rounded-lg object-cover" />
          <span className="min-w-0">
            <span className="block text-[11px] uppercase tracking-wider text-muted-foreground">On repeat</span>
            <span className="sensitive line-clamp-2 block font-semibold">{recap.mostWatched.item.title}</span>
            <span className="text-xs text-muted-foreground">{formatWatchTime(recap.mostWatched.seconds)} watched</span>
          </span>
        </button>
      )}
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const LEVELS = ["bg-white/[0.06]", "bg-white/25", "bg-white/45", "bg-white/70", "bg-amber-300"];

/**
 * The last twelve months as separate little calendars, GitHub-style: each
 * month its own block of Monday-to-Sunday week columns, with a gap between
 * months so you can tell where one ends and the next begins.
 */
function DayGrid({ days, today }: { days: Map<string, number>; today: string }) {
  const months = useMemo(() => calendarMonths(days, today), [days, today]);
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-[48rem] gap-3">
        {/* Weekday labels, spaced to match the rows beside them: a spacer the
            height of a month name, then seven equal rows. */}
        <div className="flex shrink-0 flex-col">
          <div className="mb-1.5 h-4" />
          <div className="grid flex-1 grid-rows-7 gap-[3px] text-[10px] leading-none text-muted-foreground">
            {WEEKDAYS.map((day, i) => (
              <span key={day} className="flex items-center">
                {i % 2 === 0 ? day : ""}
              </span>
            ))}
          </div>
        </div>

        {months.map(({ month, weeks }) => (
          // Width in proportion to the month's weeks, so every square in the
          // year comes out the same size.
          <div key={month} className="min-w-0" style={{ flex: `${weeks.length} 1 0` }}>
            <p className="mb-1.5 h-4 text-[11px] font-medium leading-4 text-muted-foreground">
              {MONTHS[Number(month.slice(5, 7)) - 1]}
            </p>
            <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
              {weeks.map((week, w) => (
                <div key={w} className="flex flex-col gap-[3px]">
                  {week.map((slot, d) =>
                    slot === null ? (
                      <span key={d} className="aspect-square w-full" />
                    ) : (
                      <span
                        key={slot.day}
                        title={`${new Date(slot.day + "T12:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · ${
                          slot.future ? "still to come" : slot.seconds > 0 ? formatWatchTime(slot.seconds) : "nothing"
                        }`}
                        className={cn(
                          "aspect-square w-full rounded-[3px]",
                          slot.future ? "ring-1 ring-inset ring-white/[0.06]" : LEVELS[slot.level],
                          slot.day === today && "ring-1 ring-foreground/70",
                        )}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
        Less
        {LEVELS.map((level) => (
          <span key={level} className={cn("size-3 rounded-[3px]", level)} />
        ))}
        More
      </div>
    </div>
  );
}

// --- 03 Habits --------------------------------------------------------------

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function hourName(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

function Habits({ data, lateShare }: { data: Insights; lateShare: number }) {
  const byHour = new Array<number>(24).fill(0);
  const byWeekday = new Array<number>(7).fill(0);
  for (const entry of data.log) {
    const date = new Date(entry.hour);
    byHour[date.getHours()] += entry.seconds;
    byWeekday[(date.getDay() + 6) % 7] += entry.seconds;
  }
  const primeHour = byHour.indexOf(Math.max(...byHour));
  const bestDay = byWeekday.indexOf(Math.max(...byWeekday));
  const late = Math.round(lateShare * 100);

  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div>
        <p className="mb-2 text-2xl font-bold tracking-tight">
          Prime time is <span className="text-amber-300">{hourName(primeHour)}</span>.
        </p>
        <p className="mb-6 text-sm text-muted-foreground">
          {late >= 50
            ? `${late}% of your watching happens after 10 pm — a certified night owl 🦉`
            : `${late}% of your watching happens after 10 pm.`}
        </p>
        <Bars
          values={byHour}
          labels={byHour.map((_, h) => hourName(h))}
          axisLabels={byHour.map((_, h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`)}
          format={(v) => (v > 0 ? formatWatchTime(v) : "nothing")}
          labelEvery={3}
        />
      </div>
      <div>
        <p className="mb-2 text-2xl font-bold tracking-tight">
          <span className="text-amber-300">{WEEKDAY_NAMES[bestDay]}</span> is your day.
        </p>
        <p className="mb-6 text-sm text-muted-foreground">Time watched on each day of the week.</p>
        <Bars values={byWeekday} labels={WEEKDAYS} format={(v) => (v > 0 ? formatWatchTime(v) : "nothing")} />
      </div>
    </div>
  );
}

// --- 04 Trophies ------------------------------------------------------------

function badgeIcon(id: string): LucideIcon {
  if (id.startsWith("streak")) return Flame;
  if (id === "night-owl") return Moon;
  if (id === "early-bird") return Sunrise;
  if (id === "critic") return Star;
  if (id === "rewatcher") return Repeat;
  if (id === "explorer") return Compass;
  if (id.includes("complete")) return Medal;
  if (id === "marathon" || id === "first-hour" || id === "century") return Clock;
  return Trophy;
}

function Trophies({ list }: { list: Achievement[] }) {
  const earned = list.filter((a) => a.earned);
  const locked = list.filter((a) => !a.earned);
  return (
    <div className="space-y-12">
      <div>
        <p className="mb-5 text-2xl font-bold tracking-tight">
          <span className="text-amber-300 tabular-nums">{earned.length}</span> of {list.length} unlocked
        </p>
        {earned.length === 0 ? (
          <p className="text-muted-foreground">None yet — your first one is an hour of watching away.</p>
        ) : (
          <div className="flex flex-wrap gap-x-6 gap-y-8">
            {earned.map((badge) => {
              const Icon = badgeIcon(badge.id);
              return (
                <div key={badge.id} className="group flex w-28 flex-col items-center text-center" title={badge.description}>
                  <span className="grid size-20 place-items-center rounded-full bg-gradient-to-br from-amber-200 via-amber-400 to-amber-700 text-amber-950 shadow-[0_8px_30px_-8px_rgba(245,158,11,0.6)] ring-4 ring-amber-300/20 transition-transform group-hover:-translate-y-1 group-hover:rotate-6">
                    <Icon className="size-8" />
                  </span>
                  <span className="sensitive mt-3 text-sm font-semibold leading-tight">{badge.title}</span>
                  <span className="mt-1 text-[11px] leading-snug text-muted-foreground">{badge.description}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {locked.length > 0 && (
        <div>
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">Still to unlock</p>
          <ul className="grid gap-x-10 gap-y-1 md:grid-cols-2">
            {locked.map((badge) => {
              const Icon = badgeIcon(badge.id);
              return (
                <li key={badge.id} className="flex items-center gap-4 border-b border-border py-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
                    {badge.progress > 0 ? <Icon className="size-4" /> : <Lock className="size-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="sensitive truncate text-sm font-medium">{badge.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{badge.description}</p>
                  </div>
                  {badge.progressLabel && (
                    <div className="w-28 shrink-0">
                      <div className="h-1 overflow-hidden rounded-full bg-secondary">
                        <div className="h-full rounded-full bg-white/70" style={{ width: `${badge.progress * 100}%` }} />
                      </div>
                      <p className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">{badge.progressLabel}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
