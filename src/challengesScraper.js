/**
 * Challenges Scraper
 *
 * Fetches all challenges (questions) for a contest from HackerRank
 * and writes them directly to the Supabase `questions` table.
 *
 * Resolves the contest_id from the DB using the hackerrank_slug.
 * Upserts on (contest_id, slug) to safely re-run without duplicates.
 */

const { authenticate } = require('./auth');
const hr = require('./hackerrank');
const { getSupabaseClient } = require('./supabaseClient');

/**
 * Scrape all challenges for a contest and persist to DB.
 *
 * @param {string} contestSlug  HackerRank contest slug (e.g. "fp-trainers-a-algorithm")
 * @param {string|null} contestId  Optional Supabase contest ID; if null, will be looked up by slug
 * @returns {Promise<{ contestId: string, questions: Array, count: number }>}
 */
async function run(contestSlug, contestId = null) {
  const supabase = getSupabaseClient();

  console.log(`\n[challenges] ▶ Scraping challenges for: ${contestSlug}`);

  // ── Resolve contest from DB ────────────────────────────────────────────────
  let resolvedContestId = contestId;

  if (!resolvedContestId) {
    const { data: contest, error } = await supabase
      .from('contests')
      .select('id')
      .eq('hackerrank_slug', contestSlug)
      .maybeSingle();

    if (error) throw new Error(`DB error looking up contest: ${error.message}`);
    if (!contest) throw new Error(`Contest with slug "${contestSlug}" not found in database. Create it first.`);

    resolvedContestId = contest.id;
  }

  console.log(`[challenges] Contest DB ID: ${resolvedContestId}`);

  // ── Authenticate ───────────────────────────────────────────────────────────
  const email = process.env.HACKERRANK_EMAIL;
  const password = process.env.HACKERRANK_PASSWORD;
  if (!email || !password) throw new Error('HACKERRANK_EMAIL / HACKERRANK_PASSWORD not set');

  const client = await authenticate(email, password);

  // ── Fetch challenges from HackerRank ───────────────────────────────────────
  const challenges = await hr.fetchChallenges(client, contestSlug);

  if (challenges.length === 0) {
    throw new Error(`No challenges found for contest "${contestSlug}". Check the slug and your HackerRank access.`);
  }

  console.log(`[challenges] Found ${challenges.length} challenges`);

  // ── Build DB rows ──────────────────────────────────────────────────────────
  const BASE_URL = 'https://www.hackerrank.com';
  const now = new Date().toISOString();

  const rows = challenges.map((c, idx) => ({
    contest_id: resolvedContestId,
    slug: c.slug,
    title: c.name,
    difficulty: c.difficulty,
    max_score: Math.max(0, Math.round(parseFloat(c.maxScore) || 10)),
    domain: c.domain || 'General',
    hackerrank_url: `${BASE_URL}/contests/${contestSlug}/challenges/${c.slug}`,
    order_index: c.order ?? idx,
  }));

  // ── Upsert to Supabase ─────────────────────────────────────────────────────
  // Delete existing questions and re-insert to keep ordering accurate
  // (upsert doesn't cleanly handle removed questions)
  const { error: deleteErr } = await supabase
    .from('questions')
    .delete()
    .eq('contest_id', resolvedContestId);

  if (deleteErr) {
    console.warn(`[challenges] Warning: could not delete existing questions: ${deleteErr.message}`);
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('questions')
    .insert(rows)
    .select('id, slug, title, difficulty, max_score, domain, order_index');

  if (insertErr) throw new Error(`Failed to insert questions: ${insertErr.message}`);

  // ── Update last_scraped_at ─────────────────────────────────────────────────
  await supabase
    .from('contests')
    .update({ last_scraped_at: now })
    .eq('id', resolvedContestId);

  console.log(`[challenges] ✅ Inserted ${inserted?.length ?? rows.length} questions into DB`);

  return {
    contestId: resolvedContestId,
    questions: inserted || rows,
    count: inserted?.length ?? rows.length,
  };
}

module.exports = { run };
