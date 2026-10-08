ALTER TABLE "activity_events" ADD COLUMN "media_item_id" integer;
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_events_type_idx" ON "activity_events" USING btree ("type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_events_created_at_idx" ON "activity_events" USING btree ("created_at" DESC);
