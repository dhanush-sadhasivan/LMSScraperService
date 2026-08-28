/**
 * Progress Scraper
 *
 * Orchestrates the full flow of:
 *   1. HackerRank login (Puppeteer → cookies → close browser)
 *      Supports multiple credential pairs: HACKERRANK_EMAIL_1/PASSWORD_1 ... _N
 *      Falls back to HACKERRANK_EMAIL/PASSWORD if numbered pairs are not configured.
 *   2. Leaderboard fetch (bulk, most efficient) — done by credential[0], shared
 *   3. Users partitioned across credentials and processed in parallel
 *   4. Per-user fallback (hackers/challenges endpoint)
 *   5. Dense upsert of all user-question rows to Supabase
 *
 * Multi-credential partitioning distributes API calls evenly across accounts,
 * dramatically reducing per-account HackerRank rate-limit pressure.
 */

const { authenticate } = require('./auth');
const hr = require('./hackerrank');
const { getSupabaseClient } = require('./supabaseClient');
const jobStore = require('./jobStore');
const cdnPublisher = require('./cdnPublisher');

const CONCURRENCY = 5;          // users processed in parallel per credential
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

// ─── Credential pool helpers ──────────────────────────────────────────────────

/**
 * Load all HackerRank credential pairs from environment variables.
 * Supports:
 *   HACKERRANK_EMAIL_1 / HACKERRANK_PASSWORD_1  (highest priority)
 *   HACKERRANK_EMAIL_2 / HACKERRANK_PASSWORD_2
 *   ...
 *   HACKERRANK_EMAIL_N / HACKERRANK_PASSWORD_N
 *   HACKERRANK_EMAIL   / HACKERRANK_PASSWORD    (fallback / legacy single pair)
 *
 * @returns {{ email: string, password: string }[]}
 */
function loadCredentials() {
  const credentials = [];

  // Load numbered pairs first (HACKERRANK_EMAIL_1, HACKERRANK_EMAIL_2, ...)
  for (let i = 1; i <= 20; i++) {
    const email = process.env[`HACKERRANK_EMAIL_${i}`];
    const password = process.env[`HACKERRANK_PASSWORD_${i}`];
    if (email && password) {
      credentials.push({ email: email.trim(), password: password.trim() });
    } else {
      break; // stop at first gap
    }
  }

  // Fallback to legacy single pair if no numbered pairs found
  if (credentials.length === 0) {
    const email = process.env.HACKERRANK_EMAIL;
    const password = process.env.HACKERRANK_PASSWORD;
    if (email && password) {
      credentials.push({ email: email.trim(), password: password.trim() });
    }
  }

  return credentials;
}

/**
 * Partition an array into N roughly-equal chunks (round-robin style).
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[][]}
 */
function partitionRoundRobin(arr, n) {
  const partitions = Array.from({ length: n }, () => []);
  arr.forEach((item, idx) => partitions[idx % n].push(item));
  return partitions;
}

/**
 * Authenticate all credentials in parallel. Returns authenticated clients.
 * If a credential fails, it is skipped and a warning is logged.
 *
 * @param {{ email: string, password: string }[]} credentials
 * @returns {Promise<import('axios').AxiosInstance[]>}
 */
