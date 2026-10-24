// A stand-in Zoom API and Groq endpoint behind a fetch-compatible function.
// Like meeting-vault's tests/mock_zoom.py it misbehaves on purpose: it
// paginates at two records, rate-limits one download once, redirects one
// download to a "CDN" host, reports one file size wrong, and 404s one file.

export interface MockFile {
  id: string;
  type: "MP4" | "M4A" | "TRANSCRIPT" | "CC" | "CHAT" | "TIMELINE";
  body: Buffer;
  /** What the API reports as file_size when it should disagree with the body. */
  reportedSize?: number;
  status?: string;
  /** Misbehaviour knobs. */
  rateLimitOnce?: boolean;
  redirectToCdn?: boolean;
  notFound?: boolean;
}

export interface MockRecording {
  uuid: string;
  meetingNumber: string;
  topic: string;
  start: string; // ISO
  durationMin: number;
  hostEmail?: string;
  files: MockFile[];
}

export interface MockServices {
  fetchImpl: typeof fetch;
  calls: { token: number; users: number; recordings: number; downloads: number; groq: number; anthropic: number; cdnAuthHeaders: number };
  groqRequests: Array<{ model: string | null; filename: string | null; hasAuth: boolean }>;
  anthropicRequests: Array<{ model: string; effort: string | null; hasFormat: boolean; betas: string | null; cachedSystem: boolean; chars: number; maxTokens: number }>;
  /** Replace the recording list between runs. */
  setRecordings(recs: MockRecording[]): void;
  /** How the mock Claude answers: "ok" (one real candidate per chunk plus one with impossible timestamps), or "refusal". */
  setAnthropicMode(mode: "ok" | "refusal"): void;
}

export const ANTHROPIC_TEST_KEY = "anthropic-test-key";

const EXT: Record<MockFile["type"], string> = { MP4: "MP4", M4A: "M4A", TRANSCRIPT: "VTT", CC: "VTT", CHAT: "TXT", TIMELINE: "JSON" };
const TOKEN = "mock-zoom-token";

