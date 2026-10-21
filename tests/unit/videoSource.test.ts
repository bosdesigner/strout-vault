import { describe, expect, it } from "vitest";
import { pickVideoSource, servableStorages, type PlayableCandidate } from "../../server/services/videoSource.ts";

const m = (over: Partial<PlayableCandidate> & { id: number; storage: string }): PlayableCandidate => ({
  bucket: null,
  storageKey: `k${over.id}`,
  role: "original",
  kind: "video",
  status: "verified",
  mimeType: "video/mp4",
  ...over,
});

const prod = (s: string) => s === "r2" || s === "b2"; // s3 driver with both backends
const r2only = (s: string) => s === "r2";
const dev = (s: string) => s === "local"; // local driver

describe("pickVideoSource", () => {
  it("prefers an R2 proxy over everything else", () => {
    const files = [
      m({ id: 1, storage: "b2", role: "original" }),
      m({ id: 2, storage: "r2", role: "original" }),
      m({ id: 3, storage: "r2", role: "proxy" }),
      m({ id: 4, storage: "local" }),
    ];
    expect(pickVideoSource(files, prod)?.id).toBe(3);
  });

  it("falls back to any R2 video or audio when there is no proxy", () => {
    const files = [m({ id: 1, storage: "b2" }), m({ id: 2, storage: "r2", role: "original", kind: "audio" })];
    expect(pickVideoSource(files, prod)?.id).toBe(2);
  });

  it("prefers video over audio within the same tier", () => {
    const files = [m({ id: 1, storage: "r2", kind: "audio" }), m({ id: 2, storage: "r2", kind: "video" })];
    expect(pickVideoSource(files, prod)?.id).toBe(2);
  });

  it("then uses the B2 original with a presigned GET", () => {
    const files = [m({ id: 1, storage: "zoom" }), m({ id: 2, storage: "local", storageKey: "/Volumes/Toshiba/x.mp4" }), m({ id: 3, storage: "b2", role: "original" })];
    expect(pickVideoSource(files, prod)?.id).toBe(3);
  });

  it("ignores B2 rows that are not the original", () => {
    const files = [m({ id: 1, storage: "b2", role: "proxy" })];
    expect(pickVideoSource(files, prod)).toBeNull();
  });

  it("never plays zoom or local rows in production", () => {
    const files = [m({ id: 1, storage: "zoom" }), m({ id: 2, storage: "local" })];
    expect(pickVideoSource(files, prod)).toBeNull();
  });

  it("skips B2 when the driver has no B2 credentials", () => {
    const files = [m({ id: 1, storage: "b2" })];
    expect(pickVideoSource(files, r2only)).toBeNull();
  });

  it("plays local rows only through the local driver (development)", () => {
    const files = [m({ id: 1, storage: "b2" }), m({ id: 2, storage: "local", storageKey: "samples/one.webm" })];
    expect(pickVideoSource(files, dev)?.id).toBe(2);
  });

  it("skips files that are failed, missing, pending or deleted", () => {
    const files = [
      m({ id: 1, storage: "r2", role: "proxy", status: "failed" }),
      m({ id: 2, storage: "r2", status: "pending" }),
      m({ id: 3, storage: "b2", status: "missing" }),
      m({ id: 4, storage: "b2", status: "deleted_local" }),
    ];
    expect(pickVideoSource(files, prod)).toBeNull();
  });

  it("skips transcript, chat and caption files", () => {
    const files = [m({ id: 1, storage: "r2", kind: "transcript_vtt" }), m({ id: 2, storage: "b2", kind: "cc" })];
    expect(pickVideoSource(files, prod)).toBeNull();
  });

  it("treats a null kind on a legacy row as playable", () => {
    const files = [m({ id: 1, storage: "b2", kind: null })];
    expect(pickVideoSource(files, prod)?.id).toBe(1);
  });

  it("returns null with no files", () => {
    expect(pickVideoSource([], prod)).toBeNull();
  });

  it("reports which storages count as 'has video' for the running driver", () => {
    expect(servableStorages(prod)).toEqual(["r2", "b2"]);
    expect(servableStorages(dev)).toEqual(["local"]);
  });
});
