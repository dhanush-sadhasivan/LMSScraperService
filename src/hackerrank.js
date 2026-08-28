/**
 * HackerRank API client.
 *
 * All functions accept a pre-configured axios instance (from auth.js) and
 * return clean, normalized data. No puppeteer is used here — pure HTTP.
 */

const REQUEST_DELAY_MS = 400;
const PAGE_SIZE = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resilient GET: returns parsed data or null on any failure.
 * @param {import('axios').AxiosInstance} client
 * @param {string} url
 * @returns {Promise<any|null>}
 */
async function apiGet(client, url) {
  try {
    const res = await client.get(url);
    return res.data ?? null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 403) {
      // Not found or unauthorized — not worth retrying (axios interceptor already handles 5xx/429)
      return null;
    }
    console.warn(`[api] GET ${url} failed: ${err.message}`);
    return null;
  }
}

// ─── Domain extraction ────────────────────────────────────────────────────────

/**
 * Generic / unhelpful domain values that HackerRank returns for custom contests.
 * When the API returns one of these we should NOT trust it as a meaningful category.
 */
const GENERIC_DOMAINS = new Set([
  'ai', 'algorithms', 'general', 'dsa', 'practice', 'challenge', 'contest',
  'master', 'test', 'assessment', 'certification', 'other',
]);

/**
 * Try to extract a meaningful domain / category from a challenge object.
 *
 * Priority:
 *  1. Title-prefix heuristic  —  "Arrays - Two Sum"  → "Arrays"
 *  2. HackerRank track / domain / category  (only if NOT generic)
 *  3. null  (caller should fallback to 'General')
 *
 * @param {{ name?: string, title?: string, track?: { name?: string }, domain?: string, category?: string }} challenge
 * @returns {string|null}
 */
