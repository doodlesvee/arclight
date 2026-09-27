/**
 * The Stats page's arithmetic: calendar, streaks, monthly recap, hall of fame
 * and achievements, all worked out from `/api/insights`.
 *
 * Pure functions over plain data, apart from reading the time zone through
 * `Date`, so each can be tested on its own and nothing here can fetch or
 * write anything.
 */

export type WatchLogEntry = { mediaItemId: number; hour: string; seconds: number };
export type InsightItem = {
  id: number;
  title: string;
  thumbnailFile: string | null;
  durationSeconds: number | null;
  rating: number | null;
  studio: string | null;
  playCount: number;
  completedAt: string | null;
  performerIds: number[];
};
export type InsightPerformer = {
  id: number;
  name: string;
  hasImage: boolean;
  hasBanner: boolean;
  imagePositionX: number;
  imagePositionY: number;
  imageScale: number;
  avatarPositionX: number | null;
  avatarPositionY: number | null;
  avatarScale: number | null;
  representativeItemId: number | null;
  videoCount: number;
  finishedCount: number;
};
export type InsightStudio = { name: string; videoCount: number; finishedCount: number };
export type Insights = {
  log: WatchLogEntry[];
  items: InsightItem[];
  performers: InsightPerformer[];
  studios: InsightStudio[];
  /** Saved bookmarks across the library. Optional so older payloads still parse. */
  bookmarkCount?: number;
};

/** A day counts towards a streak once you've watched at least this much. */
export const ACTIVE_DAY_SECONDS = 60;

/** "YYYY-MM-DD" in the viewer's own time zone. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const localMonth = (date: Date) => localDay(date).slice(0, 7);

/** Seconds watched per local day. */
export function secondsByDay(log: WatchLogEntry[]): Map<string, number> {
  const days = new Map<string, number>();
  for (const entry of log) {
    const day = localDay(new Date(entry.hour));
    days.set(day, (days.get(day) ?? 0) + entry.seconds);
  }
  return days;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

export type Streaks = { current: number; longest: number; longestEnded: string | null };

/**
 * Runs of consecutive active days. The current streak survives today being
 * empty so far — it only breaks once a whole day passes with nothing.
 */
export function streaks(days: Map<string, number>, today: string): Streaks {
  const active = [...days.entries()]
    .filter(([, seconds]) => seconds >= ACTIVE_DAY_SECONDS)
    .map(([day]) => day)
    .sort();
  const set = new Set(active);
  let longest = 0;
  let longestEnded: string | null = null;
  for (const day of active) {
    if (set.has(addDays(day, -1))) continue;
    let length = 1;
    let end = day;
    while (set.has(addDays(end, 1))) {
      end = addDays(end, 1);
      length++;
    }
    if (length > longest) {
      longest = length;
      longestEnded = end;
    }
  }
  let current = 0;
  let cursor = set.has(today) ? today : addDays(today, -1);
  while (set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  return { current, longest, longestEnded };
}

export type CalendarCell = { day: string; seconds: number; level: 0 | 1 | 2 | 3 | 4 };

/**
 * The last year as weeks of days, oldest first, each week starting on
 * Monday, shaded into five levels relative to your own busiest day.
 */
export function calendarWeeks(days: Map<string, number>, today: string, weekCount = 53): CalendarCell[][] {
  const [y, m, d] = today.split("-").map(Number);
  const end = new Date(y, m - 1, d);
  const mondayOffset = (end.getDay() + 6) % 7;
  const start = new Date(y, m - 1, d - mondayOffset - (weekCount - 1) * 7);
  const peak = Math.max(1, ...days.values());
  const weeks: CalendarCell[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i);
      if (date > end) break;
      const day = localDay(date);
      const seconds = days.get(day) ?? 0;
      week.push({ day, seconds, level: dayLevel(seconds, peak) });
    }
    weeks.push(week);
  }
  return weeks;
}

/** Five shades, relative to your own busiest day. */
function dayLevel(seconds: number, peak: number): CalendarCell["level"] {
  const ratio = seconds / peak;
  return seconds < ACTIVE_DAY_SECONDS ? 0 : ratio > 0.75 ? 4 : ratio > 0.45 ? 3 : ratio > 0.2 ? 2 : 1;
}

