import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { createSession } from "../auth/sessions.js";
import { setSessionCookie } from "./auth.js";
import { getVaultPinHash, unlockVault } from "../auth/vaultUnlock.js";
import { markUnlocked } from "../auth/privacyUnlock.js";
import type { FastifyInstance } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { db } from "../db/client.js";
import { users, webauthnCredentials } from "../db/schema.js";

/**
 * Passkeys for sign-in and Touch ID for discreet mode.
 *
 * The alternative to typing the privacy password, which is worth having for
 * exactly the situation the mode exists for: there's no secret to be seen
 * over your shoulder, and nothing to mistype in a hurry.
 *
 * WebAuthn needs a secure context. `http://localhost` counts as one, which is
 * why this works here without certificates — reaching the app over the
 * network by IP would not, and the browser would simply refuse.
 */

// Where the browser thinks it is: a comma-separated list, because dev (Vite on
// 5173) and production (the server itself on 3000) are different origins, and
// the server rejects a response signed on any origin not listed here.
//
// The RP ID is hostname only — no port — so one credential registered under
// `localhost` works on every port. That also means every listed origin must
// share a hostname; the browser refuses the ceremony outright when the RP ID
// doesn't match the address bar.
export function parseOrigins(value: string | undefined): { origins: string[]; rpId: string } {
  const origins = (value ?? "http://localhost:5173,http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return { origins, rpId: new URL(origins[0]).hostname };
}

const { origins: ORIGINS, rpId: RP_ID } = parseOrigins(process.env.WEBAUTHN_ORIGIN);
const RP_NAME = "Arc Light";

/**
 * Pending challenges, per session.
 *
 * In memory rather than a table: a challenge is valid for one ceremony over a
 * few seconds, and a restart in the middle of one costing a retry is a better
 * trade than a row that has to be swept.
 */
const challenges = new Map<string, { value: string; expires: number }>();
const CHALLENGE_TTL_MS = 120_000;
const LOGIN_COOKIE = "passkey_login";
const loginChallenges = new Map<string, { value: string; expires: number }>();

function putChallenge(sessionId: string, value: string): void {
  challenges.set(sessionId, { value, expires: Date.now() + CHALLENGE_TTL_MS });
}

function takeChallenge(sessionId: string): string | null {
  const entry = challenges.get(sessionId);
  // Single use, always: a replayed challenge is the thing signatures are
  // meant to prevent.
  challenges.delete(sessionId);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.value;
}

type Assertion = Parameters<typeof verifyAuthenticationResponse>[0]["response"];

async function verifyAssertion(
  response: Assertion,
  expectedChallenge: string,
  stored: typeof webauthnCredentials.$inferSelect,
): Promise<boolean> {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64")),
        counter: stored.counter,
      },
    });
  } catch {
    return false;
  }
  if (!verification.verified) return false;
  await db
    .update(webauthnCredentials)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(webauthnCredentials.id, stored.id));
  return true;
}

