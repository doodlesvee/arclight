CREATE TABLE "watch_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_item_id" integer NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watch_log" ADD CONSTRAINT "watch_log_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_log_item_hour_idx" ON "watch_log" USING btree ("media_item_id","hour");--> statement-breakpoint
CREATE INDEX "watch_log_hour_idx" ON "watch_log" USING btree ("hour");