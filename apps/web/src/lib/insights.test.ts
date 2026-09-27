import { describe, expect, it } from "vitest";
import {
  achievements,
  funFacts,
  calendarMonths,
  calendarWeeks,
  hallOfFame,
  localDay,
  monthRecap,
  secondsByDay,
  streaks,
  type Insights,
} from "./insights";

// Built from local dates, so the tests pass in any time zone.
const at = (y: number, m: number, d: number, h = 20) => new Date(y, m - 1, d, h).toISOString();

const data: Insights = {
  log: [
    { mediaItemId: 1, hour: at(2026, 9, 1), seconds: 1800 },
    { mediaItemId: 1, hour: at(2026, 9, 2), seconds: 600 },
    { mediaItemId: 2, hour: at(2026, 9, 3, 2), seconds: 3600 },
    { mediaItemId: 2, hour: at(2026, 8, 20), seconds: 120 },
  ],
  items: [
    { id: 1, title: "One", thumbnailFile: null, durationSeconds: 1800, rating: 5, studio: "Harbor", playCount: 3, completedAt: at(2026, 9, 2), performerIds: [10] },
    { id: 2, title: "Two", thumbnailFile: null, durationSeconds: 3600, rating: null, studio: "Mono", playCount: 1, completedAt: at(2026, 9, 3), performerIds: [11] },
  ],
  performers: [
    { id: 10, name: "Ann", hasImage: false, hasBanner: false, imagePositionX: 50, imagePositionY: 0, imageScale: 100, avatarPositionX: null, avatarPositionY: null, avatarScale: null, representativeItemId: 1, videoCount: 3, finishedCount: 3 },
    { id: 11, name: "Bea", hasImage: false, hasBanner: false, imagePositionX: 50, imagePositionY: 0, imageScale: 100, avatarPositionX: null, avatarPositionY: null, avatarScale: null, representativeItemId: 2, videoCount: 4, finishedCount: 1 },
  ],
  studios: [{ name: "Harbor", videoCount: 3, finishedCount: 1 }],
};

describe("insights", () => {
  it("adds up each local day", () => {
    const days = secondsByDay(data.log);
    expect(days.get("2026-09-01")).toBe(1800);
    expect(days.get("2026-09-03")).toBe(3600);
  });

  it("finds the current and longest streaks, forgiving an empty today", () => {
    const days = secondsByDay(data.log);
    expect(streaks(days, "2026-09-04")).toMatchObject({ current: 3, longest: 3, longestEnded: "2026-09-03" });
    expect(streaks(days, "2026-09-06").current).toBe(0);
  });

  it("lays out a year of weeks ending today", () => {
    const weeks = calendarWeeks(secondsByDay(data.log), "2026-09-04");
    expect(weeks).toHaveLength(53);
    const last = weeks[weeks.length - 1];
    expect(last[last.length - 1].day).toBe("2026-09-04");
    const busiest = weeks.flat().find((cell) => cell.day === "2026-09-03");
    expect(busiest?.level).toBe(4);
  });

  it("lays out each of the last twelve months on its own", () => {
    const months = calendarMonths(secondsByDay(data.log), "2026-09-04");
    expect(months.map((m) => m.month)).toEqual([
      "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03",
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
    const september = months[11];
    expect(september.weeks.every((week) => week.length === 7)).toBe(true);
    // 1 September 2026 is a Tuesday, so Monday's slot before it is padding.
    expect(september.weeks[0][0]).toBeNull();
    expect(september.weeks[0][1]?.day).toBe("2026-09-01");
    const slots = september.weeks.flat();
    expect(slots.filter(Boolean)).toHaveLength(30);
    expect(slots.find((slot) => slot?.day === "2026-09-03")?.level).toBe(4);
    expect(slots.find((slot) => slot?.day === "2026-09-05")?.future).toBe(true);
    expect(slots.find((slot) => slot?.day === "2026-09-04")?.future).toBe(false);
  });

  it("recaps a month", () => {
    const recap = monthRecap(data, "2026-09")!;
    expect(recap.seconds).toBe(6000);
    expect(recap.activeDays).toBe(3);
    expect(recap.topPerformer?.performer.name).toBe("Bea");
    expect(recap.longestStreak).toBe(3);
    expect(monthRecap(data, "2025-01")).toBeNull();
  });

  it("ranks the hall of fame", () => {
    const hall = hallOfFame(data);
    expect(hall.videosByPlays.map((i) => i.id)).toEqual([1, 2]);
    expect(hall.videosByRating.map((i) => i.id)).toEqual([1]);
    // Two has more time watched (3720s against 2400s), so it headlines.
    expect(hall.mainEvent).toMatchObject({ item: { id: 2 }, seconds: 3720 });
  });

  it("finds your prime hour, favourite day and late-night share", () => {
    const facts = funFacts(data.log);
    // The 2 am hour on 3 Sep holds the most time.
    expect(facts.primeHour).toBe(2);
    expect(facts.favouriteWeekday).toBe(new Date(2026, 8, 3).getDay());
    expect(facts.videosWatched).toBe(2);
    expect(facts.lateNightShare).toBeCloseTo(3600 / 6120);
    expect(funFacts([]).primeHour).toBeNull();
  });

  it("awards badges and shows how close the rest are", () => {
    const list = achievements(data, localDay(new Date(2026, 8, 4)));
    const byId = new Map(list.map((a) => [a.id, a]));
    expect(byId.get("first-hour")?.earned).toBe(true);
    expect(byId.get("night-owl")?.earned).toBe(true);
    expect(byId.get("rewatcher")?.earned).toBe(true);
    expect(byId.get("streak-5")).toMatchObject({ earned: false, progressLabel: "3 of 5 days" });
    expect(byId.get("performer-complete-10")?.earned).toBe(true);
    expect(byId.get("performer-complete-next")?.title).toBe("All of Bea");
    // Earned badges sort first.
    expect(list[0].earned).toBe(true);
  });
});
