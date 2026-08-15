/**
 * In-memory job store.
 *
 * Each job tracks: status, progress counters, error, timestamps.
 * Jobs are stored in a Map keyed by jobId (UUID).
 * They expire and are cleaned up after JOB_TTL_MS to prevent memory leaks.
 */

const JOB_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** @type {Map<string, JobState>} */
const _jobs = new Map();

/**
 * @typedef {{
 *   status: 'pending' | 'running' | 'done' | 'error',
 *   progress: number,
 *   total: number,
 *   message: string,
 *   error: string | null,
 *   contestId: string,
 *   contestSlug: string,
 *   startedAt: string,
 *   finishedAt: string | null,
 * }} JobState
 */

/**
 * Create a new job entry and return its state.
 * @param {string} jobId
 * @param {string} contestId
 * @param {string} contestSlug
 * @param {number} total
 * @returns {JobState}
 */
function createJob(jobId, contestId, contestSlug, total) {
  /** @type {JobState} */
  const job = {
    status: 'pending',
    progress: 0,
    total,
    message: 'Job queued',
    error: null,
    contestId,
    contestSlug,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  _jobs.set(jobId, job);

  // Auto-cleanup after TTL
  setTimeout(() => _jobs.delete(jobId), JOB_TTL_MS);

  return job;
}

/**
 * Update a job's fields in-place.
 * @param {string} jobId
 * @param {Partial<JobState>} updates
 */
function updateJob(jobId, updates) {
  const job = _jobs.get(jobId);
  if (!job) return;
  Object.assign(job, updates);
}

/**
 * Mark a job as running.
 * @param {string} jobId
 */
function markRunning(jobId) {
  updateJob(jobId, { status: 'running', message: 'Scraping in progress...' });
}

/**
 * Increment progress counter and update message.
 * @param {string} jobId
 * @param {number} [increment=1]
 * @param {string} [message]
 */
function incrementProgress(jobId, increment = 1, message) {
  const job = _jobs.get(jobId);
  if (!job) return;
  job.progress = Math.min(job.progress + increment, job.total);
  if (message) job.message = message;
}

/**
 * Mark a job as done.
 * @param {string} jobId
 * @param {string} [message]
 */
function markDone(jobId, message = 'Scraping complete') {
  updateJob(jobId, {
    status: 'done',
    progress: _jobs.get(jobId)?.total ?? 0,
    message,
    finishedAt: new Date().toISOString(),
  });
}

/**
 * Mark a job as errored.
 * @param {string} jobId
 * @param {string} errorMessage
 */
function markError(jobId, errorMessage) {
  updateJob(jobId, {
    status: 'error',
    error: errorMessage,
    message: `Error: ${errorMessage}`,
    finishedAt: new Date().toISOString(),
  });
}

/**
 * Get a job by ID.
 * @param {string} jobId
 * @returns {JobState | null}
 */
function getJob(jobId) {
  return _jobs.get(jobId) ?? null;
}

module.exports = {
  createJob,
  updateJob,
  markRunning,
  incrementProgress,
  markDone,
  markError,
  getJob,
};
