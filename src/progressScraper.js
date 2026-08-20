/**
 * Progress Scraper
 *
 * Orchestrates the full flow of:
 *   1. HackerRank login (Puppeteer → cookies → close browser)
 *   2. Leaderboard fetch (bulk, most efficient)
 *   3. Per-user fallback (hackers/challenges endpoint)
 *   4. Per-challenge last resort (slowest path)
 *   5. Dense upsert of all user-question rows to Supabase
 *
 * All users are processed in concurrent batches of CONCURRENCY to balance
 * speed vs HackerRank rate-limiting.
 */

const { authenticate } = require('./auth');
const hr = require('./hackerrank');
const { getSupabaseClient } = require('./supabaseClient');
const jobStore = require('./jobStore');
const cdnPublisher = require('./cdnPublisher');

const CONCURRENCY = 5;          // users processed in parallel
const BATCH_DELAY_MS = 300;     // delay between concurrent batches
const DB_BATCH_SIZE = 500;      // rows per Supabase upsert batch

/**
 * @typedef {{
 *   user_id: string,
 *   hackerrank_id: string,
 * }} UserInput
 *
 * @typedef {{
 *   slug: string,
 *   questionName: string,
 *   maxScore: number,
 * }} QuestionInput
 */

/**
 * Run the full progress scrape for a contest.
 *
 * @param {string} jobId
 * @param {string} contestId
 * @param {string} contestSlug
 * @param {QuestionInput[]} questions
 * @param {UserInput[]} users
 */
