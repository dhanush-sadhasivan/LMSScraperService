const { Router } = require('express');
const jobStore = require('../jobStore');

const router = Router();

/**
 * GET /scrape/status/:jobId
 *
 * Returns the current state of a background progress scrape job.
 *
 * Response:
 *   {
 *     jobId: string,
 *     status: 'pending' | 'running' | 'done' | 'error',
 *     progress: number,     // users processed so far
 *     total: number,        // total users in this job
 *     message: string,
 *     error: string | null,
 *     contestId: string,
 *     contestSlug: string,
 *     startedAt: string,
 *     finishedAt: string | null,
 *   }
 */
router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  const job = jobStore.getJob(jobId);

  if (!job) {
    return res.status(404).json({
      error: `Job "${jobId}" not found. It may have expired or never existed.`,
    });
  }

  return res.json({ jobId, ...job });
});

module.exports = router;
