import { describe, expect, it } from "vitest";
import { businessHoursBetween, keywords } from "../../server/worker/followthrough.ts";

describe("businessHoursBetween", () => {
  it("counts weekday hours only", () => {
    // 2026-10-30 is a Friday.
    expect(businessHoursBetween(new Date("2026-10-30T17:00:00Z"), new Date("2026-11-02T09:00:00Z"))).toBe(16);
    expect(businessHoursBetween(new Date("2026-10-27T09:00:00Z"), new Date("2026-10-28T09:00:00Z"))).toBe(24);
    expect(businessHoursBetween(new Date("2026-10-31T09:00:00Z"), new Date("2026-11-01T21:00:00Z"))).toBe(0);
  });

  it("is zero for an empty or backwards range", () => {
    const t = new Date("2026-10-28T12:00:00Z");
    expect(businessHoursBetween(t, t)).toBe(0);
    expect(businessHoursBetween(t, new Date("2026-10-27T12:00:00Z"))).toBe(0);
  });
});

describe("keywords", () => {
  it("keeps the words that identify a commitment and drops filler", () => {
    expect(keywords("Ben will send Tanner the vetted floor plans by Friday.")).toEqual(["tanner", "vetted", "floor", "plans", "friday"]);
    expect(keywords("")).toEqual([]);
  });
});
