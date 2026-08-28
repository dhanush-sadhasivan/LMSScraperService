# Project Architecture & Codebase Guide: FACEPrep LMS & HackerRank Scraper

> **Single Source of Truth for the Entire Codebase**  
> *Note for AI Models & Developers*: Always review this document before making code changes. Whenever any file, API route, database schema, or service configuration is modified, this document **must** be updated accordingly.

---

## 1. System Overview & Architecture

This repository is a unified multi-service platform designed for technical training, contest tracking, and coding performance analytics (HackerRank and LeetCode). It comprises two primary production services alongside database infrastructure:

1. **`lms/`**: A modern full-stack web application built with **Next.js 16 (App Router)**, **React 19**, **TypeScript**, **Supabase (Auth, PostgreSQL, Storage CDN)**, and **SWR**. Provides dashboards, internal training trackers, contest analytics, roadmap management, reports, and administrative tools.
2. **`scraper-service/`**: A standalone **Node.js / Express** background microservice deployed on **Railway**. It uses **Puppeteer** for session authentication and **Axios** for high-throughput, rate-limit-conscious scraping of HackerRank contest questions and user completions. It writes results directly to Supabase and generates pre-calculated CDN cache snapshots.
3. **`archive/`**: Historical and legacy scraper prototypes kept for reference.

### High-Level Architecture Diagram

```
                              ┌───────────────────────────────────┐
                              │           HackerRank              │
                              │  (Contests, Challenges, Progress) │
                              └─────────────────┬─────────────────┘
                                                │
                                       HTTPS (Cookies / API)
                                                │
                                                ▼
┌─────────────────────────┐          ┌───────────────────────┐
│     End Users / UI      │          │   scraper-service     │
│ (Students/Trainers/     │          │  (Node.js + Express)  │
│      Admins)            │          │  Puppeteer Auth Pool  │
└───────────┬─────────────┘          │  3-Tier Progress Sync │
            │                        └──────────┬────────────┘
         Browser                                │
      HTTPS / SWR                               │ Direct Service Role
            │                                   │ DB Writes & Snapshots
            ▼                                   ▼
┌─────────────────────────┐          ┌───────────────────────────┐
│        LMS App          │◄─────────┤   Supabase Cloud / CDN    │
│  (Next.js 16 App Router)│          │  - PostgreSQL Database    │
│  - Dashboard & Roadmaps │          │  - Storage Bucket         │
│  - Internal Training    │          │    ('api-cache' CDN)      │
│  - LeetCode Sync Engine │          │  - pg_cron Auto-Scheduler │
│  - Report Generator     │          │  - Auth & Row-Level Sec   │
└─────────────────────────┘          └───────────────────────────┘
            │                                     ▲
            └─────────────────────────────────────┘
                 SWR + Next.js fetch cache (60s SWR)
```

---

## 2. Directory Structure

