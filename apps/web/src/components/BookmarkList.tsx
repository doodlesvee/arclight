import { useState } from "react";
import { Bookmark as BookmarkIcon, Check, FileText, Trash2, X } from "lucide-react";
import { formatTimestamp, useBookmarkMutations, type Bookmark } from "@/lib/bookmarkApi";
import { useMediaQuery } from "@/lib/useMediaQuery";

/**
 * The video's bookmarks, as a table of contents.
 *
 * A label is renamed in place: click it, type, Enter or click away. There is
 * no separate edit mode, because a bookmark is usually made mid-watch with no
 * label and named later, and a mode would turn that into three clicks.
 */
export function BookmarkList({
  itemId,
  bookmarks,
  onJump,
}: {
  itemId: number;
  bookmarks: Bookmark[];
  onJump: (seconds: number) => void;
}) {
  const { rename, saveNote, remove } = useBookmarkMutations(itemId);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const touch = useMediaQuery("(pointer: coarse)");

  if (bookmarks.length === 0) {
    if (touch) {
      return (
        <p className="text-xs text-muted-foreground">
          None yet. Tap the bookmark button on the video to mark a moment.
        </p>
      );
    }
    return (
      <p className="text-xs text-muted-foreground">
        None yet. Press <kbd className="rounded border border-border px-1 font-mono text-[10px]">B</kbd>{" "}
        while playing, or the bookmark button on the video, to mark a moment.
      </p>
    );
  }

  function commit(bookmark: Bookmark) {
    setEditingId(null);
    if (draft.trim() !== (bookmark.label ?? "")) {
      rename.mutate({ id: bookmark.id, label: draft });
    }
  }

  function commitNote(bookmark: Bookmark) {
    setEditingNoteId(null);
    if (noteDraft.trim() !== (bookmark.note ?? "")) {
      saveNote.mutate({ id: bookmark.id, note: noteDraft });
    }
  }

  return (
    <ol className="space-y-1">
      {bookmarks.map((bookmark) => (
        <li key={bookmark.id} className="group space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onJump(bookmark.positionSeconds)}
              title="Play from here"
              className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs tabular-nums text-amber-500 transition-colors hover:bg-accent"
            >
              <BookmarkIcon className="size-3 fill-current" />
              {formatTimestamp(bookmark.positionSeconds)}
            </button>

            {editingId === bookmark.id ? (
              <input
                autoFocus
                value={draft}
                maxLength={200}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(bookmark)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(bookmark);
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditingId(null);
                  }
                }}
                placeholder="Name this moment"
                className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-0.5 text-xs outline-none focus:border-ring/60"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(bookmark.label ?? "");
                  setEditingId(bookmark.id);
                }}
                title="Rename"
                className="sensitive min-w-0 flex-1 truncate text-left text-xs text-muted-foreground hover:text-foreground"
              >
                {bookmark.label ?? <span className="italic opacity-60">Untitled</span>}
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setNoteDraft(bookmark.note ?? "");
                setEditingNoteId((current) => current === bookmark.id ? null : bookmark.id);
              }}
              aria-label={`${bookmark.note ? "Edit" : "Add"} note at ${formatTimestamp(bookmark.positionSeconds)}`}
              title={bookmark.note ? "Edit note" : "Add note"}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FileText className={`size-3.5 ${bookmark.note ? "text-foreground" : ""}`} />
            </button>

            <button
              type="button"
              onClick={() => remove.mutate(bookmark.id)}
              aria-label={`Delete bookmark at ${formatTimestamp(bookmark.positionSeconds)}`}
              title="Delete"
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100 max-md:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>

          {editingNoteId === bookmark.id ? (
            <div className="space-y-1.5 pl-8">
              <textarea
                autoFocus
                value={noteDraft}
                maxLength={4000}
                onChange={(event) => setNoteDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setEditingNoteId(null);
                  }
                }}
                placeholder="Add a note about this moment…"
                rows={3}
                className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs leading-relaxed outline-none focus:border-ring/60"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] tabular-nums text-muted-foreground/60">
                  {noteDraft.length}/4000
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditingNoteId(null)}
                    aria-label="Cancel note"
                    title="Cancel"
                    className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => commitNote(bookmark)}
                    disabled={saveNote.isPending}
                    aria-label="Save note"
                    title="Save note"
                    className="flex size-7 items-center justify-center rounded bg-secondary text-foreground hover:bg-accent disabled:opacity-50"
                  >
                    <Check className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ) : bookmark.note ? (
            <p className="sensitive whitespace-pre-wrap break-words pl-8 text-xs leading-relaxed text-muted-foreground">
              {bookmark.note}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
