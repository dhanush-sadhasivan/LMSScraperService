require('dotenv').config();
const express = require('express');

const progressRoutes = require('./src/routes/progress');
const challengesRoutes = require('./src/routes/challenges');
const statusRoutes = require('./src/routes/status');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

// API key authentication guard
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (API_KEY) {
    const provided = req.headers['x-api-key'];
    if (provided !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized: invalid or missing x-api-key header' });
    }
  }
  next();
});

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.use('/scrape/challenges', challengesRoutes);
app.use('/scrape/progress', progressRoutes);
app.use('/scrape/status', statusRoutes);

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 HackerRank Scraper Service running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
  if (!API_KEY) {
    console.warn('⚠️  WARNING: API_KEY is not set — all endpoints are publicly accessible!\n');
  }
});