```
lucid-pascal/
├── AGENTS.md                   # Workspace agent instructions & sync rules
├── GEMINI.md                   # Gemini workspace rules
├── CODEBASE.md                 # THIS FILE - comprehensive codebase documentation
├── .agent/
│   └── rules/
│       └── maintain-codebase-doc.md  # Continuous documentation sync rule
│
├── lms/                        # Main LMS Application (Next.js 16 App Router)
│   ├── app/                    # Next.js App Router root
│   │   ├── (dashboard)/        # Authenticated dashboard layout & pages
│   │   │   ├── admin/          # Admin-only portals (users, helpdesk, roadmaps)
│   │   │   ├── contests/       # Contest listings, details, auto-scrape config
│   │   │   ├── courses/        # Course catalog & assignment views
│   │   │   ├── dashboard/      # Main KPI dashboard (leaderboard, stats)
│   │   │   ├── groups/         # Batch & cohort management
│   │   │   ├── internal-training/ # IT Day plans, calendars, question checks
│   │   │   ├── notifications/  # User notifications & broadcast announcements
│   │   │   ├── profile/        # User profile & handle configurations
│   │   │   ├── reports/        # Analytics export (Excel/CSV) & summaries
│   │   │   ├── roadmaps/       # Topic-based learning paths
│   │   │   └── skills/         # Skills & LeetCode profile tracker
│   │   ├── api/                # Backend API routes (REST endpoints)
│   │   │   ├── access-requests/# Contest access requests
│   │   │   ├── admin/          # Admin operations (users, roadmaps, questions)
│   │   │   ├── cache/          # CDN cache revalidation & trigger endpoints
│   │   │   ├── contests/       # Contest CRUD & detail retrieval
│   │   │   ├── groups/         # Group CRUD and membership
│   │   │   ├── internal-training/ # IT attendance, question clicks, day plans
│   │   │   ├── leetcode/       # LeetCode public GraphQL sync & lookup
│   │   │   ├── notifications/  # Notification read/unread & announcements
│   │   │   ├── questions/      # Question metadata management
│   │   │   ├── reports/        # Dynamic report queries
│   │   │   ├── scrape/         # Scraper triggers, status proxies, auto-cron
│   │   │   ├── trainer/        # Trainer courses, todos, roadmaps, IT check
│   │   │   └── users/          # User management, bulk import, validation
│   │   ├── login/              # Login screen & password reset flow
│   │   ├── globals.css         # Global styling & CSS custom properties
│   │   ├── layout.tsx          # Root HTML layout with providers
│   │   └── page.tsx            # Root redirect (to /dashboard)
│   ├── components/             # Reusable UI components
│   │   ├── GlobalFloatingTodo.tsx  # Floating sticky note todo widget
│   │   ├── GlobalSupportModal.tsx # Global helpdesk support ticket modal
│   │   ├── ITAttendanceModal.tsx  # Internal training attendance modal
│   │   ├── NotificationBell.tsx   # Realtime notification center trigger
│   │   ├── PresenceProvider.tsx   # Realtime user online presence
│   │   ├── SessionManager.tsx     # Session activity watcher
│   │   ├── Sidebar.tsx            # Collapsible role-based navigation sidebar
│   │   ├── ThemeProvider.tsx      # Dark / light theme provider
│   │   ├── Toast.tsx              # Application toast alerts
│   │   └── TopBar.tsx             # Header bar with user profile & controls
│   ├── lib/                    # Shared libraries, utilities, and services
│   │   ├── cdn-cache.ts        # Supabase Storage CDN caching & revalidation
│   │   ├── contest-analytics.ts# RPC data mappers for contest statistics
│   │   ├── email.ts            # Resend email notification service
│   │   ├── it-calendar.ts      # Working days, holidays, & calendar calculator
│   │   ├── it-day-counter.ts   # IT attendance & active day counting
│   │   ├── leetcode.ts         # LeetCode GraphQL client, problem list & profile parser
│   │   ├── leetcode-sync.ts    # Reusable contest solve syncer for LeetCode participants
│   │   ├── roadmap-analytics.ts# Topic & milestone completion calculator
│   │   ├── supabase/           # Supabase client singletons:
│   │   │   ├── client.ts       # Browser client (@supabase/ssr)
│   │   │   ├── server.ts       # Server-side client with request cookies
│   │   │   ├── admin.ts        # Service role client (bypasses RLS)
│   │   │   └── middleware.ts   # Session refresh & route protection
│   │   ├── swr-hooks.ts        # SWR data fetching hooks
│   │   ├── types.ts            # TypeScript definitions for the entire app
│   │   └── utils.ts            # Formatting & general helper functions
│   ├── supabase/               # Database migrations and baseline schema
│   │   ├── schema.sql          # Primary database DDL & RLS policies
│   │   └── migrations/         # Incremental SQL migration scripts
│   ├── middleware.ts           # Next.js edge route protection middleware
│   └── package.json            # Dependencies: Next.js 16, React 19, Supabase
│
├── scraper-service/            # HackerRank Scraper Microservice (Node.js/Express)
│   ├── src/
│   │   ├── auth.js             # Puppeteer login & cookie pool manager
│   │   ├── cdnPublisher.js     # Uploads JSON snapshots to Supabase Storage
│   │   ├── challengesScraper.js# Fetches contest questions & details
│   │   ├── hackerrank.js       # Axios HTTP client for HackerRank API calls
│   │   ├── jobStore.js         # In-memory job progress tracking store
│   │   ├── progressScraper.js  # 3-tier fallback progress scraping engine
│   │   ├── supabaseClient.js   # Supabase client with service role key
│   │   └── routes/             # Express API routes
│   │       ├── challenges.js   # POST /scrape/challenges
│   │       ├── progress.js     # POST /scrape/progress
│   │       └── status.js       # GET /scrape/status/:jobId
│   ├── Dockerfile              # Docker container setup for Railway deployment
│   ├── server.js               # Express server entry point & auth guard
│   └── package.json            # Dependencies: Express, Puppeteer, Axios
│
└── archive/                    # Deprecated / Archived code
    └── railway-scraper/        # Early prototype scripts
```

