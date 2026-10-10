import { afterEach, describe, expect, it, vi } from "vitest";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { loginWithPasskey, registerPasskey, unlockVaultWithPasskey } from "./webauthnApi";

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("loginWithPasskey", () => {
  function enablePasskeys() {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PublicKeyCredential", class {});
  }

  it("authenticates and sends the assertion to the login endpoint", async () => {
    enablePasskeys();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ challenge: "login-challenge" }),
    });

    vi.stubGlobal("fetch", fetchMock);
    const response = { id: "passkey-id" } as Awaited<ReturnType<typeof startAuthentication>>;
    vi.mocked(startAuthentication).mockResolvedValue(response);

    await loginWithPasskey();
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: "login-challenge" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/webauthn/login/options", expect.objectContaining({
      method: "POST",
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/webauthn/login", expect.objectContaining({
      body: JSON.stringify({ response }),
    }));
  });

  it("reports cancellation without submitting an assertion", async () => {
    enablePasskeys();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ challenge: "login-challenge" }),
    }));
    vi.mocked(startAuthentication).mockRejectedValue(new DOMException("Cancelled", "NotAllowedError"));
    await expect(loginWithPasskey()).rejects.toThrow("Passkey sign-in did not complete: Cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("explains insecure contexts before making a request", async () => {
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("fetch", vi.fn());
    await expect(loginWithPasskey()).rejects.toThrow("localhost or HTTPS");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("unlockVaultWithPasskey", () => {
  it("requests and submits a vault-scoped assertion", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ challenge: "vault-challenge" }),
    }));
    const response = { id: "passkey-id" } as Awaited<ReturnType<typeof startAuthentication>>;
    vi.mocked(startAuthentication).mockResolvedValue(response);
    await unlockVaultWithPasskey();
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/webauthn/auth/options", expect.objectContaining({
      body: JSON.stringify({ purpose: "vault" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/webauthn/auth", expect.objectContaining({
      body: JSON.stringify({ response, purpose: "vault" }),
    }));
  });

  it("reports cancellation and does not submit an assertion", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ challenge: "vault-challenge" }),
    }));
    vi.mocked(startAuthentication).mockRejectedValue(new DOMException("Cancelled", "NotAllowedError"));
    await expect(unlockVaultWithPasskey()).rejects.toThrow("Try again or use your PIN");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("registerPasskey", () => {
  it("preserves the authenticator's error rather than reporting every failure as cancellation", async () => {
    const error = new DOMException("The relying party is not allowed.", "SecurityError");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ challenge: "test-challenge" }),
    }));
    vi.mocked(startRegistration).mockRejectedValue(error);

    await expect(registerPasskey("Arc Light")).rejects.toMatchObject({
      message: "Touch ID setup failed (SecurityError): The relying party is not allowed.",
      cause: error,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the helpful message for an already registered authenticator", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ challenge: "test-challenge" }),
    }));
    vi.mocked(startRegistration).mockRejectedValue(
      new DOMException("Already registered", "InvalidStateError"),
    );

    await expect(registerPasskey("Arc Light")).rejects.toThrow(
      "This browser is already set up — it's in the list above.",
    );
  });
});
