import { afterEach, describe, expect, it, vi } from "vitest";
import { PinError, describePinError, unlockVault } from "./vaultApi";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("unlockVault", () => {
  it("resolves on success", async () => {
    stubFetch(200, { ok: true });
    await expect(unlockVault("1234")).resolves.toBeUndefined();
  });

  it("rejects with the attempts left on a wrong PIN", async () => {
    stubFetch(403, { error: "Wrong PIN", attemptsLeft: 3 });
    const err = await unlockVault("0000").catch((e) => e);
    expect(err).toBeInstanceOf(PinError);
    expect(err.attemptsLeft).toBe(3);
  });
});

describe("describePinError", () => {
  it("explains a wrong PIN and a lockout", () => {
    expect(describePinError(new PinError("Wrong PIN", 1))).toBe("Wrong PIN. 1 try left.");
    expect(describePinError(new PinError("Wrong PIN", 4))).toBe("Wrong PIN. 4 tries left.");
    expect(describePinError(new PinError("Too many attempts", undefined, 42))).toBe(
      "Too many attempts. Try again in 42s.",
    );
  });

  it("falls back to the error message", () => {
    expect(describePinError(new Error("boom"))).toBe("boom");
    expect(describePinError("weird")).toBe("Something went wrong.");
  });
});
