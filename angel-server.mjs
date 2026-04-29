// Angel One SmartAPI proxy — NIFTY historical OHLC + option LTPs via instrument master
import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createSign } from 'crypto';
import { generate as totpGenerate } from 'otplib';

// ── Minimal .env loader (keeps secrets out of the browser build) ──────────────
const ENV_FILE = './.env';
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// ── Server-side disk cache (shared across all LAN devices) ────────────────────
const CACHE_DIR = './server-cache';
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function _cacheFile(key) {
  return join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180) + '.json');
}

function diskGet(key) {
  const file = _cacheFile(key);
  if (!existsSync(file)) return null;
  try {
    const { data, expires } = JSON.parse(readFileSync(file, 'utf8'));
    if (expires && Date.now() > expires) return null;
    return data;
  } catch { return null; }
}

function diskSet(key, data, ttlMs = null) {
  try {
    writeFileSync(_cacheFile(key), JSON.stringify({
      data,
      expires: ttlMs ? Date.now() + ttlMs : null,
      savedAt: new Date().toISOString(),
    }));
  } catch (e) { console.warn('[Cache] Write failed:', e.message); }
}

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

// ── Google Sheets Trade Log ───────────────────────────────────────────────────
const GSHEET_ID = process.env.GSHEET_ID || cfg.googleSheetId || '1kAhm4Pb9byYQalMelu8f_lRKDek2OueBrSCyqOwjPR8';
const GSHEET_TAB = process.env.GSHEET_TAB || cfg.googleSheetTab || 'Trade Log';
const GSHEET_SYNC_DEBOUNCE_MS = Number(process.env.GSHEET_SYNC_DEBOUNCE_MS || 15000);

function b64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getGoogleServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const json = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return { email: json.client_email, privateKey: json.private_key };
  }
  return {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || cfg.googleServiceAccountEmail,
    privateKey: process.env.GOOGLE_PRIVATE_KEY || cfg.googlePrivateKey,
  };
}

function getGooglePrivateKey(privateKey) {
  return privateKey?.replace(/\\n/g, '\n');
}

async function getGoogleAccessToken() {
  const { email, privateKey } = getGoogleServiceAccount();
  const normalizedKey = getGooglePrivateKey(privateKey);
  if (!GSHEET_ID || !email || !normalizedKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(normalizedKey, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const assertion = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${json.error_description || json.error || res.status}`);
  return json.access_token;
}

function sheetRange(tab, range = 'A1') {
  return `'${String(tab).replace(/'/g, "''")}'!${range}`;
}

async function gsheetFetch(path, token, options = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GSHEET_ID}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Google Sheets failed: ${json.error?.message || res.status}`);
  return json;
}

async function ensureGoogleSheetTab(token) {
  const spreadsheet = await gsheetFetch('?fields=sheets.properties.title', token);
  const exists = spreadsheet.sheets?.some(s => s.properties?.title === GSHEET_TAB);
  if (exists) return;
  await gsheetFetch(':batchUpdate', token, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: GSHEET_TAB } } }],
    }),
  });
}

function tradeRows(trades) {
  const headers = [
    'id', 'date', 'type', 'optType', 'strike', 'expiry', 'strategyName', 'lotSize',
    'entryPrice', 'targetPrice', 'stopLoss', 'status', 'placedAt', 'triggeredAt',
    'triggeredLTP', 'exitAt', 'exitPrice', 'pnl', 'carryToNextDay', 'exitReason',
    'currentLTP', 'runningPnl', 'slNeedsRecalc', 'signalSource', 'recalcScenario',
    'orderAmount', 'exitAmount', 'updatedAt', 'expiredAt', 'syncedAt',
  ];
  const syncedAt = new Date().toISOString();
  const rows = trades.map(t => {
    const orderAmount = Number(t.entryPrice || 0) * Number(t.lotSize || 0);
    const exitAmount = t.exitPrice === undefined ? '' : Number(t.exitPrice || 0) * Number(t.lotSize || 0);
    return headers.map(h => {
      if (h === 'orderAmount') return orderAmount || '';
      if (h === 'exitAmount') return exitAmount;
      if (h === 'syncedAt') return syncedAt;
      const value = t[h];
      return value === undefined || value === null ? '' : value;
    });
  });
  return [headers, ...rows];
}

let gsheetTimer = null;
let gsheetSyncing = false;
let gsheetPending = false;

function scheduleGoogleTradeSync() {
  if (!GSHEET_ID) return;
  const { email, privateKey } = getGoogleServiceAccount();
  if (!email || !privateKey) return;
  clearTimeout(gsheetTimer);
  gsheetTimer = setTimeout(() => syncTradesToGoogleSheet().catch(e => {
    console.warn('[GoogleSheet] Sync failed:', e.message);
  }), GSHEET_SYNC_DEBOUNCE_MS);
}

async function syncTradesToGoogleSheet() {
  if (gsheetSyncing) {
    gsheetPending = true;
    return { queued: true };
  }
  gsheetSyncing = true;
  try {
    const token = await getGoogleAccessToken();
    if (!token) return { skipped: true, reason: 'missing Google service-account credentials' };
    const trades = loadTrades();
    await ensureGoogleSheetTab(token);
    await gsheetFetch(`/values/${encodeURIComponent(sheetRange(GSHEET_TAB, 'A:AD'))}:clear`, token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await gsheetFetch(`/values/${encodeURIComponent(sheetRange(GSHEET_TAB, 'A1'))}?valueInputOption=USER_ENTERED`, token, {
      method: 'PUT',
      body: JSON.stringify({ values: tradeRows(trades) }),
    });
    console.log(`[GoogleSheet] Synced ${trades.length} trade(s) to "${GSHEET_TAB}"`);
    return { ok: true, count: trades.length, sheetId: GSHEET_ID, tab: GSHEET_TAB };
  } finally {
    gsheetSyncing = false;
    if (gsheetPending) {
      gsheetPending = false;
      scheduleGoogleTradeSync();
    }
  }
}

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
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function nseDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

function parseNseDate(dateStr) {
  const MONTH = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' };
  const [d, mon, y] = String(dateStr).split('-');
  return `${y}-${MONTH[mon?.toUpperCase()] ?? '01'}-${String(d).padStart(2, '0')}`;
}

function valuesDiffer(a, b, tolerance = 0.05) {
  return Math.abs(Number(a) - Number(b)) > tolerance;
}

function buildHistoricalResult(last2) {
  return {
    day1High: last2[1].high, day1Low: last2[1].low,
    day2High: last2[0].high, day2Low: last2[0].low,
    day1Date: last2[1].date,
    day2Date: last2[0].date,
  };
}

async function fetchAngelHistorical(toDateStr) {
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
  return buildHistoricalResult(last2.map(c => ({ date: fmtDate(c[0]), high: c[2], low: c[3] })));
}

async function fetchNseLiveIndex() {
  const res = await fetch('https://www.nseindia.com/api/allIndices', {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
      'Referer': 'https://www.nseindia.com/',
    },
  });
  const json = await res.json();
  if (!res.ok || !Array.isArray(json.data)) throw new Error(`NSE live fetch failed: ${res.status}`);
  const row = json.data.find(r => r.index === 'NIFTY 50');
  if (!row) throw new Error('NSE live NIFTY 50 row missing');
  return {
    date: istDateString(),
    high: row.high,
    low: row.low,
  };
}

async function fetchNseHistorical(toDateStr) {
  const from = addDays(toDateStr, -12);
  const api = `https://www.nseindia.com/api/historicalOR/indicesHistory?indexType=NIFTY%2050&from=${nseDate(from)}&to=${nseDate(toDateStr)}`;
  const res = await fetch(api, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
      'Referer': 'https://www.nseindia.com/reports-indices-historical-index-data',
    },
  });
  const json = await res.json();
  if (!res.ok || !Array.isArray(json.data)) throw new Error(`NSE historical fetch failed: ${res.status}`);

  const rows = json.data
    .map(r => ({
      date: parseNseDate(r.EOD_TIMESTAMP),
      high: r.EOD_HIGH_INDEX_VAL,
      low: r.EOD_LOW_INDEX_VAL,
    }))
    .filter(r => r.date && r.high && r.low)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (toDateStr === istDateString() && (!rows.length || rows[rows.length - 1].date < toDateStr)) {
    try {
      const live = await fetchNseLiveIndex();
      if (live.date === toDateStr && live.high && live.low) rows.push(live);
    } catch (e) {
      console.warn('[NSE] Live fallback failed:', e.message);
    }
  }

  if (rows.length < 2) throw new Error('Not enough NSE historical data');
  return buildHistoricalResult(rows.slice(-2));
}