async function run(jobId, contestId, contestSlug, questions, users) {
  const supabase = getSupabaseClient();
  jobStore.markRunning(jobId);

  console.log(`\n[progress] ▶ Job ${jobId} started`);
  console.log(`[progress]   Contest: ${contestSlug} (DB id: ${contestId})`);
  console.log(`[progress]   Questions: ${questions.length}`);
  console.log(`[progress]   Users: ${users.length}\n`);

  try {
    // ── Step 1: Authenticate ───────────────────────────────────────────────
    const email = process.env.HACKERRANK_EMAIL;
    const password = process.env.HACKERRANK_PASSWORD;
    if (!email || !password) throw new Error('HACKERRANK_EMAIL / HACKERRANK_PASSWORD not set');

    jobStore.updateJob(jobId, { message: 'Logging in to HackerRank...' });
    const client = await authenticate(email, password);

    // ── Step 2: Fetch full leaderboard (bulk) ─────────────────────────────
    jobStore.updateJob(jobId, { message: 'Fetching leaderboard...' });
    const { leaderboardMap, isComplete } = await hr.fetchLeaderboard(client, contestSlug);

    console.log(`[progress] Leaderboard: ${leaderboardMap.size} entries, complete: ${isComplete}`);

    // ── Step 3: Resolve question IDs from Supabase ────────────────────────
    const { data: dbQuestions, error: qErr } = await supabase
      .from('questions')
      .select('id, slug')
      .eq('contest_id', contestId)
      .order('order_index', { ascending: true });

    if (qErr) throw new Error(`Failed to fetch questions from DB: ${qErr.message}`);

    if (!dbQuestions || dbQuestions.length === 0) {
      throw new Error('No questions found in DB for this contest. Scrape challenges first.');
    }

    const questionIdMap = _buildQuestionIdMap(dbQuestions);
    // ── Step 3.5: Fetch existing user scores from DB for smart skip ──────────
    const { data: existingDbRows } = await supabase
      .from('progress')
      .select('user_id, question_id, status, score, max_score, last_submission_at, updated_at')
      .eq('contest_id', contestId);

    const userDbScoreMap = new Map();
    (existingDbRows || []).forEach(r => {
      if (!userDbScoreMap.has(r.user_id)) {
        userDbScoreMap.set(r.user_id, { totalScore: 0, rows: [] });
      }
      const entry = userDbScoreMap.get(r.user_id);
      entry.totalScore += r.score || 0;
      entry.rows.push(r);
    });
    console.log(`[progress] Loaded existing scores for ${userDbScoreMap.size} users from DB`);

    // ── Step 4: Process users in concurrent batches ────────────────────────
    jobStore.updateJob(jobId, { message: `Processing ${users.length} users...` });

    /** @type {Array<{contest_id, user_id, question_id, status, score, max_score, last_submission_at, updated_at}>} */
    const allProgressRows = [];

    for (let i = 0; i < users.length; i += CONCURRENCY) {
      const batch = users.slice(i, i + CONCURRENCY);

      const batchResults = await Promise.all(
        batch.map((u) =>
          _processUser(client, contestSlug, contestId, questions, questionIdMap, u, leaderboardMap, isComplete, userDbScoreMap)
        )
      );

      for (const rows of batchResults) {
        allProgressRows.push(...rows);
      }

      jobStore.incrementProgress(
        jobId,
        batch.length,
        `Processed ${Math.min(i + CONCURRENCY, users.length)} / ${users.length} users`
      );

      const remaining = users.length - (i + CONCURRENCY);
      if (remaining > 0) {
        await hr.sleep(BATCH_DELAY_MS);
      }
    }

    // ── Step 5: Upsert all rows to Supabase ───────────────────────────────
    console.log(`\n[progress] Upserting ${allProgressRows.length} progress rows to Supabase...`);
    jobStore.updateJob(jobId, { message: `Writing ${allProgressRows.length} rows to database...` });

    let totalUpserted = 0;
    for (let i = 0; i < allProgressRows.length; i += DB_BATCH_SIZE) {
      const batch = allProgressRows.slice(i, i + DB_BATCH_SIZE);
      const batchNum = Math.floor(i / DB_BATCH_SIZE) + 1;

      const { error: upsertErr } = await supabase
        .from('progress')
        .upsert(batch, { onConflict: 'contest_id,user_id,question_id' });

      if (upsertErr) {
        console.error(`[progress] Upsert batch ${batchNum} error: ${upsertErr.message}`);
      } else {
        totalUpserted += batch.length;
        console.log(`[progress] Upserted batch ${batchNum}: ${batch.length} rows`);
      }
    }

    // ── Step 6: Update last_scraped_at & Publish CDN Cache Snapshots ──────
    await supabase
      .from('contests')
      .update({ last_scraped_at: new Date().toISOString() })
      .eq('id', contestId);

    // Publish CDN Cache to Supabase Storage (api-cache bucket) to save egress
    try {
      await cdnPublisher.publishContestAndGlobalCache(contestId);
    } catch (cdnErr) {
      console.warn(`[progress] CDN cache generation skipped: ${cdnErr.message}`);
    }

    // Auto-notify LMS to purge and refresh dashboard caches
    const lmsBaseUrl = process.env.LMS_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    try {
      const axios = require('axios');
      await axios.post(`${lmsBaseUrl}/api/scrape/revalidate?contestId=${contestId}`, {}, { timeout: 5000 });
      console.log(`[progress] 🔄 Triggered automatic LMS dashboard revalidation at ${lmsBaseUrl}`);
    } catch (revalErr) {
      console.warn(`[progress] LMS revalidation ping skipped: ${revalErr.message}`);
    }

    const summary = `Done — ${totalUpserted} rows written for ${users.length} users`;
    console.log(`\n[progress] ✅ Job ${jobId} complete. ${summary}`);
    jobStore.markDone(jobId, summary);
  } catch (err) {
    console.error(`\n[progress] ❌ Job ${jobId} failed: ${err.message}`);
    jobStore.markError(jobId, err.message);
  }
}

// ─── Per-user processing ──────────────────────────────────────────────────────

