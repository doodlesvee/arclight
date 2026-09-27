import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Circle, ImagePlus, Loader2, Move, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  deletePerformerImage,
  uploadPerformerImage,
  type PerformerImageKind,
} from "@/lib/performerApi";

/**
 * Every edit for one performer image, behind a single pencil on the image
 * itself.
 *
 * Replaces a row of three permanent buttons (Change photo / Remove /
 * Reposition) sitting beside the name. Those actions are rare — a portrait is
 * set once and then looked at — so the picture is what should occupy the
 * header, not the controls for it.
 *
 * The pencil is revealed on hover, but only where hovering is a thing it can
 * be revealed by: on small screens it stays visible, since a touch device has
 * no hover state and would otherwise have no way to reach any of this.
 */
export function PerformerImageMenu({
  performerId,
  kind,
  hasImage,
  canReposition,
  onReposition,
  onRepositionCircle,
  onUploaded,
  className,
}: {
  performerId: number;
  kind: PerformerImageKind;
  /** Whether an image was *uploaded* — a fallback frame isn't removable. */
  hasImage: boolean;
  canReposition: boolean;
  onReposition: () => void;
  /**
   * When given, "Reposition" splits in two: the tiles and the round profile
   * picture crop the same photo very differently, so each gets its own.
   */
  onRepositionCircle?: () => void;
  /**
   * Fired after a successful upload, so the caller can drop straight into
   * framing. A freshly uploaded picture is exactly when you know how you want
   * it cropped — making that a separate thing to remember later is how images
   * end up badly framed forever.
   */
  onUploaded?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      // Stops here rather than bubbling on to close a modal behind this one.
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["performer", performerId] });
    queryClient.invalidateQueries({ queryKey: ["performers"] });
  }

  const upload = useMutation({
    mutationFn: (file: File) => uploadPerformerImage(performerId, kind, file),
    onSuccess: () => {
      setError(null);
      invalidate();
      onUploaded?.();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: () => deletePerformerImage(performerId, kind),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const busy = upload.isPending || remove.isPending;
  const label = kind === "banner" ? "banner" : "photo";

  return (
    <div ref={containerRef} className={cn("absolute z-30", className)}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload.mutate(file);
          // Reset so picking the same file twice still fires a change event.
          event.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Edit ${label}`}
        title={`Edit ${label}`}
        className={cn(
          "flex size-8 items-center justify-center rounded-full bg-black/70 text-white ring-1 ring-white/25 backdrop-blur-sm transition-all hover:bg-black/90 focus-visible:opacity-100 disabled:opacity-50",
          "md:opacity-0 md:group-hover:opacity-100",
          // Never hide the way in while it's in use, and never hide it at all
          // when there's no picture yet — an empty avatar with an invisible
          // control is a dead end.
          (open || busy || !hasImage) && "md:opacity-100"
        )}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Pencil className="size-3.5" />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-md border border-border bg-card shadow-xl"
        >
          <MenuItem
            icon={<ImagePlus className="size-4" />}
            onClick={() => {
              setOpen(false);
              inputRef.current?.click();
            }}
          >
            {hasImage ? `Change ${label}` : `Upload ${label}`}
          </MenuItem>

          {canReposition && (
            <MenuItem
              icon={<Move className="size-4" />}
              onClick={() => {
                setOpen(false);
                onReposition();
              }}
            >
              {onRepositionCircle ? "Adjust for tiles" : "Reposition"}
            </MenuItem>
          )}

          {canReposition && onRepositionCircle && (
            <MenuItem
              icon={<Circle className="size-4" />}
              onClick={() => {
                setOpen(false);
                onRepositionCircle();
              }}
            >
              Adjust for circle
            </MenuItem>
          )}

          {hasImage && (
            <MenuItem
              icon={<Trash2 className="size-4" />}
              destructive
              onClick={() => {
                setOpen(false);
                remove.mutate();
              }}
            >
              Remove {label}
            </MenuItem>
          )}
        </div>
      )}

      {error && (
        <p className="absolute left-0 top-full mt-2 w-48 rounded bg-destructive/90 px-2 py-1 text-xs text-white">
          {error}
        </p>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  children,
  destructive,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
        destructive ? "text-destructive" : "text-foreground"
      )}
    >
      {icon}
      {children}
    </button>
  );
}
