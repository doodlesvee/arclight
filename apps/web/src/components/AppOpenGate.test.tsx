import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPrivacyStatus } from "@/lib/privacyApi";
import { fetchPasskeys } from "@/lib/webauthnApi";
import { AppOpenGate } from "./AppOpenGate";

vi.mock("@/lib/privacyApi", () => ({ fetchPrivacyStatus: vi.fn() }));
vi.mock("@/lib/webauthnApi", () => ({ fetchPasskeys: vi.fn() }));
vi.mock("./PrivacyUnlockForm", () => ({
  PrivacyUnlockForm: ({ onUnlocked }: { onUnlocked: () => void }) => (
    <button type="button" onClick={onUnlocked}>Unlock</button>
  ),
}));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.resetAllMocks();
});

function renderGate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <AppOpenGate><p>Private library</p></AppOpenGate>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("app-open privacy gate", () => {
  it("requires an unlock and keeps it across a remount in this tab", async () => {
    vi.mocked(fetchPrivacyStatus).mockResolvedValue({ hasPassword: true });
    vi.mocked(fetchPasskeys).mockResolvedValue([]);

    const first = renderGate();
    await screen.findByRole("heading", { name: "Unlock Arc Light" });
    expect(screen.queryByText("Private library")).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Private library")).toBeInTheDocument();
    first.unmount();

    const second = renderGate();
    expect(await screen.findByText("Private library")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Unlock Arc Light" })).not.toBeInTheDocument();
    second.client.clear();
  });

  it("requires no unlock when no privacy credential is configured", async () => {
    vi.mocked(fetchPrivacyStatus).mockResolvedValue({ hasPassword: false });
    vi.mocked(fetchPasskeys).mockResolvedValue([]);

    renderGate();
    expect(await screen.findByText("Private library")).toBeInTheDocument();
  });

  it("requires a new unlock when the tab session has no saved marker", async () => {
    vi.mocked(fetchPrivacyStatus).mockResolvedValue({ hasPassword: true });
    vi.mocked(fetchPasskeys).mockResolvedValue([]);

    renderGate();
    await screen.findByRole("heading", { name: "Unlock Arc Light" });
  });
});