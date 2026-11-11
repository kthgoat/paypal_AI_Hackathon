import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkMaintainerKey } from "./auth";

const KEY = "correct-horse-battery-staple-1234";
const request = (key?: string) =>
  new Request("http://localhost/api/anything", { method: "POST", headers: key === undefined ? {} : { "x-maintainer-key": key } });

beforeEach(() => {
  vi.stubEnv("MAINTAINER_KEY", KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkMaintainerKey", () => {
  it("lets a request with the right key through", () => {
    expect(checkMaintainerKey(request(KEY))).toBeNull();
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["a wrong key", "wrong-key-wrong-key-wrong-key"],
    ["a wrong key of the same length", "x".repeat(KEY.length)],
    ["a prefix of the right key", KEY.slice(0, -1)],
    ["the right key plus extra", `${KEY}!`],
    ["the right key in another case", KEY.toUpperCase()],
  ])("answers 401 for %s", async (_name, key) => {
    const response = checkMaintainerKey(request(key));

    expect(response?.status).toBe(401);
    expect(await response!.json()).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  });

  it("never echoes the expected key", async () => {
    const response = checkMaintainerKey(request("nope"));

    expect(JSON.stringify(await response!.json())).not.toContain(KEY);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["shorter than 16 characters", "short-key-123"],
  ])("refuses to run maintainer actions when MAINTAINER_KEY is %s", async (_name, value) => {
    vi.stubEnv("MAINTAINER_KEY", value as string);

    // Even a request that sends exactly the (weak) configured key is refused.
    const response = checkMaintainerKey(request(value ?? ""));

    expect(response?.status).toBe(500);
    expect((await response!.json()).error.code).toBe("MAINTAINER_KEY_NOT_CONFIGURED");
  });
});