---

## 3. LMS Application Details (`lms/`)

### 3.1 Tech Stack & Libraries
- **Framework**: Next.js 16.3.0 (App Router), React 19.2.8, TypeScript 5.
- **Data & State**: SWR 2.5.1 (stale-while-revalidate client-side data fetching).
- **Backend / Database**: Supabase (`@supabase/ssr` 0.12.4, `@supabase/supabase-js` 2.112.3).
- **Files & Data Processing**: `papaparse` (CSV import/export), `xlsx` (Excel report generation).
- **Transactional Email**: `resend` (access request approvals, system notifications).
- **Styling**: Modular CSS files paired with components/pages (`*.css`), global variables in `globals.css`.

### 3.2 Authentication & Authorization Model
- **User Roles (`UserRole`)**:
  - `admin`: Full administrative access (user management, global configs, bulk import, roadmaps, contest scraping).
  - `manager`: Management access (group management, contest management, scraper triggers, access requests).
  - `trainer`: Standard learner/trainer role (participating in contests, internal training tracker, solving challenges, viewing personal roadmaps).
- **Route Guarding**:
  - `middleware.ts` runs on all requests (except static assets and `_next`), checking Supabase session validity. Unauthenticated requests are redirected to `/login`.
  - In `app/(dashboard)/layout.tsx`, the user's role is queried from `public.users` and passed down to `DashboardLayoutClient`.
  - Forced Password Reset: Users with `must_change_password: true` in `user_metadata` are forced to change their password via a blocking modal on first login.
- **Supabase Clients in `lib/supabase/`**:
  - `client.ts`: Uses `createBrowserClient` for browser-side React components.
  - `server.ts`: Uses `createServerClient` reading cookies for Server Components and Server Actions.
  - `admin.ts`: Uses `createClient` with `SUPABASE_SERVICE_ROLE_KEY`. **Must only be used in secure API routes on the server** to bypass Row-Level Security (RLS) for admin operations and batch syncs.

### 3.3 Core Feature Modules

#### A. Dashboard (`/dashboard`)
- Displays overall cohort statistics: total participants, total challenges solved, average scores.
- Renders the Global Leaderboard with performance filters (by group, team, or contest).
- Powered by Supabase Storage Smart CDN caching (`getCachedGlobalLeaderboard()`) for instant loading without running heavy aggregate SQL queries on every page hit.

#### B. Internal Training (`/internal-training`)
- Purpose: Tracks daily guided training programs for new trainees/trainers.
- **Calendar & Working Days Calculation (`lib/it-calendar.ts`)**:
  - Supports custom working day configurations (e.g., Monday through Friday).
  - Automatically calculates target calendar dates for Day 1, Day 2, etc., skipping weekends and excluded days.
  - Handles day extension requests (`ITTrainerProgress.extended_days`).
- **Question Verification & Completion**:
  - Distinguishes between HackerRank problems and custom problem links.
  - Trainees click to launch the problem (logged in `it_question_completions.clicked_at`).
  - Completions are marked either automatically via scraper results (`hr_solved`) or manually by trainers (`is_completed`).
- **Overview Table for Managers (`/api/internal-training/trainer-overview`)**:
  - Summarizes each trainee's current day, total days, completed questions, pending questions, attendance count (`it_days_count`), and online status.

