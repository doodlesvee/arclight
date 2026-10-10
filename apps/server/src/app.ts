import "dotenv/config";
import { buildApp } from "./buildApp.js";
import { purgeExpiredSessions } from "./auth/sessions.js";
import { startScanSchedule } from "./scanner/schedule.js";
import { startBackupSchedule } from "./backup/schedule.js";
import { readRestoreMarker } from "./backup/restoreState.js";
import { runMigrations } from "./db/client.js";
import { seed, seedCategories } from "./db/seed.js";

// The entry point owns everything that changes state on boot. buildApp only
// wires routes, so tests can build the same server without a scan schedule
// starting or the seed running underneath them.

// Node's default for an error nothing caught is to crash with no record of
// why beyond whatever reached stderr before the process died. Logging first
// means `docker logs` has the actual cause; exiting (rather than limping on)
// is deliberate too, since whatever broke could be holding a lock or a half-
// finished write — restart: unless-stopped brings the process back clean.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException — exiting", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection — exiting", reason);
  process.exit(1);
});

// A restore writes this before touching anything and deletes it on success,
// so finding one means the process died part-way through. The database half
// is safe regardless — psql runs the dump in a single transaction, so a crash
// rolls it back whole — which leaves only a half-swapped set of uploaded
// images. That is recoverable from the safety backup named here, so this
// reports rather than refusing to start.
const interrupted = await readRestoreMarker();
if (interrupted) {
  console.warn(
    `restore: a restore from ${interrupted.source} started at ` +
      `${interrupted.startedAt} did not finish. Uploaded images may be ` +
      `incomplete; the safety backup taken first was ` +
      `${interrupted.safetyBackup ?? "(none)"}.`,
  );
}

await runMigrations();
await seed();
await seedCategories();
await purgeExpiredSessions();
await startScanSchedule();
startBackupSchedule();

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
