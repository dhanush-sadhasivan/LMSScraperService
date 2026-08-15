const puppeteer = require('puppeteer');
const axios = require('axios');

const BASE_URL = 'https://www.hackerrank.com';
const LOGIN_URL = `${BASE_URL}/auth/login`;

let cachedAxiosInstance = null;
let lastAuthTimestamp = 0;
const SESSION_TTL_MS = 25 * 60 * 1000; // 25 minutes

/**
 * Launches a headless browser, logs in to HackerRank, extracts session
 * cookies + CSRF token, closes the browser, and returns a pre-configured
 * axios instance ready to make authenticated API calls.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('axios').AxiosInstance>}
 */
async function authenticate(email, password) {
  // ── Check if we have a valid cached session ───────────────────────────────
  if (cachedAxiosInstance && (Date.now() - lastAuthTimestamp < SESSION_TTL_MS)) {
    try {
      const res = await cachedAxiosInstance.get('/rest/contests', { timeout: 8000 });
      if (res.status === 200) {
        console.log('[auth] ⚡ Reusing valid active HackerRank session (cached)');
        return cachedAxiosInstance;
      }
    } catch (e) {
      cachedAxiosInstance = null;
    }
  }

  console.log('[auth] Launching headless browser for login...');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  } catch (err) {
    console.warn('[auth] Default Puppeteer Chrome launch failed, trying system Chrome...', err.message);
    browser = await puppeteer.launch({
      headless: 'new',
      channel: 'chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 900 });

    // ── Navigate to login ──────────────────────────────────────────────────
    console.log('[auth] Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await _sleep(1500);

    // Dismiss any cookie consent banners
    await page.evaluate(() => {
      const selectors = [
        '#onetrust-accept-btn-handler',
        'button#accept-cookie',
        'button[data-testid="accept-cookies"]',
        '.cookie-banner button',
        'button.onetrust-close-btn-handler',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return; }
      }
      // Text-based fallback
      for (const btn of document.querySelectorAll('button')) {
        const t = btn.textContent.trim().toLowerCase();
        if (t === 'ok' || t.includes('accept all') || t.includes('accept cookies')) {
          btn.click(); return;
        }
      }
    });
    await _sleep(800);

    // Wait for password input (signals form is ready)
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });

    // ── Fill in credentials ────────────────────────────────────────────────
    console.log('[auth] Filling credentials...');

    // Find email input — try selectors in priority order
    const emailHandle = await _findFirst(page, [
      'input[name="username"]',
      'input[data-analytics="LoginUsername"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[type="text"]',
    ]);
    if (!emailHandle) throw new Error('[auth] Could not find email input');
    await emailHandle.click({ clickCount: 3 });
    await emailHandle.type(email, { delay: 30 });

    const passwordHandle = await _findFirst(page, [
      'input[name="password"]',
      'input#input-2',
      'input[type="password"]',
    ]);
    if (!passwordHandle) throw new Error('[auth] Could not find password input');
    await passwordHandle.click({ clickCount: 3 });
    await passwordHandle.type(password, { delay: 30 });

    // ── Submit ─────────────────────────────────────────────────────────────
    console.log('[auth] Submitting login...');

    // Listen for the login API response before clicking
    const loginResponsePromise = page
      .waitForResponse(
        (res) => res.url().includes('/rest/auth/login') && res.request().method() === 'POST',
        { timeout: 15000 }
      )
      .catch(() => null);

    const loginBtnHandle = await _findFirst(page, [
      'button[data-analytics="LoginPassword"]',
      'button.auth-button.btn-primary',
      'button[type="submit"]',
    ]) || await _findButtonByText(page, ['log in', 'login', 'sign in']);

    if (!loginBtnHandle) throw new Error('[auth] Could not find login button');
    await loginBtnHandle.click();

    const loginResponse = await loginResponsePromise;
    if (loginResponse) {
      const loginData = await loginResponse.json().catch(() => null);
      if (loginData && loginData.status !== true) {
        const msg = loginData.errors?.join(', ') || loginData.message || 'Unknown error';
        throw new Error(`[auth] Login rejected: ${msg}`);
      }
    }

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await _sleep(2000);

    // ── Extract cookies & CSRF token ───────────────────────────────────────
    const cookies = await page.cookies();
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    // Extract CSRF token (HackerRank uses _token or csrf header)
    const csrfToken = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="csrf-token"]');
      return meta?.getAttribute('content') || null;
    });

    // Verify session is valid
    const sessionOk = await page.evaluate(async () => {
      try {
        const r = await fetch('/rest/contests', { credentials: 'include' });
        return r.ok;
      } catch { return false; }
    });

    if (!sessionOk) {
      throw new Error('[auth] Session verification failed after login');
    }

    console.log('[auth] ✅ Login successful — browser session verified');
    console.log(`[auth] Extracted ${cookies.length} cookies`);

    // ── Build axios instance ───────────────────────────────────────────────
    const axiosInstance = axios.create({
      baseURL: BASE_URL,
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `${BASE_URL}/`,
        'Origin': BASE_URL,
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      timeout: 30000,
    });

    // Intercept 429 / 5xx and add auto-retry with exponential back-off
    axiosInstance.interceptors.response.use(
      (res) => res,
      async (err) => {
        const config = err.config;
        if (!config) return Promise.reject(err);

        const status = err.response?.status;
        config._retryCount = (config._retryCount || 0) + 1;

        if (config._retryCount <= 3 && (status === 429 || (status >= 500 && status < 600))) {
          const delay = Math.pow(2, config._retryCount) * 500; // 1s, 2s, 4s
          console.warn(`[auth] HTTP ${status} — retry ${config._retryCount}/3 in ${delay}ms...`);
          await _sleep(delay);
          return axiosInstance(config);
        }

        return Promise.reject(err);
      }
    );

    // Extract logged in username/handle for comparison API
    const loggedInUsername = await page.evaluate(() => {
      try {
        return window.HR?.currentUser?.username || window.HRData?.user?.username || null;
      } catch { return null; }
    }) || email.split('@')[0];

    axiosInstance.username = loggedInUsername;
    console.log(`[auth] Logged in user handle: ${loggedInUsername}`);

    cachedAxiosInstance = axiosInstance;
    lastAuthTimestamp = Date.now();

    return axiosInstance;
  } finally {
    await browser.close();
    console.log('[auth] Browser closed — using cookie-based axios for all subsequent requests');
  }
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function _findFirst(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) return el;
  }
  return null;
}

async function _findButtonByText(page, texts) {
  return page.evaluateHandle((texts) => {
    for (const btn of document.querySelectorAll('button')) {
      if (texts.includes(btn.textContent.trim().toLowerCase())) return btn;
    }
    return null;
  }, texts).then(async (handle) => {
    const isNull = await handle.evaluate((el) => el === null);
    return isNull ? null : handle;
  });
}

module.exports = { authenticate };