/**
 * A slot in a month's grid: a day of that month, one still to come, or
 * padding before the 1st and after the last so every column is a full week.
 */
export type MonthSlot = (CalendarCell & { future: boolean }) | null;
export type CalendarMonth = { month: string; weeks: MonthSlot[][] };

/**
 * The last `monthCount` months, oldest first and ending with this one, each
 * laid out on its own as columns of Monday-to-Sunday weeks. Shading is
 * relative to the busiest day across all of them, so months compare fairly.
 */
export function calendarMonths(days: Map<string, number>, today: string, monthCount = 12): CalendarMonth[] {
  const [y, m] = today.split("-").map(Number);
  const firstMonth = new Date(y, m - 1 - (monthCount - 1), 1);
  const firstDay = localDay(firstMonth);
  const peak = Math.max(1, ...[...days.entries()].filter(([day]) => day >= firstDay && day <= today).map(([, s]) => s));

  return Array.from({ length: monthCount }, (_, i) => {
    const year = firstMonth.getFullYear();
    const month = firstMonth.getMonth() + i;
    const length = new Date(year, month + 1, 0).getDate();
    const lead = (new Date(year, month, 1).getDay() + 6) % 7;
    const slots: MonthSlot[] = Array.from({ length: lead }, () => null);
    for (let date = 1; date <= length; date++) {
      const day = localDay(new Date(year, month, date));
      const seconds = days.get(day) ?? 0;
      slots.push({ day, seconds, level: dayLevel(seconds, peak), future: day > today });
    }
    while (slots.length % 7 !== 0) slots.push(null);
    const weeks: MonthSlot[][] = [];
    for (let w = 0; w < slots.length; w += 7) weeks.push(slots.slice(w, w + 7));
    return { month: localMonth(new Date(year, month, 1)), weeks };
  });
}