async function authenticateAll(credentials) {
  const results = await Promise.allSettled(
    credentials.map(({ email, password }) => authenticate(email, password))
  );

  const clients = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      clients.push(r.value);
      console.log(`[progress] ✅ Credential ${i + 1} authenticated (${credentials[i].email})`);
    } else {
      console.warn(`[progress] ⚠️  Credential ${i + 1} failed (${credentials[i].email}): ${r.reason?.message}`);
    }
  });

  return clients;
}

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
    const credentials = loadCredentials();
    if (credentials.length === 0) throw new Error('No HACKERRANK credentials configured');
    
    jobStore.updateJob(jobId, { message: 'Logging in to HackerRank...' });
    const clients = await authenticateAll(credentials);
    if (clients.length === 0) throw new Error('All authentication attempts failed');

    // ── Step 2: Fetch full leaderboard (bulk) using first client ──────────
    jobStore.updateJob(jobId, { message: 'Fetching leaderboard...' });
    const primaryClient = clients[0];
    const { leaderboardMap, isComplete } = await hr.fetchLeaderboard(primaryClient, contestSlug);

    console.log(`[progress] Leaderboard: ${leaderboardMap.size} entries, complete: ${isComplete}`);
    console.log(`[progress] Credential pool: ${clients.length} active client(s)`);

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

    let existingDbRows = [];
    let eFrom = 0;
    const eStep = 1000;
    while (true) {
      const { data: ePage } = await supabase
        .from('progress')
        .select('contest_id, user_id, question_id, status, score, max_score, last_submission_at, updated_at')
        .eq('contest_id', contestId)
        .order('id', { ascending: true })
        .range(eFrom, eFrom + eStep - 1);
      if (!ePage || ePage.length === 0) break;
      existingDbRows = existingDbRows.concat(ePage);
      if (ePage.length < eStep) break;
      eFrom += eStep;
    }

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

    // ── Step 4: Partition users across credential pool & process ──────────
    jobStore.updateJob(jobId, { message: `Processing ${users.length} users across ${clients.length} credential(s)...` });

    /** @type {Array<{contest_id, user_id, question_id, status, score, max_score, last_submission_at, updated_at}>} */
    const allProgressRows = [];

    if (clients.length === 1) {
      // Single credential: original sequential batch processing
      const client = clients[0];
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
    } else {
      // Multiple credentials: partition users round-robin, run partitions in parallel
      const partitions = partitionRoundRobin(users, clients.length);
      console.log(`[progress] Partitioned ${users.length} users across ${clients.length} credentials:`);
      partitions.forEach((p, i) =>
        console.log(`[progress]   Credential ${i + 1}: ${p.length} users`)
      );

      let processedCount = 0;
      const partitionResults = await Promise.all(
        partitions.map(async (partition, credIdx) => {
          const client = clients[credIdx];
          const partitionRows = [];

          for (let i = 0; i < partition.length; i += CONCURRENCY) {
            const batch = partition.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.all(
              batch.map((u) =>
                _processUser(client, contestSlug, contestId, questions, questionIdMap, u, leaderboardMap, isComplete, userDbScoreMap)
              )
            );
            for (const rows of batchResults) partitionRows.push(...rows);

            processedCount += batch.length;
            jobStore.incrementProgress(
              jobId,
              batch.length,
              `Processed ${processedCount} / ${users.length} users (${clients.length} credentials)`
            );

            const remaining = partition.length - (i + CONCURRENCY);
            if (remaining > 0) await hr.sleep(BATCH_DELAY_MS);
          }
          return partitionRows;
        })
      );

      for (const rows of partitionResults) {
        allProgressRows.push(...rows);
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
  // We also compare the number of solved questions to avoid false positives when the
  // leaderboard total score matches but the per-challenge distribution changed.
  if (dbUserScore !== -1 && leaderboardScore === dbUserScore && dbEntry?.rows?.length === questions.length) {
    const dbSolvedCount = dbEntry.rows.filter(r => r.status === 'solved').length;
    const leaderSolvedCount = leaderEntry?.hasPerChallengeData
      ? Object.values(leaderEntry.challenges).filter(ch => (ch.score ?? 0) > 0).length
      : null; // unknown — can't verify, be conservative
    if (leaderSolvedCount === null || leaderSolvedCount === dbSolvedCount) {
      console.log(`[progress]   ⚡ [skip-unchanged] ${hackerrank_id}: score ${leaderboardScore} pts, ${dbSolvedCount} solved. Skipping fetch.`);
      return dbEntry.rows;
    }
    console.log(`[progress]   ⚠️  [skip-overridden] ${hackerrank_id}: score unchanged (${leaderboardScore} pts) but solved count changed (DB: ${dbSolvedCount}, leaderboard: ${leaderSolvedCount}). Refetching.`);
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
      // Check actual coverage: how many of this contest's questions exist in compareMap.
      // The compare endpoint only returns challenges either user attempted — if the
      // logged-in admin account hasn't tried all problems, the rest would be silently
      // missed and incorrectly marked unattempted.
      const coveredCount = _countCoverage(questions, compareMap);
      console.log(`[progress]   [compare-api] ${hackerrank_id}: ${compareMap.size} API challenges, ${coveredCount}/${questions.length} questions matched`);

      if (coveredCount >= questions.length) {
        // Full coverage — safe to use compare results directly
        return _buildDenseRowsFromCompare(questions, questionIdMap, contestId, user_id, compareMap, userSubmittedAt, now);
      }

      // Partial coverage — supplement with direct per-user API for questions that
      // the compare API didn't return data for.
      console.log(`[progress]   [compare-api] ${hackerrank_id}: partial coverage, supplementing with per-user API...`);
      const supplementMap = await hr.fetchUserChallenges(client, contestSlug, hackerrank_id) || new Map();
      return _buildDenseRowsFromCompareWithSupplement(questions, questionIdMap, contestId, user_id, compareMap, supplementMap, userSubmittedAt, now);
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
    // Best case: per-challenge data from leaderboard — index by both raw & normalized slug
    challengeMap = new Map();
    for (const [slug, ch] of Object.entries(leaderEntry.challenges)) {
      const val = {
        score: ch.score ?? 0,
        timestamp: ch.timestamp ? new Date(ch.timestamp * 1000).toISOString() : leaderEntry.submittedAt,
        status: null,
      };
      challengeMap.set(slug, val);
      challengeMap.set(slug.toLowerCase(), val);
      challengeMap.set(slug.replace(/[^a-z0-9]/gi, '').toLowerCase(), val);
    }
    console.log(`[progress]   [leaderboard] ${hackerrank_id}: ${Object.keys(leaderEntry.challenges).length} challenges found`);
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

    // Multi-format slug lookup to survive slug differences across HackerRank endpoints
    const item = _lookupCompareItem(compareMap, q.slug);
    const maxScore = Math.max(0, Math.round(parseFloat(q.maxScore) || item?.maxScore || 10));

    let status = 'unattempted';
    let score = 0;

    if (item) {
      score = Math.max(0, Math.round(parseFloat(item.score) || 0));
      if (maxScore > 0 && score >= maxScore) {
        status = 'solved';
      } else if (item.status === 'attempted' || item.attempted || score > 0) {
        status = 'attempted';
      } else {
        status = item.status || 'unattempted';
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
 * Build dense rows merging compare API data (authoritative for covered questions)
 * with per-user API data for questions that compareMap didn't cover.
 */
function _buildDenseRowsFromCompareWithSupplement(questions, questionIdMap, contestId, user_id, compareMap, supplementMap, userSubmittedAt, now) {
  const rows = [];

  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const questionId = _resolveQuestionId(questionIdMap, q.slug, idx);
    if (!questionId) continue;

    // Prefer compare API entry; fall back to supplement (user-challenges API)
    const item = _lookupCompareItem(compareMap, q.slug);
    const maxScore = Math.max(0, Math.round(parseFloat(q.maxScore) || item?.maxScore || 10));

    let status = 'unattempted';
    let score = 0;
    let subTime = null;

    if (item) {
      // Compare API has data for this question
      score = Math.max(0, Math.round(parseFloat(item.score) || 0));
      if (maxScore > 0 && score >= maxScore) {
        status = 'solved';
      } else if (item.status === 'attempted' || item.attempted || score > 0) {
        status = 'attempted';
      } else {
        status = item.status || 'unattempted';
      }
      subTime = (status === 'solved' || status === 'attempted') ? (item.timestamp || userSubmittedAt || null) : null;
    } else {
      // Compare API missed this question — use supplement data
      const sub = _lookupSubmissionItem(supplementMap, q.slug);
      if (sub) {
        score = Math.max(0, Math.round(parseFloat(sub.score) || 0));
        subTime = sub.timestamp || null;
        if (sub.status === 'Accepted' || sub.status === 'accepted' || (score >= maxScore && maxScore > 0)) {
          status = 'solved';
        } else {
          status = 'attempted';
        }
      }
    }

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

    // Try multiple slug formats to survive API slug inconsistencies
    const sub = _lookupSubmissionItem(challengeMap, q.slug);
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

/**
 * Look up a compareMap entry using multiple slug formats.
 * HackerRank's compare API and challenges API sometimes use slightly different slugs.
 *
 * @param {Map} compareMap
 * @param {string|undefined} slug
 * @returns {any|undefined}
 */
function _lookupCompareItem(compareMap, slug) {
  if (!slug) return undefined;
  return (
    compareMap.get(slug) ||
    compareMap.get(slug.toLowerCase()) ||
    compareMap.get(slug.replace(/[^a-z0-9]/gi, '').toLowerCase())
  );
}

/**
 * Look up a submission map entry using multiple slug formats.
 * Same normalization as _lookupCompareItem.
 *
 * @param {Map} map
 * @param {string|undefined} slug
 * @returns {any|undefined}
 */
function _lookupSubmissionItem(map, slug) {
  if (!slug) return undefined;
  return (
    map.get(slug) ||
    map.get(slug.toLowerCase()) ||
    map.get(slug.replace(/[^a-z0-9]/gi, '').toLowerCase())
  );
}

/**
 * Count how many questions from the contest have a matching entry in compareMap.
 * Uses the same multi-format slug matching used during row building.
 *
 * @param {Array<{slug: string}>} questions
 * @param {Map} compareMap
 * @returns {number}
 */
function _countCoverage(questions, compareMap) {
  let count = 0;
  for (const q of questions) {
    if (_lookupCompareItem(compareMap, q.slug) !== undefined) count++;
  }
  return count;
}

module.exports = { run };

