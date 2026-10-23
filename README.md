# Strout Vault

A private web app that holds every recorded conversation (Zoom meetings, phone calls, uploaded videos) with transcripts, full-text search, and the people, companies and projects involved. Uploading feels like Loom, browsing like Google Drive, reading a recording like Otter or Grain.

One Node process serves the Express API and the React client. It reads and writes the existing relationship-engine Postgres (Neon) and talks to Cloudflare R2 (new uploads) and Backblaze B2 (archived originals) through the S3 API. Transcription happens elsewhere (the meeting-vault Python service picks up rows from the `jobs` table); this app only enqueues jobs and shows status.

**Phase 1**: library, recording page, search, upload. **Phase 2**: people and companies, projects, the workspace switcher, the review queue, and hand-tagging on the recording page. **Phase 3**: contractor logins (magic links) scoped to one workspace, and tracked phone numbers (Twilio) whose recordings land in the vault.

---

## Deploy on Replit

### 1. Import the repo

Go to <https://replit.com/import/github> and import `bosdesigner/strout-vault`. The repo ships a `.replit` with:

- workspace: `npm run dev` (API + client with hot reload, one process on `PORT`)
- deployment: **Autoscale**, build `npm run build`, run `npm start`

`replit.nix` adds ffmpeg, which only the worker (step 6) uses; the web app needs nothing beyond the `nodejs-20` module.

### 2. Add the Secrets

Open the **Secrets** tab and add each of these (names must match exactly):

