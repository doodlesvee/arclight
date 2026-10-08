import type { FastifyInstance } from "fastify";
import { isAuthorisedCastStream } from "./castTokens.js";
import { resolveSession, SESSION_COOKIE, type SessionUser } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

// Everything an unauthenticated visitor legitimately needs: the auth
// endpoints themselves, and a health check that reveals nothing.
const PUBLIC_API_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/webauthn/login/options",
  "/api/webauthn/login",
  "/api/health",
]);

/**
 * Requires a valid session for every /api route that isn't explicitly public.
 *
 * Deny-by-default on purpose: a new endpoint is protected the moment it's
 * added, rather than only once someone remembers to guard it. Non-API paths
 * fall through so the SPA shell can load and show a login screen — every
 * request it then makes for actual data is gated here.
 */
export function registerAuthGuard(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    request.user = (await resolveSession(request.cookies[SESSION_COOKIE])) ?? undefined;

    if (!request.url.startsWith("/api/")) return;

    // Query strings must not smuggle a path past the allow-list.
    const path = request.url.split("?")[0];
    if (PUBLIC_API_PATHS.has(path)) return;

    if (!request.user && !isAuthorisedCastStream(request.method, request.url)) {
      reply.code(401).send({ error: "Authentication required" });
    }
  });
}
