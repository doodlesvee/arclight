import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { activityEvents } from "../db/schema.js";
import { listActivity } from "../activity/log.js";
import { isVaultUnlocked } from "../auth/vaultUnlock.js";

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string; type?: string } }>(
    "/api/activity",
    async (request) => ({
      events: await listActivity(
        Number(request.query.limit ?? 200),
        request.query.type || undefined,
        isVaultUnlocked(request.user?.sessionId),
      ),
    }),
  );

  app.delete("/api/activity", async () => {
    await db.delete(activityEvents);
    return { ok: true };
  });
}