| Secret | What it is for |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (the production relationship-engine database). Include `?sslmode=require`. |
| `SESSION_SECRET` | Random string, 32+ characters. Signs the login cookie and the local-driver URLs. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `ADMIN_EMAIL` | The one email address that can log in. |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of your password. Produce it with `npm run hash-password` (in the Replit shell or locally) and paste the whole `$2b$12$…` value. |
| `STORAGE_DRIVER` | `s3` on Replit. (`local` is for development and tests only.) |
| `R2_ACCOUNT_ID` | Cloudflare account id. The endpoint becomes `https://<id>.r2.cloudflarestorage.com`. |
| `R2_ACCESS_KEY_ID` | R2 API token key id (needs object read + write on the bucket). |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret. |
| `R2_BUCKET` | R2 bucket that receives new uploads (`uploads/<yyyy>/<mm>/<uuid>/<filename>`). |
| `B2_KEY_ID` | Backblaze application key id with read access to the archive bucket. |
| `B2_APPLICATION_KEY` | Backblaze application key. |
| `B2_BUCKET` | `anotherstory-meeting-vault` |
| `B2_REGION` | Region in the bucket's S3 endpoint, e.g. `us-west-004` (endpoint becomes `https://s3.<region>.backblazeb2.com`). |
| `PUBLIC_URL` | The deployed origin, e.g. `https://strout-vault.replit.app` (no trailing slash). Used for secure cookies, the links in sign-in emails, Twilio webhook URLs and the R2 CORS rule below. |
| `RESEND_API_KEY` | (Phase 3) Resend API key used to email contractor sign-in links. Without it links are only written to the server log. |
| `MAIL_FROM` | (Phase 3) Sender for those emails, e.g. `Strout Vault <vault@yourdomain.com>` (a domain verified in Resend). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | (Phase 3) Needed to verify Twilio webhook signatures and to fetch call recordings. Webhooks return 503 until both are set. |
| `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | (Phase 4, worker) The Zoom Server-to-Server OAuth app meeting-vault already uses, with its read-only scopes (`recording:read:admin`, `user:read:admin`). Without them the worker skips Zoom. |
| `GROQ_API_KEY`, `GROQ_MONTHLY_BUDGET_USD` | (Phase 4, worker, optional) Groq Whisper for recordings that have no Zoom transcript, about $0.04 per audio hour. Nothing is sent unless **both** are set; the budget is enforced from `spend_ledger`. |

`PORT` is set by Replit itself. Optional tuning variables are listed in [`.env.example`](.env.example).

**R2 bucket CORS.** Browsers upload parts straight to R2, so the bucket needs a CORS rule that allows your origin and exposes `ETag`:

```json
[
  {
    "AllowedOrigins": ["https://strout-vault.replit.app"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

(Cloudflare dashboard → R2 → bucket → Settings → CORS policy.) B2 only needs GET from the app's presigned URLs, which browsers do not preflight.

### 3. Apply the migrations to Neon

`db/migrations/0001_relationship_engine.sql` and `0002_recordings.sql` are the production schema and are already applied to Neon (2026-10-20). Phases 1 and 2 add no migration. **Phase 3 adds `db/migrations/0003_access_and_calls.sql`** (tables `memberships`, `login_tokens`, `tracked_numbers`, `calls`; additive, `if not exists`, safe to re-run). The app never creates, alters or drops anything at startup, so apply it by hand before deploying Phase 3:

```bash
psql "$DATABASE_URL" -f db/migrations/0003_access_and_calls.sql
```

`/healthz` then reports `schema.version` starting with `v0.3`.

### 4. Click Deploy

Replit → **Deploy** → Autoscale. The build runs `npm run build` (esbuild for the server, Vite for the client) and the deployment runs `npm start`.

### 5. Check `/healthz`

Open `https://<your-app>/healthz`. It needs no login and should return:

```json
{"db":"ok","storage":"ok","storageDriver":"s3","schema":{"version":"v0.2 recordings: …","appliedAt":"…","entries":1}}
```

`db` is a `select 1` against Neon, `storage` is a `HeadBucket` on R2, and `schema.version` is the latest row of `schema_log`. Anything other than `ok` returns HTTP 503 with a short reason (never a connection string or key).

Then sign in at `/login` with `ADMIN_EMAIL` and your password.

### 6. Deploy the worker (hourly)

The worker is what used to be `vault run` on the Mac: every hour it asks Zoom for new cloud recordings, streams each file into the archive bucket (B2) with a SHA-256 check, transcribes whatever is waiting (Zoom's own transcript first, Groq only if allowed), processes uploads and phone calls, and writes a report you can read at **Pipeline** in the account menu. It runs once and exits, so it fits a Replit **Scheduled Deployment**. Replit runs one deployment per Repl, so the worker gets a second Repl made from the same repository:

1. Go to <https://replit.com/import/github> again, import `bosdesigner/strout-vault`, and name the Repl `strout-vault-worker`.
2. In its **Secrets** tab add the same secrets as the web app (everything in step 2) plus `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET`. Leave `GROQ_API_KEY` out until you have decided on a monthly budget; the worker still uses Zoom's transcripts without it.
3. Click **Deploy**, choose **Scheduled**, and set:
   - Schedule: every hour (`0 * * * *`)
   - Build command: `npm run build:worker`
   - Run command: `npm run worker`
   - Timeout: 55 minutes (the worker stops starting new work after `WORKER_TIME_BUDGET_SEC`, 50 minutes by default, so runs never overlap; a database lock guarantees it anyway)
4. Run it once from the deployment page and open **Pipeline** in the web app: the run appears with what it found. The first run sweeps the last three months, matches the recordings meeting-vault already archived by Zoom UUID and downloads nothing twice.

Useful from the worker Repl's shell: `npm run worker:dev -- --report` (the pipeline report as JSON), `npm run worker:dev -- --dry-run` (enumerate Zoom, download nothing), `npm run worker:dev -- --steps transcribe`.

---

## Local development

Requirements: Node 20+, and either a local Postgres (`brew install postgresql@16`), Docker, or a Postgres you run yourself (`LOCAL_PG_URL=postgres://…@localhost/postgres`). ffmpeg is not required.

```bash
npm install
npm run db:local     # starts/finds a local Postgres, applies db/migrations, loads db/seed.sql, writes .env
npm run dev          # http://localhost:3000  — login: dev@strout.local / vault-dev-password
```

`db:local` recreates the local `strout_vault` database each time. If the `vector` extension is not installed it says so and swaps `vector(1024)` for `real[]` (the app never touches that column). It also installs three short sample videos that play under the local storage driver.

Local development and the tests never touch Neon, B2 or R2: `DATABASE_URL` from `.env` points at the local server and `STORAGE_DRIVER=local` keeps files under `./.data/storage`.

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | API + Vite client in one process with hot reload |
| `npm run build` / `npm start` | Production build to `dist/`, then serve it |
| `npm run typecheck` | `tsc` for server and client |
| `npm test` | Vitest unit + API tests (seeds `strout_vault_test`) |
| `npm run test:e2e` | Playwright end-to-end tests (seeds `strout_vault_e2e`, runs the app on :3100) |
| `npm run screenshots` | Every page at 1440 px and 390 px into `docs/screenshots/phase-1/` (needs `npm run dev` running); `SCREENSHOT_PHASE=phase-2` / `phase-3` for the later pages (Phase 3 needs the dev server started with `EXPOSE_TEST_MAIL=1`) |
| `npm run db:bench` | 400k generated segments + `EXPLAIN ANALYZE` of the search query into `docs/search-explain-analyze.md` |
| `npm run hash-password` | bcrypt hash for `ADMIN_PASSWORD_HASH` |

---

## How it is put together

```
server/            Express 5 API (TypeScript, ESM)
  config.ts        env parsing (zod); refuses to start with anything missing
  app.ts           createApp(): routes, auth, static client
  auth/            swappable AuthProvider (env admin + bcrypt), signed httpOnly session
                   cookie, CSRF synchroniser token, login rate limit
  storage/         StorageDriver interface; s3 (R2 + B2 clients) and local drivers
  services/        library listing, recording detail, search, upload transaction,
                   video-source selection rules
  routes/          thin route handlers
  worker/          `npm run worker`: Zoom sync (zoom.ts, sync.ts), transcription
                   (vtt.ts, groq.ts, media.ts, transcribe.ts), budgets, report, run lock
  db/schema.ts     hand-written Drizzle schema matching db/migrations exactly
client/            React 18 + Vite + Tailwind + shadcn-style components
shared/            types and text helpers used by both sides
db/migrations/     0001 and 0002 copied unchanged from meeting-vault (source of truth); 0003, 0004 additive
db/seed.sql        realistic fake data for development and tests (generated by scripts/gen-seed.ts)
scripts/           db-local, bench-search, screenshots, hash-password, e2e-server
tests/             unit + API (Vitest), end-to-end (Playwright)
```

**Hard rules the code keeps.** The app never runs DDL (no ORM migrations, no `drizzle-kit push`); it only reads, inserts and updates rows and never deletes rows or storage objects (the `StorageDriver` has no delete method). Every page and every `/api` route requires the session cookie; every state-changing request also needs the `X-CSRF-Token` header. Only `/healthz` is public. No secrets live in the repo.

**Uploads.** The browser hashes each file (SHA-256, in a Web Worker), asks `/api/uploads/check` whether that hash is already in `media`, then uploads straight to storage with presigned multipart URLs (Uppy AwsS3). File bytes never pass through Express with the `s3` driver. On completion `/api/uploads/finish` writes, in one transaction: the `interactions` row (`pipeline_status='queued'`), the `media` row (`role='original'`, `status='verified'`, bytes, sha256, mime type, location), `jobs` rows for `transcribe` and `extract`, and `interaction_participants`. A duplicate SHA-256 is refused with the existing recording's title. Status is refreshed every 10 seconds while anything is in progress.

**Which file plays.** First of: an R2 proxy → any R2 video/audio → the B2 original (presigned GET, 6 hours) → in development only, a `storage='local'` row through the local driver. Production rows with `storage='local'` (a path on the Mac) or `'zoom'` are never playable; the transcript still shows with a quiet "Video not online yet" note.

**Search.** One GIN probe, `segments.tsv @@ websearch_to_tsquery('english', $q)`, grouped per recording, ranked by best `ts_rank`, paginated by group; only the three lines shown per group go through `ts_headline`. Quoted phrases, `OR` and `-exclude` come from `websearch_to_tsquery`. See [`docs/search-explain-analyze.md`](docs/search-explain-analyze.md) for the plans on 400k segments (20–92 ms).

**Review queue.** `/review` lists `review_queue` rows (open first). Approving a `participant_match` runs one transaction: insert `interaction_participants` (with the speaker label), set `segments.speaker_party_id` for every line of that label that is still unassigned, and mark the item approved with `decided_at`. Rejecting only marks it. Keyboard: `a` approve, `r` reject, `j`/`k` move, `o` open the moment in the call.

**People, projects and the switcher.** `/people` and `/p/:id` show role chips per workspace ("Another Story · contractor · Houston (Conroe)") and let you edit contact fields, add roles (roles are never deleted, only marked `former`), link organizations and create people. `/projects` and `/projects/:id` show parties with their roles, linked recordings and facts. The workspace switcher in the top bar scopes the library, search, people, projects and the review queue. On the recording page you can tag a person by hand (optionally naming which speaker label is theirs) and link projects.

**Contractor logins (Phase 3).** `AuthProvider` has two implementations behind a composite: the env admin (password) and `MembershipAuthProvider` (magic links). A row in `memberships` (created from **Access & numbers** in the account menu, or `POST /api/memberships`) scopes a login to one workspace and to the contractor's own `parties` row. Requesting a link always answers the same way; the token is 32 random bytes, stored only as a SHA-256 hash in `login_tokens`, single-use, and expires after `MAGIC_LINK_TTL_MIN` (20) minutes. A contractor's session carries `workspaceId` and `partyId`; every list and detail query is filtered by `visibleInteractionsSql()`: interactions in their workspace where they are an `interaction_participants` row **or** `media.uploaded_by` is them. Everything that changes data except uploading is owner-only (403); hidden recordings are 404, never 403. Their uploads are forced into their workspace and tagged with them.

**Tracked numbers (Phase 3, Twilio).** Buy a number in the Twilio console (the app never buys anything), set its voice webhook to `POST <PUBLIC_URL>/webhooks/twilio/voice`, and record it under Access & numbers with the contractor it belongs to and the phone to forward to. On a call the app verifies `X-Twilio-Signature` (HMAC-SHA1 of the URL built from `PUBLIC_URL` plus the sorted form fields), writes a `calls` row (matching the caller id against `parties.phones`), and answers with TwiML: the recording notice, then `<Dial record="record-from-answer-dual">` to the contractor. When Twilio posts the finished recording, the app fetches it once (HTTP basic auth with the account SID and token), writes it to storage under `calls/<yyyy>/<mm>/<CallSid>.mp3`, and in one transaction creates the `interactions` row (`source='contractor_call'`, `pipeline_status='queued'`), the `media` row, `transcribe` + `extract` jobs and the participants (the contractor, plus the caller when matched). Repeated callbacks are no-ops; a failed fetch is recorded on the call and answered with 500 so Twilio retries.

**The worker (Phase 4).** `server/worker/index.ts` runs one pass and exits. It takes a Postgres advisory lock so two runs never overlap, records a `worker_runs` row, then: (1) **Zoom sync**, ported from meeting-vault's `zoom.py`/`download.py`: a Server-to-Server OAuth token, every user's recordings month by month from the cursor minus `ZOOM_SYNC_OVERLAP_MONTHS` (3) to today, de-duplicated by meeting UUID (`interactions.source_ref`) and file id (`media.source_file_id`); each archive-worthy file (video, audio, transcript, captions, chat; never timeline/summary metadata) is streamed from Zoom into the archive bucket while being hashed, then its byte count is checked against Zoom's report (`verified`, or `verified_stable` when two downloads agree with each other but not with Zoom's number). Downloads go newest-meeting-first and small-files-first, and stop at the run's time or byte budget, leaving the rest `pending` for the next hour. (2) **Transcription** for every recording with a verified original and no transcript: Zoom's TRANSCRIPT file, then its CC file, then Groq Whisper (16 kHz mono Opus, split into 15-minute chunks, word timestamps kept), each written in one transaction (`transcripts`, `segments`, `interactions.transcript`, `pipeline_status='ready'`, the `transcribe` job). A recording whose transcription would push the month over `GROQ_MONTHLY_BUDGET_USD` stays `queued` with the reason shown on the Pipeline page. Failures are retried automatically up to three times, then wait for **Retry**. (3) **Report**: queue counts, pending downloads, recordings without an off-site copy, month-to-date spend. `GET /api/pipeline` and `/pipeline` (owner only) show the last runs and the lists; `POST /api/pipeline/retry` only updates statuses and counters.

## Phase status

- [x] Phase 1 — library, recording page, search, upload ([verification](docs/phase-1-verification.md), [screenshots](docs/screenshots/phase-1/))
- [x] Phase 2 — people, companies, projects, review queue ([verification](docs/phase-2-verification.md), [screenshots](docs/screenshots/phase-2/))
- [x] Phase 3 — contractor access and call capture ([verification](docs/phase-3-verification.md), [screenshots](docs/screenshots/phase-3/)); migration `0003` must be applied first
- [x] Phase 4 — the worker: Zoom sync, transcription, upload queue, Pipeline page ([verification](docs/phase-4-verification.md), [screenshots](docs/screenshots/phase-4/)); migration `0004` must be applied first, then deploy the worker (step 6 above)