async function fetchHistorical(toDateStr) {
  const ck = `historical_verified_${toDateStr}`;
  const warnings = [];
  const [angelSettled, nseSettled] = await Promise.allSettled([
    fetchAngelHistorical(toDateStr),
    fetchNseHistorical(toDateStr),
  ]);

  const angel = angelSettled.status === 'fulfilled' ? angelSettled.value : null;
  const nse = nseSettled.status === 'fulfilled' ? nseSettled.value : null;

  if (angelSettled.status === 'rejected') warnings.push(`Angel One failed: ${angelSettled.reason?.message ?? angelSettled.reason}`);
  if (nseSettled.status === 'rejected') warnings.push(`NSE failed: ${nseSettled.reason?.message ?? nseSettled.reason}`);

  let result = nse ?? angel;
  let source = nse ? 'NSE' : 'Angel One';
  if (!result) {
    const hit = diskGet(ck);
    if (hit) return { ...hit, source: 'verified-cache', warnings };
    throw new Error(warnings.join('; ') || 'Historical fetch failed');
  }

  if (angel && nse) {
    const mismatch =
      angel.day1Date !== nse.day1Date || angel.day2Date !== nse.day2Date ||
      valuesDiffer(angel.day1High, nse.day1High) || valuesDiffer(angel.day1Low, nse.day1Low) ||
      valuesDiffer(angel.day2High, nse.day2High) || valuesDiffer(angel.day2Low, nse.day2Low);

    if (mismatch) {
      warnings.push(`Angel One/NSE mismatch; using NSE. Angel day1 ${angel.day1Date} H:${angel.day1High} L:${angel.day1Low}, NSE day1 ${nse.day1Date} H:${nse.day1High} L:${nse.day1Low}`);
    } else {
      source = 'Angel One + NSE';
    }
  }

  result = { ...result, source, angelData: angel, nseData: nse, warnings };
  diskSet(ck, result);
  return result;
}

// ── Fetch LTP for a single option token via historical API ────────────────────
async function fetchOptionLTP(token, exchange = 'NFO', attempt = 0, toDateStr = null) {
  if (toDateStr) {
    const hit = diskGet(`ltp_${token}_${toDateStr}`);
    if (hit !== null) return hit;
  }
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
  if (toDateStr && twoDLL > 0) diskSet(`ltp_${token}_${toDateStr}`, twoDLL);
  return twoDLL;
}

// ── Fetch 2-day OHLC for a single option token ───────────────────────────────
async function fetch2DayOptionOHLC(token, attempt = 0, toDateStr = null) {
  if (toDateStr) {
    const hit = diskGet(`ohlc2d_${token}_${toDateStr}`);
    if (hit) { console.log(`[Cache] Option OHLC hit: token=${token} date=${toDateStr}`); return hit; }
  }
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
  const result = { day1High: day1[2], day1Low: day1[3], day2High: day2[2], day2Low: day2[3], twoDHH, twoDLL };
  if (toDateStr) diskSet(`ohlc2d_${token}_${toDateStr}`, result);
  return result;
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
  // 1. Memory cache (sub-ms, same process)
  const cached = ocCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.data;
  // 2. Disk cache (cross-device LAN, cross-restart) — only for dated EOD requests
  if (toDateStr) {
    const diskHit = diskGet(`chain_${cacheKey}`);
    if (diskHit) {
      console.log(`[Cache] Option chain disk hit: ${cacheKey}`);
      ocCache.set(cacheKey, { time: Date.now(), data: diskHit });
      return diskHit;
    }
  }

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
  if (toDateStr) diskSet(`chain_${cacheKey}`, results); // persist for LAN devices
  return results;
}

// ── Fetch NIFTY Spot first 15-min candle (09:15–09:30) for a given date ──────
async function fetchNifty15MinCandle(dateStr) {
  const hit = diskGet(`candle15_${dateStr}`);
  if (hit) { console.log(`[Cache] 15-min candle hit: ${dateStr}`); return hit; }
  await login();
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const fromdate = `${y}-${m}-${dd} 09:15`;
  const todate   = `${y}-${m}-${dd} 09:30`;
  const res = await fetch(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ exchange: 'NSE', symboltoken: NIFTY_TOKEN, interval: 'FIFTEEN_MINUTE', fromdate, todate }),
  });
  const json = await res.json();
  if (!json.status || !Array.isArray(json.data) || json.data.length === 0)
    throw new Error('No 15-min candle data for ' + dateStr);
  const c = json.data[0]; // [timestamp, open, high, low, close, volume]
  const result = { timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4] };
  diskSet(`candle15_${dateStr}`, result); // immutable after market close
  return result;
}

// ── Fetch live option chain (live LTP + OI) via market quote FULL mode ────────
async function fetchLiveOptionChain(expiryRaw, strikesParam) {
  const expiry = toMasterExpiry(expiryRaw);
  await login();
  const master = await getInstrumentMaster();

  let opts = master.filter(r =>
    r.exch_seg === 'NFO' && r.name === 'NIFTY' &&
    r.instrumenttype === 'OPTIDX' && r.expiry === expiry
  );
  if (strikesParam) {
    const strikeSet = new Set(strikesParam.split(',').map(Number).filter(Boolean));
    opts = opts.filter(r => strikeSet.has(Math.round(Number(r.strike) / 100)));
  }

  const allTokens = opts.map(r => r.token);
  const BATCH = 50;
  const quoteMap = new Map(); // token → { ltp, oi }
  for (let i = 0; i < allTokens.length; i += BATCH) {
    const batch = allTokens.slice(i, i + BATCH);
    try {
      const res = await fetch(`${BASE}/rest/secure/angelbroking/market/v1/quote/`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ mode: 'FULL', exchangeTokens: { NFO: batch } }),
      });
      const json = await res.json();
      for (const item of json.data?.fetched ?? []) {
        quoteMap.set(String(item.symbolToken), {
          ltp: item.ltp ?? item.lastPrice ?? 0,
          oi:  item.opnInterest ?? item.openInterest ?? 0,
        });
      }
    } catch (e) { console.warn('[Angel] Live chain batch error:', e.message); }
  }

  const byStrike = new Map();
  for (const r of opts) {
    const strike = Math.round(Number(r.strike) / 100);
    if (!byStrike.has(strike)) byStrike.set(strike, {});
    const optType = r.symbol.includes('CE') ? 'CE' : 'PE';
    const q = quoteMap.get(String(r.token)) ?? { ltp: 0, oi: 0 };
    byStrike.get(strike)[optType] = { lastPrice: q.ltp, openInterest: q.oi };
  }

  return [...byStrike.entries()]
    .sort(([a], [b]) => a - b)
    .map(([strike, data]) => ({ strikePrice: strike, CE: data.CE, PE: data.PE }));
}

// ── Fetch live LTP for specific CE + PE option strikes ────────────────────────
async function fetchLiveLTPs(ceExpiryRaw, ceStrikeNum, peExpiryRaw, peStrikeNum) {
  await login();
  const master = await getInstrumentMaster();

  const findToken = (expiryRaw, strike, type) => {
    if (!expiryRaw || !strike) return null;
    const expiry = toMasterExpiry(expiryRaw);
    const r = master.find(m =>
      m.exch_seg === 'NFO' && m.name === 'NIFTY' && m.instrumenttype === 'OPTIDX' &&
      m.expiry === expiry &&
      Math.round(Number(m.strike) / 100) === strike &&
      (type === 'CE' ? m.symbol.endsWith('CE') : m.symbol.endsWith('PE'))
    );
    return r?.token ?? null;
  };

  const ceToken = findToken(ceExpiryRaw, ceStrikeNum, 'CE');
  const peToken = findToken(peExpiryRaw, peStrikeNum, 'PE');
  const tokens = [ceToken, peToken].filter(Boolean);
  if (tokens.length === 0) return { ceLTP: 0, peLTP: 0 };

  const res = await fetch(`${BASE}/rest/secure/angelbroking/market/v1/quote/`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ mode: 'LTP', exchangeTokens: { NFO: tokens } }),
  });
  const json = await res.json();
  const ltpMap = new Map();
  for (const item of json.data?.fetched ?? [])
    ltpMap.set(String(item.symbolToken), item.ltp ?? item.lastPrice ?? 0);

  return {
    ceLTP: ceToken ? (ltpMap.get(String(ceToken)) ?? 0) : 0,
    peLTP: peToken ? (ltpMap.get(String(peToken)) ?? 0) : 0,
  };
}

