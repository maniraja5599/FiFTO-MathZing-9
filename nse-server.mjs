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
    const allRecords = new Map(); // strike+expiry -> record

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
        if (body.length > 2) {
          try {
            const j = JSON.parse(body);
            const records = j?.records?.data ?? j?.data ?? [];
            // Extract expiry from the first CE in first record
            const expLabel = records[0]?.CE?.expiryDate ?? 'unknown';
            console.log(`[NSE] Records for ${expLabel}: ${records.length}`);
            for (const rec of records) {
              const key = `${rec.strikePrice}_${expLabel}`;
              allRecords.set(key, rec);
            }
            console.log(`[NSE] Total unique records so far: ${allRecords.size}`);
          } catch {}
        }
      }
    });

    console.log('[NSE] Loading option-chain page...');
    await page.goto('https://www.nseindia.com/option-chain', {
      waitUntil: 'domcontentloaded',
      timeout: 40000,
    });

    // Wait for first expiry data to arrive (up to 30s)
    const deadline1 = Date.now() + 30000;
    while (allRecords.size === 0 && Date.now() < deadline1) {
      await page.waitForTimeout(500);
    }
    console.log(`[NSE] First expiry loaded. Records: ${allRecords.size}`);

    // Fetch additional expiries by calling the NSE API directly from within the page context
    // This uses the page's existing session/cookies, bypassing Akamai
    const targetExpiries = ['16-Jun-2026', '23-Jun-2026'];
    for (const exp of targetExpiries) {
      try {
        const moreRecords = await page.evaluate(async (expiryLabel) => {
          const resp = await fetch(`/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=${encodeURIComponent(expiryLabel)}`, {
            credentials: 'include',
          });
          if (!resp.ok) return [];
          const j = await resp.json();
          return j?.records?.data ?? j?.data ?? [];
        }, exp);
        if (moreRecords.length > 0) {
          const expLabel = moreRecords[0]?.CE?.expiryDate ?? exp;
          console.log(`[NSE] Fetched ${moreRecords.length} records for ${expLabel}`);
          for (const rec of moreRecords) {
            const key = `${rec.strikePrice}_${expLabel}`;
            allRecords.set(key, rec);
          }
        } else {
          console.log(`[NSE] No records returned for expiry ${exp}`);
        }
      } catch (e) {
        console.log(`[NSE] Failed to fetch expiry ${exp}:`, e.message);
      }
    }
    console.log(`[NSE] After additional expiries: ${allRecords.size} total records`);

    if (allRecords.size === 0) throw new Error('NSE option chain API returned no data');

    const mergedRecords = [...allRecords.values()];
    const data = {
      records: {
        expiryDates,
        data: mergedRecords,
      },
    };

    if (!data?.records?.expiryDates?.length) {
      throw new Error('Empty or invalid response from NSE');
    }

    console.log(`[NSE] Got data — expiries: ${data.records.expiryDates.slice(0, 3).join(', ')}`);
    console.log(`[NSE] Merged records: ${mergedRecords.length}`);
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
