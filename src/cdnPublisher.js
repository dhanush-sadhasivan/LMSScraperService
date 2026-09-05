/**
 * CDN Publisher Module
 *
 * Pre-aggregates sanitized leaderboard and contest snapshots and uploads them
 * to the Supabase Storage 'api-cache' public bucket.
 *
 * This enables the LMS to fetch pre-computed JSON directly from the Supabase Smart CDN,
 * routing read traffic through the 5 GB Cached Egress allowance instead of depleting
 * the Uncached Database Egress limit.
 */

const { getSupabaseClient } = require('./supabaseClient');

const BUCKET_NAME = 'api-cache';
const CACHE_CONTROL_HEADER = 'public, max-age=180, s-maxage=180'; // 3 minutes CDN cache

/**
 * Canonical check for whether a submission/progress record is solved.
 * Returns true if and only if p.status === 'solved' AND
 * (if max_score > 0, score >= max_score; otherwise score > 0).
 */
function isRecordSolved(p) {
  if (!p) return false;
  if (p.status !== 'solved') return false;
  const score = p.score != null ? Number(p.score) : 0;
  const maxScore = p.max_score != null ? Number(p.max_score) : 0;
  if (Number.isFinite(maxScore) && maxScore > 0) {
    return Number.isFinite(score) && score >= maxScore;
  }
  return Number.isFinite(score) && score > 0;
}

/**
 * Upload a JSON snapshot to Supabase Storage.
 *
 * @param {string} fileName - E.g. 'leaderboard.json' or 'contest_<id>.json'
 * @param {object|array} data - The data payload to serialize
 */
