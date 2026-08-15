const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const jobStore = require('../jobStore');
const progressScraper = require('../progressScraper');

const router = Router();

/**
 * POST /scrape/progress
 *
 * Body:
 *   {
 *     contestId: string,        // Supabase contest UUID
 *     contestSlug: string,      // HackerRank contest slug
 *     questions: Array<{ slug, questionName, maxScore }>,
 *     users: Array<{ user_id, hackerrank_id }>
 *   }
 *
 * Returns:
 *   { jobId: string, message: string, userCount: number, questionCount: number }
 */
router.post('/', async (req, res) => {
  const { contestId, contestSlug, questions, users } = req.body;

  // ── Validate ─────────────────────────────────────────────────────────────
  if (!contestId || typeof contestId !== 'string') {
    return res.status(400).json({ error: 'contestId (string) is required' });
  }
  if (!contestSlug || typeof contestSlug !== 'string') {
    return res.status(400).json({ error: 'contestSlug (string) is required' });
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions (non-empty array) is required' });
  }
  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: 'users (non-empty array) is required' });
  }

  const invalidUsers = users.filter((u) => !u.user_id || !u.hackerrank_id);
  if (invalidUsers.length > 0) {
    return res.status(400).json({
      error: `${invalidUsers.length} user(s) are missing user_id or hackerrank_id`,
    });
  }

  // ── Create job ────────────────────────────────────────────────────────────
  const jobId = uuidv4();
  jobStore.createJob(jobId, contestId, contestSlug, users.length);

  console.log(`[routes/progress] New job ${jobId}: ${users.length} users, ${questions.length} questions, contest="${contestSlug}"`);

  // ── Start background scrape (fire-and-forget) ─────────────────────────────
  setImmediate(() => {
    progressScraper
      .run(jobId, contestId, contestSlug, questions, users)
      .catch((err) => {
        console.error(`[routes/progress] Unhandled error in job ${jobId}:`, err);
        jobStore.markError(jobId, err.message || 'Unknown error');
      });
  });

  return res.status(202).json({
    jobId,
    message: `Progress scrape started for ${users.length} user(s) across ${questions.length} question(s)`,
    userCount: users.length,
    questionCount: questions.length,
  });
});

module.exports = router;
