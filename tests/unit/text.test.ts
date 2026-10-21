import { describe, expect, it } from "vitest";
import { firstMeaningfulLine, formatDuration, formatTimestamp, isGenericTitle, titleFromFilename } from "../../shared/text.ts";
import { splitMarked, MARK_START, MARK_END } from "../../server/services/search.ts";
import { decodeCursor, encodeCursor } from "../../server/services/library.ts";
import { assertSafeKey, sanitizeFilename, uploadKey } from "../../server/storage/types.ts";

describe("isGenericTitle", () => {
  it("flags Zoom defaults, hex ids, IMG names and blanks", () => {
    for (const t of ["Ben Strout's Zoom Meeting", "Zoom Meeting", "Ben Strout's Personal Meeting Room", "a91f3c0d7e2b48f6", "IMG_1234", "IMG_4821.MOV", "", null]) {
      expect(isGenericTitle(t), String(t)).toBe(true);
    }
  });
  it("keeps real titles", () => {
    for (const t of ["Heights bungalow: beam sizes and permit set", "Kevin: drone pass", "Q3 planning"]) expect(isGenericTitle(t)).toBe(false);
  });
});

describe("firstMeaningfulLine", () => {
  it("skips filler and speaker prefixes", () => {
    const text = "Ben Strout: Okay.\nKevin McGuire: Recording in progress\nBen Strout: The structural engineer wants to see the foundation plan first.";
    expect(firstMeaningfulLine(text)).toBe("The structural engineer wants to see the foundation plan first.");
  });
  it("returns null when nothing qualifies", () => {
    expect(firstMeaningfulLine("Hi\nYeah.\n")).toBeNull();
    expect(firstMeaningfulLine(null)).toBeNull();
  });
});

describe("formatters", () => {
  it("formats durations and timestamps with hours when needed", () => {
    expect(formatDuration(59)).toBe("59 sec");
    expect(formatDuration(1500)).toBe("25 min");
    expect(formatDuration(4320)).toBe("1h 12m");
    expect(formatTimestamp(42.7)).toBe("0:42");
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });
  it("derives a title from a filename", () => {
    expect(titleFromFilename("Kevin_drone_pass.mov")).toBe("Kevin drone pass");
  });
});

describe("splitMarked", () => {
  it("splits ts_headline output into plain and highlighted parts", () => {
    const s = `The ${MARK_START}copper${MARK_END} ${MARK_START}gutters${MARK_END} will patina.`;
    expect(splitMarked(s)).toEqual([
      { t: "The ", m: false },
      { t: "copper", m: true },
      { t: " ", m: false },
      { t: "gutters", m: true },
      { t: " will patina.", m: false },
    ]);
  });
  it("passes through text with no marks", () => {
    expect(splitMarked("plain")).toEqual([{ t: "plain", m: false }]);
  });
});

describe("library cursor", () => {
  it("round-trips and rejects garbage", () => {
    const c = { o: "2025-01-01T00:00:00.000Z", id: 42 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ o: null, id: 7 }))).toEqual({ o: null, id: 7 });
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor(Buffer.from('{"id":"x"}').toString("base64url"))).toBeNull();
  });
});

describe("storage keys", () => {
  it("builds uploads/<yyyy>/<mm>/<uuid>/<filename>", () => {
    expect(uploadKey("My Call.m4a", new Date("2026-03-05T12:00:00Z"), "u-1")).toBe("uploads/2026/03/u-1/My Call.m4a");
  });
  it("strips paths and control characters from filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\ben\\clip.mp4")).toBe("clip.mp4");
    expect(sanitizeFilename("bad\u0000name.mp4")).toBe("badname.mp4");
  });
  it("rejects traversal and absolute keys", () => {
    for (const k of ["../x", "a/../b", "/abs", "a//b", "", "a\\b"]) expect(() => assertSafeKey(k), k).toThrow();
    expect(() => assertSafeKey("uploads/2026/01/x/y.mp4")).not.toThrow();
  });
});
