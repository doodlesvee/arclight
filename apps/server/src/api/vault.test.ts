import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import { makeItem, makeLibrary } from "../test/fixtures.js";
import { db } from "../db/client.js";
import { activityEvents } from "../db/schema.js";
import { resetVaultAttempts } from "./vault.js";
import { logActivity } from "../activity/log.js";

let app: FastifyInstance;
let cookie: string;
let libraryId: number;

beforeAll(async () => {
  app = await testApp();
});

beforeEach(async () => {
  await resetDatabase();
  resetVaultAttempts();
  cookie = await signIn();
  ({ libraryId } = await makeLibrary());
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object });

const setPin = (pin = "1234") =>
  send("PUT", "/api/vault/pin", { pin, accountPassword: "test-password" });

describe("PIN setup", () => {
  it("starts with no PIN and a locked vault", async () => {
    expect((await get("/api/vault")).json()).toEqual({ hasPin: false, unlocked: false, count: null });
  });

  it("needs the account password", async () => {
    const res = await send("PUT", "/api/vault/pin", { pin: "1234", accountPassword: "nope" });
    expect(res.statusCode).toBe(403);
  });

  it("accepts only 4 to 12 digits", async () => {
    for (const pin of ["123", "12ab", "1".repeat(13)]) {
      expect((await setPin(pin)).statusCode).toBe(400);
    }
  });

  it("opens the vault for the session that set it", async () => {
    await setPin();
    expect((await get("/api/vault")).json()).toMatchObject({ hasPin: true, unlocked: true });
  });

  it("an empty PIN removes it", async () => {
    await setPin();
    const res = await send("PUT", "/api/vault/pin", { pin: "", accountPassword: "test-password" });
    expect(res.json().hasPin).toBe(false);
  });
});

describe("unlock and lock", () => {
  it("refuses to unlock before a PIN exists", async () => {
    expect((await send("POST", "/api/vault/unlock", { pin: "1234" })).statusCode).toBe(400);
  });

  it("rejects a wrong PIN and accepts the right one", async () => {
    await setPin();
    await send("POST", "/api/vault/lock");
    expect((await get("/api/vault")).json().unlocked).toBe(false);

    const wrong = await send("POST", "/api/vault/unlock", { pin: "0000" });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().attemptsLeft).toBe(4);

    expect((await send("POST", "/api/vault/unlock", { pin: "1234" })).statusCode).toBe(200);
    expect((await get("/api/vault")).json().unlocked).toBe(true);
  });

  it("blocks further attempts after five wrong PINs, even the right one", async () => {
    await setPin();
    await send("POST", "/api/vault/lock");
    for (let i = 0; i < 5; i++) await send("POST", "/api/vault/unlock", { pin: "0000" });

    const blocked = await send("POST", "/api/vault/unlock", { pin: "1234" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("GET /api/vault/items", () => {
  it("is forbidden while locked", async () => {
    await setPin();
    await send("POST", "/api/vault/lock");
    expect((await get("/api/vault/items")).statusCode).toBe(403);
  });

  it("lists only hidden items once unlocked", async () => {
    const shown = await makeItem(libraryId, { title: "Shown" });
    await makeItem(libraryId, { title: "Secret", hiddenAt: new Date() });
    await makeItem(libraryId, { title: "Gone", hiddenAt: new Date(), missingSince: new Date() });
    await setPin();

    const body = (await get("/api/vault/items")).json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Secret"]);
    expect(body.items.map((i: { id: number }) => i.id)).not.toContain(shown);
    expect((await get("/api/vault")).json().count).toBe(1);
  });
});

describe("restoring hidden items", () => {
  it("needs the vault open once a PIN is set", async () => {
    const id = await makeItem(libraryId, { hiddenAt: new Date() });
    await setPin();
    await send("POST", "/api/vault/lock");

    const locked = await send("PUT", `/api/media-items/${id}/hidden`, { hidden: false });
    expect(locked.statusCode).toBe(403);

    await send("POST", "/api/vault/unlock", { pin: "1234" });
    const open = await send("PUT", `/api/media-items/${id}/hidden`, { hidden: false });
    expect(open.statusCode).toBe(200);
  });

  it("is unrestricted when no PIN exists", async () => {
    const id = await makeItem(libraryId, { hiddenAt: new Date() });
    const res = await send("PUT", `/api/media-items/${id}/hidden`, { hidden: false });
    expect(res.statusCode).toBe(200);
  });

  it("hiding never needs the PIN", async () => {
    const id = await makeItem(libraryId);
    await setPin();
    await send("POST", "/api/vault/lock");
    const res = await send("PUT", `/api/media-items/${id}/hidden`, { hidden: true });
    expect(res.statusCode).toBe(200);
  });
});

describe("activity log", () => {
  it("leaves out events about hidden items until the vault is open", async () => {
    const secret = await makeItem(libraryId, { title: "Secret", hiddenAt: new Date() });
    const plain = await makeItem(libraryId, { title: "Plain" });
    await logActivity("edit", "Edited Secret", undefined, secret);
    await logActivity("edit", "Edited Plain", undefined, plain);
    await logActivity("scan", "Scan done");
    await setPin();
    await send("POST", "/api/vault/lock");

    const messages = async () =>
      ((await get("/api/activity")).json().events as { message: string }[]).map((e) => e.message);

    const locked = await messages();
    expect(locked).toContain("Edited Plain");
    expect(locked).toContain("Scan done");
    expect(locked).not.toContain("Edited Secret");

    await send("POST", "/api/vault/unlock", { pin: "1234" });
    expect(await messages()).toContain("Edited Secret");
    expect((await db.select().from(activityEvents)).length).toBeGreaterThan(3);
  });
});
