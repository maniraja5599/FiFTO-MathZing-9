// Angel One SmartAPI proxy — NIFTY historical OHLC + option LTPs via instrument master
import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { generate as totpGenerate } from 'otplib';

const PORT = 3001;
const BASE = 'https://apiconnect.angelone.in';
const NIFTY_TOKEN = '99926000'; // NIFTY 50 index token on NSE
const INSTRUMENT_MASTER_URL = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_FILE = './angel-config.json';
if (!existsSync(CONFIG_FILE)) {
  console.error('[Angel] angel-config.json not found.');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));

// ── Auth ──────────────────────────────────────────────────────────────────────
let jwtToken = null;
let tokenExpiry = 0;

async function login() {
  if (jwtToken && Date.now() < tokenExpiry) return jwtToken;
  const totpCode = await totpGenerate({ secret: cfg.totpSecret });
  console.log('[Angel] Logging in...');
  const res = await fetch(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': cfg.apiKey,
    },
    body: JSON.stringify({ clientcode: cfg.clientCode, password: cfg.password, totp: totpCode }),
  });
  const json = await res.json();
  if (!json.status || !json.data?.jwtToken) throw new Error(`Login failed: ${json.message}`);
  jwtToken = json.data.jwtToken;
  tokenExpiry = Date.now() + 8 * 60 * 60 * 1000;
  console.log('[Angel] Login OK');
  return jwtToken;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${jwtToken}`,
    'X-PrivateKey': cfg.apiKey,
    Accept: 'application/json',
    'X-UserType': 'USER', 'X-SourceID': 'WEB', 'Content-Type': 'application/json',
    'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
  };
}

// ── Instrument Master (cached daily, persisted to disk) ───────────────────────
const MASTER_CACHE_FILE = './instrument-master-cache.json';
let masterData = null;
let masterCacheDate = '';

async function getInstrumentMaster() {
  const today = new Date().toISOString().split('T')[0];
  if (masterData && masterCacheDate === today) return masterData;

  // Try disk cache first
  if (existsSync(MASTER_CACHE_FILE)) {
    try {
      const disk = JSON.parse(readFileSync(MASTER_CACHE_FILE, 'utf8'));
      if (disk.date === today && Array.isArray(disk.data)) {
        masterData = disk.data;
        masterCacheDate = today;
        console.log(`[Angel] Instrument master loaded from disk cache — ${masterData.length} records`);
        return masterData;
      }
    } catch {}
  }

  console.log('[Angel] Fetching instrument master from web...');
  const res = await fetch(INSTRUMENT_MASTER_URL);
  masterData = await res.json();
  masterCacheDate = today;
  console.log(`[Angel] Instrument master loaded — ${masterData.length} records`);

  // Save to disk
  try {
    writeFileSync(MASTER_CACHE_FILE, JSON.stringify({ date: today, data: masterData }));
    console.log('[Angel] Instrument master cached to disk');
  } catch (e) {
    console.warn('[Angel] Could not write disk cache:', e.message);
  }

  return masterData;
}

// Convert display expiry "24Apr2026" → master format "24APR2026"
function toMasterExpiry(expiry) {
  return expiry.toUpperCase();
}

// ── Expiry Dates (derived from instrument master) ─────────────────────────────
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function parseMasterExpiry(exp) {
  // "28APR2026" → Date
  const dd = parseInt(exp.slice(0, 2), 10);
  const mmStr = exp.slice(2, 5);
  const yyyy = parseInt(exp.slice(5), 10);
  const mm = MONTHS.indexOf(mmStr);
  return new Date(yyyy, mm, dd);
}

async function computeNiftyExpiries(count = 8) {
  const master = await getInstrumentMaster();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const niftyExpiries = [...new Set(
    master
      .filter(r => r.exch_seg === 'NFO' && r.name === 'NIFTY' && r.instrumenttype === 'OPTIDX')
      .map(r => r.expiry)
  )].filter(exp => parseMasterExpiry(exp) >= today)
    .sort((a, b) => parseMasterExpiry(a) - parseMasterExpiry(b));

  return niftyExpiries.slice(0, count);
}

// ── Historical OHLC (NIFTY index) ─────────────────────────────────────────────
async function fetchHistorical(toDateStr) {
  await login();
  const toDate = new Date(toDateStr);
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 10);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 09:15`;
  const fmtEnd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 15:30`;
  const res = await fetch(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ exchange: 'NSE', symboltoken: NIFTY_TOKEN, interval: 'ONE_DAY', fromdate: fmt(fromDate), todate: fmtEnd(toDate) }),
  });
  const json = await res.json();
  if (!json.status || !Array.isArray(json.data)) throw new Error(`Historical fetch failed: ${json.message}`);
  const candles = json.data.filter(c => c[2] && c[3]);
  if (candles.length < 2) throw new Error('Not enough historical data');
  const last2 = candles.slice(-2);
  const fmtDate = (ts) => ts ? ts.split('T')[0] : '';
  return {
    day1High: last2[1][2], day1Low: last2[1][3],
    day2High: last2[0][2], day2Low: last2[0][3],
    day1Date: fmtDate(last2[1][0]),
    day2Date: fmtDate(last2[0][0]),
  };
}

// ── Fetch LTP for a single option token via historical API ────────────────────
async function fetchOptionLTP(token, exchange = 'NFO', attempt = 0, toDateStr = null) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  // Use toDateStr directly — same as fetchHistorical. Frontend already adjusts for market-open.
  const eod = toDateStr ? new Date(toDateStr) : (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })();
  const fromDate = new Date(eod);
  fromDate.setDate(fromDate.getDate() - 5);

  const res = await fetch(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      exchange,
      symboltoken: token,
      interval: 'ONE_DAY',
      fromdate: `${fmt(fromDate)} 09:15`,
      todate: `${fmt(eod)} 15:30`,
    }),
  });
  const raw = await res.text();
  if (!raw.startsWith('{"status"')) {
    if (raw.includes('rate') && attempt < 2) {
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      return fetchOptionLTP(token, exchange, attempt + 1, toDateStr);
    }
    console.log(`[Angel] LTP token ${token} error: ${raw.slice(0, 80)}`);
    return 0;
  }
  const json = JSON.parse(raw);
  if (!json.status || !Array.isArray(json.data) || json.data.length === 0) return 0;
  // Use 2-day lowest low (index 3 = low) so premium filter matches strategy logic
  const candles = json.data.slice(-2);
  const twoDLL = candles.length >= 2
    ? Math.min(candles[0][3], candles[1][3])
    : candles[0][3] ?? 0;
  return twoDLL;
}

// ── Fetch 2-day OHLC for a single option token ───────────────────────────────
async function fetch2DayOptionOHLC(token, attempt = 0, toDateStr = null) {
  await login();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  // Use toDateStr directly — same as fetchHistorical. Frontend already adjusts for market-open.
  const eod = toDateStr ? new Date(toDateStr) : (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })();
  const fromDate = new Date(eod);
  fromDate.setDate(fromDate.getDate() - 10);

  const res = await fetch(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      exchange: 'NFO', symboltoken: token, interval: 'ONE_DAY',
      fromdate: `${fmt(fromDate)} 09:15`,
      todate: `${fmt(eod)} 15:30`,
    }),
  });
  const raw = await res.text();
  if (!raw.startsWith('{"status"')) {
    if (raw.includes('rate') && attempt < 2) {
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      return fetch2DayOptionOHLC(token, attempt + 1, toDateStr);
    }
    throw new Error(`Option OHLC failed: ${raw.slice(0, 80)}`);
  }
  const json = JSON.parse(raw);
  if (!json.status || !Array.isArray(json.data) || json.data.length < 2)
    throw new Error('Not enough option OHLC data');

  const last2 = json.data.slice(-2);
  const day2 = last2[0]; // previous day
  const day1 = last2[1]; // most recent day
  const twoDHH = Math.max(day1[2], day2[2]);
  const twoDLL = Math.min(day1[3], day2[3]);
  return {
    day1High: day1[2], day1Low: day1[3],
    day2High: day2[2], day2Low: day2[3],
    twoDHH, twoDLL,
  };
}

// ── Fetch live OI for a batch of NFO tokens via market quote API ──────────────
async function fetchLiveOI(tokens) {
  // Angel One quote API accepts up to 50 tokens per request
  const BATCH = 50;
  const oiMap = new Map(); // token → openInterest
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    try {
      const res = await fetch(`${BASE}/rest/secure/angelbroking/market/v1/quote/`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ mode: 'FULL', exchangeTokens: { NFO: batch } }),
      });
      const raw = await res.text();
      if (!raw.startsWith('{"status"')) { console.warn('[Angel] OI batch error:', raw.slice(0, 80)); continue; }
      const json = JSON.parse(raw);
      const fetched = json.data?.fetched ?? [];
      for (const item of fetched) {
        oiMap.set(String(item.symbolToken), item.opnInterest ?? item.openInterest ?? 0);
      }
    } catch (e) {
      console.warn('[Angel] OI fetch error:', e.message);
    }
  }
  return oiMap;
}

// ── Option Chain via instrument master + historical LTPs ──────────────────────
const ocCache = new Map(); // key → { time, data }

async function fetchOptionChain(expiryRaw, strikesParam, toDateStr = null) {
  const expiry = toMasterExpiry(expiryRaw);
  const requestedStrikes = strikesParam
    ? strikesParam.split(',').map(Number).filter(Boolean)
    : null;

  const cacheKey = `${expiry}:${strikesParam ?? 'all'}:${toDateStr ?? 'today'}`;
  const cached = ocCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.data;

  await login();
  const master = await getInstrumentMaster();

  // Filter NIFTY options for this expiry
  let opts = master.filter(r =>
    r.exch_seg === 'NFO' &&
    r.name === 'NIFTY' &&
    r.instrumenttype === 'OPTIDX' &&
    r.expiry === expiry
  );

  if (opts.length === 0) {
    console.log(`[Angel] No options found for expiry ${expiry}`);
    return [];
  }

  // If specific strikes requested, filter to those
  if (requestedStrikes && requestedStrikes.length > 0) {
    const strikeSet = new Set(requestedStrikes);
    opts = opts.filter(r => strikeSet.has(Math.round(Number(r.strike) / 100)));
  }

  console.log(`[Angel] Fetching OI + 2D Low for ${opts.length} option contracts (expiry: ${expiry})`);

  // Group by strike
  const byStrike = new Map();
  for (const r of opts) {
    const strike = Math.round(Number(r.strike) / 100);
    if (!byStrike.has(strike)) byStrike.set(strike, {});
    const optType = r.symbol.includes('CE') ? 'CE' : 'PE';
    byStrike.get(strike)[optType] = r.token;
  }

  // Batch-fetch live OI for all tokens in one go (fast, single API call batch)
  const allTokens = opts.map(r => r.token);
  const oiMap = await fetchLiveOI(allTokens);
  console.log(`[Angel] OI fetched for ${oiMap.size} tokens`);

  // Fetch 2D Low for each strike sequentially (rate-limited historical API)
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  const results = [];
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  for (const strike of strikes) {
    const tokens = byStrike.get(strike);
    const [ceLTP, peLTP] = await Promise.all([
      tokens.CE ? fetchOptionLTP(tokens.CE, 'NFO', 0, toDateStr).catch(() => 0) : Promise.resolve(0),
      tokens.PE ? fetchOptionLTP(tokens.PE, 'NFO', 0, toDateStr).catch(() => 0) : Promise.resolve(0),
    ]);
    results.push({
      strikePrice: strike,
      CE: tokens.CE ? { lastPrice: ceLTP, openInterest: oiMap.get(String(tokens.CE)) ?? 0 } : undefined,
      PE: tokens.PE ? { lastPrice: peLTP, openInterest: oiMap.get(String(tokens.PE)) ?? 0 } : undefined,
    });
    await delay(300); // 300ms between strikes to stay under rate limit
  }

  console.log(`[Angel] Option chain done — ${results.length} strikes`);
  ocCache.set(cacheKey, { time: Date.now(), data: results });
  return results;
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // GET /angel/historical?toDate=2026-04-22
    if (url.pathname === '/angel/historical') {
      const toDate = url.searchParams.get('toDate') ?? new Date().toISOString().split('T')[0];
      const data = await fetchHistorical(toDate);
      return send(res, 200, data);
    }

    // GET /angel/expiry
    if (url.pathname === '/angel/expiry') {
      const dates = await computeNiftyExpiries(8);
      return send(res, 200, { expiryDates: dates });
    }

    // GET /angel/option-chain?expiry=24APR2026&strikes=24300,24350,...&toDate=2026-04-25
    if (url.pathname === '/angel/option-chain') {
      const expiry = url.searchParams.get('expiry');
      if (!expiry) return send(res, 400, { error: 'expiry param required' });
      const strikes = url.searchParams.get('strikes') ?? null;
      const toDate  = url.searchParams.get('toDate') ?? null;
      const data = await fetchOptionChain(expiry, strikes, toDate);
      return send(res, 200, { data });
    }

    // GET /angel/option-ohlc?expiry=28APR2026&strike=24350&type=CE&toDate=2026-04-25
    if (url.pathname === '/angel/option-ohlc') {
      const expiry  = url.searchParams.get('expiry');
      const strike  = parseInt(url.searchParams.get('strike'));
      const type    = url.searchParams.get('type'); // CE or PE
      const toDate  = url.searchParams.get('toDate') ?? null;
      if (!expiry || !strike || !type) return send(res, 400, { error: 'expiry, strike, type required' });

      const master = await getInstrumentMaster();
      const opt = master.find(r =>
        r.exch_seg === 'NFO' && r.name === 'NIFTY' && r.instrumenttype === 'OPTIDX' &&
        r.expiry === expiry.toUpperCase() &&
        Math.round(Number(r.strike) / 100) === strike &&
        (type === 'CE' ? r.symbol.endsWith('CE') : r.symbol.endsWith('PE'))
      );
      if (!opt) return send(res, 404, { error: `Option not found: NIFTY ${expiry} ${strike} ${type}` });

      console.log(`[Angel] Fetching 2D OHLC for ${opt.symbol} (token ${opt.token})`);
      const data = await fetch2DayOptionOHLC(opt.token, 0, toDate);
      return send(res, 200, data);
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[Angel] Error:', err.message);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Angel] Server running at http://127.0.0.1:${PORT} (internal only)`);
  console.log('[Angel] Endpoints:');
  console.log(`  GET /angel/historical?toDate=YYYY-MM-DD`);
  console.log(`  GET /angel/expiry`);
  // Pre-warm instrument master cache in background
  getInstrumentMaster().catch(e => console.error('[Angel] Instrument master pre-warm failed:', e.message));
  console.log(`  GET /angel/option-chain?expiry=24APR2026&strikes=24300,24350,...`);
});
