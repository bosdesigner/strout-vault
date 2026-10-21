# Strout Vault

A private web app that holds every recorded conversation (Zoom meetings, phone calls, uploaded videos) with transcripts, full-text search, and the people, companies and projects involved. Uploading feels like Loom, browsing like Google Drive, reading a recording like Otter or Grain.

One Node process serves the Express API and the React client. It reads and writes the existing relationship-engine Postgres (Neon) and talks to Cloudflare R2 (new uploads) and Backblaze B2 (archived originals) through the S3 API. Transcription happens elsewhere (the meeting-vault Python service picks up rows from the `jobs` table); this app only enqueues jobs and shows status.

**Phase 1** (this release): library, recording page, search, upload.
Phase 2 adds people/companies/projects and the review queue; Phase 3 adds contractor logins and call capture.

---

## Deploy on Replit

### 1. Import the repo

Go to <https://replit.com/import/github> and import `bosdesigner/strout-vault`. The repo ships a `.replit` with:

- workspace: `npm run dev` (API + client with hot reload, one process on `PORT`)
- deployment: **Autoscale**, build `npm run build`, run `npm start`

No `replit.nix` is needed; the `nodejs-20` module is enough.

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
| `PUBLIC_URL` | The deployed origin, e.g. `https://strout-vault.replit.app` (no trailing slash). Used for secure cookies and the R2 CORS rule below. |

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

`db/migrations/0001_relationship_engine.sql` and `0002_recordings.sql` are the production schema and are already applied to Neon (2026-10-20). Phase 1 adds **no new migration**. The app never creates, alters or drops anything at startup; any future change arrives only as a new numbered file `db/migrations/0003_<name>.sql`, listed in its pull request for you to apply by hand:

```bash
psql "$DATABASE_URL" -f db/migrations/0003_<name>.sql
```

### 4. Click Deploy

Replit → **Deploy** → Autoscale. The build runs `npm run build` (esbuild for the server, Vite for the client) and the deployment runs `npm start`.

### 5. Check `/healthz`

Open `https://<your-app>/healthz`. It needs no login and should return:

```json
{"db":"ok","storage":"ok","storageDriver":"s3","schema":{"version":"v0.2 recordings: …","appliedAt":"…","entries":1}}
```

`db` is a `select 1` against Neon, `storage` is a `HeadBucket` on R2, and `schema.version` is the latest row of `schema_log`. Anything other than `ok` returns HTTP 503 with a short reason (never a connection string or key).

Then sign in at `/login` with `ADMIN_EMAIL` and your password.

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
| `npm run screenshots` | Every page at 1440 px and 390 px into `docs/screenshots/phase-1/` (needs `npm run dev` running) |
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
  db/schema.ts     hand-written Drizzle schema matching db/migrations exactly
client/            React 18 + Vite + Tailwind + shadcn-style components
shared/            types and text helpers used by both sides
db/migrations/     0001 and 0002 copied unchanged from meeting-vault (source of truth)
db/seed.sql        realistic fake data for development and tests (generated by scripts/gen-seed.ts)
scripts/           db-local, bench-search, screenshots, hash-password, e2e-server
tests/             unit + API (Vitest), end-to-end (Playwright)
```

**Hard rules the code keeps.** The app never runs DDL (no ORM migrations, no `drizzle-kit push`); it only reads, inserts and updates rows and never deletes rows or storage objects (the `StorageDriver` has no delete method). Every page and every `/api` route requires the session cookie; every state-changing request also needs the `X-CSRF-Token` header. Only `/healthz` is public. No secrets live in the repo.

**Uploads.** The browser hashes each file (SHA-256, in a Web Worker), asks `/api/uploads/check` whether that hash is already in `media`, then uploads straight to storage with presigned multipart URLs (Uppy AwsS3). File bytes never pass through Express with the `s3` driver. On completion `/api/uploads/finish` writes, in one transaction: the `interactions` row (`pipeline_status='queued'`), the `media` row (`role='original'`, `status='verified'`, bytes, sha256, mime type, location), `jobs` rows for `transcribe` and `extract`, and `interaction_participants`. A duplicate SHA-256 is refused with the existing recording's title. Status is refreshed every 10 seconds while anything is in progress.

**Which file plays.** First of: an R2 proxy → any R2 video/audio → the B2 original (presigned GET, 6 hours) → in development only, a `storage='local'` row through the local driver. Production rows with `storage='local'` (a path on the Mac) or `'zoom'` are never playable; the transcript still shows with a quiet "Video not online yet" note.

**Search.** One GIN probe, `segments.tsv @@ websearch_to_tsquery('english', $q)`, grouped per recording, ranked by best `ts_rank`, paginated by group; only the three lines shown per group go through `ts_headline`. Quoted phrases, `OR` and `-exclude` come from `websearch_to_tsquery`. See [`docs/search-explain-analyze.md`](docs/search-explain-analyze.md) for the plans on 400k segments (20–92 ms).

**Auth is swappable.** `AuthProvider.verifyPassword()` is the only thing that knows about the env admin; sessions carry `sub`, `role`, and (for Phase 3) `workspaceId` / `partyId`.

## Phase status

- [x] Phase 1 — library, recording page, search, upload ([verification](docs/phase-1-verification.md), [screenshots](docs/screenshots/phase-1/))
- [ ] Phase 2 — people, companies, projects, review queue
- [ ] Phase 3 — contractor access and call capture