/** Seconds watched per (performer id | studio name | item id), over some log. */
function tally<K>(log: WatchLogEntry[], items: Map<number, InsightItem>, keys: (item: InsightItem) => K[]) {
  const totals = new Map<K, number>();
  for (const entry of log) {
    const item = items.get(entry.mediaItemId);
    if (!item) continue;
    for (const key of keys(item)) totals.set(key, (totals.get(key) ?? 0) + entry.seconds);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

export type MonthRecap = {
  month: string;
  seconds: number;
  activeDays: number;
  videos: number;
  topPerformer: { performer: InsightPerformer; seconds: number } | null;
  topStudio: { name: string; seconds: number } | null;
  mostWatched: { item: InsightItem; seconds: number } | null;
  longestStreak: number;
  busiestDay: { day: string; seconds: number } | null;
};

/** One month, Wrapped-style. `null` when nothing was watched in it. */
export function monthRecap(data: Insights, month: string): MonthRecap | null {
  const log = data.log.filter((entry) => localMonth(new Date(entry.hour)) === month);
  if (log.length === 0) return null;
  const items = new Map(data.items.map((item) => [item.id, item]));
  const performers = new Map(data.performers.map((p) => [p.id, p]));
  const days = secondsByDay(log);
  const topPerformer = tally(log, items, (item) => item.performerIds)[0];
  const topStudio = tally(log, items, (item) => (item.studio ? [item.studio] : []))[0];
  const topItem = tally(log, items, (item) => [item.id])[0];
  const busiest = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
  // The month's own streak: the longest run inside it, not the one running now.
  const { longest } = streaks(days, "0000-01-01");
  return {
    month,
    seconds: log.reduce((sum, entry) => sum + entry.seconds, 0),
    activeDays: [...days.values()].filter((s) => s >= ACTIVE_DAY_SECONDS).length,
    videos: new Set(log.map((entry) => entry.mediaItemId)).size,
    topPerformer:
      topPerformer && performers.get(topPerformer[0])
        ? { performer: performers.get(topPerformer[0])!, seconds: topPerformer[1] }
        : null,
    topStudio: topStudio ? { name: topStudio[0], seconds: topStudio[1] } : null,
    mostWatched: topItem && items.get(topItem[0]) ? { item: items.get(topItem[0])!, seconds: topItem[1] } : null,
    longestStreak: longest,
    busiestDay: busiest ? { day: busiest[0], seconds: busiest[1] } : null,
  };
}

/** Months with any watching, newest first. */
export function recapMonths(log: WatchLogEntry[]): string[] {
  return [...new Set(log.map((entry) => localMonth(new Date(entry.hour))))].sort().reverse();
}

export type HallOfFame = {
  /**
   * The headline: the one video you've spent the most time with, all time.
   * Ties go to the one played more, then the one rated higher.
   */
  mainEvent: { item: InsightItem; seconds: number } | null;
  performersByTime: { performer: InsightPerformer; seconds: number }[];
  videosByPlays: InsightItem[];
  videosByRating: InsightItem[];
};

export function hallOfFame(data: Insights, size = 6): HallOfFame {
  const items = new Map(data.items.map((item) => [item.id, item]));
  const performers = new Map(data.performers.map((p) => [p.id, p]));
  const watched = new Map(tally(data.log, items, (item) => [item.id]));
  const [top] = [...data.items]
    .filter((item) => (watched.get(item.id) ?? 0) > 0 || item.playCount > 0)
    .sort(
      (a, b) =>
        (watched.get(b.id) ?? 0) - (watched.get(a.id) ?? 0) ||
        b.playCount - a.playCount ||
        (b.rating ?? 0) - (a.rating ?? 0),
    );
  return {
    mainEvent: top ? { item: top, seconds: watched.get(top.id) ?? 0 } : null,
    performersByTime: tally(data.log, items, (item) => item.performerIds)
      .filter(([id]) => performers.has(id))
      .slice(0, size)
      .map(([id, seconds]) => ({ performer: performers.get(id)!, seconds })),
    videosByPlays: data.items
      .filter((item) => item.playCount > 0)
      .sort((a, b) => b.playCount - a.playCount || a.title.localeCompare(b.title))
      .slice(0, size),
    videosByRating: data.items
      .filter((item) => item.rating != null)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.playCount - a.playCount)
      .slice(0, size),
  };
}

export type Achievement = {
  id: string;
  title: string;
  description: string;
  earned: boolean;
  /** 0–1 towards earning it; 1 once earned. */
  progress: number;
  /** "3 of 5 days", for the locked ones. */
  progressLabel?: string;
  /**
   * Badges that come in bronze, silver and gold share a family; each tier is
   * its own badge with its own id, so each one unlocks (and toasts) on its own.
   */
  family?: string;
  tier?: 1 | 2 | 3;
};

const hoursOf = (seconds: number) => seconds / 3600;

/** Whole days from one "YYYY-MM-DD" to another. */
function daysBetween(from: string, to: string): number {
  const utc = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

const weekdayOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
};

/** The longest run of consecutive days in a set of "YYYY-MM-DD" days. */
function longestRun(days: Set<string>): number {
  let best = 0;
  for (const day of days) {
    if (days.has(addDays(day, -1))) continue;
    let length = 1;
    while (days.has(addDays(day, length))) length++;
    best = Math.max(best, length);
  }
  return best;
}

/**
 * Every badge, earned or not, with how close the locked ones are. Built from
 * the watch log, play counts, ratings, bookmarks and how much of each
 * performer and studio you've finished.
 *
 * Tier one of each family keeps the id it had before tiers existed, so a
 * badge unlocked back then is still recognised as unlocked now.
 */
export function achievements(data: Insights, today: string): Achievement[] {
  const days = secondsByDay(data.log);
  const activeDays = [...days.entries()]
    .filter(([, seconds]) => seconds >= ACTIVE_DAY_SECONDS)
    .map(([day]) => day)
    .sort();
  const active = new Set(activeDays);
  const total = data.log.reduce((sum, entry) => sum + entry.seconds, 0);
  const { longest } = streaks(days, today);
  const bestDay = Math.max(0, ...days.values());
  const localHours = data.log.map((entry) => new Date(entry.hour).getHours());
  const finished = data.items.filter((item) => item.completedAt);
  const studiosWatched = new Set(finished.filter((item) => item.studio).map((item) => item.studio)).size;
  const rated = data.items.filter((item) => item.rating != null).length;
  const mostPlays = Math.max(0, ...data.items.map((item) => item.playCount));

  // Finishes per local day. Only an item's latest finish is known, so a
  // rewatch moves it rather than counting twice.
  const finishesByDay = new Map<string, number>();
  for (const item of finished) {
    const day = localDay(new Date(item.completedAt!));
    finishesByDay.set(day, (finishesByDay.get(day) ?? 0) + 1);
  }
  const bestFinishDay = Math.max(0, ...finishesByDay.values());

  const weekends = activeDays.filter((day) => weekdayOf(day) === 6 && active.has(addDays(day, 1))).length;

  // Distinct active days in each Monday-to-Sunday week.
  const perWeek = new Map<string, number>();
  for (const day of activeDays) {
    const monday = addDays(day, -((weekdayOf(day) + 6) % 7));
    perWeek.set(monday, (perWeek.get(monday) ?? 0) + 1);
  }
  const fullestWeek = Math.max(0, ...perWeek.values());

  const lunchDays = new Set(
    data.log
      .filter((entry) => entry.seconds > 0 && new Date(entry.hour).getHours() === 12)
      .map((entry) => localDay(new Date(entry.hour))),
  ).size;

  const longestGap = activeDays.reduce(
    (gap, day, i) => (i === 0 ? gap : Math.max(gap, daysBetween(activeDays[i - 1], day))),
    0,
  );
  const sinceFirst = activeDays.length > 0 ? daysBetween(activeDays[0], today) : 0;

  const longHaul = finished.some((item) => (item.durationSeconds ?? 0) >= 2 * 3600);
  const shorts = finished.filter(
    (item) => item.durationSeconds != null && item.durationSeconds > 0 && item.durationSeconds < 600,
  ).length;
  const fiveStars = data.items.filter((item) => item.rating === 5).length;
  const oneStar = data.items.some((item) => item.rating === 1);

  // Days each video was watched on, for the three-days-running badge.
  const daysByItem = new Map<number, Set<string>>();
  for (const entry of data.log) {
    if (entry.seconds <= 0) continue;
    const set = daysByItem.get(entry.mediaItemId) ?? new Set<string>();
    set.add(localDay(new Date(entry.hour)));
    daysByItem.set(entry.mediaItemId, set);
  }
  const bestItemRun = Math.max(0, ...[...daysByItem.values()].map(longestRun));

  // Performers in anything you actually watched — rated-only items don't count.
  const performersSeen = new Set(
    data.items
      .filter((item) => daysByItem.has(item.id) || item.completedAt || item.playCount > 0)
      .flatMap((item) => item.performerIds),
  ).size;
  const bookmarks = data.bookmarkCount ?? 0;

  const goal = (
    id: string,
    title: string,
    description: string,
    value: number,
    target: number,
    unit: (n: number) => string,
  ): Achievement => ({
    id,
    title,
    description,
    earned: value >= target,
    progress: Math.min(1, value / target),
    // "3 of 5 days": the unit once, on the target.
    progressLabel: `${unit(Math.min(value, target)).split(" ")[0]} of ${unit(target)}`,
  });
  const flag = (id: string, title: string, description: string, earned: boolean, progress = earned ? 1 : 0): Achievement => ({
    id,
    title,
    description,
    earned,
    progress: Math.min(1, progress),
  });
  /** Bronze, silver and gold of one goal, each its own badge. */
  const tiers = (
    family: string,
    value: number,
    unit: (n: number) => string,
    steps: [id: string, title: string, description: string, target: number][],
  ): Achievement[] =>
    steps.map(([id, title, description, target], i) => ({
      ...goal(id, title, description, value, target, unit),
      family,
      tier: (i + 1) as 1 | 2 | 3,
    }));
  const days_ = (n: number) => `${Math.floor(n)} day${Math.floor(n) === 1 ? "" : "s"}`;
  const hours_ = (n: number) => `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.floor(n)} h`;
  const count_ = (n: number) => `${Math.floor(n)}`;

  const list: Achievement[] = [
    ...tiers("watch-time", hoursOf(total), hours_, [
      ["first-hour", "First hour", "Watch an hour in total.", 1],
      ["century", "Century", "A hundred hours in total.", 100],
      ["watch-time-t3", "Five hundred club", "Five hundred hours in total.", 500],
    ]),
    ...tiers("marathon", hoursOf(bestDay), hours_, [
      ["marathon", "Marathon", "Watch two hours in a single day.", 2],
      ["marathon-t2", "Ultramarathon", "Watch four hours in a single day.", 4],
      ["marathon-t3", "Iron eyes", "Watch six hours in a single day.", 6],
    ]),
    ...tiers("streak", longest, days_, [
      ["streak-5", "5-day streak", "Watch something five days running.", 5],
      ["streak-30", "30-day streak", "A whole month without missing a day.", 30],
      ["streak-100", "100-day streak", "A hundred days without missing one.", 100],
    ]),
    ...tiers("critic", rated, count_, [
      ["critic", "Critic", "Rate 25 videos.", 25],
      ["critic-t2", "Reviewer", "Rate 100 videos.", 100],
      ["critic-t3", "Chief critic", "Rate 250 videos.", 250],
    ]),
    ...tiers("explorer", studiosWatched, count_, [
      ["explorer", "Explorer", "Finish videos from five different studios.", 5],
      ["explorer-t2", "Voyager", "Finish videos from 15 different studios.", 15],
      ["explorer-t3", "Cartographer", "Finish videos from 30 different studios.", 30],
    ]),
    ...tiers("people", performersSeen, count_, [
      ["people-t1", "People person", "Watch videos with 10 different performers.", 10],
      ["people-t2", "Social butterfly", "Watch videos with 25 different performers.", 25],
      ["people-t3", "Who's who", "Watch videos with 50 different performers.", 50],
    ]),
    ...tiers("moments", bookmarks, count_, [
      ["moments-t1", "Moment keeper", "Save 10 bookmarks.", 10],
      ["moments-t2", "Scrapbooker", "Save 50 bookmarks.", 50],
      ["moments-t3", "Archivist", "Save 100 bookmarks.", 100],
    ]),
    flag("night-owl", "Night owl", "Watch between midnight and 4 am.", localHours.some((h) => h < 4)),
    flag("early-bird", "Early bird", "Watch between 5 and 7 am.", localHours.some((h) => h >= 5 && h < 7)),
    goal("lunch-break", "Lunch break", "Watch during the noon hour on five different days.", lunchDays, 5, days_),
    goal("rewatcher", "On repeat", "Finish the same video three times.", mostPlays, 3, count_),
    goal("binge", "Binge", "Finish five videos in a single day.", bestFinishDay, 5, count_),
    goal("weekend-warrior", "Weekend warrior", "Watch on both days of four weekends.", weekends, 4, count_),
    goal("full-week", "Full week", "Watch every day from Monday to Sunday.", fullestWeek, 7, days_),
    goal("hat-trick", "Hat-trick", "Watch the same video three days running.", bestItemRun, 3, days_),
    goal("short-and-sweet", "Short & sweet", "Finish ten videos under ten minutes.", shorts, 10, count_),
    goal("tastemaker", "Tastemaker", "Give ten videos five stars.", fiveStars, 10, count_),
    goal("anniversary", "Anniversary", "A year since the first thing you watched.", sinceFirst, 365, days_),
    flag("long-haul", "Long haul", "Finish a video two hours or longer.", longHaul),
    flag("tough-crowd", "Tough crowd", "Give a video one star.", oneStar),
    flag("comeback", "Comeback", "Come back after a month or more away.", longestGap > 30),
  ];

  // Completionist badges: one earned badge per performer or studio you've
  // finished entirely (with enough videos for it to mean something), and a
  // locked one showing whoever you're closest to finishing.
  const completion = (
    kind: "performer" | "studio",
    rows: { name: string; videoCount: number; finishedCount: number; key: string }[],
  ) => {
    const eligible = rows.filter((row) => row.videoCount >= 3);
    const done = eligible.filter((row) => row.finishedCount >= row.videoCount);
    for (const row of done) {
      list.push({
        id: `${kind}-complete-${row.key}`,
        title: kind === "performer" ? `All of ${row.name}` : `${row.name} completionist`,
        description: `Finished every one of ${row.videoCount} videos.`,
        earned: true,
        progress: 1,
      });
    }
    const closest = eligible
      .filter((row) => row.finishedCount < row.videoCount)
      .sort((a, b) => b.finishedCount / b.videoCount - a.finishedCount / a.videoCount)[0];
    if (closest) {
      list.push({
        id: `${kind}-complete-next`,
        title: kind === "performer" ? `All of ${closest.name}` : `${closest.name} completionist`,
        description:
          kind === "performer"
            ? `Watch every video of a performer — ${closest.name} is closest.`
            : `Finish every video from a studio — ${closest.name} is closest.`,
        earned: false,
        progress: closest.finishedCount / closest.videoCount,
        progressLabel: `${closest.finishedCount} of ${closest.videoCount}`,
      });
    }
  };
  completion(
    "performer",
    data.performers.map((p) => ({ ...p, key: String(p.id) })),
  );
  completion(
    "studio",
    data.studios.map((s) => ({ ...s, key: s.name })),
  );

  // Earned first, then the ones you're nearest to.
  return list.sort((a, b) => Number(b.earned) - Number(a.earned) || b.progress - a.progress);
}

/**
 * The shelf as the Stats page shows it: a tiered family appears once, as the
 * highest tier you hold, plus its next tier among the ones still to unlock.
 * Every tier still counts on its own towards "n of m unlocked".
 */
export function trophyShelf(list: Achievement[]): { earned: Achievement[]; locked: Achievement[] } {
  const top = new Map<string, Achievement>();
  const next = new Map<string, Achievement>();
  const earned: Achievement[] = [];
  const locked: Achievement[] = [];
  for (const badge of list) {
    if (!badge.family) {
      (badge.earned ? earned : locked).push(badge);
      continue;
    }
    const map = badge.earned ? top : next;
    const held = map.get(badge.family);
    const better = badge.earned ? (held?.tier ?? 0) < (badge.tier ?? 0) : (held?.tier ?? 4) > (badge.tier ?? 0);
    if (!held || better) map.set(badge.family, badge);
  }
  earned.push(...top.values());
  locked.push(...next.values());
  const order = (a: Achievement, b: Achievement) => b.progress - a.progress;
  return { earned, locked: locked.sort(order) };
}

/** The earned badges in `list` that `unlocked` has no record of yet. */
export function newlyEarned(list: Achievement[], unlocked: Record<string, string>): Achievement[] {
  return list.filter((badge) => badge.earned && !(badge.id in unlocked));
}

export type FunFacts = {
  /** Local hour (0–23) you watch most in, weighted by time. */
  primeHour: number | null;
  /** Weekday (0 = Sunday) you watch most on. */
  favouriteWeekday: number | null;
  /** Average time on a day you watched anything. */
  averageDaySeconds: number;
  /** Share of all time watched between 10 pm and 4 am, 0–1. */
  lateNightShare: number;
  /** Distinct videos in the log. */
  videosWatched: number;
};

/** Small, cheerful numbers from the watch log, all in local time. */
export function funFacts(log: WatchLogEntry[]): FunFacts {
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  let total = 0;
  let late = 0;
  for (const entry of log) {
    const date = new Date(entry.hour);
    hours[date.getHours()] += entry.seconds;
    weekdays[date.getDay()] += entry.seconds;
    total += entry.seconds;
    if (date.getHours() >= 22 || date.getHours() < 4) late += entry.seconds;
  }
  const peak = (values: number[]) => {
    const max = Math.max(...values);
    return max > 0 ? values.indexOf(max) : null;
  };
  const activeDays = [...secondsByDay(log).values()].filter((s) => s >= ACTIVE_DAY_SECONDS).length;
  return {
    primeHour: peak(hours),
    favouriteWeekday: peak(weekdays),
    averageDaySeconds: activeDays > 0 ? total / activeDays : 0,
    lateNightShare: total > 0 ? late / total : 0,
    videosWatched: new Set(log.map((entry) => entry.mediaItemId)).size,
  };
}

export function formatWatchTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = seconds / 3600;
  return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)} h`;
}