// ── Paper Trade Storage ───────────────────────────────────────────────────────
const TRADES_FILE = './server-cache/paper-trades.json';

function loadTrades() {
  try { if (existsSync(TRADES_FILE)) return JSON.parse(readFileSync(TRADES_FILE, 'utf8')); } catch {}
  return [];
}
function saveTrades(trades) {
  writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  scheduleGoogleTradeSync();
}
function addTrade(trade) {
  const trades = loadTrades(); trades.push(trade); saveTrades(trades);
}
function updateTrade(id, updates) {
  const trades = loadTrades();
  const idx = trades.findIndex(t => t.id === id);
  if (idx === -1) return null;
  trades[idx] = { ...trades[idx], ...updates };
  saveTrades(trades);
  return trades[idx];
}
function removeTradesForDate(dateStr) {
  const trades = loadTrades();
  const next = trades.filter(t => t.date !== dateStr);
  const removed = trades.length - next.length;
  if (removed > 0) saveTrades(next);
  return { removed, remaining: next.length, date: dateStr };
}

function istDateString() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function expireStalePendingOrders(dateStr = istDateString()) {
  const trades = loadTrades();
  let expired = 0;
  const now = new Date().toISOString();
  const next = trades.map(t => {
    if (t.status === 'PENDING' && t.date && t.date < dateStr) {
      expired++;
      return { ...t, status: 'EXPIRED', expiredAt: now, updatedAt: now, exitReason: 'NOT_TRIGGERED' };
    }
    return t;
  });
  if (expired > 0) {
    saveTrades(next);
    console.log(`[Trade] Expired ${expired} stale pending order(s) before ${dateStr}`);
  }
  return expired;
}

// ── Batch live LTP for multiple options ───────────────────────────────────────
async function batchFetchLTPs(options) {
  // options: [{expiry, strike, optType, id}]
  if (!options.length) return new Map();
  await login();
  const master = await getInstrumentMaster();
  const tokenToId = new Map();
  for (const { expiry, strike, optType, id } of options) {
    const opt = master.find(r =>
      r.exch_seg === 'NFO' && r.name === 'NIFTY' && r.instrumenttype === 'OPTIDX' &&
      r.expiry === toMasterExpiry(expiry) &&
      Math.round(Number(r.strike) / 100) === strike &&
      (optType === 'CE' ? r.symbol.endsWith('CE') : r.symbol.endsWith('PE'))
    );
    if (opt) tokenToId.set(String(opt.token), id);
  }
  if (!tokenToId.size) return new Map();
  try {
    const res = await fetch(`${BASE}/rest/secure/angelbroking/market/v1/quote/`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode: 'LTP', exchangeTokens: { NFO: [...tokenToId.keys()] } }),
    });
    const json = await res.json();
    const result = new Map();
    for (const item of json.data?.fetched ?? []) {
      const id = tokenToId.get(String(item.symbolToken));
      if (id) result.set(id, item.ltp ?? item.lastPrice ?? 0);
    }
    return result;
  } catch { return new Map(); }
}

// ── Market open check ─────────────────────────────────────────────────────────
function isMarketOpen() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930; // 09:15–15:30
}
function istMinutes() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// ── Poll open trades every N seconds ─────────────────────────────────────────
let pollIntervalMs = (cfg.ltpPollIntervalSec ?? 5) * 1000;
let pollTimer = null;