async function _uploadJsonSnapshot(fileName, data) {
  const supabase = getSupabaseClient();
  const jsonString = JSON.stringify(data);
  const buffer = Buffer.from(jsonString, 'utf-8');

  // Ensure bucket exists or auto-create if possible
  try {
    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, buffer, {
        contentType: 'application/json',
        cacheControl: '0',
        upsert: true,
      });

    if (uploadError) {
      // If bucket doesn't exist yet, attempt creation
      if (uploadError.message?.includes('Bucket not found') || uploadError.error === 'Bucket not found') {
        console.log(`[cdnPublisher] Bucket '${BUCKET_NAME}' not found. Creating it...`);
        await supabase.storage.createBucket(BUCKET_NAME, { public: true });
        // Retry upload
        await supabase.storage.from(BUCKET_NAME).upload(fileName, buffer, {
          contentType: 'application/json',
          cacheControl: '180',
          upsert: true,
        });
      } else {
        console.warn(`[cdnPublisher] ⚠️ Failed to upload ${fileName} to CDN storage:`, uploadError.message);
        return false;
      }
    }

    console.log(`[cdnPublisher] 🚀 Published CDN snapshot: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (err) {
    console.warn(`[cdnPublisher] ⚠️ Error publishing ${fileName}:`, err.message);
    return false;
  }
}

/**
 * Generate and publish the global leaderboard snapshot (leaderboard.json).
 * Sanitizes all output to ensure ZERO PII (no emails, phone numbers, tokens).
 */
async function publishGlobalLeaderboard() {
  const supabase = getSupabaseClient();
  console.log('[cdnPublisher] Generating global leaderboard snapshot...');

  try {
    // 1. Fetch non-admin user profiles (sanitized fields only)
    let users = [];
    let uFrom = 0;
    const uStep = 1000;
    while (true) {
      const { data: uPage, error: uErr } = await supabase
        .from('users').select('id, full_name, emp_id, team')
        .neq('role', 'admin')
        .order('id', { ascending: true })
        .range(uFrom, uFrom + uStep - 1);
      if (uErr || !uPage || uPage.length === 0) break;
      users = users.concat(uPage);
      if (uPage.length < uStep) break;
      uFrom += uStep;
    }

    const userMap = new Map();
    users.forEach((u) => {
      userMap.set(u.id, {
        id: u.id,
        user_id: u.id,
        name: u.full_name || 'Anonymous',
        emp_id: u.emp_id || '—',
        team: u.team || 'N/A',
        score: 0,
        solved: 0,
      });
    });

    // 2. Fetch all scoring progress rows in chunks
    let allProgressRows = [];
    let pFrom = 0;
    const pStep = 1000;

    while (true) {
      const { data: pageRows, error: pErr } = await supabase
        .from('progress')
        .select('user_id, question_id, score, status, max_score')
        .or('score.gt.0,status.eq.solved')
        .order('id', { ascending: true })
        .range(pFrom, pFrom + pStep - 1);

      if (pErr || !pageRows || pageRows.length === 0) break;
      allProgressRows = allProgressRows.concat(pageRows);
      if (pageRows.length < pStep) break;
      pFrom += pStep;
    }

    // 3. Deduplicate by (user_id, question_id) and aggregate scores
    // A question solved across multiple contests/roadmaps only counts once with highest score
    const userQuestionMap = new Map();
    allProgressRows.forEach((p) => {
      if (!p.user_id || !p.question_id) return;
      const key = `${p.user_id}:${p.question_id}`;
      const existing = userQuestionMap.get(key);
      const isSolved = isRecordSolved(p);
      if (!existing) {
        userQuestionMap.set(key, {
          user_id: p.user_id,
          score: p.score || 0,
          isSolved,
        });
      } else {
        existing.score = Math.max(existing.score, p.score || 0);
        if (isSolved) existing.isSolved = true;
      }
    });

    userQuestionMap.forEach((item) => {
      const entry = userMap.get(item.user_id);
      if (entry) {
        entry.score += item.score;
        if (item.isSolved) entry.solved++;
      }
    });

    // 4. Sort and format leaderboard (Sanitized: display-safe fields only, NO emp_id, email, or UUIDs)
    const globalPerformers = Array.from(userMap.values())
      .sort((a, b) => (b.score - a.score) || (b.solved - a.solved) || (a.name || '').localeCompare(b.name || ''))
      .map((entry, idx) => ({
        rank: idx + 1,
        name: entry.name,
        team: entry.team,
        score: entry.score,
        solved: entry.solved,
      }));

    const payload = {
      updated_at: new Date().toISOString(),
      performers: globalPerformers,
    };

    return await _uploadJsonSnapshot('leaderboard.json', payload);
  } catch (err) {
    console.error('[cdnPublisher] Failed to build global leaderboard:', err.message);
    return false;
  }
}

/**
 * Generate and publish contest-specific snapshot (contest_<contestId>.json).
 *
 * @param {string} contestId
 */
async function publishContestCache(contestId) {
  if (!contestId) return false;
  const supabase = getSupabaseClient();
  console.log(`[cdnPublisher] Generating contest snapshot for: ${contestId}...`);

  try {
    // 1. Fetch contest and questions
    const { data: contest, error: cErr } = await supabase
      .from('contests')
      .select('id, title, hackerrank_slug, start_date, end_date, last_scraped_at, questions(*)')
      .eq('id', contestId)
      .single();

    if (cErr || !contest) {
      console.warn(`[cdnPublisher] Contest not found for ID ${contestId}:`, cErr?.message);
      return false;
    }

    const allQuestions = (contest.questions || []).sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    const enabledQuestions = allQuestions.filter((q) => q.is_enabled !== false);
    const enabledQuestionIds = new Set(enabledQuestions.map((q) => q.id));
    const totalMaxScore = enabledQuestions.reduce((sum, q) => sum + (q.max_score || 10), 0);

    // 2. Fetch assigned user profiles
    const { data: assignments } = await supabase
      .from('contest_assignments')
      .select('group_id, team')
      .eq('contest_id', contestId);

    const groupIds = [];
    const teams = [];
    (assignments || []).forEach((a) => {
      if (a.group_id) groupIds.push(a.group_id);
      if (a.team && a.team.trim() !== '') teams.push(a.team.trim());
    });

    const assignedUserIds = new Set();

    if (groupIds.length > 0) {
      const { data: groupMembers } = await supabase
        .from('group_members')
        .select('user_id, users!inner(role)')
        .in('group_id', groupIds)
        .neq('users.role', 'admin');
      (groupMembers || []).forEach((gm) => {
        if (gm.user_id) assignedUserIds.add(gm.user_id);
      });
    }

    if (teams.length > 0) {
      const { data: teamUsers } = await supabase
        .from('users')
        .select('id')
        .in('team', teams)
        .neq('role', 'admin');
      (teamUsers || []).forEach((tu) => {
        if (tu.id) assignedUserIds.add(tu.id);
      });
    }

    // Fetch user details for assigned users (strictly non-admin)
    const userList = [];
    if (assignedUserIds.size > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, full_name, emp_id, team, hackerrank_id, leetcode_id')
        .in('id', Array.from(assignedUserIds))
        .neq('role', 'admin');
      if (users) userList.push(...users);
    }

    const leaderboardMap = new Map();
    userList.forEach((u) => {
      leaderboardMap.set(u.id, {
        user_id: u.id,
        name: u.full_name || 'Anonymous',
        emp_id: u.emp_id || '—',
        team: u.team || 'N/A',
        hackerrank_id: u.hackerrank_id || null,
        leetcode_id: u.leetcode_id || null,
        solved: 0,
        total: enabledQuestions.length,
        score: 0,
        maxScore: totalMaxScore,
        lastActive: null,
        progress: [],
      });
    });

    // 3. Fetch progress rows for this contest
    let progressRows = [];
    let from = 0;
    const step = 1000;

    while (true) {
      const { data: pageRows, error: pErr } = await supabase
        .from('progress')
        .select('user_id, question_id, status, score, max_score, last_submission_at, updated_at')
        .eq('contest_id', contestId)
        .order('id', { ascending: true })
        .range(from, from + step - 1);

      if (pErr || !pageRows || pageRows.length === 0) break;
      progressRows = progressRows.concat(pageRows);
      if (pageRows.length < step) break;
      from += step;
    }

    // Overlay progress on assigned users with deduplication
    const contestUserQuestionMap = new Map();
    progressRows.forEach((p) => {
      if (!p.user_id || !p.question_id || !enabledQuestionIds.has(p.question_id)) return;
      const key = `${p.user_id}:${p.question_id}`;
      const isSolved = isRecordSolved(p);
      const score = Number(p.score) || 0;
      const maxScore = Number(p.max_score) || 10;
      const isActive = isSolved || p.status === 'attempted' || score > 0;
      const subTime = p.last_submission_at || (isActive ? p.updated_at : null);

      const existing = contestUserQuestionMap.get(key);
      if (!existing) {
        contestUserQuestionMap.set(key, {
          ...p,
          score,
          max_score: maxScore,
          isSolved,
          isActive,
          subTime,
        });
      } else {
        existing.score = Math.max(existing.score, score);
        if (isSolved) existing.isSolved = true;
        if (isActive) existing.isActive = true;
        if (subTime && (!existing.subTime || new Date(subTime) > new Date(existing.subTime))) {
          existing.subTime = subTime;
        }
      }
    });

    contestUserQuestionMap.forEach((p) => {
      const u = leaderboardMap.get(p.user_id);
      if (u) {
        if (p.isSolved) u.solved++;
        u.score += p.score;
        if (p.subTime && (!u.lastActive || new Date(p.subTime) > new Date(u.lastActive))) {
          u.lastActive = p.subTime;
        }
        u.progress.push({
          question_id: p.question_id,
          status: p.isSolved ? 'solved' : (p.score > 0 || p.status === 'attempted' ? 'attempted' : (p.status || 'unattempted')),
          score: p.score,
          max_score: p.max_score,
          last_submission_at: p.last_submission_at,
        });
      }
    });

    // Sanitize leaderboard for public CDN snapshot (strictly no internal user_id, emp_id, or email)
    const sortedLeaderboard = Array.from(leaderboardMap.values())
      .sort((a, b) => (b.score - a.score) || (b.solved - a.solved) || (a.name || '').localeCompare(b.name || ''))
      .map((entry, idx) => ({
        rank: idx + 1,
        name: entry.name,
        team: entry.team,
        hackerrank_id: entry.hackerrank_id || null,
        leetcode_id: entry.leetcode_id || null,
        solved: entry.solved,
        total: entry.total,
        score: entry.score,
        maxScore: entry.maxScore,
        lastActive: entry.lastActive,
        progress: (entry.progress || []).map((p) => ({
          question_id: p.question_id,
          status: p.status,
          score: p.score,
          max_score: p.max_score,
          last_submission_at: p.last_submission_at,
        })),
      }));

    const sanitizedQuestions = (allQuestions || []).map((q) => ({
      id: q.id,
      slug: q.slug,
      title: q.title,
      difficulty: q.difficulty,
      domain: q.domain,
      max_score: q.max_score,
      order_index: q.order_index,
      is_enabled: q.is_enabled,
    }));

    const payload = {
      contest_id: contestId,
      updated_at: new Date().toISOString(),
      questions: sanitizedQuestions,
      enabled_question_count: enabledQuestions.length,
      total_max_score: totalMaxScore,
      leaderboard: sortedLeaderboard,
    };

    return await _uploadJsonSnapshot(`contest_${contestId}.json`, payload);
  } catch (err) {
    console.error(`[cdnPublisher] Failed to build contest cache for ${contestId}:`, err.message);
    return false;
  }
}

/**
 * Publish roadmap analytics snapshot (roadmap_analytics.json).
 */
async function publishRoadmapAnalytics() {
  const supabase = getSupabaseClient();
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc('get_roadmap_analytics');
    if (!rpcErr && rpcData) {
      await _uploadJsonSnapshot('roadmap_analytics.json', {
        updated_at: new Date().toISOString(),
        roadmaps: rpcData,
      });
      return true;
    }
  } catch (err) {
    console.warn('[cdnPublisher] ⚠️ Error publishing roadmap analytics snapshot:', err.message);
  }
  return false;
}

/**
 * Publish Internal Training trainer overview snapshot (disabled from public CDN).
 */
async function publishITTrainerOverview() {
  // Disabled: IT overview contains trainer emails and employee details and must not be published to the public bucket.
  return false;
}

/**
 * Publish contest snapshot, global leaderboard, and roadmap analytics snapshots.
 *
 * @param {string} contestId
 */
async function publishContestAndGlobalCache(contestId) {
  try {
    await Promise.all([
      publishContestCache(contestId),
      publishGlobalLeaderboard(),
      publishRoadmapAnalytics(),
    ]);
    console.log(`[cdnPublisher] ✅ All CDN cache snapshots generated successfully for contest ${contestId}`);
  } catch (err) {
    console.warn('[cdnPublisher] ⚠️ Error publishing caches:', err.message);
  }
}

module.exports = {
  publishGlobalLeaderboard,
  publishContestCache,
  publishRoadmapAnalytics,
  publishITTrainerOverview,
  publishContestAndGlobalCache,
};
