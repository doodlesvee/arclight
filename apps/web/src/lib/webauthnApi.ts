import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export type Passkey = { id: string; label: string };

export async function fetchPasskeys(): Promise<Passkey[]> {
  const res = await fetch("/api/webauthn/credentials");
  if (!res.ok) throw new Error(`Failed to load passkeys: ${res.status}`);
  return ((await res.json()) as { credentials: Passkey[] }).credentials;
}

async function post(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    // The header only goes with an actual body. Declaring JSON and sending
    // nothing makes Fastify reject the request as an empty JSON body — a 400
    // before the handler ever runs, which is what broke Touch ID setup: the
    // two "options" calls take no body at all.
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed: ${res.status}`);
  return data;
}

/**
 * Registers this browser's built-in authenticator — Touch ID on a Mac.
 *
 * Two round trips by design: the server issues a challenge, the browser has
 * the authenticator sign it, and the server verifies that signature. The
 * fingerprint itself never leaves the laptop; it only unlocks the private key
 * the browser holds.
 */
export async function registerPasskey(label: string): Promise<void> {
  const options = (await post("/api/webauthn/register/options")) as Parameters<
    typeof startRegistration
  >[0]["optionsJSON"];

  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (error) {
    // The server sends the existing credentials as `excludeCredentials`, and
    // the authenticator refuses to enrol twice. That's correct behaviour, but
    // "The authenticator was previously registered" reads like a fault.
    const isAuthenticatorError = error instanceof Error || error instanceof DOMException;
    if (isAuthenticatorError && error.name === "InvalidStateError") {
      throw new Error("This browser is already set up — it's in the list above.");
    }
    if (isAuthenticatorError) {
      throw new Error(`Touch ID setup failed (${error.name}): ${error.message}`, {
        cause: error,
      });
    }
    throw new Error("Touch ID setup failed with an unknown authenticator error.", {
      cause: error,
    });
  }

  await post("/api/webauthn/register", { response, label });
}

/** Resolves true when the fingerprint checked out; false when it was declined. */
export async function authenticatePasskey(purpose: "privacy" | "vault" = "privacy"): Promise<boolean> {
  const options = (await post("/api/webauthn/auth/options", { purpose })) as Parameters<
    typeof startAuthentication
  >[0]["optionsJSON"];
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch {
    // Cancelled the prompt, or no finger matched. Not an error worth showing
    // as one — the password field is still sitting there.
    return false;
  }
  await post("/api/webauthn/auth", { response, purpose });
  return true;
}

export async function unlockVaultWithPasskey(): Promise<void> {
  if (!window.isSecureContext || !window.PublicKeyCredential) {
    throw new Error("Passkey unlock needs a supported browser on localhost or HTTPS.");
  }
  if (!(await authenticatePasskey("vault"))) {
    throw new Error("Passkey unlock did not complete. Try again or use your PIN.");
  }
}

export async function loginWithPasskey(): Promise<void> {
  if (!window.isSecureContext || !window.PublicKeyCredential) {
    throw new Error("Passkey sign-in needs a supported browser on localhost or HTTPS.");
  }
  const options = (await post("/api/webauthn/login/options")) as Parameters<
    typeof startAuthentication
  >[0]["optionsJSON"];
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (error) {
    const detail = error instanceof Error || error instanceof DOMException
      ? error.message
      : "Unknown authenticator error";
    throw new Error(`Passkey sign-in did not complete: ${detail}`, { cause: error });
  }
  await post("/api/webauthn/login", { response });
}

export async function deletePasskey(id: string): Promise<void> {
  const res = await fetch(`/api/webauthn/credentials/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to remove: ${res.status}`);
}