function extractDomain(challenge) {
  // 1. Title-prefix heuristic: "Topic - Question Name"
  const rawTitle = challenge.name || challenge.title || '';
  if (rawTitle.includes('-')) {
    const prefix = rawTitle.split('-')[0].trim();
    if (prefix.length > 0 && prefix.length < 40) {
      // Capitalise first letter
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
  }

  // 2. HackerRank track / domain / category — skip generic values
  const hrDomain = challenge.track?.name || challenge.domain || challenge.category || '';
  if (hrDomain && !GENERIC_DOMAINS.has(hrDomain.toLowerCase().trim())) {
    return hrDomain.trim();
  }

  // 3. Nothing useful found
  return null;
}

// ─── Challenges ───────────────────────────────────────────────────────────────

/**
 * Fetch all challenges (questions) for a contest, paginated.
 * Returns normalized challenge objects.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} contestSlug
 * @returns {Promise<Array<{ slug, name, difficulty, maxScore, domain, order }>>}
 */
async function fetchChallenges(client, contestSlug) {
  console.log(`[api] Fetching challenges for contest: ${contestSlug}`);

  const allModels = [];
  let offset = 0;
  let total = null;
  let page = 1;

  while (total === null || offset < total) {
    const url = `/rest/contests/${contestSlug}/challenges?offset=${offset}&limit=${PAGE_SIZE}`;
    const data = await apiGet(client, url);

    if (!data || !data.models) {
      if (page === 1) console.warn(`[api] No challenge data returned for ${contestSlug}`);
      break;
    }

    const models = data.models || [];
    total = data.total ?? models.length;
    allModels.push(...models);

    console.log(`[api]   Challenges page ${page}: ${models.length} items (total: ${total})`);

    if (models.length === 0 || offset + models.length >= total) break;
    offset += models.length;
    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  // Normalize
  return allModels.map((c, idx) => ({
    slug: c.slug || c.challenge_slug || '',
    name: c.name || c.title || c.slug || '',
    difficulty: normalizeDifficulty(c.difficulty_name || c.difficulty),
    maxScore: c.max_score ?? c.points ?? 10,
    domain: extractDomain(c) || 'General',
    order: idx,
  })).filter((c) => c.slug);
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

/**
 * Fetch the full contest leaderboard, paginated.
 * Returns a Map keyed by lowercased hackerrank username.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} contestSlug
 * @returns {Promise<{ leaderboardMap: Map<string, LeaderboardEntry>, isComplete: boolean, totalParticipants: number }>}
 */
async function fetchLeaderboard(client, contestSlug) {
  console.log(`[api] Fetching leaderboard for contest: ${contestSlug}`);

  /** @type {Map<string, LeaderboardEntry>} */
  const leaderboardMap = new Map();
  let offset = 0;
  let total = null;
  let page = 1;

  while (total === null || offset < total) {
    const url = `/rest/contests/${contestSlug}/leaderboard?offset=${offset}&limit=${PAGE_SIZE}&_=${Date.now()}`;
    const data = await apiGet(client, url);

    if (!data || !data.models) {
      if (page === 1) console.warn(`[api] No leaderboard data for ${contestSlug}`);
      break;
    }

    total = data.total ?? 0;
    const models = data.models || [];

    for (const entry of models) {
      const username = entry.hacker || entry.hacker_username || entry.username;
      if (!username) continue;

      const challenges = _parseChallenges(entry.challenges);

      const rawTs = entry.timestamp ?? entry.created_at ?? entry.submitted_at ?? entry.date_submitted ?? null;
      let submittedAt = null;
      if (rawTs) {
        if (typeof rawTs === 'number' && rawTs > 100000000) {
          const ms = rawTs < 1e11 ? rawTs * 1000 : rawTs;
          submittedAt = new Date(ms).toISOString();
        } else if (typeof rawTs === 'string') {
          const parsed = Date.parse(rawTs);
          if (!isNaN(parsed)) submittedAt = new Date(parsed).toISOString();
        }
      }

      leaderboardMap.set(username.toLowerCase(), {
        username,
        rank: entry.rank ?? null,
        totalScore: entry.score ?? 0,
        submittedAt,
        challenges,
        hasPerChallengeData: Object.keys(challenges).length > 0,
      });
    }

    console.log(`[api]   Leaderboard page ${page}: ${models.length} entries (total: ${total})`);

    if (models.length === 0 || offset + models.length >= total) break;
    offset += models.length;
    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  const isComplete = total !== null && leaderboardMap.size >= total;
  console.log(`[api] Leaderboard loaded: ${leaderboardMap.size} participants (complete: ${isComplete})`);

  return { leaderboardMap, isComplete, totalParticipants: total || leaderboardMap.size };
}

// ─── Per-user fallbacks ───────────────────────────────────────────────────────

/**
 * Strategy 2: Fetch per-user challenge completion data.
 * Tries multiple endpoint patterns.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} contestSlug
 * @param {string} hackerrankId
 * @returns {Promise<Map<string, { score, timestamp, status }> | null>}
 */
async function fetchUserChallenges(client, contestSlug, hackerrankId) {
  const endpoints = [
    {
      name: 'submissions?hacker',
      url: `/rest/contests/${contestSlug}/submissions?hacker=${hackerrankId}&offset=0&limit=1000`,
      extract: (d) => d?.models || null,
    },
    {
      name: 'hackers/challenges',
      url: `/rest/contests/${contestSlug}/hackers/${hackerrankId}/challenges`,
      extract: (d) => d?.models || d?.challenges || null,
    },
    {
      name: 'judge_submissions',
      url: `/rest/contests/${contestSlug}/judge_submissions?hacker=${hackerrankId}&offset=0&limit=1000`,
      extract: (d) => d?.models || null,
    },
    {
      name: 'leaderboard?hacker',
      url: `/rest/contests/${contestSlug}/leaderboard?hacker=${hackerrankId}`,
      extract: (d) => {
        const entry = d?.models?.[0];
        if (!entry?.challenges) return null;
        return Object.entries(entry.challenges).map(([slug, ch]) => ({
          challenge_slug: slug,
          score: ch.score ?? 0,
          created_at: ch.time_taken ? new Date(ch.time_taken * 1000).toISOString() : null,
          status: (ch.score ?? 0) > 0 ? 'Attempted' : 'Unattempted',
        }));
      },
    },
  ];

  for (const { name, url, extract } of endpoints) {
    const data = await apiGet(client, url);
    const result = extract(data);
    if (result && (Array.isArray(result) ? result.length > 0 : Object.keys(result).length > 0)) {
      console.log(`[api]     ✓ Per-user data via "${name}" for ${hackerrankId}`);
      return _buildSubmissionMap(Array.isArray(result) ? result : Object.values(result));
    }
    await sleep(REQUEST_DELAY_MS);
  }

  return null;
}

/**
 * Strategy 3 (last resort): Fetch submissions for one specific challenge for a user.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} contestSlug
 * @param {string} challengeSlug
 * @param {string} hackerrankId
 * @returns {Promise<{ score, timestamp, status } | null>}
 */
async function fetchChallengeSubmission(client, contestSlug, challengeSlug, hackerrankId) {
  const url = `/rest/contests/${contestSlug}/challenges/${challengeSlug}/submissions?hacker=${hackerrankId}&offset=0&limit=10`;
  const data = await apiGet(client, url);
  const models = data?.models;
  if (!models || models.length === 0) return null;

  // Find best submission
  let best = { score: 0, timestamp: null, status: null };
  for (const sub of models) {
    const s = sub.score ?? sub.display_score ?? 0;
    if (s >= best.score) {
      best = {
        score: s,
        timestamp: sub.created_at ?? sub.updated_at ?? null,
        status: sub.status ?? sub.result ?? null,
      };
    }
  }
  return best;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Parse the `challenges` field from a leaderboard entry.
 * HackerRank returns either an array or an object keyed by slug.
 */
function _parseChallenges(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};

  if (Array.isArray(raw)) {
    for (const ch of raw) {
      const slug = ch.slug || ch.challenge_slug;
      if (slug) {
        out[slug] = {
          score: ch.score ?? ch.solved_score ?? 0,
          timestamp: ch.time_taken ?? ch.timestamp ?? null,
        };
      }
    }
  } else {
    for (const [slug, ch] of Object.entries(raw)) {
      if (typeof ch === 'object' && ch !== null) {
        out[slug] = {
          score: ch.score ?? ch.solved_score ?? 0,
          timestamp: ch.time_taken ?? ch.timestamp ?? null,
        };
      } else {
        out[slug] = {
          score: typeof ch === 'number' ? ch : parseFloat(ch) || 0,
          timestamp: null,
        };
      }
    }
  }

  return out;
}

/**
 * Build a slug → {score, timestamp, status} map from an array of submission-like objects.
 * Keeps the best (highest score, then latest timestamp) submission per challenge.
 */
function _buildSubmissionMap(submissions) {
  const map = new Map();
  for (const sub of submissions) {
    const slug = sub.challenge_slug || sub.slug || sub.challenge?.slug;
    if (!slug) continue;

    const score = sub.score ?? sub.display_score ?? 0;
    const timestamp = sub.created_at ?? sub.updated_at ?? null;
    const status = sub.status ?? sub.result ?? null;

    const existing = map.get(slug);
    if (!existing || score > existing.score || (score === existing.score && timestamp > existing.timestamp)) {
      map.set(slug, { score, timestamp, status });
    }
  }
  return map;
}

/**
 * Normalize difficulty string to 'Easy' | 'Medium' | 'Hard' | 'Unknown'.
 */
function normalizeDifficulty(raw) {
  if (!raw) return 'Unknown';
  const lower = raw.toLowerCase().trim();
  if (lower.includes('easy')) return 'Easy';
  if (lower.includes('medium')) return 'Medium';
  if (lower.includes('hard')) return 'Hard';
  return raw.trim() || 'Unknown';
}

/**
 * Comparison Scraper (from extension logic):
 * Compare reference user (hacker1) against target user (hacker2) for a contest.
 * Returns challenge-by-challenge completion breakdown.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} contestSlug
 * @param {string} refHacker
 * @param {string} studentHacker
 * @returns {Promise<Map<string, { score: number, attempted: boolean, status: string, name: string, maxScore: number }> | null>}
 */
async function fetchUserComparison(client, contestSlug, refHacker, studentHacker) {
  const ts = Date.now();
  const url = `/rest/compare?contest_slug=${contestSlug}&hacker_slug_1=${refHacker}&hacker_slug_2=${studentHacker}&_=${ts}`;
  const data = await apiGet(client, url);

  if (!data || !data.model || !Array.isArray(data.model.challenges)) {
    return null;
  }

  const result = new Map();

  for (const ch of data.model.challenges) {
    // Determine challenge slug
    let slug = ch.slug || ch.challenge_slug;
    if (!slug && ch.url) {
      const parts = ch.url.split('/');
      slug = parts[parts.length - 1] || parts[parts.length - 2];
    }
    if (!slug && ch.name) {
      slug = ch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    if (!slug) continue;

    const score = typeof ch.score2 === 'number' ? ch.score2 : (parseFloat(ch.score2) || 0);
    const maxScore = ch.point || ch.max_score || 0;
    const attempted = Boolean(ch.attempted2 || ch.submitted2 || (ch.submission_count2 && ch.submission_count2 > 0) || ch.status2 === 'Attempted' || ch.status2 === 'Solved');

    let status = 'unattempted';
    if (maxScore > 0 && score >= maxScore) {
      status = 'solved';
    } else if (attempted || score > 0) {
      status = 'attempted';
    }

    let timestamp = null;
    const rawTs = ch.timestamp2 || ch.timestamp || ch.created_at || ch.submitted_at;
    if (rawTs) {
      if (typeof rawTs === 'number' && rawTs > 100000000) {
        const ms = rawTs < 1e11 ? rawTs * 1000 : rawTs;
        timestamp = new Date(ms).toISOString();
      } else if (typeof rawTs === 'string') {
        const parsed = Date.parse(rawTs);
        if (!isNaN(parsed)) timestamp = new Date(parsed).toISOString();
      }
    }

    const entry = {
      score,
      attempted,
      status,
      name: ch.name || '',
      maxScore: ch.point || 0,
      timestamp,
    };

    // Store under multiple slug formats so downstream lookup survives slug variations
    // between the challenges endpoint and the compare endpoint.
    const keyLower = slug.toLowerCase();
    const keyNorm  = slug.replace(/[^a-z0-9]/gi, '').toLowerCase();
    result.set(keyLower, entry);
    if (keyNorm !== keyLower) result.set(keyNorm, entry);
  }

  return result;
}


/**
 * Fast lookup for user's latest submission timestamp in a contest.
 * GET /rest/contests/${contestSlug}/submissions?hacker=${hackerrankId}&offset=0&limit=1
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} contestSlug
 * @param {string} hackerrankId
 * @returns {Promise<string|null>} ISO timestamp string or null
 */
async function fetchLatestSubmissionTimestamp(client, contestSlug, hackerrankId) {
  try {
    const url = `/rest/contests/${contestSlug}/submissions?hacker=${encodeURIComponent(hackerrankId)}&offset=0&limit=1`;
    const data = await apiGet(client, url);
    const models = data?.models;
    if (models && models.length > 0) {
      const latest = models[0];
      const raw = latest.created_at || latest.updated_at || latest.timestamp;
      if (raw) {
        if (typeof raw === 'number' && raw > 100000000) {
          return new Date(raw < 1e11 ? raw * 1000 : raw).toISOString();
        }
        if (typeof raw === 'string') {
          const parsed = Date.parse(raw);
          if (!isNaN(parsed)) return new Date(parsed).toISOString();
        }
      }
    }
  } catch (err) {
    // Silent fallback
  }
  return null;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

/**
 * @typedef {{ username: string, rank: number|null, totalScore: number, submittedAt: string|null, challenges: Object, hasPerChallengeData: boolean }} LeaderboardEntry
 */

module.exports = {
  fetchChallenges,
  fetchLeaderboard,
  fetchUserChallenges,
  fetchChallengeSubmission,
  fetchUserComparison,
  fetchLatestSubmissionTimestamp,
  sleep,
  normalizeDifficulty,
};