async function pollOpenTrades() {
  const dateStr = istDateString();
  expireStalePendingOrders(dateStr);
  const trades = loadTrades().filter(t => t.status === 'TRIGGERED' || (t.status === 'PENDING' && t.date === dateStr));
  if (!trades.length) return;

  const ltpMap = await batchFetchLTPs(trades.map(t => ({ expiry: t.expiry, strike: t.strike, optType: t.optType, id: t.id })));
  const tok = cfg.telegramToken; const cid = cfg.telegramChatId;
  const now = new Date().toISOString();
  const timeMins = istMinutes();
  const marketOpen = isMarketOpen();

  for (const trade of trades) {
    const ltp = ltpMap.get(trade.id);
    if (!ltp || ltp <= 0) continue;

    if (trade.status === 'PENDING') {
      // Only trigger entries during market hours
      if (marketOpen && ltp <= trade.entryPrice) {
        updateTrade(trade.id, { status: 'TRIGGERED', triggeredAt: now, triggeredLTP: ltp, carryToNextDay: false });
        console.log(`[Trade] TRIGGERED: ${trade.strike} ${trade.optType} @ ₹${ltp}`);
        if (tok && cid) tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
✅ <b>Order Triggered — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📊 ${trade.expiry} · ${trade.strategyName}
💰 Entry: ₹${ltp.toFixed(1)} (limit: ₹${trade.entryPrice.toFixed(1)})
🎯 Target: ₹${trade.targetPrice.toFixed(1)}
🛑 SL: ₹${trade.stopLoss.toFixed(1)}
💼 ${trade.lotSize} units · ₹${(ltp * trade.lotSize).toFixed(0)}`);
      }
    } else if (trade.status === 'TRIGGERED') {
      // Always update currentLTP + running P&L (shown even outside market hours)
      const runningPnl = (trade.entryPrice - ltp) * trade.lotSize;
      updateTrade(trade.id, { currentLTP: ltp, runningPnl });

      // Target / SL checks only during market hours
      if (!marketOpen) continue;
      const canTarget = !trade.carryToNextDay || timeMins >= 555; // 09:15
      const canSL     = !trade.carryToNextDay || timeMins >= 565; // 09:25

      if (canTarget && ltp <= trade.targetPrice) {
        const pnl = (trade.entryPrice - ltp) * trade.lotSize;
        updateTrade(trade.id, { status: 'TARGET_HIT', exitAt: now, exitPrice: ltp, pnl });
        console.log(`[Trade] TARGET HIT: ${trade.strike} ${trade.optType} P&L ₹${pnl.toFixed(0)}`);
        if (tok && cid) tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
🎯 <b>Target Hit! — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📈 Sold ₹${trade.entryPrice.toFixed(1)} → Closed ₹${ltp.toFixed(1)}
💰 P&L: <b>+₹${pnl.toFixed(0)}</b> (${trade.lotSize} units)
✅ Trade closed successfully`);
      } else if (canSL && ltp >= trade.stopLoss) {
        const pnl = (trade.entryPrice - ltp) * trade.lotSize;
        updateTrade(trade.id, { status: 'SL_HIT', exitAt: now, exitPrice: ltp, pnl });
        console.log(`[Trade] SL HIT: ${trade.strike} ${trade.optType} P&L ₹${pnl.toFixed(0)}`);
        if (tok && cid) tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
🛑 <b>Stop Loss Hit — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📉 Sold ₹${trade.entryPrice.toFixed(1)} → Closed ₹${ltp.toFixed(1)}
💰 P&L: <b>₹${pnl.toFixed(0)}</b> (${trade.lotSize} units)`);
      }
    }
  }
}

function startPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOpenTrades, pollIntervalMs);
  console.log(`[Poll] LTP polling started — interval: ${pollIntervalMs / 1000}s`);
}
startPollTimer();

// ── Fetch option candle for a given interval and time window ──────────────────
async function fetchOptionCandle(expiryRaw, strike, optType, dateStr, interval, fromTime, toTime) {
  await login();
  const master = await getInstrumentMaster();
  const opt = master.find(r =>
    r.exch_seg === 'NFO' && r.name === 'NIFTY' && r.instrumenttype === 'OPTIDX' &&
    r.expiry === toMasterExpiry(expiryRaw) &&
    Math.round(Number(r.strike) / 100) === strike &&
    (optType === 'CE' ? r.symbol.endsWith('CE') : r.symbol.endsWith('PE'))
  );
  if (!opt) { console.warn(`[SL] Token not found: ${strike} ${optType} ${expiryRaw}`); return null; }
  const d = new Date(dateStr);
  const y = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  try {
    const res = await fetch(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ exchange:'NFO', symboltoken: opt.token, interval, fromdate:`${y}-${mo}-${dd} ${fromTime}`, todate:`${y}-${mo}-${dd} ${toTime}` }),
    });
    const json = await res.json();
    if (!json.status || !Array.isArray(json.data) || !json.data.length) return null;
    const c = json.data[0];
    return { open: c[1], high: c[2], low: c[3], close: c[4] };
  } catch { return null; }
}

// ── 09:25 AM — SL check using 10-min candle (09:15–09:25) ────────────────────
let lastSLCheckDate = '';

async function checkCarriedSLAt0925(dateStr) {
  if (lastSLCheckDate === dateStr) return;
  const trades = loadTrades().filter(t => t.status === 'TRIGGERED' && t.carryToNextDay);
  if (!trades.length) { lastSLCheckDate = dateStr; return; }

  lastSLCheckDate = dateStr;
  const tok = cfg.telegramToken; const cid = cfg.telegramChatId;

  for (const trade of trades) {
    // Fetch 09:15–09:25 TEN_MINUTE candle of the option
    const candle10 = await fetchOptionCandle(trade.expiry, trade.strike, trade.optType, dateStr, 'TEN_MINUTE', '09:15', '09:25');
    if (!candle10) { console.warn(`[SL] No 10-min candle for ${trade.strike} ${trade.optType}`); continue; }

    console.log(`[SL] ${trade.strike} ${trade.optType}: 10m high=₹${candle10.high} SL=₹${trade.stopLoss}`);

    if (candle10.high < trade.stopLoss) {
      // Safe — 10m high is below SL, keep SL as-is
      console.log(`[SL] ${trade.strike} ${trade.optType}: 10m high ₹${candle10.high} < SL ₹${trade.stopLoss} → SL maintained ✅`);
      if (tok && cid) tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
✅ <b>SL Maintained — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📊 10-min candle (09:15–09:25): High ₹${candle10.high}
🛑 SL: ₹${trade.stopLoss}  (High ₹${candle10.high} &lt; SL → Safe)
💰 Entry: ₹${trade.entryPrice}
📅 ${trade.expiry}`);
    } else {
      // 10m high ≥ SL — flag for recalc after 15-min candle
      updateTrade(trade.id, { slNeedsRecalc: true });
      console.log(`[SL] ${trade.strike} ${trade.optType}: 10m high ₹${candle10.high} ≥ SL ₹${trade.stopLoss} → waiting for 15m candle`);
      if (tok && cid) tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
⚠️ <b>SL Check — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📊 10-min candle (09:15–09:25): High ₹${candle10.high}
🛑 Current SL: ₹${trade.stopLoss}
⚡ 10m High ≥ SL → Waiting for 15-min candle to recalculate
⏳ New SL will be set at 09:31 AM`);
    }
  }
}

// ── 09:31 AM — Recalculate SL using 15-min candle (09:15–09:30) if flagged ────
let lastSLRecalcDate = '';

async function recalcCarriedSLAt0931(dateStr) {
  if (lastSLRecalcDate === dateStr) return;
  const trades = loadTrades().filter(t => t.status === 'TRIGGERED' && t.carryToNextDay && t.slNeedsRecalc);
  if (!trades.length) { lastSLRecalcDate = dateStr; return; }

  lastSLRecalcDate = dateStr;
  const tok = cfg.telegramToken; const cid = cfg.telegramChatId;

  for (const trade of trades) {
    // Fetch 09:15–09:30 FIFTEEN_MINUTE candle
    const candle15 = await fetchOptionCandle(trade.expiry, trade.strike, trade.optType, dateStr, 'FIFTEEN_MINUTE', '09:15', '09:30');
    if (!candle15) { console.warn(`[SL] No 15-min candle for ${trade.strike} ${trade.optType}`); continue; }

    // New SL = 15m HIGH × 1.10, rounded to 0.5
    const newSL = Math.round(candle15.high * 1.10 * 2) / 2;
    const prevSL = trade.stopLoss;

    updateTrade(trade.id, { stopLoss: newSL, slNeedsRecalc: false, carryToNextDay: false });
    console.log(`[SL] ${trade.strike} ${trade.optType}: 15m high ₹${candle15.high} → new SL ₹${newSL} (was ₹${prevSL})`);

    if (tok && cid) tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
🔄 <b>SL Recalculated — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📊 15-min candle (09:15–09:30): H:₹${candle15.high} L:₹${candle15.low} C:₹${candle15.close}
🛑 New SL: <b>₹${newSL}</b>  (15m High ₹${candle15.high} × 1.10)
📉 Previous SL: ₹${prevSL}
💰 Entry: ₹${trade.entryPrice}
📅 ${trade.expiry} · ${trade.strategyName}`);
  }
}

// ── 0DTE expiry close at 3:00 PM ─────────────────────────────────────────────
function parseExpiryToDate(expiry) {
  // "28APR2026" → Date (midnight IST)
  const dd   = parseInt(expiry.slice(0, 2), 10);
  const mmStr = expiry.slice(2, 5);
  const yyyy = parseInt(expiry.slice(5), 10);
  const mm   = MONTHS.indexOf(mmStr);
  return new Date(yyyy, mm, dd); // local date
}

function isExpiryToday(expiry) {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth()+1).padStart(2,'0')}-${String(ist.getUTCDate()).padStart(2,'0')}`;
  try {
    const exp = parseExpiryToDate(expiry);
    const expStr = `${exp.getFullYear()}-${String(exp.getMonth()+1).padStart(2,'0')}-${String(exp.getDate()).padStart(2,'0')}`;
    return expStr === today;
  } catch { return false; }
}

let lastExpiryCloseDate = '';

async function runExpiryClose(dateStr) {
  if (lastExpiryCloseDate === dateStr) return;
  const trades = loadTrades().filter(t => t.status === 'TRIGGERED' && isExpiryToday(t.expiry));
  if (!trades.length) return;

  lastExpiryCloseDate = dateStr;
  console.log(`[Expiry] 0DTE close for ${trades.length} trade(s)`);

  const tok = cfg.telegramToken; const cid = cfg.telegramChatId;
  const now = new Date().toISOString();

  // Batch fetch live LTPs for all expiry trades
  const ltpMap = await batchFetchLTPs(trades.map(t => ({ expiry: t.expiry, strike: t.strike, optType: t.optType, id: t.id })));

  for (const trade of trades) {
    const ltp = ltpMap.get(trade.id) ?? 0;
    const exitPrice = ltp > 0 ? ltp : trade.entryPrice * 0.1; // fallback ~90% profit if LTP unavailable
    const pnl = (trade.entryPrice - exitPrice) * trade.lotSize;

    updateTrade(trade.id, {
      status: pnl >= 0 ? 'TARGET_HIT' : 'SL_HIT',
      exitAt: now,
      exitPrice,
      pnl,
      exitReason: 'EXPIRY',
      carryToNextDay: false,
    });

    console.log(`[Expiry] Closed ${trade.strike} ${trade.optType} @ ₹${exitPrice.toFixed(1)} P&L ₹${pnl.toFixed(0)}`);

    if (tok && cid) await tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
🔄 <b>Nifty Weekly Rollover — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📅 Expiry Day (0DTE) — Position closed at 03:00 PM
━━━━━━━━━━━━━━━━━━━━
📉 Sold @ ₹${trade.entryPrice.toFixed(1)} → Closed @ ₹${exitPrice.toFixed(1)}
💰 P&L: <b>${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)}</b> (${trade.lotSize} units)
━━━━━━━━━━━━━━━━━━━━
⏳ Next setup starts tomorrow at 08:45 AM`);
  }
}