#### C. Contests (`/contests`)
- Lists active, upcoming, and past HackerRank contests.
- Allows admins/managers to:
  - Add new contests using a HackerRank contest slug.
  - Scrape and populate contest challenges (`/api/scrape/challenges`).
  - Manually trigger progress scrape for a contest (`/api/scrape/trigger`).
  - Configure automated scraping via `AutoScrapeScheduler` and `AutoScrapeConfigModal`.
  - Tag and organize contest questions into topics via `ManageTopicsModal`.

#### D. Topic Roadmaps (`/roadmaps` & `/admin/roadmaps`)
- Structured learning paths containing ordered topics, milestones, resources, and practice questions.
- Can be directly linked to a HackerRank contest (`contest_id`).
- Admins can create and edit roadmaps; trainees can mark topics complete and track overall progress.

#### E. Skills & LeetCode Integration (`/skills` & `/api/leetcode/*`)
- Allows users to link their LeetCode username or profile URL (`parseLeetcodeUsername`).
- `/api/leetcode/sync`: Queries LeetCode's public GraphQL API (`https://leetcode.com/graphql`) to fetch:
  - Total solved count, broken down by difficulty (Easy, Medium, Hard).
  - Global ranking and contest rating.
  - Submission calendar heatmap.
  - Stores data in `leetcode_user_stats`.
- `/api/leetcode/problem-lookup`: Validates individual LeetCode problems and fetches metadata (difficulty, acceptance rate, tags).

#### F. Reports & Analytics (`/reports`)
- Comprehensive export module for managers and admins.
- Exports contest performance, participant rankings, submission status, and attendance data into formatted Excel (`.xlsx`) or CSV (`.csv`) files using `xlsx` and `papaparse`.

#### G. Notification & Announcements System (`/notifications`)
- Realtime bell indicator (`NotificationBell.tsx`) displaying unread notifications.
- Supports types: `access_request`, `contest_assigned`, `access_approved`, `access_denied`, `system`, and `announcement`.
- Admin broadcast feature to send announcements to all users or specific groups.

### 3.4 Smart CDN Caching System (`lib/cdn-cache.ts`)
To maintain high responsiveness under heavy traffic, the LMS avoids running expensive aggregation queries on every dashboard load:
- Pre-aggregated JSON files (`leaderboard.json` and `contest-{contestId}.json`) are uploaded directly to the Supabase Storage bucket `api-cache`.
- Frontend reads from the public CDN URL using Next.js `fetch` with `revalidate: 60` (stale-while-revalidate).
- **Self-Healing Fallback**: If a CDN file returns 404, `getCachedGlobalLeaderboard()` triggers a background generation (`generateAndUploadCdnSnapshots()`) using stored RPC functions.
- `/api/cache/refresh`: Admin endpoint to force snapshot generation on demand.

### 3.5 Automated Scraper Scheduler (`app/api/scrape/auto-cron/*`)
- Triggered on a recurring schedule (every 30 minutes) via Supabase `pg_cron` or external scheduler.
- **Enforcement Rules**:
  - Restricts execution to working hours: **10:00 to 18:00 IST**.
  - Checks allowed weekdays configured in `auto_scrape_config` (e.g., Monday through Friday).
  - Sequentially triggers contests with a 5-second buffer to prevent CPU/network spikes.
  - Includes concurrent lock guards (`is_running`) to prevent overlapping scraper jobs.

---

## 4. Scraper Service Details (`scraper-service/`)

### 4.1 Purpose & Standalone Deployment
The scraper service is an isolated Express.js service containerized with Docker and deployed on Railway. It handles the heavy lifting of logging into HackerRank, interacting with HackerRank's private API endpoints, and syncing data back to Supabase.

### 4.2 API Endpoints
All endpoints (except `/health`) require the `x-api-key` header matching the `API_KEY` environment variable.