export function createMockServices(initial: MockRecording[], opts: { pageSize?: number; groqPayload?: (filename: string | null) => Record<string, unknown> } = {}): MockServices {
  let recordings = initial;
  const pageSize = opts.pageSize ?? 2;
  const calls = { token: 0, users: 0, recordings: 0, downloads: 0, groq: 0, anthropic: 0, cdnAuthHeaders: 0 };
  const groqRequests: MockServices["groqRequests"] = [];
  const anthropicRequests: MockServices["anthropicRequests"] = [];
  let anthropicMode: "ok" | "refusal" = "ok";
  const rateLimited = new Set<string>();

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const findFile = (id: string): { rec: MockRecording; file: MockFile } | null => {
    for (const rec of recordings) for (const file of rec.files) if (file.id === id) return { rec, file };
    return null;
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const auth = headers.get("authorization");

    // ---- Zoom OAuth ----
    if (url.host === "zoom.test" && url.pathname === "/oauth/token" && method === "POST") {
      calls.token++;
      if (!auth?.startsWith("Basic ")) return json({ error: "no basic auth" }, 401);
      if (url.searchParams.get("grant_type") !== "account_credentials") return json({ error: "bad grant" }, 400);
      return json({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 });
    }
    // ---- Zoom API ----
    if (url.host === "zoom.test" && url.pathname.startsWith("/v2/")) {
      if (auth !== `Bearer ${TOKEN}`) return json({ code: 124, message: "Invalid access token." }, 401);
      if (url.pathname === "/v2/users") {
        calls.users++;
        return json({ users: url.searchParams.get("status") === "active" ? [{ id: "u1", email: "ben@test.local", created_at: "2020-01-01T00:00:00Z" }] : [] });
      }
      if (url.pathname === "/v2/users/u1/recordings") {
        calls.recordings++;
        const from = url.searchParams.get("from")!;
        const to = url.searchParams.get("to")!;
        const inWindow = recordings.filter((r) => r.start.slice(0, 10) >= from && r.start.slice(0, 10) <= to);
        const page = Number(url.searchParams.get("next_page_token")?.replace("page-", "") ?? 0);
        const slice = inWindow.slice(page * pageSize, (page + 1) * pageSize);
        const more = (page + 1) * pageSize < inWindow.length;
        return json({
          from,
          to,
          page_size: pageSize,
          total_records: inWindow.length,
          next_page_token: more ? `page-${page + 1}` : "",
          meetings: slice.map((r) => ({
            uuid: r.uuid,
            id: Number(r.meetingNumber),
            topic: r.topic,
            start_time: r.start,
            duration: r.durationMin,
            host_email: r.hostEmail ?? "ben@test.local",
            total_size: r.files.reduce((n, f) => n + (f.reportedSize ?? f.body.length), 0),
            share_url: "https://zoom.test/rec/share/secret",
            recording_files: r.files.map((f) => ({
              id: f.id,
              file_type: f.type,
              file_extension: EXT[f.type],
              file_size: f.reportedSize ?? f.body.length,
              download_url: `https://zoom.test/rec/download/${f.id}`,
              recording_start: r.start,
              recording_end: r.start,
              recording_type: f.type === "M4A" ? "audio_only" : "shared_screen_with_speaker_view",
              status: f.status ?? "completed",
            })),
          })),
        });
      }
      return json({ code: 404, message: `no mock for ${url.pathname}` }, 404);
    }
    // ---- Zoom downloads ----
    if (url.host === "zoom.test" && url.pathname.startsWith("/rec/download/")) {
      const id = url.pathname.slice("/rec/download/".length);
      const hit = findFile(id);
      if (!hit) return new Response("not found", { status: 404 });
      const ok = auth === `Bearer ${TOKEN}` || url.searchParams.get("access_token") === TOKEN;
      if (!ok) return new Response("unauthorized", { status: 401 });
      if (hit.file.notFound) return new Response("gone", { status: 404 });
      if (hit.file.rateLimitOnce && !rateLimited.has(id)) {
        rateLimited.add(id);
        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      }
      if (hit.file.redirectToCdn) {
        return new Response(null, { status: 302, headers: { location: `https://cdn.test/blob/${id}` } });
      }
      calls.downloads++;
      return new Response(new Uint8Array(hit.file.body), { status: 200, headers: { "content-length": String(hit.file.body.length), "content-type": "application/octet-stream" } });
    }
    if (url.host === "cdn.test" && url.pathname.startsWith("/blob/")) {
      if (auth) calls.cdnAuthHeaders++;
      const hit = findFile(url.pathname.slice("/blob/".length));
      if (!hit) return new Response("not found", { status: 404 });
      calls.downloads++;
      return new Response(new Uint8Array(hit.file.body), { status: 200, headers: { "content-length": String(hit.file.body.length) } });
    }
    // ---- Anthropic (the scout) ----
    if (url.host === "anthropic.test" && url.pathname === "/v1/messages" && method === "POST") {
      calls.anthropic++;
      // The SDK sends the key as x-api-key or as a bearer token depending on version and environment.
      if (headers.get("x-api-key") !== ANTHROPIC_TEST_KEY && auth !== `Bearer ${ANTHROPIC_TEST_KEY}`) {
        return json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        model: string;
        max_tokens: number;
        system?: Array<{ text: string; cache_control?: unknown }> | string;
        messages: Array<{ role: string; content: string }>;
        output_config?: { effort?: string; format?: unknown };
      };
      const text = String(body.messages?.[0]?.content ?? "");
      anthropicRequests.push({
        model: body.model,
        effort: body.output_config?.effort ?? null,
        hasFormat: !!body.output_config?.format,
        betas: headers.get("anthropic-beta"),
        cachedSystem: Array.isArray(body.system) && !!body.system[0]?.cache_control,
        chars: text.length,
        maxTokens: body.max_tokens,
      });
      const usage = { input_tokens: Math.max(1, Math.round(text.length / 4)), output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      if (anthropicMode === "refusal") {
        return json({ id: "msg_mock_refusal", type: "message", role: "assistant", model: body.model, content: [], stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: "general_harms", explanation: "mock" }, usage });
      }
      // One plausible candidate inside the chunk, plus one with invented timestamps the guardrail must drop.
      const stamps = [...text.matchAll(/^\[(\d{2}):(\d{2}):(\d{2})\] (.*)$/gm)].map((m) => ({ sec: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), line: m[4] }));
      const first = stamps[0]?.sec ?? 0;
      const last = stamps[stamps.length - 1]?.sec ?? first + 60;
      const start = first + 5;
      const end = Math.min(start + 30, Math.max(start + 8, last + 10));
      const hook = (stamps.find((s) => s.sec >= start) ?? stamps[0])?.line.replace(/^[^:]{1,60}: /, "") ?? "A moment worth clipping";
      const candidates = [
        { start_sec: start, end_sec: end, score: 8, hook: hook.slice(0, 120), why: "Mock scout: a crisp, self-contained moment.", platforms: ["tiktok", "reels"] },
        { start_sec: last + 900, end_sec: last + 930, score: 9, hook: "invented", why: "timestamps outside the chunk", platforms: ["shorts"] },
      ];
      return json({ id: `msg_mock_${calls.anthropic}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify({ candidates }) }], stop_reason: "end_turn", stop_sequence: null, usage });
    }
    // ---- Groq ----
    if (url.host === "groq.test" && method === "POST") {
      calls.groq++;
      const form = init?.body instanceof FormData ? init.body : null;
      const file = form?.get("file");
      const filename = file instanceof File ? file.name : null;
      groqRequests.push({ model: (form?.get("model") as string | null) ?? null, filename, hasAuth: !!auth?.startsWith("Bearer ") });
      if (!auth?.startsWith("Bearer ")) return json({ error: { message: "Invalid API Key" } }, 401);
      return json(
        opts.groqPayload?.(filename) ?? {
          task: "transcribe",
          language: "en",
          duration: 3,
          text: "Hello from the mock. Second line here.",
          segments: [
            { id: 0, start: 0, end: 1.5, text: " Hello from the mock." },
            { id: 1, start: 1.5, end: 3, text: " Second line here." },
          ],
          words: [
            { word: "Hello", start: 0, end: 0.4 },
            { word: "from", start: 0.4, end: 0.7 },
            { word: "the", start: 0.7, end: 0.9 },
            { word: "mock.", start: 0.9, end: 1.5 },
            { word: "Second", start: 1.5, end: 2 },
            { word: "line", start: 2, end: 2.4 },
            { word: "here.", start: 2.4, end: 3 },
          ],
        },
      );
    }
    return new Response(`no mock route for ${method} ${url}`, { status: 404 });
  };

  return {
    fetchImpl,
    calls,
    groqRequests,
    anthropicRequests,
    setRecordings(recs) {
      recordings = recs;
    },
    setAnthropicMode(mode) {
      anthropicMode = mode;
    },
  };
}

export const SAMPLE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
Dana Whitfield: Thanks for making the time today.

2
00:00:03.600 --> 00:00:06.000
Ben Strout: Of course. Let's start with the <b>pelican</b> roof tiles.

3
00:00:06.100 --> 00:00:06.100
Dana Whitfield: Perfect.
`;
