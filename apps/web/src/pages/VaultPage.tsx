import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Fingerprint, Lock, LockOpen } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { settingsInputClass } from "@/components/SettingsSection";
import { openDetails } from "@/lib/appEvents";
import { hideItem, framingStyle, thumbnailUrl } from "@/lib/mediaItemApi";
import {
  describePinError,
  fetchVault,
  fetchVaultItems,
  lockVault,
  setVaultPin,
  unlockVault,
} from "@/lib/vaultApi";
import { formatDuration } from "@/lib/utils";
import { fetchPasskeys, unlockVaultWithPasskey } from "@/lib/webauthnApi";

function PinForm({
  title,
  hint,
  withAccountPassword,
  submitLabel,
  pending,
  error,
  onSubmit,
  onPasskey,
}: {
  title: string;
  hint: string;
  withAccountPassword: boolean;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (pin: string, accountPassword: string) => void;
  onPasskey?: () => void;
}) {
  const [pin, setPin] = useState("");
  const [accountPassword, setAccountPassword] = useState("");

  return (
    <form
      className="mx-auto w-full max-w-sm space-y-4 rounded-lg border border-border bg-card/40 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(pin, accountPassword);
      }}
    >
      <div className="space-y-1 text-center">
        <Lock className="mx-auto size-8 text-muted-foreground" />
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        aria-label="PIN"
        placeholder="PIN"
        maxLength={12}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        className={`${settingsInputClass} text-center tracking-[0.4em]`}
      />
      {withAccountPassword && (
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Account password"
          placeholder="Your account password"
          value={accountPassword}
          onChange={(e) => setAccountPassword(e.target.value)}
          className={settingsInputClass}
        />
      )}
      {error && <p className="text-center text-xs text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={pending || pin.length < 4 || (withAccountPassword && !accountPassword)}
        className="w-full rounded-md bg-white px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
      >
        {submitLabel}
      </button>
      {onPasskey && (
        <button
          type="button"
          onClick={onPasskey}
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Fingerprint className="size-4" />
          Unlock with passkey
        </button>
      )}
    </form>
  );
}

function Unlocked({ count }: { count: number | null }) {
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["vault-items"],
    queryFn: fetchVaultItems,
  });

  const restore = useMutation({
    mutationFn: (id: number) => hideItem(id, false),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const lock = useMutation({
    mutationFn: lockVault,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["vault-items"] });
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
    },
  });

  const changePin = useMutation({
    mutationFn: ({ pin, accountPassword }: { pin: string; accountPassword: string }) =>
      setVaultPin(pin, accountPassword),
    onSuccess: () => {
      setChanging(false);
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LockOpen className="size-4" />
          {count === null ? "Unlocked" : `${count} hidden item${count === 1 ? "" : "s"}`}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setChanging((v) => !v)}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {changing ? "Cancel" : "Change PIN"}
          </button>
          <button
            type="button"
            onClick={() => lock.mutate()}
            disabled={lock.isPending}
            className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            <Lock className="size-3.5" />
            Lock now
          </button>
        </div>
      </div>

      {changing && (
        <PinForm
          title="Change PIN"
          hint="4 to 12 digits. Leave it empty to remove the PIN altogether."
          withAccountPassword
          submitLabel="Save PIN"
          pending={changePin.isPending}
          error={changePin.error?.message ?? null}
          onSubmit={(pin, accountPassword) => changePin.mutate({ pin, accountPassword })}
        />
      )}

      {isLoading && (
        <div className="flex justify-center py-16">
          <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          Nothing is hidden. Use “Hide” in a tile’s menu to put something here.
        </p>
      )}

      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.id} className="overflow-hidden rounded-lg border border-border bg-card/40">
            <button
              type="button"
              onClick={() => openDetails(item.id)}
              className="relative block aspect-video w-full overflow-hidden bg-secondary"
              aria-label={`Open ${item.title}`}
            >
              <img
                src={thumbnailUrl(item)}
                alt=""
                style={framingStyle(item)}
                className="size-full object-cover"
              />
              {item.durationSeconds ? (
                <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
                  {formatDuration(item.durationSeconds)}
                </span>
              ) : null}
            </button>
            <div className="space-y-2 p-2.5">
              <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
              <button
                type="button"
                onClick={() => restore.mutate(item.id)}
                disabled={restore.isPending}
                className="flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Eye className="size-3.5" />
                Restore
              </button>
            </div>
          </li>
        ))}
      </ul>
      {restore.error && <p className="text-xs text-destructive">{restore.error.message}</p>}
    </div>
  );
}

export function VaultPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["vault"], queryFn: fetchVault });
  const passkeys = useQuery({ queryKey: ["passkeys"], queryFn: fetchPasskeys });
  const passkeyUnlock = useMutation({
    mutationFn: unlockVaultWithPasskey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vault"] }),
  });

  const unlock = useMutation({
    mutationFn: ({ pin }: { pin: string }) => unlockVault(pin),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vault"] }),
  });

  const create = useMutation({
    mutationFn: ({ pin, accountPassword }: { pin: string; accountPassword: string }) =>
      setVaultPin(pin, accountPassword),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vault"] }),
  });

  // Leaving the page closes the vault, so a tab left behind is not an open door.
  useEffect(
    () => () => {
      void lockVault();
      queryClient.removeQueries({ queryKey: ["vault-items"] });
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
    },
    [queryClient],
  );

  return (
    <AppShell title="Vault">
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        {isLoading || !data ? (
          <div className="flex justify-center py-24">
            <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          </div>
        ) : !data.hasPin ? (
          <PinForm
            title="Set a vault PIN"
            hint="Hidden videos stay out of search, lists, the inbox and the activity log. The PIN is what brings them back."
            withAccountPassword
            submitLabel="Create vault"
            pending={create.isPending}
            error={create.error?.message ?? null}
            onSubmit={(pin, accountPassword) => create.mutate({ pin, accountPassword })}
          />
        ) : !data.unlocked ? (
          <PinForm
            title="Vault locked"
            hint="Use your PIN or a registered passkey to see what is hidden."
            withAccountPassword={false}
            submitLabel="Unlock"
            pending={unlock.isPending || passkeyUnlock.isPending}
            error={passkeyUnlock.error?.message
              ?? (unlock.error ? describePinError(unlock.error) : null)
              ?? passkeys.error?.message
              ?? null}
            onSubmit={(pin) => {
              passkeyUnlock.reset();
              unlock.mutate({ pin });
            }}
            onPasskey={passkeys.data?.length ? () => {
              unlock.reset();
              passkeyUnlock.mutate();
            } : undefined}
          />
        ) : (
          <Unlocked count={data.count} />
        )}
      </div>
    </AppShell>
  );
}
