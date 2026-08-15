# HackerRank Scraper Service

Standalone Node.js HTTP service that authenticates with HackerRank (via a one-time Puppeteer login), then uses plain HTTP calls to fetch contest challenges and user progress, writing results directly to Supabase.

## Architecture

```
LMS (Next.js)
  │
  ├─ POST /api/scrape/challenges → POST /scrape/challenges  ─→ Supabase questions table
  │
  └─ POST /api/scrape/trigger   → POST /scrape/progress    ─→ Supabase progress table
                                     └─ returns { jobId }
         LMS polls: GET /api/scrape/status?jobId=...
                  → GET /scrape/status/:jobId
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/scrape/challenges` | Scrape & store all questions for a contest |
| `POST` | `/scrape/progress` | Async: scrape user completions (returns jobId) |
| `GET` | `/scrape/status/:jobId` | Poll async job progress |

All endpoints (except `/health`) require the `x-api-key` header.

## Local Development

```bash
cp .env.example .env
# Fill in your values in .env

npm install
npm run dev
```

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3001) |
| `HACKERRANK_EMAIL` | HackerRank admin account email |
| `HACKERRANK_PASSWORD` | HackerRank admin account password |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS) |
| `API_KEY` | Shared secret for the `x-api-key` header |

## Railway Deployment

1. Create a new Railway project and connect this repo
2. Set **Root Directory** to `scraper-service`
3. Add all environment variables from the table above
4. Railway will auto-build using the `Dockerfile`
5. Copy the Railway public URL and set it as `RAILWAY_SCRAPER_URL` in the LMS `.env.local`

## How It Works

1. **Login once**: Puppeteer opens a headless Chromium, logs in to HackerRank, extracts session cookies, then closes the browser immediately.
2. **All API calls via axios**: The extracted cookies are used for all subsequent HTTP requests — no browser overhead.
3. **3-tier fallback**: For each user, tries leaderboard (bulk) → per-user API → per-challenge last resort.
4. **Concurrent batches**: 5 users processed in parallel to balance speed vs rate-limiting.
5. **Direct DB writes**: Results are written straight to Supabase using the service role key.
