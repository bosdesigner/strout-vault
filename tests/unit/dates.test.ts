import { describe, expect, it } from "vitest";
import { localDay, resolveDueDate } from "../../server/facts/dates.ts";

// Tuesday 2026-10-27, 2:30 PM Central (19:30 UTC).
const tue = new Date("2026-10-27T19:30:00Z");
// Friday 2026-10-30, 10:00 AM Central.
const fri = new Date("2026-10-30T15:00:00Z");
// Saturday 2026-10-31, late evening Central, already Sunday in UTC.
const satNight = new Date("2026-11-01T03:30:00Z");

describe("resolveDueDate", () => {
  it("resolves weekday names to the next one on or after the day it was said", () => {
    expect(resolveDueDate("Friday", tue)).toBe("2026-10-30");
    expect(resolveDueDate("by Friday", tue)).toBe("2026-10-30");
    expect(resolveDueDate("this Friday", tue)).toBe("2026-10-30");
    expect(resolveDueDate("Monday morning", tue)).toBe("2026-11-02");
    expect(resolveDueDate("Tuesday", tue)).toBe("2026-10-27");
    expect(resolveDueDate("Wednesday", tue)).toBe("2026-10-28");
    expect(resolveDueDate("Thurs", tue)).toBe("2026-10-29");
    // Said on a Friday, "Friday" is today.
    expect(resolveDueDate("Friday", fri)).toBe("2026-10-30");
  });

  it("puts 'next Friday' in the following week", () => {
    expect(resolveDueDate("next Friday", tue)).toBe("2026-11-06");
    expect(resolveDueDate("Friday next week", tue)).toBe("2026-11-06");
    expect(resolveDueDate("next Monday", fri)).toBe("2026-11-02");
  });

  it("handles today, tomorrow, end of day, end of week and next week", () => {
    expect(resolveDueDate("today", tue)).toBe("2026-10-27");
    expect(resolveDueDate("end of day", tue)).toBe("2026-10-27");
    expect(resolveDueDate("tomorrow", tue)).toBe("2026-10-28");
    expect(resolveDueDate("the day after tomorrow", tue)).toBe("2026-10-29");
    expect(resolveDueDate("end of the week", tue)).toBe("2026-10-30");
    expect(resolveDueDate("EOW", tue)).toBe("2026-10-30");
    expect(resolveDueDate("next week", tue)).toBe("2026-11-06");
    expect(resolveDueDate("by end of next week", tue)).toBe("2026-11-06");
  });

  it("uses Ben's time zone, not UTC, for the day something was said", () => {
    // 03:30 UTC Sunday is still Saturday evening in Chicago.
    expect(localDay(satNight).toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(resolveDueDate("tomorrow", satNight)).toBe("2026-11-01");
    // End of week said on a weekend is the coming Friday.
    expect(resolveDueDate("end of week", satNight)).toBe("2026-11-06");
  });

  it("counts days, weeks and business days from the day it was said", () => {
    expect(resolveDueDate("in 3 days", tue)).toBe("2026-10-30");
    expect(resolveDueDate("in two weeks", tue)).toBe("2026-11-10");
    expect(resolveDueDate("within a week", tue)).toBe("2026-11-03");
    expect(resolveDueDate("10 days from now", tue)).toBe("2026-11-06");
    expect(resolveDueDate("in 2 business days", fri)).toBe("2026-11-03");
  });

  it("reads month names, numeric dates and a bare day of the month", () => {
    expect(resolveDueDate("Nov 3", tue)).toBe("2026-11-03");
    expect(resolveDueDate("November 3rd", tue)).toBe("2026-11-03");
    expect(resolveDueDate("the 3rd of November", tue)).toBe("2026-11-03");
    expect(resolveDueDate("11/15", tue)).toBe("2026-11-15");
    expect(resolveDueDate("1/5/27", tue)).toBe("2027-01-05");
    expect(resolveDueDate("the 15th", tue)).toBe("2026-11-15");
    expect(resolveDueDate("the 28th", tue)).toBe("2026-10-28");
    expect(resolveDueDate("end of month", tue)).toBe("2026-10-31");
    // A month already well past rolls to next year.
    expect(resolveDueDate("January 10", tue)).toBe("2027-01-10");
    // Recently past stays this year (a late follow-up on something overdue).
    expect(resolveDueDate("Oct 20", tue)).toBe("2026-10-20");
    expect(resolveDueDate("2026-12-01", tue)).toBe("2026-12-01");
  });

  it("leaves vague or impossible phrases null", () => {
    for (const p of ["soon", "ASAP", "next month", "sometime", "when we can", "", null, undefined, "February 30"]) expect(resolveDueDate(p as string | null, tue)).toBeNull();
    expect(resolveDueDate("Friday", new Date("not a date"))).toBeNull();
  });
});