| Method | Route | Description |
|---|---|---|
| `GET` | `/health` | Healthcheck returning `{ status: 'ok', ts: ... }` |
| `POST` | `/scrape/challenges` | Synchronously fetches contest challenges and writes to Supabase `questions` |
| `POST` | `/scrape/progress` | Asynchronously starts a user progress scrape job; returns `{ jobId }` |
| `GET` | `/scrape/status/:jobId` | Polls the status, percent completion, and logs of an active or finished job |

### 4.3 Multi-Credential Account Pool (`src/auth.js`)
To avoid HackerRank rate limits and account locks when scraping contests with dozens or hundreds of trainees:
- The service supports multiple HackerRank admin credentials (`HACKERRANK_EMAIL_1`, `HACKERRANK_PASSWORD_1`, `HACKERRANK_EMAIL_2`, etc.).
- Puppeteer launches headless Chromium, enters credentials, solves basic session requirements, captures session cookies (`_hr_session`), and closes the browser immediately.
- The pool partitions the user list among the active credentials, multiplying overall throughput while staying within HackerRank thresholds.

### 4.4 3-Tier Fallback Scraping Strategy (`src/progressScraper.js`)
For each contest user, the scraper applies a 3-tier resolution strategy:
1. **Tier 1: Contest Leaderboard API (Bulk)**: Fast fetch of the contest's full leaderboard. If the user appears with complete challenge breakdown, progress is parsed in bulk.
2. **Tier 2: User Contest Submissions API**: If leaderboard data is incomplete or truncated, queries the specific user's contest submission history endpoint.
3. **Tier 3: Per-Challenge Last Resort**: If specific submissions are missing, checks individual challenge submission records.
- Concurrency: Processes batches of 5 users concurrently per credential.
- Direct Writes: Inserts/upserts records directly into `public.progress` in Supabase using the service role client.
- Post-Job CDN Snapshot: Upon completion, immediately invokes `cdnPublisher.js` to upload fresh `leaderboard.json` and `contest-{id}.json` to Supabase Storage.

---

## 5. Database Schema & Data Models

### 5.1 Core Tables (`supabase/schema.sql`)
- **`users`**: Extends `auth.users`. Contains `emp_id`, `full_name`, `email`, `emp_email`, `team`, `manager`, `hackerrank_id`, `leetcode_id`, `role` (`admin` | `manager` | `trainer`).
- **`groups`**: Cohort / batch groupings created by managers or admins.
- **`group_members`**: Join table mapping `group_id` to `user_id`.
- **`contests`**: Contest records with `title`, `hackerrank_slug`, `start_date`, `end_date`, `last_scraped_at`.
- **`contest_assignments`**: Assigns contests to entire groups or specific teams.
- **`questions`**: Problems belonging to a contest. Columns include `slug`, `title`, `domain`, `hackerrank_url`, `max_score`, `difficulty`, `order_index`, `is_enabled`.
- **`progress`**: Stores trainee problem performance. Columns include `contest_id`, `user_id`, `question_id`, `status` (`solved` | `attempted` | `unattempted`), `score`, `max_score`, `last_submission_at`.
- **`access_requests`**: Trainee requests to access specific contests (`pending` | `approved` | `denied`).
- **`notifications`**: User alert notifications with read/unread tracking.

### 5.2 Extended & Module Tables (`supabase/migrations/*`)
- **`roadmaps` & `user_roadmap_progress`**: Hierarchical topic roadmaps, milestones, and trainee completion tracking (`02_trainer_flow.sql`, `03_contest_roadmaps.sql`).
- **`courses` & `course_assignments`**: Multi-week curriculum with weekly syllabi.
- **`trainer_todos`**: Personal trainer task checklist (`GlobalFloatingTodo.tsx`).
- **`it_roadmap_configs`**: Working days and extension defaults for internal training (`04_internal_training.sql`).
- **`it_day_plans` & `it_day_questions`**: Daily training curriculum and associated problems.
- **`it_trainer_progress` & `it_question_completions`**: Trainee day tracking, link click timestamps, and problem completions.
- **`leetcode_user_stats`**: Cached LeetCode profile stats, difficulty breakdowns, contest ratings, and submission calendars (`04_leetcode_support.sql`).
- **`auto_scrape_config` & `auto_scrape_schedules`**: Auto-scrape timing, allowed days, and contest schedules (`20260824_auto_scrape_scheduler.sql`).

