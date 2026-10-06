import { and, eq, isNull, type SQL } from "drizzle-orm";
import { mediaItems } from "../db/schema.js";

/**
 * The condition every list of media has to satisfy.
 *
 * Two things hide an item: a folder that is no longer being scanned
 * (`inScope`), and a file that has gone from disk (`missingSince`). They were
 * applied separately, and inconsistently — performers and studios filtered
 * missing items out, the main library grid and search did not, so the same
 * video was absent from one page and present with a red badge on another.
 *
 * A missing item is not deleted. It still exists, still holds its tags and
 * performers, and is still counted by library health — it simply stops
 * appearing in the places you browse, because there is nothing behind it to
 * play. The one screen that deliberately shows them is the missing-videos
 * manager, which asks for them by name rather than going through here.
 */
export function visibleItems(): SQL {
  // Non-null assertion is safe and deliberate: `and` only returns undefined
  // when given no defined conditions, and all of these are constants.
  return and(eq(mediaItems.inScope, true), isNull(mediaItems.missingSince), isNull(mediaItems.hiddenAt))!;
}

/** Just the "file is still there" half, for queries that scope differently. */
export function notMissing(): SQL {
  return isNull(mediaItems.missingSince);
}
