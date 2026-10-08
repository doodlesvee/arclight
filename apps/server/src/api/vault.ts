import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { appSettings, mediaItemTypes, mediaItems, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  VAULT_KEY,
  getVaultPinHash,
  isVaultUnlocked,
  lockVault,
  unlockVault,
} from "../auth/vaultUnlock.js";
import { logActivity } from "../activity/log.js";

const PIN_PATTERN = /^\d{4,12}$/;
const PAGE_SIZE = 60;

/**
 * Wrong-PIN attempts across every session.
 *
 * Global rather than per session, unlike the privacy password: a PIN is short
 * enough that a per-session limit could be sidestepped by starting a fresh
 * session, so the limit follows the vault instead.
 */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const attempts = { count: 0, blockedUntil: 0 };

/** Test hook: the counter is process-wide, so suites reset it between cases. */
export function resetVaultAttempts(): void {
  attempts.count = 0;
  attempts.blockedUntil = 0;
}

const hiddenNow = () =>
  and(
    isNotNull(mediaItems.hiddenAt),
    eq(mediaItems.inScope, true),
    sql`${mediaItems.missingSince} is null`,
  );

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vault", async (request) => {
    const hasPin = (await getVaultPinHash()) !== null;
    const unlocked = hasPin && isVaultUnlocked(request.user?.sessionId);
    let count: number | null = null;
    if (unlocked) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(mediaItems)
        .where(hiddenNow());
      count = row?.n ?? 0;
    }
    return { hasPin, unlocked, count };
  });

  /** Sets, replaces, or (with an empty pin) removes the PIN. */
  app.put<{ Body: { pin?: string; accountPassword?: string } }>(
    "/api/vault/pin",
    async (request, reply) => {
      const userId = request.user?.id;
      if (userId === undefined) {
        reply.code(401);
        return { error: "Not signed in" };
      }
      const { pin, accountPassword } = request.body ?? {};

      const [account] = await db.select().from(users).where(eq(users.id, userId));
      if (!account || !(await verifyPassword(accountPassword ?? "", account.passwordHash))) {
        reply.code(403);
        return { error: "That account password isn't right" };
      }

      if (!pin) {
        await db.delete(appSettings).where(eq(appSettings.key, VAULT_KEY));
        lockVault(request.user!.sessionId);
        await logActivity("vault", "Vault PIN removed");
        return { hasPin: false };
      }
      if (!PIN_PATTERN.test(pin)) {
        reply.code(400);
        return { error: "Use 4 to 12 digits" };
      }

      const value = { pinHash: await hashPassword(pin) };
      await db
        .insert(appSettings)
        .values({ key: VAULT_KEY, value })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
      unlockVault(request.user!.sessionId);
      resetVaultAttempts();
      await logActivity("vault", "Vault PIN changed");
      return { hasPin: true };
    },
  );

  app.post<{ Body: { pin?: string } }>("/api/vault/unlock", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "Not signed in" };
    }

    if (attempts.blockedUntil > Date.now()) {
      reply.code(429);
      return {
        ok: false,
        error: "Too many attempts",
        retryAfterSeconds: Math.ceil((attempts.blockedUntil - Date.now()) / 1000),
      };
    }

    const stored = await getVaultPinHash();
    if (stored === null) {
      reply.code(400);
      return { ok: false, error: "Set a PIN first" };
    }

    if (!(await verifyPassword(request.body?.pin ?? "", stored))) {
      attempts.count += 1;
      if (attempts.count >= MAX_ATTEMPTS) attempts.blockedUntil = Date.now() + LOCKOUT_MS;
      reply.code(403);
      return {
        ok: false,
        error: "Wrong PIN",
        attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts.count),
      };
    }

    resetVaultAttempts();
    unlockVault(request.user.sessionId);
    return { ok: true };
  });

  app.post("/api/vault/lock", async (request) => {
    if (request.user) lockVault(request.user.sessionId);
    return { ok: true };
  });

  app.get<{ Querystring: { page?: string } }>("/api/vault/items", async (request, reply) => {
    if (!isVaultUnlocked(request.user?.sessionId)) {
      reply.code(403);
      return { error: "The vault is locked" };
    }
    const page = Math.max(1, Number(request.query.page ?? 1) || 1);

    const rows = await db
      .select({
        id: mediaItems.id,
        title: mediaItems.title,
        itemType: mediaItemTypes.name,
        thumbnailFile: mediaItems.thumbnailFile,
        thumbnailPositionX: mediaItems.thumbnailPositionX,
        thumbnailPositionY: mediaItems.thumbnailPositionY,
        thumbnailScale: mediaItems.thumbnailScale,
        durationSeconds: mediaItems.durationSeconds,
        hiddenAt: mediaItems.hiddenAt,
      })
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItemTypes.id, mediaItems.itemTypeId))
      .where(hiddenNow())
      .orderBy(desc(mediaItems.hiddenAt), desc(mediaItems.id))
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE);

    return {
      items: rows.slice(0, PAGE_SIZE),
      page,
      pageSize: PAGE_SIZE,
      hasMore: rows.length > PAGE_SIZE,
    };
  });
}