### 5.3 Stored Procedures & Database Functions (RPCs)
- **`get_global_leaderboard()`**: Aggregates top performers across all contests for the dashboard.
- **`get_contest_analytics(contest_uuid)`**: Returns score distributions, problem completion percentages, and student averages.
- **`get_contest_leaderboard_rpc(contest_uuid)`**: Fast indexed retrieval of contest leaderboards.

---

## 6. Environment Variables Configuration

### LMS (`lms/.env.local`)
| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous API key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret (server-only, bypasses RLS) |
| `RAILWAY_SCRAPER_URL` | Base URL of the deployed scraper service (e.g. `https://scraper.up.railway.app` or `http://localhost:3001`) |
| `RAILWAY_API_KEY` | Shared secret key sent in `x-api-key` header to authenticate scraper calls |
| `SCRAPER_INGEST_API_KEY` | Secret key for scraper to push ingest payloads to LMS |
| `RESEND_API_KEY` | Resend API key for automated transactional emails |
| `RESEND_FROM_EMAIL` | Sender email address (e.g. `noreply@faceprep.ed`) |

### Scraper Service (`scraper-service/.env`)
| Variable | Description |
|---|---|
| `PORT` | Local service port (default `3001`) |
| `API_KEY` | Shared secret for incoming `x-api-key` header |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key for direct PostgreSQL writes |
| `HACKERRANK_EMAIL_1` | HackerRank account 1 username/email |
| `HACKERRANK_PASSWORD_1` | HackerRank account 1 password |
| `HACKERRANK_EMAIL_2` | (Optional) HackerRank account 2 for credential pooling |
| `HACKERRANK_PASSWORD_2` | (Optional) HackerRank account 2 password |

---

## 7. Development & Deployment Workflows

### 7.1 Local Development

#### Running LMS:
```bash
cd lms
npm install
npm run dev
# App will run on http://localhost:3000
```

#### Running Scraper Service:
```bash
cd scraper-service
npm install
npm run dev
# Service will run on http://localhost:3001
```

