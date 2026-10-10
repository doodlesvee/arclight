import { isRestoring } from "./restoreState.js";
import { isBackupRunning, createBackup } from "./create.js";

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Backs up the database and uploads on an interval, mirroring
 * scanner/schedule.ts.
 *
 * Left purely manual, a backup is only ever as recent as the last time
 * someone remembered to click "Back up now" — which can be never. Everything
 * poster frames and preview clips aside is unrecoverable if lost, so this
 * runs on its own regardless of whether anyone opens Settings.
 */
async function tick(): Promise<void> {
  // createBackup throws when one is already running, and an unhandled
  // rejection inside setInterval would take the process down rather than
  // skip a beat.
  if (isBackupRunning()) return;
  // A restore drops and recreates every table; pg_dump mid-restore would
  // just produce a backup of a half-restored database.
  if (isRestoring()) return;
  try {
    await createBackup({ reason: "Scheduled backup" });
  } catch {
    // createBackup already logs the failure to the activity log; there's
    // nothing more useful to do from the timer.
  }
}

export function startBackupSchedule(): void {
  const hours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!Number.isFinite(hours) || hours <= 0) return; // 0 or unset disables it

  timer = setInterval(() => void tick(), hours * 60 * 60_000);
  // Don't hold the process open on shutdown for a backup that hasn't fired.
  timer.unref?.();
}

export function stopBackupSchedule(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
