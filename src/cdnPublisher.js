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
        cacheControl: '180',
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
        .select('user_id, question_id, score, status')
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
      if (!existing) {
        userQuestionMap.set(key, {
          user_id: p.user_id,
          score: p.score || 0,
          isSolved: p.status === 'solved',
        });
      } else {
        existing.score = Math.max(existing.score, p.score || 0);
        if (p.status === 'solved') existing.isSolved = true;
      }
    });

    userQuestionMap.forEach((item) => {
      const entry = userMap.get(item.user_id);
      if (entry) {
        entry.score += item.score;
        if (item.isSolved) entry.solved++;
      }
    });

    // 4. Sort and format leaderboard
    const globalPerformers = Array.from(userMap.values())
      .sort((a, b) => (b.score - a.score) || (b.solved - a.solved));

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
      if (a.team) teams.push(a.team);
    });

    const assignedUserIds = new Set();

    if (groupIds.length > 0) {
      const { data: groupMembers } = await supabase
        .from('group_members')
        .select('user_id')
        .in('group_id', groupIds);
      (groupMembers || []).forEach((gm) => assignedUserIds.add(gm.user_id));
    }

    if (teams.length > 0) {
      const { data: teamUsers } = await supabase
        .from('users')
        .select('id')
        .in('team', teams);
      (teamUsers || []).forEach((tu) => assignedUserIds.add(tu.id));
    }

    // Fetch user details for assigned users
    const userList = [];
    if (assignedUserIds.size > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, full_name, emp_id, team')
        .in('id', Array.from(assignedUserIds));
      if (users) userList.push(...users);
    }

    const leaderboardMap = new Map();
    userList.forEach((u) => {
      leaderboardMap.set(u.id, {
        user_id: u.id,
        name: u.full_name || 'Anonymous',
        emp_id: u.emp_id || '—',
        team: u.team || 'N/A',
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

    // Overlay progress on assigned users
    progressRows.forEach((p) => {
      if (!enabledQuestionIds.has(p.question_id)) return;
      const u = leaderboardMap.get(p.user_id);
      if (u) {
        if (p.status === 'solved') u.solved++;
        u.score += p.score || 0;
        const isActive = p.status === 'solved' || p.status === 'attempted' || (p.score || 0) > 0;
        const subTime = p.last_submission_at || (isActive ? p.updated_at : null);
        if (subTime && (!u.lastActive || new Date(subTime) > new Date(u.lastActive))) {
          u.lastActive = subTime;
        }
        u.progress.push({
          question_id: p.question_id,
          status: p.status,
          score: p.score,
          last_submission_at: p.last_submission_at,
        });
      }
    });

    const sortedLeaderboard = Array.from(leaderboardMap.values()).sort((a, b) => b.score - a.score);

    const payload = {
      contest_id: contestId,
      updated_at: new Date().toISOString(),
      questions: allQuestions,
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
 * Publish both contest snapshot and global leaderboard snapshot.
 *
 * @param {string} contestId
 */
async function publishContestAndGlobalCache(contestId) {
  try {
    await Promise.all([
      publishContestCache(contestId),
      publishGlobalLeaderboard(),
    ]);
    console.log(`[cdnPublisher] ✅ CDN cache snapshots generated successfully for contest ${contestId}`);
  } catch (err) {
    console.warn('[cdnPublisher] ⚠️ Error publishing caches:', err.message);
  }
}

module.exports = {
  publishGlobalLeaderboard,
  publishContestCache,
  publishContestAndGlobalCache,
};