/**
 * Determine progress data for a single user across all questions.
 * Uses Strategy 0 (Comparison API from extension e) as primary path,
 * falling back to leaderboard → per-user API → per-challenge API.
 *
 * @returns {Promise<Array>} Array of progress row objects for DB upsert
 */
async function _processUser(
  client,
  contestSlug,
  contestId,
  questions,
  questionIdMap,
  user,
  leaderboardMap,
  isComplete,
  userDbScoreMap
) {
  const { user_id, hackerrank_id } = user;
  const now = new Date().toISOString();

  const leaderEntry = leaderboardMap.get(hackerrank_id.toLowerCase());
  const leaderboardScore = leaderEntry?.totalScore ?? 0;
  const dbEntry = userDbScoreMap?.get(user_id);
  const dbUserScore = dbEntry ? dbEntry.totalScore : -1;

  // ── SMART SKIP: If user's leaderboard score matches DB score & all rows exist, skip fetching! ──
  if (dbUserScore !== -1 && leaderboardScore === dbUserScore && dbEntry?.rows?.length === questions.length) {
    console.log(`[progress]   ⚡ [skip-unchanged] ${hackerrank_id}: score unchanged (${leaderboardScore} pts). Skipping fetch.`);
    return dbEntry.rows;
  }

  let userSubmittedAt = leaderEntry?.submittedAt || null;

  // Real timestamp enrichment if user submitted but submittedAt missing from leaderboard
  if (leaderboardScore > 0 && !userSubmittedAt) {
    const realTs = await hr.fetchLatestSubmissionTimestamp(client, contestSlug, hackerrank_id);
    if (realTs) {
      userSubmittedAt = realTs;
      console.log(`[progress]   ✓ Fetched real last submission timestamp for ${hackerrank_id}: ${realTs}`);
    }
  }

  // ── Strategy 0: Direct Comparison API (Extension e Logic) ───────────────
  const refHacker = client.username || process.env.HACKERRANK_ADMIN_HANDLE || leaderboardMap.keys().next().value || '';
  if (refHacker && refHacker.toLowerCase() !== hackerrank_id.toLowerCase()) {
    const compareMap = await hr.fetchUserComparison(client, contestSlug, refHacker, hackerrank_id);
    if (compareMap && compareMap.size > 0) {
      console.log(`[progress]   [compare-api] ${hackerrank_id}: ${compareMap.size} challenges resolved`);
      return _buildDenseRowsFromCompare(questions, questionIdMap, contestId, user_id, compareMap, userSubmittedAt, now);
    }
  } else if (refHacker && refHacker.toLowerCase() === hackerrank_id.toLowerCase()) {
    // Self-user (logged in admin user): fetch submissions via 1 bulk API call
    console.log(`[progress]   [self-user] ${hackerrank_id}: fetching logged-in user submissions (1 call)...`);
    const selfMap = await hr.fetchUserChallenges(client, contestSlug, hackerrank_id);
    return _buildDenseRows(questions, questionIdMap, contestId, user_id, selfMap || new Map(), now);
  }

  /** @type {Map<string, {score, timestamp, status}> | null} */
  let challengeMap = null;

  if (leaderEntry && leaderEntry.hasPerChallengeData) {
    // Best case: per-challenge data from leaderboard
    challengeMap = new Map(
      Object.entries(leaderEntry.challenges).map(([slug, ch]) => [
        slug,
        {
          score: ch.score ?? 0,
          timestamp: ch.timestamp ? new Date(ch.timestamp * 1000).toISOString() : leaderEntry.submittedAt,
          status: null,
        },
      ])
    );
    console.log(`[progress]   [leaderboard] ${hackerrank_id}: ${challengeMap.size} challenges found`);
  } else if (isComplete) {
    // Leaderboard is fully loaded and user isn't there → definitely 0 score
    console.log(`[progress]   [fast-path] ${hackerrank_id}: not in leaderboard (0 score)`);
    return _buildDenseRows(questions, questionIdMap, contestId, user_id, new Map(), now);
  }

  // ── Strategy 2: Per-user challenges API ───────────────────────────────────
  if (!challengeMap) {
    challengeMap = await hr.fetchUserChallenges(client, contestSlug, hackerrank_id);
  }

  return _buildDenseRows(questions, questionIdMap, contestId, user_id, challengeMap ?? new Map(), now);
}

