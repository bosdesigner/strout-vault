import { describe, expect, it } from "vitest";
import { ZoomClient, monthWindows, monthsBefore, parseRecording, stripToken } from "../../server/worker/zoom.ts";
import { mimeFor, zoomObjectKey } from "../../server/worker/sync.ts";
import { createMockServices, type MockRecording } from "../mocks/zoomGroq.ts";

describe("monthWindows", () => {
  it("walks month by month and never asks for future dates", () => {
    const today = new Date("2026-10-23T12:00:00Z");
    expect(monthWindows("2026-08", undefined, today)).toEqual([
      ["2026-08-01", "2026-08-31"],
      ["2026-09-01", "2026-09-30"],
      ["2026-10-01", "2026-10-23"],
    ]);
  });
  it("returns nothing when the start is after the end", () => {
    expect(monthWindows("2026-12", "2026-10", new Date("2026-10-23T00:00:00Z"))).toEqual([]);
  });
  it("steps back across a year boundary", () => {
    expect(monthsBefore("2026-01", 3)).toBe("2025-10");
    expect(monthsBefore("2026-10", 0)).toBe("2026-10");
  });
});

describe("parseRecording", () => {
  it("maps Zoom file types to media kinds and keeps unknown ones as other", () => {
    const rec = parseRecording({
      uuid: "abc==",
      id: 123,
      topic: "",
      start_time: "2026-10-01T10:00:00Z",
      duration: 42,
      recording_files: [
        { id: "f1", file_type: "MP4", file_extension: "MP4", file_size: "10", download_url: "https://zoom.test/d/f1", status: "completed" },
        { id: "f2", file_type: "TRANSCRIPT", file_extension: "VTT", file_size: 5, download_url: "https://zoom.test/d/f2" },
        { id: "f3", file_type: "SUMMARY", file_size: 0, download_url: "https://zoom.test/d/f3" },
      ],
    });
    expect(rec.topic).toBe("(no topic)");
    expect(rec.meetingNumber).toBe("123");
    expect(rec.files.map((f) => [f.kind, f.extension, f.size])).toEqual([
      ["video", "mp4", 10],
      ["transcript_vtt", "vtt", 5],
      ["summary", "summary", 0],
    ]);
  });
});

describe("object keys and tokens", () => {
  it("builds a key under the legacy archive prefix from the meeting date, uuid and file id", () => {
    const rec = parseRecording({ uuid: "aPU5y6soSnGbTr05L5SLpQ==", start_time: "2026-10-16T18:31:46Z", recording_files: [{ id: "48715f14-e6ff-4414", file_type: "MP4", file_extension: "MP4" }] });
    expect(zoomObjectKey(rec, rec.files[0])).toBe("meeting-vault/2026/2026-10-16_zapu5y6sosngb/original/video_48715f14.mp4");
    expect(mimeFor("m4a")).toBe("audio/mp4");
    expect(mimeFor("vtt")).toBe("text/vtt");
  });
  it("strips access tokens before anything is logged or stored", () => {
    expect(stripToken("https://zoom.test/rec/download/x?access_token=secret&b=1")).toBe("https://zoom.test/rec/download/x?b=1");
    expect(stripToken("not a url")).toBe("not a url");
  });
});

describe("ZoomClient against the mock API", () => {
  const recs: MockRecording[] = [1, 2, 3].map((n) => ({
    uuid: `uuid-${n}==`,
    meetingNumber: `${n}`,
    topic: `Meeting ${n}`,
    start: `2026-09-0${n}T10:00:00Z`,
    durationMin: n,
    files: [{ id: `m${n}-a`, type: "M4A", body: Buffer.from("audio") }],
  }));

  function client(mock = createMockServices(recs)) {
    return {
      mock,
      client: new ZoomClient({
        accountId: "acc",
        clientId: "id",
        clientSecret: "secret",
        apiBase: "https://zoom.test/v2",
        oauthBase: "https://zoom.test",
        fetchImpl: mock.fetchImpl,
        sleep: async () => {},
        now: () => new Date("2026-10-23T00:00:00Z"),
      }),
    };
  }

  it("mints one token, lists users and follows next_page_token", async () => {
    const { client: c, mock } = client();
    const seen: string[] = [];
    const windows: string[] = [];
    for await (const rec of c.iterWindows("2026-09", "2026-09", (from, to, found) => windows.push(`${from}..${to}=${found}`))) seen.push(rec.topic);
    expect(seen).toEqual(["Meeting 1", "Meeting 2", "Meeting 3"]);
    expect(windows).toEqual(["2026-09-01..2026-09-30=3"]);
    expect(mock.calls.token).toBe(1);
    expect(mock.calls.recordings).toBe(2); // page size 2 -> two pages
  });

  it("streams a download, retrying once after a 429 and dropping auth on a cross-host redirect", async () => {
    const mock = createMockServices([
      {
        uuid: "u==",
        meetingNumber: "9",
        topic: "x",
        start: "2026-09-09T00:00:00Z",
        durationMin: 1,
        files: [
          { id: "rl", type: "M4A", body: Buffer.from("rate limited once"), rateLimitOnce: true },
          { id: "cdn", type: "MP4", body: Buffer.from("via cdn"), redirectToCdn: true },
        ],
      },
    ]);
    const { client: c } = client(mock);
    const a = await c.openDownload("https://zoom.test/rec/download/rl");
    expect(await readAll(a.stream)).toBe("rate limited once");
    const b = await c.openDownload("https://zoom.test/rec/download/cdn");
    expect(await readAll(b.stream)).toBe("via cdn");
    expect(mock.calls.cdnAuthHeaders).toBe(0);
    await expect(c.openDownload("https://zoom.test/rec/download/missing")).rejects.toThrow(/HTTP 404/);
  });
});

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString();
}
