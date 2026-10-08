CREATE TABLE IF NOT EXISTS "playback_heatmap" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_item_id" integer NOT NULL,
	"bucket" integer NOT NULL,
	"count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN "triaged_at" timestamp;
--> statement-breakpoint
UPDATE "media_items" SET "triaged_at" = NOW() WHERE "triaged_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "playback_heatmap" ADD CONSTRAINT "playback_heatmap_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "playback_heatmap_item_bucket_idx" ON "playback_heatmap" USING btree ("media_item_id","bucket");
