ALTER TABLE "media_items" ADD COLUMN "duel_score" integer DEFAULT 1000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN "duel_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "duels" (
	"id" serial PRIMARY KEY NOT NULL,
	"winner_id" integer NOT NULL,
	"loser_id" integer NOT NULL,
	"winner_score_before" integer NOT NULL,
	"loser_score_before" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_winner_id_media_items_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_loser_id_media_items_id_fk" FOREIGN KEY ("loser_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "duels_winner_idx" ON "duels" USING btree ("winner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "duels_loser_idx" ON "duels" USING btree ("loser_id");
