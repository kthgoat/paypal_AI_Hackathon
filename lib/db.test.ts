import { describe, expect, it } from "vitest";

import {
  centsToUsd,
  parseStringList,
  serialiseStringList,
  usdToCents,
} from "./db";

describe("JSON string-list helpers", () => {
  it("round-trips a list, including empty and special characters", () => {
    for (const list of [[], ["a"], ['quote " and, comma', "ünïcode ✓"]]) {
      expect(parseStringList(serialiseStringList(list))).toEqual(list);
    }
  });

  it("throws on malformed or wrongly-shaped data", () => {
    expect(() => parseStringList("not json")).toThrow();
    expect(() => parseStringList('{"a":1}')).toThrow();
    expect(() => parseStringList("[1,2]")).toThrow();
  });
});

describe("money helpers", () => {
  it("converts dollars to integer cents without float drift", () => {
    expect(usdToCents(19.99)).toBe(1999);
    expect(usdToCents(0.1 + 0.2)).toBe(30);
    expect(centsToUsd(1999)).toBe(19.99);
  });
});