export async function webauthnRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/webauthn/login/options", async (request, reply) => {
    for (const [id, entry] of loginChallenges) {
      if (entry.expires <= Date.now()) loginChallenges.delete(id);
    }
    const previous = request.cookies[LOGIN_COOKIE];
    if (previous) loginChallenges.delete(previous);
    if (loginChallenges.size >= 1000) {
      reply.code(429);
      return { error: "Too many sign-in requests. Try again in a few minutes." };
    }
    const existing = await db.select({ id: webauthnCredentials.id }).from(webauthnCredentials);
    if (existing.length === 0) {
      reply.code(404);
      return { error: "No passkey registered. Sign in with your password and set one up in Settings." };
    }
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: existing.map((row) => ({ id: row.id })),
      userVerification: "required",
    });
    const id = randomBytes(32).toString("hex");
    loginChallenges.set(id, { value: options.challenge, expires: Date.now() + CHALLENGE_TTL_MS });
    reply.setCookie(LOGIN_COOKIE, id, {
      path: "/api/webauthn/login",
      httpOnly: true,
      sameSite: "strict",
      secure: request.protocol === "https",
      maxAge: CHALLENGE_TTL_MS / 1000,
    });
    return options;
  });

  app.post<{ Body: { response?: Assertion } }>("/api/webauthn/login", async (request, reply) => {
    const id = request.cookies[LOGIN_COOKIE];
    const challenge = id ? loginChallenges.get(id) : undefined;
    if (id) loginChallenges.delete(id);
    reply.clearCookie(LOGIN_COOKIE, { path: "/api/webauthn/login" });
    const response = request.body?.response;
    if (!challenge || challenge.expires <= Date.now() || !response?.id) {
      reply.code(400);
      return { error: "That took too long — try again" };
    }
    const [stored] = await db.select().from(webauthnCredentials)
      .where(eq(webauthnCredentials.id, response.id));
    if (!stored || !(await verifyAssertion(response, challenge.value, stored))) {
      reply.code(401);
      return { error: "That passkey didn't verify" };
    }
    const [user] = await db.select().from(users).where(eq(users.id, stored.userId));
    if (!user) {
      reply.code(401);
      return { error: "That passkey didn't verify" };
    }
    const sessionId = await createSession(user.id);
    setSessionCookie(reply, sessionId, request.protocol === "https");
    return { user: { id: user.id, username: user.username } };
  });

  app.get("/api/webauthn/credentials", async (request) => {
    if (!request.user) return { credentials: [] };
    const rows = await db
      .select({ id: webauthnCredentials.id, label: webauthnCredentials.label })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, request.user.id));
    return { credentials: rows };
  });

  app.post("/api/webauthn/register/options", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "Not signed in" };
    }
    const [account] = await db.select().from(users).where(eq(users.id, request.user.id));

    const existing = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, request.user.id));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: account?.username ?? "user",
      // Excluded so registering twice in the same browser replaces nothing and
      // silently piles up duplicates.
      excludeCredentials: existing.map((row) => ({ id: row.id })),
      authenticatorSelection: {
        // The built-in authenticator — Touch ID — rather than a USB key.
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        // What actually makes it ask for a fingerprint instead of just
        // confirming presence.
        userVerification: "required",
      },
    });

    putChallenge(request.user.sessionId, options.challenge);
    return options;
  });

  app.post<{ Body: { response?: unknown; label?: string } }>(
    "/api/webauthn/register",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "Not signed in" };
      }
      const expected = takeChallenge(request.user.sessionId);
      if (!expected) {
        reply.code(400);
        return { error: "That took too long — try again" };
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          // The library validates the shape; a malformed body throws below.
          response: request.body?.response as never,
          expectedChallenge: expected,
          expectedOrigin: ORIGINS,
          expectedRPID: RP_ID,
          requireUserVerification: true,
        });
      } catch {
        reply.code(400);
        return { error: "That didn't verify" };
      }

      if (!verification.verified || !verification.registrationInfo) {
        reply.code(400);
        return { error: "That didn't verify" };
      }

      const { credential } = verification.registrationInfo;
      await db
        .insert(webauthnCredentials)
        .values({
          id: credential.id,
          userId: request.user.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64"),
          counter: credential.counter,
          label: (request.body?.label ?? "This browser").slice(0, 60),
        })
        .onConflictDoNothing();

      return { ok: true };
    }
  );

  app.post<{ Body: { purpose?: string } }>("/api/webauthn/auth/options", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "Not signed in" };
    }
    const purpose = request.body?.purpose ?? "privacy";
    if (purpose !== "privacy" && purpose !== "vault") {
      reply.code(400);
      return { error: "Invalid unlock purpose" };
    }
    if (purpose === "vault" && !(await getVaultPinHash())) {
      reply.code(400);
      return { error: "Set a vault PIN first" };
    }
    const existing = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, request.user.id));

    if (existing.length === 0) {
      reply.code(404);
      return { error: "No passkey registered" };
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: existing.map((row) => ({ id: row.id })),
      userVerification: "required",
    });

    putChallenge(`${purpose}:${request.user.sessionId}`, options.challenge);
    return options;
  });

  /**
   * Verifies an assertion. Success is the same thing a correct privacy
   * password is: proof the person at the machine is you.
   */
  app.post<{ Body: { response?: Assertion; purpose?: string } }>(
    "/api/webauthn/auth",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "Not signed in" };
      }
      const purpose = request.body?.purpose ?? "privacy";
      if (purpose !== "privacy" && purpose !== "vault") {
        reply.code(400);
        return { error: "Invalid unlock purpose" };
      }
      const expected = takeChallenge(`${purpose}:${request.user.sessionId}`);
      const credentialId = request.body?.response?.id;
      if (!expected || !credentialId) {
        reply.code(400);
        return { ok: false, error: "That took too long — try again" };
      }

      const [stored] = await db
        .select()
        .from(webauthnCredentials)
        .where(
          and(
            eq(webauthnCredentials.id, credentialId),
            // Scoped to this account, so a credential belonging to someone
            // else can't be presented here.
            eq(webauthnCredentials.userId, request.user.id)
          )
        );
      if (!stored) {
        reply.code(403);
        return { ok: false, error: "Unknown passkey" };
      }

      if (!request.body.response || !(await verifyAssertion(request.body.response, expected, stored))) {
        reply.code(403);
        return { ok: false, error: "That didn't verify" };
      }

      // Same standing as the password: either credential guards discreet
      // mode, so either has to unlock what the password unlocks.
      if (purpose === "vault") {
        if (!(await getVaultPinHash())) {
          reply.code(400);
          return { error: "Set a vault PIN first" };
        }
        unlockVault(request.user.sessionId);
      } else {
        markUnlocked(request.user.sessionId);
      }
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>("/api/webauthn/credentials/:id", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "Not signed in" };
    }
    await db
      .delete(webauthnCredentials)
      .where(
        and(
          eq(webauthnCredentials.id, request.params.id),
          eq(webauthnCredentials.userId, request.user.id)
        )
      );
    return { ok: true };
  });
}
