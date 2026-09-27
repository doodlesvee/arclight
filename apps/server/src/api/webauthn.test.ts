import { describe, expect, it } from "vitest";
import { parseOrigins } from "./webauthn.js";

describe("parseOrigins", () => {
  it("defaults to both the dev and the production origin on localhost", () => {
    expect(parseOrigins(undefined)).toEqual({
      origins: ["http://localhost:5173", "http://localhost:3000"],
      rpId: "localhost",
    });
  });

  it("splits a comma-separated list and trims it", () => {
    expect(parseOrigins(" http://media.local:5173 , http://media.local:3000 ,")).toEqual({
      origins: ["http://media.local:5173", "http://media.local:3000"],
      rpId: "media.local",
    });
  });

  it("takes the relying party from the hostname alone, so one passkey works on every port", () => {
    expect(parseOrigins("https://media.example.com:8443").rpId).toBe("media.example.com");
  });
});