### 7.2 Railway Deployment (`scraper-service`)
1. In Railway, configure root directory as `scraper-service`.
2. Ensure Dockerfile build is selected.
3. Configure all environment variables in Railway dashboard (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_KEY`, `HACKERRANK_EMAIL_*`, `HACKERRANK_PASSWORD_*`).
4. Set `RAILWAY_SCRAPER_URL` and `RAILWAY_API_KEY` in the LMS production environment to match the Railway deployment.

### 7.3 Vercel Deployment (`lms`)
1. In Vercel, set root directory to `lms`.
2. Framework preset: **Next.js**.
3. Supply all environment variables specified in Section 6.

---

## 8. Living Changelog & Project Updates

| Date | Author / Agent | Summary of Changes |
|---|---|---|
| 2026-08-28 | Antigravity Agent | **Fix Scrape Data Accuracy — Slug Normalization, Coverage Check, Smart Skip**: Fixed three compounding bugs causing the LMS leaderboard to display fewer solved questions than HackerRank. (1) **Slug Mismatch**: HackerRank's `/rest/compare` API and `/rest/challenges` API sometimes return slightly different slug formats (e.g. `"arrays-ds"` vs `"arrayds"`). Now `fetchUserComparison` stores results under both lowercase and alphanum-normalized keys, and all lookup functions use multi-format matching. (2) **Incomplete Compare Coverage**: The compare API only returns challenges where either the ref user or target user participated — if the logged-in scraper account hasn't attempted all problems, missing questions were silently marked `unattempted`. Added `_countCoverage` check: if coverage < total questions, automatically supplements with `fetchUserChallenges` for missing questions via new `_buildDenseRowsFromCompareWithSupplement`. (3) **Smart Skip False Positive**: The skip fired when leaderboard total score matched DB total, even when the per-challenge distribution changed. Now also compares DB solved count vs leaderboard per-challenge solved count. Files: `scraper-service/src/hackerrank.js`, `scraper-service/src/progressScraper.js`. |
| 2026-08-28 | Antigravity Agent | **Fix Scraper ReferenceError & React #418 Hydration Mismatch**: Fixed runtime `ReferenceError: attempted is not defined` in `scraper-service/src/hackerrank.js`. Resolved React Error #418 (hydration text content mismatch) in `lms/app/(dashboard)/contests/[id]/page.tsx` and `LeaderboardTable.tsx` by setting fixed `timeZone: 'Asia/Kolkata'` and `mounted` guard. |
| 2026-08-27 | Antigravity Agent | **Strict Contest Participant Assignment Enforcement & CDN Cache Sanitize**: Fixed issue where unassigned users and administrators appeared under contest leaderboards, participant counters, and reports. Enforced strict active assignment filtering in `contests/[id]/page.tsx` across both CDN cache and fallback DB branches by cross-referencing against `contest_assignments` and excluding `role === 'admin'`. Updated `cdnPublisher.js` and `cdn-cache.ts` to exclude admins from team/group queries. Added automatic orphaned `progress` cleanup, immediate CDN snapshot regeneration, and cache revalidation in `PATCH /api/contests/[id]` when contest assignments change. Restricted `api/leetcode/sync/route.ts` to only sync contests assigned to the target user, eliminated all-user fallback in `leetcode-sync.ts`, removed unassigned progress fallback in `api/reports/route.ts`, and prevented unassigned roadmaps from injecting contests into trainer dashboards. Executed automated database cleanup purging legacy unassigned progress rows and republished clean CDN snapshots for all contests. |
| 2026-08-27 | Antigravity Agent | **Create Group & Assign Trainers in Contest Creation**: Implemented inline group creation and trainer assignment feature in `ContestWizard.tsx` (Step 3) and `EditContestForm.tsx`. Built `CreateGroupAndAssignModal.tsx` allowing admins/managers to name a group, filter and search through individual trainers (by name, emp ID, team, handles), select individual trainers, and create/assign the group in one click. Enhanced `POST /api/contests` to support atomic `new_group: { name, user_ids }` creation with automated group member and assignment insertion. |
| 2026-08-27 | Antigravity Agent | **Attempted vs Solved Question Counting & Contest Widget Fixes**: Fixed problem completion counting across the system so partial submissions and zero-score attempts are strictly marked as `attempted` and not counted toward `solved` or completions. Updated `hackerrank.js`, `progressScraper.js`, `cdnPublisher.js`, `cdn-cache.ts`, `contests/[id]/page.tsx`, `dashboard/page.tsx`, `reports/page.tsx`, `api/reports/route.ts`, and `api/trainer/skills/route.ts` to require full score (`status === 'solved' && score >= max_score`). Updated 26 legacy database rows in `progress` table to `attempted` and flushed stale CDN caches. Fixed dashboard Recent Contests widget by removing `.limit(6)` query truncation and `.slice(0, 3)` array slicing, added scrollable list container for all contests, increased `getContestAnalytics` limit to 50, and created `AssignedContestsWidget.tsx` for trainers. |
| 2026-08-27 | Antigravity Agent | **Full Platform Separation & LeetCode Contest Support**: Added LeetCode Problem List scraping support (`parseProblemListId`, `fetchProblemListQuestions`), dynamic step titles & platform-aware creation flow in `ContestWizard.tsx`, "➕ Add Problems" modal and "🔄 Re-sync" button in `QuestionsPanel.tsx`, platform-aware empty states in `LeaderboardTable.tsx`, dynamic track identifier and delete modal in `EditContestForm.tsx`, fixed `fontSize` CSS bug in `page.css`, added platform badges in `AutoScrapeScheduler.tsx`, created `lib/leetcode-sync.ts` and enabled LeetCode automated solve synchronizing in `api/scrape/auto-cron`. |
| 2026-08-27 | Antigravity Agent | Created comprehensive `CODEBASE.md` system documentation and established workspace auto-sync agent rules (`AGENTS.md`, `GEMINI.md`, `.agent/rules/`). |
