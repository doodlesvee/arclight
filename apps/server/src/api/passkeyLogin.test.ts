import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { db } from "../db/client.js";
import { webauthnCredentials, users } from "../db/schema.js";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import { createSession } from "../auth/sessions.js";
import { isVaultUnlocked } from "../auth/vaultUnlock.js";
import { isUnlocked } from "../auth/privacyUnlock.js";

vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@simplewebauthn/server")>(),
  verifyAuthenticationResponse: vi.fn(),
}));

let app: FastifyInstance;

beforeAll(async () => {
  app = await testApp();
});
beforeEach(async () => {
  vi.resetAllMocks();
  await resetDatabase();
  await signIn();
  const [user] = await db.select().from(users);
  await db.insert(webauthnCredentials).values({
    id: "test-passkey",
    userId: user.id,
    publicKey: Buffer.from([1, 2, 3]).toString("base64"),
    counter: 0,
    label: "Test",
  });
});
afterEach(() => vi.restoreAllMocks());

async function options() {
  const result = await app.inject({ method: "POST", url: "/api/webauthn/login/options" });
  expect(result.statusCode).toBe(200);
  return {
    cookie: String(result.headers["set-cookie"]).split(";")[0],
    challenge: result.json().challenge as string,
  };
}

const assertion = {
  id: "test-passkey",
  rawId: "test-passkey",
  type: "public-key",
  response: { clientDataJSON: "", authenticatorData: "", signature: "" },
  clientExtensionResults: {},
};

function verify(cookie?: string) {
  return app.inject({
    method: "POST",
    url: "/api/webauthn/login",
    payload: { response: assertion },
    headers: cookie ? { cookie } : {},
  });
}

describe("passkey sign-in", () => {
  it("issues public options with user verification and a short-lived httpOnly cookie", async () => {
    const result = await app.inject({ method: "POST", url: "/api/webauthn/login/options" });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      rpId: "localhost",
      userVerification: "required",
      allowCredentials: [{ id: "test-passkey", type: "public-key" }],
    });

    expect(String(result.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(result.headers["set-cookie"])).toContain("SameSite=Strict");
    expect(String(result.headers["set-cookie"])).toContain("Max-Age=120");
  });

    describe("passkey vault unlock", () => {
      async function prepare() {
        const [user] = await db.select().from(users);
        const sessionId = await createSession(user.id);
        const cookie = `media_session=${sessionId}`;
        await app.inject({
          method: "PUT", url: "/api/vault/pin", headers: { cookie },
          payload: { pin: "1234", accountPassword: "test-password" },
        });
        await app.inject({ method: "POST", url: "/api/vault/lock", headers: { cookie } });
        return { sessionId, cookie };
      }

      it("unlocks only the requesting vault session after a verified assertion", async () => {
        const { sessionId, cookie } = await prepare();
        const options = await app.inject({
          method: "POST", url: "/api/webauthn/auth/options", headers: { cookie },
          payload: { purpose: "vault" },
        });
        expect(options.statusCode).toBe(200);
        vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
          verified: true,
          authenticationInfo: {
            credentialID: "test-passkey", newCounter: 1, userVerified: true,
            credentialDeviceType: "singleDevice", credentialBackedUp: false,
            origin: "http://localhost:5173", rpID: "localhost",
          },
        });
        const payload = { response: assertion, purpose: "vault" };
        const result = await app.inject({
          method: "POST", url: "/api/webauthn/auth", headers: { cookie }, payload,
        });
        expect(result.statusCode).toBe(200);
        expect(isVaultUnlocked(sessionId)).toBe(true);
        expect(isUnlocked(sessionId)).toBe(false);
        const [user] = await db.select().from(users);
        expect(isVaultUnlocked(await createSession(user.id))).toBe(false);
        expect((await app.inject({
          method: "POST", url: "/api/webauthn/auth", headers: { cookie }, payload,
        })).statusCode).toBe(400);
        await app.inject({ method: "POST", url: "/api/vault/lock", headers: { cookie } });
        expect(isVaultUnlocked(sessionId)).toBe(false);
      });

      it("does not accept a privacy challenge for the vault or a failed assertion", async () => {
        const { cookie, sessionId } = await prepare();
        await app.inject({
          method: "POST", url: "/api/webauthn/auth/options", headers: { cookie },
        });
        expect((await app.inject({
          method: "POST", url: "/api/webauthn/auth", headers: { cookie },
          payload: { response: assertion, purpose: "vault" },
        })).statusCode).toBe(400);
        expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
        await app.inject({
          method: "POST", url: "/api/webauthn/auth/options", headers: { cookie },
          payload: { purpose: "vault" },
        });
        vi.mocked(verifyAuthenticationResponse).mockRejectedValue(new Error("Invalid signature"));
        expect((await app.inject({
          method: "POST", url: "/api/webauthn/auth", headers: { cookie },
          payload: { response: assertion, purpose: "vault" },
        })).statusCode).toBe(403);
        expect(isVaultUnlocked(sessionId)).toBe(false);
      });
    });
  it("creates a real session only after successful verification and rejects replay", async () => {
    const { cookie, challenge } = await options();
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "test-passkey",
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "http://localhost:5173",
        rpID: "localhost",
      },
    });
    const result = await verify(cookie);
    expect(result.statusCode).toBe(200);
    expect(result.json().user.username).toBe("tester");
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: challenge,
      expectedOrigin: ["http://localhost:5173", "http://localhost:3000"],
      expectedRPID: "localhost",
      requireUserVerification: true,
    }));
    const sessionCookie = ([] as string[]).concat(result.headers["set-cookie"] ?? [])
      .find((value) => value.startsWith("media_session="))?.split(";")[0];
    expect(sessionCookie).toBeDefined();
    const status = await app.inject({
      url: "/api/auth/status",
      headers: { cookie: sessionCookie! },
    });
    expect(status.json().user.username).toBe("tester");
    const [stored] = await db.select().from(webauthnCredentials);
    expect(stored.counter).toBe(1);
    expect((await verify(cookie)).statusCode).toBe(400);
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it("rejects missing and expired challenges", async () => {
    expect((await verify()).statusCode).toBe(400);
    const { cookie } = await options();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 120_001);
    expect((await verify(cookie)).statusCode).toBe(400);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature without issuing a session", async () => {
    const { cookie } = await options();
    vi.mocked(verifyAuthenticationResponse).mockRejectedValue(new Error("Invalid signature"));
    const result = await verify(cookie);
    expect(result.statusCode).toBe(401);
    expect(String(result.headers["set-cookie"])).not.toContain("media_session=");
    expect((await verify(cookie)).statusCode).toBe(400);
  });

  it("reports when no passkey is registered and keeps registration protected", async () => {
    await db.delete(webauthnCredentials);
    expect((await app.inject({ method: "POST", url: "/api/webauthn/login/options" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/webauthn/register/options" })).statusCode).toBe(401);
  });
});