// ── End-of-day: expire PENDING, carry TRIGGERED ───────────────────────────────
let lastEODProcessDate = '';
async function processEndOfDay(dateStr) {
  if (lastEODProcessDate === dateStr) return;
  lastEODProcessDate = dateStr;
  const tok = cfg.telegramToken; const cid = cfg.telegramChatId;
  const trades = loadTrades();
  let pendingExpired = 0, triggered = 0;
  for (const t of trades) {
    if (t.status === 'PENDING') {
      updateTrade(t.id, { status: 'EXPIRED' });
      pendingExpired++;
    } else if (t.status === 'TRIGGERED') {
      updateTrade(t.id, { carryToNextDay: true });
      triggered++;
    }
  }
  console.log(`[EOD] Expired: ${pendingExpired} pending, Carrying: ${triggered} triggered`);
  if ((pendingExpired > 0 || triggered > 0) && tok && cid) {
    let msg = `🔔 <b>FiFTO Trading Secret</b>\n📋 <b>End of Day Summary</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    if (pendingExpired > 0) msg += `⏳ ${pendingExpired} pending order(s) expired\n`;
    if (triggered > 0) msg += `🔄 ${triggered} position(s) carrying to next day\n  📅 Target active from 09:15 AM\n  🛑 SL active from 09:25 AM`;
    await tgSend(tok, cid, msg);
  }
}

// ── Auto-place paper orders (called after morning check / gap recalc) ─────────
let gapDownSignals = null; // set by runGapDownRecalcServer
let lastAutoPlaceDate = '';

async function autoPlacePaperOrders(safeCheck) {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const dateStr = ist.toISOString().slice(0, 10);
  if (lastAutoPlaceDate === dateStr) { console.log('[AutoPlace] Already placed today'); return; }
  if (!eodStore) { console.warn('[AutoPlace] No EOD store'); return; }

  expireStalePendingOrders(dateStr);
  const trades = loadTrades();
  const todayTrades = trades.filter(t => t.date === dateStr);
  if (todayTrades.length > 0) { console.log('[AutoPlace] Trades already exist for today'); return; }

  const ceOpenTrade = getActiveTrade('CE');
  const peOpenTrade = getActiveTrade('PE');
  const ceOpen = !!ceOpenTrade;
  const peOpen = !!peOpenTrade;

  const tok = cfg.telegramToken; const cid = cfg.telegramChatId;

  if (ceOpen && peOpen) {
    console.log('[AutoPlace] Both legs holding — no new trade');
    lastAutoPlaceDate = dateStr;
    if (tok && cid) await tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
📋 <b>No New Trade Today</b>
━━━━━━━━━━━━━━━━━━━━
📈 CALL (CE)
${fmtActiveTrade(ceOpenTrade)}

📉 PUT (PE)
${fmtActiveTrade(peOpenTrade)}
━━━━━━━━━━━━━━━━━━━━
Tracking existing positions for Target/SL.`);
    return;
  }

  lastAutoPlaceDate = dateStr;
  const placedAt = new Date().toISOString();
  const toPlace = [];

  const pickSignal = (optType) => {
    const baseTrade = optType === 'CE' ? eodStore.callTrade : eodStore.putTrade;
    const baseExpiry = optType === 'CE' ? eodStore.callExpiry : eodStore.putExpiry;

    // Prefer recalc signals when they actually changed the strike (avoid false "recalc" tags)
    if (gapDownSignals) {
      const recTrade = optType === 'CE' ? gapDownSignals.callTrade : gapDownSignals.putTrade;
      const recExpiry = optType === 'CE' ? gapDownSignals.callExpiry : gapDownSignals.putExpiry;
      const recalcChanged = !!(recTrade?.isValid && baseTrade?.isValid && recTrade.strike !== baseTrade.strike);
      if (recTrade?.isValid) {
        return {
          trade: recTrade,
          expiry: recExpiry,
          signalSource: recalcChanged ? 'GAP_RECALC' : 'EOD',
          recalcScenario: recalcChanged ? (optType === 'CE' ? 'GAP_DOWN' : 'GAP_UP') : null,
        };
      }
    }

    return baseTrade?.isValid
      ? { trade: baseTrade, expiry: baseExpiry, signalSource: 'EOD', recalcScenario: null }
      : null;
  };

  if (!ceOpen) {
    const s = pickSignal('CE');
    if (s) toPlace.push({ id: `${Date.now()}_CE`, date: dateStr, type: 'CALL', optType: 'CE', strike: s.trade.strike, expiry: s.expiry, strategyName: eodStore.strategyName, lotSize: SRV_CFG.lotSize, entryPrice: s.trade.entryPrice, targetPrice: s.trade.target ?? s.trade.targetPrice, stopLoss: s.trade.stopLoss, status: 'PENDING', placedAt, carryToNextDay: false, signalSource: s.signalSource, recalcScenario: s.recalcScenario });
  }
  if (!peOpen) {
    const s = pickSignal('PE');
    if (s) toPlace.push({ id: `${Date.now() + 1}_PE`, date: dateStr, type: 'PUT', optType: 'PE', strike: s.trade.strike, expiry: s.expiry, strategyName: eodStore.strategyName, lotSize: SRV_CFG.lotSize, entryPrice: s.trade.entryPrice, targetPrice: s.trade.target ?? s.trade.targetPrice, stopLoss: s.trade.stopLoss, status: 'PENDING', placedAt, carryToNextDay: false, signalSource: s.signalSource, recalcScenario: s.recalcScenario });
  }

  for (const t of toPlace) {
    addTrade(t);
    console.log(`[AutoPlace] Placed: ${t.strike} ${t.optType} Entry:₹${t.entryPrice} SL:₹${t.stopLoss}`);
    if (tok && cid) await tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
📋 <b>Paper Trade Placed — ${t.strike} ${t.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📊 ${t.expiry} · ${t.strategyName}
⏳ Status: PENDING (sell limit order)
🎯 Entry: ₹${t.entryPrice.toFixed(1)}
✅ Target: ₹${t.targetPrice.toFixed(1)}
🛑 SL: ₹${t.stopLoss.toFixed(1)}
💼 ${t.lotSize} units · ₹${(t.entryPrice * t.lotSize).toFixed(0)}`);
  }
  if (tok && cid && (ceOpenTrade || peOpenTrade)) {
    const active = ceOpenTrade || peOpenTrade;
    await tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
🔄 <b>Existing Position Kept — ${active.strike} ${active.optType}</b>
━━━━━━━━━━━━━━━━━━━━
${fmtActiveTrade(active)}
━━━━━━━━━━━━━━━━━━━━
Only missing leg(s) were placed today.`);
  }
  if (!toPlace.length) console.log('[AutoPlace] No signals to place');
}

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function tgSend(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.warn('[Telegram] Send failed:', e.message); }
}

function fmtSignal(trade, expiry) {
  if (!trade?.isValid) return 'No valid strike';
  return `Strike: <b>${trade.strike} ${trade.type === 'CALL' ? 'CE' : 'PE'}</b> · ${expiry}\n🎯 Entry: ₹${trade.entryPrice.toFixed(1)} | Target: ₹${trade.target.toFixed(1)} | SL: ₹${trade.stopLoss.toFixed(1)}`;
}

function getActiveTrade(optType) {
  const dateStr = istDateString();
  return loadTrades().find(t =>
    t.optType === optType &&
    (t.status === 'TRIGGERED' || (t.status === 'PENDING' && t.date === dateStr))
  ) ?? null;
}

function fmtActiveTrade(trade) {
  if (!trade) return '';
  const status = trade.status === 'TRIGGERED' ? 'Order Active' : 'Pending Order';
  const ltp = trade.currentLTP ? `\n📍 LTP: ₹${trade.currentLTP.toFixed(1)}` : '';
  return `<b>${status}: ${trade.strike} ${trade.optType}</b> · ${trade.expiry}\n🎯 Entry: ₹${trade.entryPrice.toFixed(1)} | Target: ₹${trade.targetPrice.toFixed(1)} | SL: ₹${trade.stopLoss.toFixed(1)}${ltp}\nNo duplicate order will be placed.`;
}

function fmtSignalOrActive(optType, trade, expiry) {
  const active = getActiveTrade(optType);
  return active ? fmtActiveTrade(active) : fmtSignal(trade, expiry);
}

// ── Server-side strategy calculation (NIFTY Weekly Selling defaults) ──────────
const SRV_CFG = {
  lotSize: 65, minOIContracts: 500, strikeFactor: 0.0015,
  minPremiumFactor: 0.0085, entryDiscount: 0.10, targetProfit: 0.75,
  mslIncrease: 0.75, tslIncrease: 0.10, strikeInterval: 50, numStrikes: 10, maxTries: 5,
};

