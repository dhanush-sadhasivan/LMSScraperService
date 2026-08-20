/**
 * Challenges Scraper
 *
 * Fetches all challenges (questions) for a contest from HackerRank
 * and writes them directly to the Supabase `questions` table if contest exists,
 * or returns them for preview mode if creating a new contest.
 */

const { authenticate } = require('./auth');
const hr = require('./hackerrank');
const { getSupabaseClient } = require('./supabaseClient');

/**
 * Scrape all challenges for a contest and persist to DB if contestId resolved.
 *
 * @param {string} contestSlug  HackerRank contest slug (e.g. "fp-trainers-a-algorithm")
 * @param {string|null} contestId  Optional Supabase contest ID; if null, will be looked up by slug
 * @returns {Promise<{ contestId: string|null, questions: Array, count: number }>}
 */
async function run(contestSlug, contestId = null) {
  const supabase = getSupabaseClient();

  console.log(`\n[challenges] ▶ Scraping challenges for: ${contestSlug}`);

  // ── Resolve contest from DB if not provided ─────────────────────────────
  let resolvedContestId = contestId;

  if (!resolvedContestId) {
    try {
      const { data: contest } = await supabase
        .from('contests')
        .select('id')
        .eq('hackerrank_slug', contestSlug)
        .maybeSingle();

      if (contest) {
        resolvedContestId = contest.id;
      }
    } catch (err) {
      console.warn(`[challenges] Warning looking up contest in DB: ${err.message}`);
    }
  }

  console.log(`[challenges] Contest DB ID: ${resolvedContestId || 'None (Preview Mode)'}`);

  // ── Authenticate ───────────────────────────────────────────────────────────
  const email = process.env.HACKERRANK_EMAIL;
  const password = process.env.HACKERRANK_PASSWORD;
  if (!email || !password) throw new Error('HACKERRANK_EMAIL / HACKERRANK_PASSWORD environment variables are not set.');

  const client = await authenticate(email, password);

  // ── Fetch challenges from HackerRank ───────────────────────────────────────
  const challenges = await hr.fetchChallenges(client, contestSlug);

  if (!challenges || challenges.length === 0) {
    throw new Error(`No challenges found for contest "${contestSlug}". Check if the slug is correct and accessible on HackerRank.`);
  }

  console.log(`[challenges] Found ${challenges.length} challenges on HackerRank`);

  // ── Build DB / Preview rows ────────────────────────────────────────────────
  const BASE_URL = 'https://www.hackerrank.com';
  const now = new Date().toISOString();

  const rows = challenges.map((c, idx) => {
    // Domain is already intelligently extracted by hackerrank.js fetchChallenges
    // (title-prefix heuristic → HR track/category → 'General' fallback)
    const domain = c.domain || 'General';

    return {
      contest_id: resolvedContestId,
      slug: c.slug,
      title: c.name,
      displayTitle: c.name,
      topic: domain,
      difficulty: c.difficulty || 'Medium',
      max_score: Math.max(0, Math.round(parseFloat(c.maxScore) || 10)),
      maxScore: Math.max(0, Math.round(parseFloat(c.maxScore) || 10)),
      domain: domain,
      hackerrank_url: `${BASE_URL}/contests/${contestSlug}/challenges/${c.slug}`,
      questionLink: `${BASE_URL}/contests/${contestSlug}/challenges/${c.slug}`,
      order_index: c.order ?? idx,
    };
  });

  // ── Upsert to Supabase if resolvedContestId exists ─────────────────────────
  let inserted = null;
  if (resolvedContestId) {
    const questionsToInsert = rows.map(r => ({
      contest_id: r.contest_id,
      slug: r.slug,
      title: r.title,
      topic: r.topic,
      difficulty: r.difficulty,
      max_score: r.max_score,
      domain: r.domain,
      hackerrank_url: r.hackerrank_url,
      order_index: r.order_index,
    }));

    const { data: insertedRows, error: insertErr } = await supabase
      .from('questions')
      .upsert(questionsToInsert, { onConflict: 'contest_id,slug' })
      .select('id, slug, title, topic, difficulty, max_score, domain, order_index');

    if (insertErr) {
      console.error(`[challenges] Failed to insert questions into DB: ${insertErr.message}`);
    } else {
      inserted = insertedRows;

      // Soft-disable questions that were removed from the contest
      const scrapedSlugs = questionsToInsert.map(q => q.slug);
      if (scrapedSlugs.length > 0) {
        await supabase
          .from('questions')
          .update({ is_enabled: false })
          .eq('contest_id', resolvedContestId)
          .not('slug', 'in', `(${scrapedSlugs.join(',')})`);
      }
    }

    await supabase
      .from('contests')
      .update({ last_scraped_at: now })
      .eq('id', resolvedContestId);
  }

  console.log(`[challenges] ✅ Successfully processed ${challenges.length} questions for "${contestSlug}"`);

  return {
    contestId: resolvedContestId,
    questions: inserted || rows,
    count: challenges.length,
  };
}

module.exports = { run };
