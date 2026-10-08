import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultPage } from "./VaultPage";
import { fetchVault, lockVault } from "@/lib/vaultApi";
import { unlockVaultWithPasskey } from "@/lib/webauthnApi";

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/vaultApi", async (original) => ({
  ...await original<typeof import("@/lib/vaultApi")>(),
  fetchVault: vi.fn(),
  lockVault: vi.fn().mockResolvedValue(undefined),
  fetchVaultItems: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock("@/lib/webauthnApi", () => ({
  fetchPasskeys: vi.fn(),
  unlockVaultWithPasskey: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderVault() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["vault"], { hasPin: true, unlocked: false, count: null });
  client.setQueryData(["passkeys"], [{ id: "passkey", label: "Test" }]);
  render(
    <QueryClientProvider client={client}>
      <VaultPage />
    </QueryClientProvider>,
  );
  return client;
}

describe("vault passkey unlock", () => {
  it("opens the vault with a passkey without entering a PIN", async () => {
    const client = renderVault();
    vi.mocked(unlockVaultWithPasskey).mockResolvedValue();
    vi.mocked(fetchVault).mockResolvedValue({ hasPin: true, unlocked: true, count: 0 });
    await userEvent.setup().click(screen.getByRole("button", { name: "Unlock with passkey" }));
    await screen.findByRole("button", { name: "Lock now" });
    expect(unlockVaultWithPasskey).toHaveBeenCalledTimes(1);
    cleanup();
    expect(lockVault).toHaveBeenCalled();
    client.clear();
  });

  it("shows passkey errors and keeps the PIN fallback", async () => {
    const client = renderVault();
    vi.mocked(unlockVaultWithPasskey).mockRejectedValue(new Error("Passkey cancelled"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Unlock with passkey" }));
    await screen.findByText("Passkey cancelled");
    expect(screen.getByLabelText("PIN")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
    cleanup();
    client.clear();
  });
});