const roundHalf = (v) => Math.round(v * 2) / 2;

function srvRoundStrike(value, roundUp) {
  const si = SRV_CFG.strikeInterval;
  const s = Math.round(value / si) * si;
  return roundUp ? (s >= value ? s : s + si) : (s <= value ? s : s - si);
}

function getEffectiveEODDate() {
  // Returns the most recent past market day (data is final after 15:30 IST)
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000); // UTC→IST
  const isAfterClose = istNow.getUTCHours() > 15 || (istNow.getUTCHours() === 15 && istNow.getUTCMinutes() >= 30);
  const d = new Date(istNow);
  d.setUTCHours(0, 0, 0, 0);
  if (!isAfterClose) d.setUTCDate(d.getUTCDate() - 1); // use previous day if market not closed
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1); // skip weekends
  return d.toISOString().slice(0, 10);
}

function getNextTradingDay(dateStr) {
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return { date: d.toISOString().slice(0, 10), day: DAYS[d.getUTCDay()] };
}

function srvFindStrike(chain, range, type) {
  const minOI = SRV_CFG.minOIContracts * SRV_CFG.lotSize;
  for (const strike of range) {
    const row = chain.find(r => r.strikePrice === strike);
    if (!row) continue;
    const d = type === 'CE' ? row.CE : row.PE;
    if (!d || !d.lastPrice || d.lastPrice <= 0) continue;
    if (d.openInterest > 0 && d.openInterest < minOI) continue;
    if (d.lastPrice < strike * SRV_CFG.minPremiumFactor) continue;
    return { strike, ltp: d.lastPrice };
  }
  return null;
}

async function runAutoCalculation() {
  console.log('[Auto] Starting EOD calculation...');
  try {
    const effectiveDate = getEffectiveEODDate();
    console.log('[Auto] EOD date:', effectiveDate);

    // Step 1: NIFTY OHLC
    const ohlc = await fetchHistorical(effectiveDate);
    const twoDHH = Math.max(ohlc.day1High, ohlc.day2High);
    const twoDLL = Math.min(ohlc.day1Low, ohlc.day2Low);

    // Step 2: Strike ranges
    const si = SRV_CFG.strikeInterval;
    const n  = SRV_CFG.numStrikes;
    const callEnd = srvRoundStrike(twoDLL * (1 - SRV_CFG.strikeFactor), false);
    const putEnd  = srvRoundStrike(twoDHH * (1 + SRV_CFG.strikeFactor), true);
    const callRange = Array.from({length: n}, (_, i) => callEnd + (n - 1 - i) * si); // high→low (OTM first)
    const putRange  = Array.from({length: n}, (_, i) => putEnd  - (n - 1 - i) * si); // low→high (OTM first)

    // Step 3: Expiry dates + prep day
    const expiries = await computeNiftyExpiries(8);
    if (!expiries.length) throw new Error('No expiry dates');
    const { date: prepDate, day: prepDay } = getNextTradingDay(effectiveDate);
    const startIdx = (prepDay === 'Monday' || prepDay === 'Tuesday') ? 1 : 0;
    const toTry = expiries.slice(startIdx, startIdx + SRV_CFG.maxTries).map(e => e.toUpperCase());

    // Step 4: Find valid strikes across expiries
    let callRes = null, callExp = '', putRes = null, putExp = '';
    for (const expiry of toTry) {
      if (!callRes) {
        const chain = await fetchOptionChain(expiry, callRange.join(','), effectiveDate);
        callRes = srvFindStrike(chain, callRange, 'CE');
        if (callRes) { callExp = expiry; console.log(`[Auto] CALL: ${callRes.strike} CE (${expiry})`); }
      }
      if (!putRes) {
        const chain = await fetchOptionChain(expiry, putRange.join(','), effectiveDate);
        putRes = srvFindStrike(chain, putRange, 'PE');
        if (putRes) { putExp = expiry; console.log(`[Auto] PUT:  ${putRes.strike} PE (${expiry})`); }
      }
      if (callRes && putRes) break;
    }

    // Step 5: Fetch 2D OHLC for selected strikes
    const master = await getInstrumentMaster();
    const findOpt = (strike, type, expiry) => master.find(r =>
      r.exch_seg === 'NFO' && r.name === 'NIFTY' && r.instrumenttype === 'OPTIDX' &&
      r.expiry === expiry && Math.round(Number(r.strike) / 100) === strike &&
      (type === 'CE' ? r.symbol.endsWith('CE') : r.symbol.endsWith('PE'))
    );
    const [callOHLC, putOHLC] = await Promise.all([
      callRes ? fetch2DayOptionOHLC(findOpt(callRes.strike,'CE',callExp)?.token, 0, effectiveDate).catch(()=>null) : null,
      putRes  ? fetch2DayOptionOHLC(findOpt(putRes.strike, 'PE',putExp )?.token, 0, effectiveDate).catch(()=>null) : null,
    ]);

    // Step 6: Build trade signals
    const buildTrade = (type, res, ohlc2d, expiry) => {
      if (!res) return { type, strike: 0, isValid: false };
      const ll = ohlc2d?.twoDLL ?? twoDLL;
      const hh = ohlc2d?.twoDHH ?? twoDHH;
      const entryPrice = roundHalf(ll  * (1 - SRV_CFG.entryDiscount));
      const target     = roundHalf(entryPrice * (1 - SRV_CFG.targetProfit));
      const msl        = roundHalf(entryPrice * (1 + SRV_CFG.mslIncrease));
      const tsl        = roundHalf(hh  * (1 + SRV_CFG.tslIncrease));
      const stopLoss   = roundHalf(Math.min(msl, tsl));
      return { type, strike: res.strike, entryPrice, target, stopLoss, msl, tsl, isValid: true };
    };

    const store = {
      strategyName: 'NIFTY Weekly Selling',
      callTrade: buildTrade('CALL', callRes, callOHLC, callExp),
      putTrade:  buildTrade('PUT',  putRes,  putOHLC,  putExp),
      callExpiry: callExp, putExpiry: putExp,
      prepDate, prepDay, eodDate: effectiveDate,
      calculatedAt: new Date().toISOString(),
    };

    eodStore = store;
    diskSet('eod_store', store); // persist across restarts
    console.log(`[Auto] EOD calc done ✓ CE=${store.callTrade.strike} PE=${store.putTrade.strike}`);
    return store;
  } catch (e) {
    console.error('[Auto] EOD calc failed:', e.message);
    return null;
  }
}

// ── EOD store — holds the last computed signals for 09:00 AM reminder ─────────
let eodStore = diskGet('eod_store') ?? null; // load persisted store on startup
if (eodStore) console.log(`[Angel] EOD store loaded from disk — prep: ${eodStore.prepDate}`);

