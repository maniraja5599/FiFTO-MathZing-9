// NSE option chain proxy — uses stealth Playwright to bypass Akamai bot detection
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createServer } from 'http';

chromium.use(StealthPlugin());

const PORT = 3002;
let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchNSEOptionChain() {
  if (cachedData && Date.now() - cacheTime < CACHE_TTL) {
    console.log('[NSE] Serving from cache');
    return cachedData;
  }

  console.log('[NSE] Launching Chromium to fetch option chain...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9,en-IN;q=0.8' },
  });
  const page = await context.newPage();

  try {
    let expiryDates = [];
    let chainRecords = [];

    // Intercept contract-info (expiry dates) and option-chain-v3 (LTPs)
    page.on('response', async r => {
      const url = r.url();
      if (url.includes('option-chain-contract-info')) {
        const body = await r.text().catch(() => '{}');
        if (body.length > 2) {
          try {
            const j = JSON.parse(body);
            expiryDates = j?.expiryDates ?? j?.data?.expiryDates ?? [];
            console.log('[NSE] Expiry dates:', expiryDates.slice(0, 4));
          } catch {}
        }
      }
      if (url.includes('/api/option-chain-v3')) {
        const body = await r.text().catch(() => '{}');
        console.log('[NSE] option-chain-v3 response size:', body.length);
        if (body.length > 2) {
          try {
            const j = JSON.parse(body);
            chainRecords = j?.records?.data ?? j?.data ?? [];
            console.log('[NSE] Records fetched:', chainRecords.length);
          } catch {}
        }
      }
    });

    console.log('[NSE] Loading option-chain page...');
    await page.goto('https://www.nseindia.com/option-chain', {
      waitUntil: 'domcontentloaded',
      timeout: 40000,
    });

    // Wait for the page JS to fire the API calls (up to 40s)
    const deadline = Date.now() + 40000;
    while (chainRecords.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }

    if (chainRecords.length === 0) throw new Error('NSE option chain API returned no data');

    // Build a shape compatible with our existing app code
    const data = {
      records: {
        expiryDates,
        data: chainRecords,
      },
    };

    if (!data?.records?.expiryDates?.length) {
      throw new Error('Empty or invalid response from NSE');
    }

    console.log(`[NSE] Got data — expiries: ${data.records.expiryDates.slice(0, 3).join(', ')}`);
    cachedData = data;
    cacheTime = Date.now();
    return data;
  } finally {
    await browser.close();
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/nse/option-chain') {
    try {
      const data = await fetchNSEOptionChain();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[NSE] Error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    res.writeHead(404);
    res.end('{}');
  }
});

server.listen(PORT, () => {
  console.log(`[NSE] Proxy server running at http://localhost:${PORT}`);
  console.log('[NSE] App fetches from: http://localhost:3002/nse/option-chain');
});
