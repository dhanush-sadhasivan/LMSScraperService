const { Router } = require('express');
const challengesScraper = require('../challengesScraper');

const router = Router();

/**
 * POST /scrape/challenges
 *
 * Body:
 *   {
 *     slug: string,           // HackerRank contest slug (required)
 *     contestId?: string,     // Supabase contest UUID (optional — looked up by slug if omitted)
 *   }
 *
 * Returns:
 *   { questions: Array, count: number, contestId: string }
 *
 * This endpoint is synchronous — it waits for all challenges to be fetched
 * and stored before responding. Challenge counts are small (< 50 typically)
 * so this is fine.
 */
router.post('/', async (req, res) => {
  const { slug, contestId } = req.body;

  // ── Validate ─────────────────────────────────────────────────────────────
  if (!slug || typeof slug !== 'string') {
    return res.status(400).json({ error: 'slug (string) is required' });
  }

  console.log(`[routes/challenges] Scraping challenges for slug="${slug}"${contestId ? ` (contestId=${contestId})` : ''}`);

  try {
    const result = await challengesScraper.run(slug, contestId || null);

    return res.json({
      ok: true,
      contestId: result.contestId,
      count: result.count,
      questions: result.questions,
    });
  } catch (err) {
    console.error(`[routes/challenges] Error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