// ── Server-side morning check + gap-down recalc ───────────────────────────────
async function runMorningCheck() {
  if (!eodStore) { console.warn('[MorningCheck] No EOD store — skipping'); return null; }
  const { callTrade, putTrade, callExpiry, putExpiry } = eodStore;
  if (!callTrade?.isValid && !putTrade?.isValid) return null;
  const ceActive = getActiveTrade('CE');
  const peActive = getActiveTrade('PE');
  const checkCE = callTrade?.isValid && !ceActive;
  const checkPE = putTrade?.isValid && !peActive;

  console.log('[MorningCheck] Fetching live LTPs at 09:25...');
  const { ceLTP, peLTP } = await fetchLiveLTPs(
    checkCE ? callExpiry : '', checkCE ? callTrade.strike : 0,
    checkPE ? putExpiry  : '', checkPE ? putTrade.strike  : 0,
  );

  const callGap = checkCE ? ceLTP < callTrade.entryPrice : false;
  const putGap  = checkPE ? peLTP  < putTrade.entryPrice  : false;

  const tok = cfg.telegramToken;
  const cid = cfg.telegramChatId;
  const { strategyName, prepDate, prepDay } = eodStore;

  let msg = `🔔 <b>FiFTO Trading Secret</b>\n📊 <b>${strategyName} — Morning Check (09:25)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  if (ceActive) {
    msg += `🔄 CE already active\n${fmtActiveTrade(ceActive)}\n\n`;
  } else if (checkCE) {
    msg += callGap
      ? `📉 CE ${callTrade.strike} · ${callExpiry}\nLTP ₹${ceLTP.toFixed(1)} &lt; Entry ₹${callTrade.entryPrice.toFixed(1)} → <b>⚠️ Gap-Down — Skip</b>\n\n`
      : `✅ CE ${callTrade.strike} · ${callExpiry}\nLTP ₹${ceLTP.toFixed(1)} ≥ Entry ₹${callTrade.entryPrice.toFixed(1)} → <b>Safe to Enter</b>\n\n`;
  }
  if (peActive) {
    msg += `🔄 PE already active\n${fmtActiveTrade(peActive)}\n`;
  } else if (checkPE) {
    msg += putGap
      ? `📈 PE ${putTrade.strike} · ${putExpiry}\nLTP ₹${peLTP.toFixed(1)} &lt; Entry ₹${putTrade.entryPrice.toFixed(1)} → <b>⚠️ Gap-Up — Skip</b>\n`
      : `✅ PE ${putTrade.strike} · ${putExpiry}\nLTP ₹${peLTP.toFixed(1)} ≥ Entry ₹${putTrade.entryPrice.toFixed(1)} → <b>Safe to Enter</b>\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  if (!checkCE && !checkPE) {
    msg += `📋 <b>Both legs already active — tracking existing positions</b>`;
  } else {
    msg += (!callGap && !putGap)
      ? `✅ <b>Open leg(s) safe — place only missing order(s)</b>`
      : `⚡ Gap detected — recalculating missing leg(s) after 09:30 candle…`;
  }

  if (tok && cid) await tgSend(tok, cid, msg);
  console.log(`[MorningCheck] CE active=${!!ceActive} PE active=${!!peActive} CE gap=${callGap} PE gap=${putGap}`);
  const result = { callGap, putGap, ceLTP, peLTP };

  // If no gap — place paper orders immediately (safe to enter)
  if ((checkCE || checkPE) && !callGap && !putGap) {
    gapDownSignals = null; // use EOD signals
    setTimeout(() => autoPlacePaperOrders(result), 1000);
  }
  // Gap case: gap recalc at 09:30:01 will call autoPlacePaperOrders after it finishes

  return result;
}

let morningCheckResult = null; // { callGap, putGap } — shared with 09:32 recalc

async function runGapDownRecalcServer() {
  if (!morningCheckResult || (!morningCheckResult.callGap && !morningCheckResult.putGap)) return;
  if (!eodStore) return;

  const { callGap, putGap } = morningCheckResult;
  const { callExpiry, putExpiry, prepDate, prepDay, strategyName } = eodStore;
  const GAP_BUF = 0.00125;
  const si = SRV_CFG.strikeInterval;
  const n  = SRV_CFG.numStrikes;
  const minOI = SRV_CFG.minOIContracts * SRV_CFG.lotSize;

  console.log('[GapRecalc] Fetching 9:30 candle...');
  // Use today's prep date (the trading day)
  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const candle = await fetchNifty15MinCandle(today).catch(() => null);
  if (!candle) { console.warn('[GapRecalc] No candle data'); return; }

  const ceBuffer = Math.round(candle.low  * (1 - GAP_BUF));
  const peBuffer = Math.round(candle.high * (1 + GAP_BUF));
  const callEnd  = srvRoundStrike(ceBuffer, false);
  const putEnd   = srvRoundStrike(peBuffer, true);

  const callRange = callGap ? Array.from({length: n}, (_, i) => callEnd + (n - 1 - i) * si) : [];
  const putRange  = putGap  ? Array.from({length: n}, (_, i) => putEnd  - (n - 1 - i) * si) : [];

  const [ceChain, peChain] = await Promise.all([
    callGap ? fetchLiveOptionChain(callExpiry, callRange.join(',')) : Promise.resolve([]),
    putGap  ? fetchLiveOptionChain(putExpiry,  putRange.join(','))  : Promise.resolve([]),
  ]);

  const callSel = callGap ? srvFindStrike(ceChain, callRange, 'CE') : null;
  const putSel  = putGap  ? srvFindStrike(peChain,  putRange,  'PE') : null;

  const buildRecalcTrade = (sel, scenario) => {
    if (!sel) return null;
    const entry = roundHalf(sel.ltp * (1 - SRV_CFG.entryDiscount));
    return { strike: sel.strike, ltp: sel.ltp, entryPrice: entry,
      target: roundHalf(entry * (1 - SRV_CFG.targetProfit)),
      stopLoss: roundHalf(Math.min(roundHalf(entry * (1 + SRV_CFG.mslIncrease)), roundHalf(sel.ltp * (1 + SRV_CFG.tslIncrease)))),
      scenario };
  };

  const callNew = buildRecalcTrade(callSel, 'Gap-Down CE');
  const putNew  = buildRecalcTrade(putSel,  'Gap-Up PE');

  const tok = cfg.telegramToken;
  const cid = cfg.telegramChatId;
  if (!tok || !cid) return;

  let msg = `🔔 <b>FiFTO Trading Secret</b>\n⚡ <b>${strategyName} — Recalculated Signals</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 9:30 Candle: O:${candle.open} H:${candle.high} <b>L:${candle.low}</b> C:${candle.close}\n━━━━━━━━━━━━━━━━━━━━\n`;
  if (callGap) {
    msg += callNew
      ? `📉 <b>CE Gap-Down → ${callNew.strike} CE · ${callExpiry}</b>\n🎯 Entry ₹${callNew.entryPrice.toFixed(1)} | Target ₹${callNew.target.toFixed(1)} | SL ₹${callNew.stopLoss.toFixed(1)}\n\n`
      : `📉 CE Gap-Down → No valid strike found\n\n`;
  }
  if (putGap) {
    msg += putNew
      ? `📈 <b>PE Gap-Up → ${putNew.strike} PE · ${putExpiry}</b>\n🎯 Entry ₹${putNew.entryPrice.toFixed(1)} | Target ₹${putNew.target.toFixed(1)} | SL ₹${putNew.stopLoss.toFixed(1)}\n`
      : `📈 PE Gap-Up → No valid strike found\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━\n📅 Prep: ${prepDate} (${prepDay})`;
  // Store recalculated signals so autoPlacePaperOrders uses them
  gapDownSignals = {
    callTrade: callNew ? { ...eodStore.callTrade, strike: callNew.strike, entryPrice: callNew.entryPrice, target: callNew.target, targetPrice: callNew.target, stopLoss: callNew.stopLoss, isValid: true } : eodStore.callTrade,
    putTrade:  putNew  ? { ...eodStore.putTrade,  strike: putNew.strike,  entryPrice: putNew.entryPrice,  target: putNew.target,  targetPrice: putNew.target,  stopLoss: putNew.stopLoss,  isValid: true } : eodStore.putTrade,
    callExpiry, putExpiry,
  };

  await tgSend(tok, cid, msg);
  console.log('[GapRecalc] Recalculated signals sent to Telegram');

  // Place paper orders 3s after recalc completes
  setTimeout(() => autoPlacePaperOrders(morningCheckResult), 3000);
}

// ── Daily IST scheduler (08:45 auto-calc + 09:00 reminder) ───────────────────
let lastAutoCalcDate    = '';
let lastReminderDate    = '';
let lastMorningCheck    = '';
let lastGapRecalcDate   = '';

async function checkSchedule() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day     = ist.getUTCDay();
  const hour    = ist.getUTCHours();
  const min     = ist.getUTCMinutes();
  const dateStr = ist.toISOString().slice(0, 10);

  if (day === 0 || day === 6) return; // skip weekends

  // 08:45 AM IST — auto-run EOD calculation
  if (hour === 8 && min === 45 && lastAutoCalcDate !== dateStr) {
    lastAutoCalcDate = dateStr;
    console.log('[Schedule] 08:45 IST — running auto EOD calculation');
    await runAutoCalculation();
  }

  // 09:00 AM IST — send Telegram reminder
  if (hour === 9 && min === 0 && lastReminderDate !== dateStr) {
    lastReminderDate = dateStr;
    if (!eodStore) {
      console.log('[Schedule] 09:00 IST — no EOD store, trying auto-calc first');
      await runAutoCalculation();
    }
    if (!eodStore) { console.warn('[Schedule] Still no EOD data — skipping reminder'); return; }

    const { callTrade, putTrade, callExpiry, putExpiry, prepDate, prepDay, eodDate, strategyName } = eodStore;
    const tok = cfg.telegramToken;
    const cid = cfg.telegramChatId;
    if (!tok || !cid) return;

    const msg =
`🔔 <b>FiFTO Trading Secret</b>
📊 <b>${strategyName} — Morning Reminder</b>
━━━━━━━━━━━━━━━━━━━━
📅 Prep: ${prepDate} (${prepDay})
📆 EOD Data: ${eodDate}
━━━━━━━━━━━━━━━━━━━━
📈 CALL (CE)
${fmtSignalOrActive('CE', callTrade, callExpiry)}

📉 PUT (PE)
${fmtSignalOrActive('PE', putTrade, putExpiry)}
━━━━━━━━━━━━━━━━━━━━
⏰ Check LTP at 09:25 AM before placing orders`;

    await tgSend(tok, cid, msg);
    console.log('[Telegram] 09:00 AM reminder sent');
  }

  // 09:25 AM IST — (1) SL 10-min candle check for carried positions
  //                (2) Morning LTP check for new orders (gap-down / gap-up)
  if (hour === 9 && min === 25 && lastMorningCheck !== dateStr) {
    lastMorningCheck = dateStr;
    console.log('[Schedule] 09:25 IST — SL 10-min check + morning LTP check');
    await checkCarriedSLAt0925(dateStr);          // SL check first
    morningCheckResult = await runMorningCheck(); // then new order check
  }

  // 09:30:01 AM IST — recalculate SL from 15-min candle for flagged positions
  if (hour === 9 && min === 30 && lastSLRecalcDate !== dateStr) {
    lastSLRecalcDate = dateStr;
    setTimeout(() => recalcCarriedSLAt0931(dateStr), 1000); // 1s after 09:30 candle closes
  }

  // 15:00 IST — 0DTE expiry close (Nifty Weekly Rollover)
  if (hour === 15 && min === 0) {
    await runExpiryClose(dateStr);
  }

  // 15:30 IST — end of day: expire pending, mark triggered as carry
  if (hour === 15 && min === 30 && lastEODProcessDate !== dateStr) {
    await processEndOfDay(dateStr);
  }

  // 09:30 AM IST — auto gap-down recalc 1 second after 9:30 candle closes
  if (hour === 9 && min === 30 && lastGapRecalcDate !== dateStr) {
    lastGapRecalcDate = dateStr;
    if (morningCheckResult?.callGap || morningCheckResult?.putGap) {
      console.log('[Schedule] 09:30 IST — gap detected, waiting 1s for candle to close...');
      setTimeout(async () => {
        console.log('[Schedule] 09:30:01 IST — running gap-down recalculation');
        await runGapDownRecalcServer();
      }, 1000);
    }
  }
}

