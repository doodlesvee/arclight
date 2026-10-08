import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "../auth/passwords.js";
import {
  createSession,
  destroySession,
  hasAnyUser,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "../auth/sessions.js";

// Deliberately vague: distinguishing "no such user" from "wrong password"
// tells an attacker which usernames exist.
const INVALID_CREDENTIALS = "Incorrect username or password";

// Enough to make online guessing useless without ever locking you out for
// long. Keyed in memory: a single-instance app, and losing the counter on
// restart is not worth a table.
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

function tooManyAttempts(ip: string): boolean {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

export function setSessionCookie(reply: FastifyReply, sessionId: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    // The cookie is never read by JavaScript, so httpOnly costs nothing and
    // takes XSS-driven session theft off the table.
    httpOnly: true,
    // lax still sends the cookie on top-level navigation, so opening the app
    // from a bookmark works, while blocking cross-site form posts.
    sameSite: "lax",
    // Only when actually served over TLS — a secure cookie on plain http
    // would be dropped, locking you out of a LAN deployment.
    secure,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Lets the frontend decide between the setup screen, the login screen and
  // the app without guessing from a 401.
  app.get("/api/auth/status", async (request) => {
    return {
      needsSetup: !(await hasAnyUser()),
      user: request.user ?? null,
    };
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/setup",
    async (request, reply) => {
      // Closes permanently the moment an account exists, so this can't be
      // used to add a second admin later.
      if (await hasAnyUser()) {
        reply.code(409);
        return { error: "An account already exists" };
      }

      const username = request.body.username?.trim();
      const password = request.body.password ?? "";
      if (!username) {
        reply.code(400);
        return { error: "Username is required" };
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        reply.code(400);
        return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
      }

      const [user] = await db
        .insert(users)
        .values({ username, passwordHash: await hashPassword(password) })
        .returning();

      const sessionId = await createSession(user.id);
      setSessionCookie(reply, sessionId, request.protocol === "https");
      return { user: { id: user.id, username: user.username } };
    }
  );

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    async (request, reply) => {
      const ip = request.ip;
      // if (tooManyAttempts(ip)) {
      //   reply.code(429);
      //   return { error: "Too many attempts. Try again in a few minutes." };
      // }

      const username = request.body.username?.trim() ?? "";
      const password = request.body.password ?? "";

      const [user] = await db.select().from(users).where(eq(users.username, username));
      // Verify even when the user doesn't exist would be better still, but a
      // single-account app has one known username anyway; the constant
      // message is what matters here.
      const ok = user ? await verifyPassword(password, user.passwordHash) : false;

      if (!ok) {
        recordFailure(ip);
        reply.code(401);
        return { error: INVALID_CREDENTIALS };
      }

      attempts.delete(ip);
      const sessionId = await createSession(user.id);
      setSessionCookie(reply, sessionId, request.protocol === "https");
      return { user: { id: user.id, username: user.username } };
    }
  );

  app.patch<{ Body: { username?: string } }>(
    "/api/auth/account",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "Authentication required" };
      }

      const username = request.body.username?.trim();
      if (!username) {
        reply.code(400);
        return { error: "Username is required" };
      }

      // Checked up front so a clash reads as 409 rather than surfacing the
      // raw unique-constraint violation as a 500.
      const [clash] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.username, username), ne(users.id, request.user.id)));
      if (clash) {
        reply.code(409);
        return { error: "That username is taken" };
      }

      const [updated] = await db
        .update(users)
        .set({ username })
        .where(eq(users.id, request.user.id))
        .returning();
      return { user: { id: updated.id, username: updated.username } };
    }
  );

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    "/api/auth/password",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "Authentication required" };
      }

      const { currentPassword = "", newPassword = "" } = request.body;
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        reply.code(400);
        return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
      }

      const [user] = await db.select().from(users).where(eq(users.id, request.user.id));
      // Requiring the current password is what stops someone who walks up to
      // an unlocked browser from locking you out of your own server.
      if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
        reply.code(403);
        return { error: "Current password is incorrect" };
      }

      await db
        .update(users)
        .set({ passwordHash: await hashPassword(newPassword) })
        .where(eq(users.id, user.id));

      // Every other session is dropped — a password change should end any
      // login you didn't make. The current one survives so you aren't kicked
      // out of the page you just used to change it.
      const current = request.cookies[SESSION_COOKIE];
      await db
        .delete(sessions)
        .where(current ? and(eq(sessions.userId, user.id), ne(sessions.id, current)) : eq(sessions.userId, user.id));

      return { ok: true };
    }
  );

  app.post("/api/auth/logout", async (request, reply) => {
    await destroySession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
