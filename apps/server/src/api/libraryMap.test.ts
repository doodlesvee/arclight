import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import { linkPerformer, linkTag, makeItem, makeLibrary, makePerformer, makeStudio, makeTag } from "../test/fixtures.js";
import { db } from "../db/client.js";
import { mediaItems } from "../db/schema.js";
import { eq } from "drizzle-orm";

let app: FastifyInstance;
let cookie: string;
let libraryId: number;

beforeAll(async () => {
  app = await testApp();
});

beforeEach(async () => {
  await resetDatabase();
  cookie = await signIn();
  ({ libraryId } = await makeLibrary());
});

describe("library map", () => {
  it("connects entity types through visible media and supports finding a node", async () => {
    const itemId = await makeItem(libraryId);
    const performerId = await makePerformer("Aster Vale");
    const studioId = await makeStudio("Silver Gate");
    const tagId = await makeTag("Blue hour");
    await linkPerformer(itemId, performerId);
    await linkTag(itemId, tagId);
    await db.update(mediaItems).set({ studioId }).where(eq(mediaItems.id, itemId));

    const response = await app.inject({
      url: "/api/library/map",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const graph = response.json();
    expect(graph.nodes.map((node: { key: string }) => node.key).sort()).toEqual([
      `performer:${performerId}`,
      `studio:${studioId}`,
      `tag:${tagId}`,
    ]);
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges.every((edge: { sharedItems: number }) => edge.sharedItems === 1)).toBe(true);

    const search = await app.inject({
      url: "/api/library/map?q=aster",
      headers: { cookie },
    });
    expect(search.json().nodes.map((node: { key: string }) => node.key)).toContain(
      `performer:${performerId}`,
    );
  });
});