setInterval(checkSchedule, 60 * 1000); // check every minute

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

    // GET /angel/nifty-candle?date=YYYY-MM-DD  → first 15-min candle (09:15–09:30)
    if (url.pathname === '/angel/nifty-candle') {
      const date = url.searchParams.get('date');
      if (!date) return send(res, 400, { error: 'date param required' });
      console.log(`[Angel] Fetching NIFTY 15-min candle for ${date}`);
      const data = await fetchNifty15MinCandle(date);
      return send(res, 200, data);
    }

    // GET /angel/live-chain?expiry=...&strikes=...  → live LTP + OI (market quote)
    if (url.pathname === '/angel/live-chain') {
      const expiry  = url.searchParams.get('expiry');
      if (!expiry) return send(res, 400, { error: 'expiry param required' });
      const strikes = url.searchParams.get('strikes') ?? null;
      console.log(`[Angel] Fetching live chain for ${expiry} strikes=${strikes}`);
      const data = await fetchLiveOptionChain(expiry, strikes);
      return send(res, 200, { data });
    }

    // GET /angel/live-ltp?ceExpiry=...&ceStrike=...&peExpiry=...&peStrike=...
    if (url.pathname === '/angel/live-ltp') {
      const ceExpiry  = url.searchParams.get('ceExpiry')  ?? null;
      const ceStrike  = parseInt(url.searchParams.get('ceStrike') ?? '0') || null;
      const peExpiry  = url.searchParams.get('peExpiry')  ?? null;
      const peStrike  = parseInt(url.searchParams.get('peStrike') ?? '0') || null;
      const data = await fetchLiveLTPs(ceExpiry, ceStrike, peExpiry, peStrike);
      return send(res, 200, data);
    }

    // GET /angel/eod-store  — current prepared EOD signals
    if (url.pathname === '/angel/eod-store' && req.method === 'GET') {
      return send(res, 200, eodStore ?? null);
    }

    // GET /angel/paper-trades
    if (url.pathname === '/angel/paper-trades' && req.method === 'GET') {
      return send(res, 200, loadTrades());
    }

    // POST /angel/google-sheet-sync  — create/update Trade Log tab with all orders
    if (url.pathname === '/angel/google-sheet-sync' && req.method === 'POST') {
      const result = await syncTradesToGoogleSheet();
      return send(res, result.skipped ? 400 : 200, result);
    }

    // POST /angel/paper-trades  — manual trade placement from browser
    if (url.pathname === '/angel/paper-trades' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const trade = JSON.parse(body);
      addTrade(trade);
      return send(res, 200, { ok: true, id: trade.id });
    }

    // DELETE /angel/paper-trades/today  - remove only today's stored paper trades
    if (url.pathname === '/angel/paper-trades/today' && req.method === 'DELETE') {
      const result = removeTradesForDate(istDateString());
      console.log(`[Trade] Removed ${result.removed} stored trade(s) for ${result.date}`);
      return send(res, 200, { ok: true, ...result });
    }

    // PATCH /angel/paper-trades/:id  — update (cancel with reason, close manually)
    if (url.pathname.startsWith('/angel/paper-trades/') && req.method === 'PATCH') {
      const id = url.pathname.split('/').pop();
      let body = ''; for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body);
      const updated = updateTrade(id, { ...patch, updatedAt: new Date().toISOString() });
      if (!updated) return send(res, 404, { error: 'Not found' });
      // Send Telegram on cancellation
      if (patch.status === 'CANCELLED' && patch.cancelReason) {
        const tok = cfg.telegramToken; const cid = cfg.telegramChatId;
        if (tok && cid) tgSend(tok, cid,
`🔔 <b>FiFTO Trading Secret</b>
❌ <b>Order Cancelled — ${updated.strike} ${updated.optType}</b>
━━━━━━━━━━━━━━━━━━━━
📊 ${updated.expiry} · ${updated.strategyName}
🎯 Entry was: ₹${updated.entryPrice.toFixed(1)}
📝 Reason: <b>${patch.cancelReason}</b>
⏰ Cancelled at: ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} IST`);
      }
      return send(res, 200, updated);
    }

    // PUT /angel/settings  — update runtime settings (e.g. poll interval)
    if (url.pathname === '/angel/settings' && req.method === 'PUT') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { ltpPollIntervalSec } = JSON.parse(body);
      if (ltpPollIntervalSec && ltpPollIntervalSec >= 5) {
        pollIntervalMs = ltpPollIntervalSec * 1000;
        startPollTimer();
        console.log(`[Settings] Poll interval updated to ${ltpPollIntervalSec}s`);
      }
      return send(res, 200, { ok: true });
    }

    // POST /angel/store-eod  — stores EOD signals for 09:00 AM reminder
    if (url.pathname === '/angel/store-eod' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      eodStore = JSON.parse(body);
      diskSet('eod_store', eodStore); // persist so 09:00 AM reminder survives restarts
      console.log('[Angel] EOD store updated:', eodStore?.strategyName, eodStore?.prepDate);
      return send(res, 200, { ok: true });
    }

    // POST /angel/telegram  { token, chatId, message }
    if (url.pathname === '/angel/telegram' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { token, chatId, message } = JSON.parse(body);
      if (!token || !chatId || !message) return send(res, 400, { error: 'token, chatId, message required' });
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      });
      const tgJson = await tgRes.json();
      return send(res, tgRes.ok ? 200 : 400, tgJson);
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