/**
 * Build dense rows from compare API results (Extension e logic).
 */
function _buildDenseRowsFromCompare(questions, questionIdMap, contestId, user_id, compareMap, userSubmittedAt, now) {
  const rows = [];

  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const questionId = _resolveQuestionId(questionIdMap, q.slug, idx);
    if (!questionId) continue;

    const slugKey = q.slug ? q.slug.toLowerCase() : '';
    const item = compareMap.get(slugKey);
    const maxScore = Math.max(0, Math.round(parseFloat(q.maxScore) || item?.maxScore || 10));

    let status = 'unattempted';
    let score = 0;

    if (item) {
      score = Math.max(0, Math.round(parseFloat(item.score) || 0));
      status = item.status; // 'solved' | 'attempted' | 'unattempted'
      if (score > 0 && status !== 'solved') {
        status = 'solved';
      }
    }

    const subTime = (status === 'solved' || status === 'attempted') ? (item?.timestamp || userSubmittedAt || null) : null;

    rows.push({
      contest_id: contestId,
      user_id,
      question_id: questionId,
      status,
      score,
      max_score: maxScore,
      last_submission_at: subTime,
      updated_at: now,
    });
  }

  return rows;
}

/**
 * Build a dense array of progress rows (one per question per user).
 * Dense = include unattempted rows too.
 */
function _buildDenseRows(questions, questionIdMap, contestId, user_id, challengeMap, now) {
  const rows = [];

  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const questionId = _resolveQuestionId(questionIdMap, q.slug, idx);
    if (!questionId) continue;

    const sub = challengeMap.get(q.slug);
    const maxScore = Math.max(0, Math.round(parseFloat(q.maxScore) || 10));

    let status, score, lastSubmissionAt;

    if (sub) {
      score = Math.max(0, Math.round(parseFloat(sub.score) || 0));
      lastSubmissionAt = sub.timestamp || null;

      if (
        sub.status === 'Accepted' ||
        sub.status === 'accepted' ||
        (score >= maxScore && maxScore > 0)
      ) {
        status = 'solved';
      } else if (score > 0) {
        status = 'attempted';
      } else {
        // Score 0 but submission exists
        status = 'attempted';
      }
    } else {
      score = 0;
      status = 'unattempted';
      lastSubmissionAt = null;
    }

    rows.push({
      contest_id: contestId,
      user_id,
      question_id: questionId,
      status,
      score,
      max_score: maxScore,
      last_submission_at: lastSubmissionAt,
      updated_at: now,
    });
  }

  return rows;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Build a multi-key map for resolving question slugs to DB IDs.
 * Tries exact match, lowercase, normalized (alphanum only), and index.
 */
function _buildQuestionIdMap(dbQuestions) {
  const map = new Map();
  dbQuestions.forEach((q, idx) => {
    if (q.slug) {
      map.set(q.slug, q.id);
      map.set(q.slug.trim().toLowerCase(), q.id);
      map.set(q.slug.replace(/[^a-z0-9]/gi, '').toLowerCase(), q.id);
    }
    map.set(`__idx_${idx}`, q.id);
  });
  return map;
}

function _resolveQuestionId(map, slug, idx) {
  if (!slug) return map.get(`__idx_${idx}`);
  return (
    map.get(slug) ||
    map.get(slug.trim().toLowerCase()) ||
    map.get(slug.replace(/[^a-z0-9]/gi, '').toLowerCase()) ||
    map.get(`__idx_${idx}`)
  );
}

module.exports = { run };
