import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginWithPasskey } from "@/lib/webauthnApi";
import { AuthGate } from "./AuthGate";

vi.mock("@/lib/webauthnApi", () => ({
  fetchPasskeys: vi.fn(),
  loginWithPasskey: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function renderGate(needsSetup = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["auth-status"], { needsSetup, user: null });
  client.setQueryData(["privacy"], { hasPassword: false });
  client.setQueryData(["passkeys"], []);
  render(
    <QueryClientProvider client={client}>
      <AuthGate><p>Private library</p></AuthGate>
    </QueryClientProvider>,
  );
  return client;
}

describe("passkey login screen", () => {
  it("signs in without username or password and refreshes auth status", async () => {
    const client = renderGate();
    vi.mocked(loginWithPasskey).mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ needsSetup: false, user: { id: 1, username: "Tester" } }),
    }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign in with passkey" }));
    await screen.findByText("Private library");
    expect(loginWithPasskey).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it("shows failures and leaves password sign-in available", async () => {
    const client = renderGate();
    vi.mocked(loginWithPasskey).mockRejectedValue(new Error("No passkey registered"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign in with passkey" }));
    await screen.findByText("No passkey registered");
    expect(screen.getByPlaceholderText("Username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
    client.clear();
  });

  it("does not offer passkey sign-in during first-time setup", () => {
    const client = renderGate(true);
    expect(screen.queryByRole("button", { name: "Sign in with passkey" })).not.toBeInTheDocument();
    client.clear();
  });
});
