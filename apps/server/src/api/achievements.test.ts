import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await testApp();
});
beforeEach(async () => {
  await resetDatabase();
  cookie = await signIn();
});

async function load() {
  const res = await app.inject({ method: "GET", url: "/api/achievements", headers: { cookie } });
  return res.json() as { unlocked: Record<string, string>; seeded: boolean };
}

function unlock(ids: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/achievements/unlock",
    headers: { cookie },
    payload: { ids },
  });
}

describe("achievements", () => {
  it("starts empty and unseeded", async () => {
    expect(await load()).toEqual({ unlocked: {}, seeded: false });
  });

  it("records new unlocks and keeps each one's first date", async () => {
    await unlock(["first-hour"]);
    const first = (await load()).unlocked["first-hour"];
    expect(Date.parse(first)).not.toBeNaN();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await unlock(["first-hour", "night-owl"]);
    const record = await load();
    expect(record.seeded).toBe(true);
    expect(record.unlocked["first-hour"]).toBe(first);
    expect(Object.keys(record.unlocked).sort()).toEqual(["first-hour", "night-owl"]);
  });

  it("marks itself seeded even when nothing was earned yet", async () => {
    await unlock([]);
    expect(await load()).toEqual({ unlocked: {}, seeded: true });
  });

  it("accepts studio names in completionist ids", async () => {
    const res = await unlock(["studio-complete-Harbor & Co."]);
    expect(res.statusCode).toBe(200);
    expect(Object.keys((await load()).unlocked)).toEqual(["studio-complete-Harbor & Co."]);
  });

  it("rejects anything that isn't a list of short strings", async () => {
    expect((await unlock("first-hour")).statusCode).toBe(400);
    expect((await unlock([42])).statusCode).toBe(400);
    expect((await unlock([""])).statusCode).toBe(400);
    expect((await unlock(["x".repeat(201)])).statusCode).toBe(400);
    expect((await load()).seeded).toBe(false);
  });

  it("is behind the sign-in guard", async () => {
    const res = await app.inject({ method: "GET", url: "/api/achievements" });
    expect(res.statusCode).toBe(401);
  });
});
