// Angel One SmartAPI proxy — NIFTY historical OHLC + option LTPs via instrument master
import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { createSign } from 'crypto';
import { generate as totpGenerate } from 'otplib';

process.on('uncaughtException', (err) => {
  console.error('[Angel] Uncaught:', err.message);
});
process.on('unhandledRejection', (err) => {
  // ignore — handled per-request already
});

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
const BACKUP_DIR = './server-cache-backups';
if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_KEEP_PER_FILE = 50;

function _cacheFile(key) {
  return join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180) + '.json');
}

function _backupTarget(label) {
  if (label === 'paper-trades') return join(CACHE_DIR, 'paper-trades.json');
  if (label === 'eod_store') return _cacheFile('eod_store');
  return null;
}

function _backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function _backupFiles(label = null) {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  return readdirSync(BACKUP_DIR)
    .filter(name => name.endsWith('.json') && (!label || name.startsWith(`${label}__`)))
    .map(name => {
      const path = join(BACKUP_DIR, name);
      const stats = statSync(path);
      return {
        name,
        path,
        label: name.split('__')[0],
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function backupCacheFile(label, file) {
  try {
    if (!existsSync(file)) return null;
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = join(BACKUP_DIR, `${label}__${_backupStamp()}__${Date.now()}.json`);
    copyFileSync(file, backup);
    const old = _backupFiles(label).slice(BACKUP_KEEP_PER_FILE);
    for (const item of old) unlinkSync(item.path);
    return backup;
  } catch (e) {
    console.warn(`[Backup] ${label} backup failed:`, e.message);
    return null;
  }
}

function restoreLatestBackup(label) {
  const target = _backupTarget(label);
  if (!target) return null;
  const latest = _backupFiles(label)[0];
  if (!latest) return null;
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    copyFileSync(latest.path, target);
    console.log(`[Backup] Restored ${label} from ${latest.name}`);
    return latest;
  } catch (e) {
    console.warn(`[Backup] ${label} restore failed:`, e.message);
    return null;
  }
}

function diskGet(key) {
  const file = _cacheFile(key);
  if (!existsSync(file)) {
    if (key === 'eod_store') restoreLatestBackup('eod_store');
    if (!existsSync(file)) return null;
  }
  try {
    const { data, expires } = JSON.parse(readFileSync(file, 'utf8'));
    if (expires && Date.now() > expires) return null;
    return data;
  } catch { return null; }
}

function diskSet(key, data, ttlMs = null) {
  try {
    const file = _cacheFile(key);
    writeFileSync(file, JSON.stringify({
      data,
      expires: ttlMs ? Date.now() + ttlMs : null,
      savedAt: new Date().toISOString(),
    }));
    if (key === 'eod_store') backupCacheFile('eod_store', file);
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

const telegramTargets = Array.isArray(cfg.telegramTargets) && cfg.telegramTargets.length > 0
  ? cfg.telegramTargets.map(t => ({ chatId: String(t.chatId ?? '').trim(), name: String(t.name ?? '') })).filter(t => t.chatId)
  : cfg.telegramChatId
    ? [{ chatId: String(cfg.telegramChatId).trim(), name: String(cfg.telegramChatName ?? 'Group 1') }]
    : [];

function tgSendToAll(token, targets, text) {
  if (!token || !targets.length) return;
  for (const target of targets) {
    const chatId = String(target.chatId ?? '').trim();
    if (!chatId) continue;
    const prefix = target.name ? `📌 <b>${target.name}</b>\n` : '';
    tgSend(token, chatId, `${prefix}${text}`);
  }
}

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
  const prevCandles = candles.filter(c => !c[0]?.startsWith(toDateStr));
  if (prevCandles.length < 2) throw new Error('Not enough historical data (need 2 completed days before target date)');
  const last2 = prevCandles.slice(-2);
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
  if (!existsSync(TRADES_FILE)) restoreLatestBackup('paper-trades');
  try { if (existsSync(TRADES_FILE)) return JSON.parse(readFileSync(TRADES_FILE, 'utf8')); } catch {}
  return [];
}
function saveTrades(trades) {
  writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  backupCacheFile('paper-trades', TRADES_FILE);
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
  if (trades.length) {
    const ltpMap = await batchFetchLTPs(trades.map(t => ({ expiry: t.expiry, strike: t.strike, optType: t.optType, id: t.id })));
    const tok = cfg.telegramToken;
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
          if (tok) tgSendToAll(tok, telegramTargets,
`🔔 <b>FiFTO Trading Secret</b>
✅ <b>Order Triggered — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━
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
          if (tok) tgSendToAll(tok, telegramTargets,
`🔔 <b>FiFTO Trading Secret</b>
🎯 <b>Target Hit! — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━
📈 Sold ₹${trade.entryPrice.toFixed(1)} → Closed ₹${ltp.toFixed(1)}
💰 P&L: <b>+₹${pnl.toFixed(0)}</b> (${trade.lotSize} units)
✅ Trade closed successfully`);
        } else if (canSL && ltp >= trade.stopLoss) {
          const pnl = (trade.entryPrice - ltp) * trade.lotSize;
          updateTrade(trade.id, { status: 'SL_HIT', exitAt: now, exitPrice: ltp, pnl });
          console.log(`[Trade] SL HIT: ${trade.strike} ${trade.optType} P&L ₹${pnl.toFixed(0)}`);
          if (tok) tgSendToAll(tok, telegramTargets,
`🔔 <b>FiFTO Trading Secret</b>
🛑 <b>Stop Loss Hit — ${trade.strike} ${trade.optType}</b>
━━━━━━━━━━━━━━━━━━
📉 Sold ₹${trade.entryPrice.toFixed(1)} → Closed ₹${ltp.toFixed(1)}
💰 P&L: <b>₹${pnl.toFixed(0)}</b> (${trade.lotSize} units)`);
        }
      }
    }
  }

  // Futures position polling (always, even without option trades)
  try { await futuresPollPosition(); } catch (e) { /* ignore futures poll errors */ }
}

function startPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOpenTrades, pollIntervalMs);
  console.log(`[Poll] LTP polling started — interval: ${pollIntervalMs / 1000}s`);
}
startPollTimer();

// ── Fetch option candle for a given interval and time window ──────────────────
async function fetchOptionCandle(expiryRaw, strike, optType, dateStr, interval, fromTime, toTime) {
  return fetchOptionWindowCandle(expiryRaw, strike, optType, dateStr, interval, fromTime, toTime);
}

// ── 09:25 AM — SL check using 10-min candle (09:15–09:25) ────────────────────
let lastSLCheckDate = '';

async function checkCarriedSLAt0925(dateStr) {
  if (lastSLCheckDate === dateStr) return;
  const trades = loadTrades().filter(t => t.status === 'TRIGGERED' && t.carryToNextDay);
  if (!trades.length) { lastSLCheckDate = dateStr; return; }

  lastSLCheckDate = dateStr;
  const tok = cfg.telegramToken;

  for (const trade of trades) {
    const opt = await findOptionContract(trade.expiry, trade.strike, trade.optType);
    if (opt?.token) {
      const hist = await fetch2DayOptionOHLC(opt.token, 0, dateStr).catch(() => null);
      if (hist) {
        const fixedMsl = roundHalf(Number(trade.msl ?? (trade.entryPrice * (1 + SRV_CFG.mslIncrease))));
        const freshTsl = roundHalf(hist.twoDHH * (1 + SRV_CFG.tslIncrease));
        const activeSl = roundHalf(Math.min(fixedMsl, freshTsl));
        updateTrade(trade.id, {
          msl: fixedMsl,
          tsl: freshTsl,
          stopLoss: activeSl,
          updatedAt: new Date().toISOString(),
        });
        trade.msl = fixedMsl;
        trade.tsl = freshTsl;
        trade.stopLoss = activeSl;
      }
    }

    // Fetch 09:15–09:25 TEN_MINUTE candle of the option
    const candle10 = await fetchOptionCandle(trade.expiry, trade.strike, trade.optType, dateStr, 'TEN_MINUTE', '09:15', '09:25');
    if (!candle10) { console.warn(`[SL] No 10-min candle for ${trade.strike} ${trade.optType}`); continue; }

    console.log(`[SL] ${trade.strike} ${trade.optType}: 10m high=₹${candle10.high} SL=₹${trade.stopLoss}`);

    if (candle10.high < trade.stopLoss) {
      // Safe — 10m high is below SL, keep SL as-is
      console.log(`[SL] ${trade.strike} ${trade.optType}: 10m high ₹${candle10.high} < SL ₹${trade.stopLoss} → SL maintained ✅`);
      if (tok) tgSendToAll(tok, telegramTargets,
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
      if (tok) tgSendToAll(tok, telegramTargets,
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
  const tok = cfg.telegramToken;

  for (const trade of trades) {
    // Fetch 09:15–09:30 FIFTEEN_MINUTE candle
    const candle15 = await fetchOptionCandle(trade.expiry, trade.strike, trade.optType, dateStr, 'FIFTEEN_MINUTE', '09:15', '09:30');
    if (!candle15) { console.warn(`[SL] No 15-min candle for ${trade.strike} ${trade.optType}`); continue; }

    // New SL = 15m HIGH × 1.10, rounded to 0.5
    const newSL = Math.round(candle15.high * 1.10 * 2) / 2;
    const prevSL = trade.stopLoss;

    updateTrade(trade.id, { stopLoss: newSL, slNeedsRecalc: false, carryToNextDay: false });
    console.log(`[SL] ${trade.strike} ${trade.optType}: 15m high ₹${candle15.high} → new SL ₹${newSL} (was ₹${prevSL})`);

    if (tok) tgSendToAll(tok, telegramTargets,
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

  const tok = cfg.telegramToken;
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

    if (tok) await tgSendToAll(tok, telegramTargets,
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
  const tok = cfg.telegramToken;
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
  if ((pendingExpired > 0 || triggered > 0) && tok) {
    let msg = `🔔 <b>FiFTO Trading Secret</b>\n📋 <b>End of Day Summary</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    if (pendingExpired > 0) msg += `⏳ ${pendingExpired} pending order(s) expired\n`;
    if (triggered > 0) msg += `🔄 ${triggered} position(s) carrying to next day\n  📅 Target active from 09:15 AM\n  🛑 SL active from 09:25 AM`;
    await tgSendToAll(tok, telegramTargets, msg);
  }
}

// ── Auto-place paper orders (called after morning check / gap recalc) ─────────
let gapDownSignals = null; // set by runGapDownRecalcServer
let lastAutoPlaceDate = '';

async function autoPlacePaperOrders(safeCheck) {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const dateStr = ist.toISOString().slice(0, 10);
  if (!eodStore) { console.warn('[AutoPlace] No EOD store'); return; }

  expireStalePendingOrders(dateStr);
  loadTrades();

  const ceOpenTrade = getActiveTrade('CE');
  const peOpenTrade = getActiveTrade('PE');
  const ceOpen = !!ceOpenTrade;
  const peOpen = !!peOpenTrade;

  const tok = cfg.telegramToken;

  if (ceOpen && peOpen) {
    console.log('[AutoPlace] Both legs holding — no new trade');
    lastAutoPlaceDate = dateStr;
    if (tok) await tgSendToAll(tok, telegramTargets,
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

  const placedAt = new Date().toISOString();
  const toPlace = [];
  const skipCE = !!(safeCheck && !gapDownSignals && safeCheck.callGap);
  const skipPE = !!(safeCheck && !gapDownSignals && safeCheck.putGap);

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

  if (!ceOpen && !skipCE) {
    const s = pickSignal('CE');
    if (s) toPlace.push({ id: `${Date.now()}_CE`, date: dateStr, type: 'CALL', optType: 'CE', strike: s.trade.strike, expiry: s.expiry, strategyName: eodStore.strategyName, lotSize: SRV_CFG.lotSize, entryPrice: s.trade.entryPrice, targetPrice: s.trade.target ?? s.trade.targetPrice, stopLoss: s.trade.stopLoss, status: 'PENDING', placedAt, carryToNextDay: false, signalSource: s.signalSource, recalcScenario: s.recalcScenario });
  }
  if (!peOpen && !skipPE) {
    const s = pickSignal('PE');
    if (s) toPlace.push({ id: `${Date.now() + 1}_PE`, date: dateStr, type: 'PUT', optType: 'PE', strike: s.trade.strike, expiry: s.expiry, strategyName: eodStore.strategyName, lotSize: SRV_CFG.lotSize, entryPrice: s.trade.entryPrice, targetPrice: s.trade.target ?? s.trade.targetPrice, stopLoss: s.trade.stopLoss, status: 'PENDING', placedAt, carryToNextDay: false, signalSource: s.signalSource, recalcScenario: s.recalcScenario });
  }

  for (const t of toPlace) {
    addTrade(t);
    console.log(`[AutoPlace] Placed: ${t.strike} ${t.optType} Entry:₹${t.entryPrice} SL:₹${t.stopLoss}`);
    if (tok) await tgSendToAll(tok, telegramTargets,
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
  if (tok && (ceOpenTrade || peOpenTrade)) {
    const active = ceOpenTrade || peOpenTrade;
    await tgSendToAll(tok, telegramTargets,
`🔔 <b>FiFTO Trading Secret</b>
🔄 <b>Existing Position Kept — ${active.strike} ${active.optType}</b>
━━━━━━━━━━━━━━━━━━━━
${fmtActiveTrade(active)}
━━━━━━━━━━━━━━━━━━━━
Only missing leg(s) were placed today.`);
  }
  if (toPlace.length) lastAutoPlaceDate = dateStr;
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

function getPreviousTradingDay(dateStr) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function findOptionContract(expiryRaw, strike, optType) {
  if (!expiryRaw || !strike) return null;
  await login();
  const master = await getInstrumentMaster();
  return master.find(r =>
    r.exch_seg === 'NFO' &&
    r.name === 'NIFTY' &&
    r.instrumenttype === 'OPTIDX' &&
    r.expiry === toMasterExpiry(expiryRaw) &&
    Math.round(Number(r.strike) / 100) === strike &&
    (optType === 'CE' ? r.symbol.endsWith('CE') : r.symbol.endsWith('PE'))
  ) ?? null;
}

async function fetchOptionWindowCandle(expiryRaw, strike, optType, dateStr, interval, fromTime, toTime) {
  const opt = await findOptionContract(expiryRaw, strike, optType);
  if (!opt) return null;
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  try {
    const res = await fetch(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        exchange: 'NFO',
        symboltoken: opt.token,
        interval,
        fromdate: `${y}-${mo}-${dd} ${fromTime}`,
        todate: `${y}-${mo}-${dd} ${toTime}`,
      }),
    });
    const json = await res.json();
    if (!json.status || !Array.isArray(json.data) || !json.data.length) return null;
    const c = json.data[0];
    return { open: c[1], high: c[2], low: c[3], close: c[4] };
  } catch {
    return null;
  }
}

async function buildTradeFromOptionHistory(type, strike, expiry, optionToken, refDate) {
  if (!strike || !expiry || !optionToken) return { type, strike: 0, isValid: false };
  const ohlc2d = await fetch2DayOptionOHLC(optionToken, 0, refDate).catch(() => null);
  if (!ohlc2d) return { type, strike: 0, isValid: false };
  const entryPrice = roundHalf(ohlc2d.twoDLL * (1 - SRV_CFG.entryDiscount));
  const target = roundHalf(entryPrice * (1 - SRV_CFG.targetProfit));
  const msl = roundHalf(entryPrice * (1 + SRV_CFG.mslIncrease));
  const tsl = roundHalf(ohlc2d.twoDHH * (1 + SRV_CFG.tslIncrease));
  const stopLoss = roundHalf(Math.min(msl, tsl));
  return {
    type,
    strike,
    expiry,
    entryPrice,
    target,
    targetPrice: target,
    stopLoss,
    msl,
    tsl,
    option2DLL: ohlc2d.twoDLL,
    option2DHH: ohlc2d.twoDHH,
    isValid: true,
  };
}

async function selectStrikeRecalcServer(optType, expiryList, strikeRange, tradeDate) {
  const refDate = getPreviousTradingDay(tradeDate);
  for (const expiry of expiryList) {
    const chain = await fetchOptionChain(expiry, strikeRange.join(','), refDate);
    for (const strike of strikeRange) {
      const row = chain.find(r => r.strikePrice === strike);
      const side = optType === 'CE' ? row?.CE : row?.PE;
      if (!side?.lastPrice || side.lastPrice <= 0) continue;
      if (!(side.openInterest > SRV_CFG.minOIContracts * SRV_CFG.lotSize)) continue;

      const optionRef = await findOptionContract(expiry, strike, optType);
      if (!optionRef?.token) continue;
      const hist = await fetch2DayOptionOHLC(optionRef.token, 0, refDate).catch(() => null);
      if (!hist) continue;
      if (hist.twoDLL < strike * SRV_CFG.minPremiumFactor) continue;

      const entryPrice = roundHalf(hist.twoDLL * (1 - SRV_CFG.entryDiscount));
      const candle15 = await fetchOptionWindowCandle(expiry, strike, optType, tradeDate, 'FIFTEEN_MINUTE', '09:15', '09:30');
      if (!candle15 || candle15.low < entryPrice) continue;

      const target = roundHalf(entryPrice * (1 - SRV_CFG.targetProfit));
      const msl = roundHalf(entryPrice * (1 + SRV_CFG.mslIncrease));
      const tsl = roundHalf(hist.twoDHH * (1 + SRV_CFG.tslIncrease));
      const stopLoss = roundHalf(Math.min(msl, tsl));
      return {
        strike,
        expiry,
        entryPrice,
        target,
        targetPrice: target,
        stopLoss,
        msl,
        tsl,
        option2DLL: hist.twoDLL,
        option2DHH: hist.twoDHH,
        isValid: true,
      };
    }
  }
  return null;
}

function srvFindStrike(chain, range, type) {
  const minOI = SRV_CFG.minOIContracts * SRV_CFG.lotSize;
  for (const strike of range) {
    const row = chain.find(r => r.strikePrice === strike);
    if (!row) continue;
    const d = type === 'CE' ? row.CE : row.PE;
    if (!d || !d.lastPrice || d.lastPrice <= 0) continue;
    if (!(d.openInterest > minOI)) continue;
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
    const callToken = callRes ? findOpt(callRes.strike, 'CE', callExp)?.token : null;
    const putToken  = putRes  ? findOpt(putRes.strike,  'PE', putExp)?.token  : null;

    const [callTrade, putTrade] = await Promise.all([
      callRes && callToken ? buildTradeFromOptionHistory('CALL', callRes.strike, callExp, callToken, effectiveDate) : Promise.resolve({ type: 'CALL', strike: 0, isValid: false }),
      putRes  && putToken  ? buildTradeFromOptionHistory('PUT',  putRes.strike,  putExp,  putToken,  effectiveDate) : Promise.resolve({ type: 'PUT', strike: 0, isValid: false }),
    ]);

    const store = {
      strategyName: 'NIFTY Weekly Selling',
      callTrade,
      putTrade,
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
backupCacheFile('paper-trades', TRADES_FILE);
backupCacheFile('eod_store', _cacheFile('eod_store'));

// ── Server-side morning check + gap-down recalc ───────────────────────────────
async function runMorningCheck(opts = {}) {
  const { autoPlace = true, sendTelegram = true } = opts;
  if (!eodStore) { console.warn('[MorningCheck] No EOD store — skipping'); return null; }
  const { callTrade, putTrade, callExpiry, putExpiry } = eodStore;
  if (!callTrade?.isValid && !putTrade?.isValid) return null;
  const ceActive = getActiveTrade('CE');
  const peActive = getActiveTrade('PE');
  const checkCE = callTrade?.isValid && !ceActive;
  const checkPE = putTrade?.isValid && !peActive;

  console.log('[MorningCheck] Validating first F1+F2 strike using 10-minute option low...');
  const tradeDate = istDateString();
  const [ceCandle10, peCandle10] = await Promise.all([
    checkCE ? fetchOptionWindowCandle(callExpiry, callTrade.strike, 'CE', tradeDate, 'TEN_MINUTE', '09:15', '09:25') : Promise.resolve(null),
    checkPE ? fetchOptionWindowCandle(putExpiry, putTrade.strike, 'PE', tradeDate, 'TEN_MINUTE', '09:15', '09:25') : Promise.resolve(null),
  ]);

  const callGap = checkCE ? !ceCandle10 || ceCandle10.low < callTrade.entryPrice : false;
  const putGap  = checkPE ? !peCandle10 || peCandle10.low < putTrade.entryPrice  : false;

  const tok = cfg.telegramToken;
  const { strategyName, prepDate, prepDay } = eodStore;

  let msg = `🔔 <b>FiFTO Trading Secret</b>\n📊 <b>${strategyName} — Morning Check (09:25)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  if (ceActive) {
    msg += `🔄 CE already active\n${fmtActiveTrade(ceActive)}\n\n`;
  } else if (checkCE) {
    msg += callGap
      ? `📉 CE ${callTrade.strike} · ${callExpiry}\n10m Low ₹${ceCandle10?.low?.toFixed?.(1) ?? 'NA'} &lt; Entry ₹${callTrade.entryPrice.toFixed(1)} → <b>F3 Fail — Recalc @ 09:30</b>\n\n`
      : `✅ CE ${callTrade.strike} · ${callExpiry}\n10m Low ₹${ceCandle10.low.toFixed(1)} ≥ Entry ₹${callTrade.entryPrice.toFixed(1)} → <b>F3 OK</b>\n\n`;
  }
  if (peActive) {
    msg += `🔄 PE already active\n${fmtActiveTrade(peActive)}\n`;
  } else if (checkPE) {
    msg += putGap
      ? `📈 PE ${putTrade.strike} · ${putExpiry}\n10m Low ₹${peCandle10?.low?.toFixed?.(1) ?? 'NA'} &lt; Entry ₹${putTrade.entryPrice.toFixed(1)} → <b>F3 Fail — Recalc @ 09:30</b>\n`
      : `✅ PE ${putTrade.strike} · ${putExpiry}\n10m Low ₹${peCandle10.low.toFixed(1)} ≥ Entry ₹${putTrade.entryPrice.toFixed(1)} → <b>F3 OK</b>\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  if (!checkCE && !checkPE) {
    msg += `📋 <b>Both legs already active — tracking existing positions</b>`;
  } else {
    msg += (!callGap && !putGap)
      ? `✅ <b>Open leg(s) safe — place only missing order(s)</b>`
      : `⚡ Gap detected — recalculating missing leg(s) after 09:30 candle…`;
  }

  if (sendTelegram && tok) await tgSendToAll(tok, telegramTargets, msg);
  console.log(`[MorningCheck] CE active=${!!ceActive} PE active=${!!peActive} CE recalc=${callGap} PE recalc=${putGap}`);
  const result = {
    callGap,
    putGap,
    ce10Low: ceCandle10?.low ?? 0,
    pe10Low: peCandle10?.low ?? 0,
  };

  // Place any safe leg immediately. Recalc legs will be handled at 09:30.
  if (autoPlace && (checkCE || checkPE) && (!callGap || !putGap)) {
    gapDownSignals = null; // use EOD signals
    setTimeout(() => autoPlacePaperOrders(result), 1000);
  }
  // F3-fail case: 09:30 recalc will decide whether a new strike is valid.

  return result;
}

let morningCheckResult = null; // { callGap, putGap } — shared with 09:32 recalc

function mergeRecalcSignalsIntoEodStore(nextSignals, meta = {}) {
  if (!eodStore || !nextSignals) return;
  eodStore = {
    ...eodStore,
    recalculatedSignals: nextSignals,
    recalculatedAt: new Date().toISOString(),
    recalcMeta: meta,
  };
  diskSet('eod_store', eodStore);
}

function buildRecalcTelegramMessage({ strategyName, prepDate, prepDay, callExpiry, putExpiry, candle, callGap, putGap, callNew, putNew }) {
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
  return msg;
}

async function runGapDownRecalcServer(opts = {}) {
  const { autoPlace = true, forceFreshMorningCheck = false, sendTelegram = autoPlace } = opts;
  if (!eodStore) return null;
  if (forceFreshMorningCheck || !morningCheckResult) {
    morningCheckResult = await runMorningCheck({ autoPlace: false, sendTelegram: false });
  }
  if (!morningCheckResult || (!morningCheckResult.callGap && !morningCheckResult.putGap)) return null;

  const { callGap, putGap } = morningCheckResult;
  const { prepDate, prepDay, strategyName } = eodStore;
  const GAP_BUF = 0.00125;
  const si = SRV_CFG.strikeInterval;
  const n  = SRV_CFG.numStrikes;

  console.log('[GapRecalc] Fetching 9:30 candle...');
  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const candle = await fetchNifty15MinCandle(today).catch(() => null);
  if (!candle) { console.warn('[GapRecalc] No candle data'); return; }

  const ceBuffer = candle.low  * (1 - GAP_BUF);
  const peBuffer = candle.high * (1 + GAP_BUF);
  const callEnd  = srvRoundStrike(ceBuffer, false);
  const putEnd   = srvRoundStrike(peBuffer, true);

  const callRange = callGap ? Array.from({length: n}, (_, i) => callEnd + (n - 1 - i) * si) : [];
  const putRange  = putGap  ? Array.from({length: n}, (_, i) => putEnd  - (n - 1 - i) * si) : [];
  const expiries = await computeNiftyExpiries(8);
  const nextTrade = getNextTradingDay(getPreviousTradingDay(today));
  const startIdx = (nextTrade.day === 'Monday' || nextTrade.day === 'Tuesday') ? 1 : 0;
  const expiryList = expiries.slice(startIdx, startIdx + SRV_CFG.maxTries).map(e => e.toUpperCase());

  const [callNew, putNew] = await Promise.all([
    callGap ? selectStrikeRecalcServer('CE', expiryList, callRange, today) : Promise.resolve(null),
    putGap  ? selectStrikeRecalcServer('PE', expiryList, putRange,  today) : Promise.resolve(null),
  ]);

  const msg = buildRecalcTelegramMessage({
    strategyName,
    prepDate,
    prepDay,
    callExpiry: callNew?.expiry ?? eodStore.callExpiry,
    putExpiry: putNew?.expiry ?? eodStore.putExpiry,
    candle,
    callGap,
    putGap,
    callNew,
    putNew,
  });

  // Store recalculated signals so autoPlacePaperOrders uses them
  gapDownSignals = {
    callTrade: callNew ? { ...eodStore.callTrade, ...callNew } : eodStore.callTrade,
    putTrade:  putNew  ? { ...eodStore.putTrade,  ...putNew }  : eodStore.putTrade,
    callExpiry: callNew?.expiry ?? eodStore.callExpiry,
    putExpiry: putNew?.expiry ?? eodStore.putExpiry,
  };
  mergeRecalcSignalsIntoEodStore(gapDownSignals, {
    callGap,
    putGap,
    candle,
    source: 'MANUAL_OR_AUTO_0930',
    telegramMessage: msg,
  });

  if (sendTelegram && cfg.telegramToken) {
    await tgSendToAll(cfg.telegramToken, telegramTargets, msg);
    console.log('[GapRecalc] Recalculated signals sent to Telegram');
  } else {
    console.log('[GapRecalc] Recalculated signals stored; Telegram waiting for manual send');
  }

  if (autoPlace) {
    // Place paper orders 3s after recalc completes
    setTimeout(() => autoPlacePaperOrders(morningCheckResult), 3000);
  }
  return { morningCheckResult, gapDownSignals, candle, callNew, putNew };
}

// ── NIFTY Futures — 2-Day Breakout Strategy ────────────────────────────────
const MROUND = (v, base = 0.05) => Math.round(v / base) * base;
const FUTURES_LOT_SIZE = 65;

function getFuturesContract(dateStr) {
  const ist = dateStr ? new Date(dateStr + 'T00:00:00+05:30') : new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  // NIFTY index futures expire on last Tuesday of the month
  const lastDay = new Date(Date.UTC(y, m + 1, 0));
  const lastTue = new Date(Date.UTC(y, m, lastDay.getUTCDate() - ((lastDay.getUTCDay() + 7 - 3) % 7 + 1)));
  const todayNum = ist.getUTCDate();
  const expiryDate = lastTue.getUTCDate();
  let useMonth = m, useYear = y;
  if (todayNum > expiryDate || (todayNum === expiryDate && ist.getUTCHours() >= 15)) {
    useMonth = (m + 1) % 12;
    if (useMonth === 0) useYear++;
  }
  // If we're within 5 weekdays of expiry, roll to next month
  let wd = 0;
  const d = new Date(ist);
  d.setUTCDate(d.getUTCDate() + 1);
  // Recalculate lastTue for the selected month
  const selLastDay = new Date(Date.UTC(useYear, useMonth + 1, 0));
  let selLastTue = new Date(Date.UTC(useYear, useMonth, selLastDay.getUTCDate() - ((selLastDay.getUTCDay() + 7 - 3) % 7 + 1)));
  const tmpD = new Date(ist);
  tmpD.setUTCDate(tmpD.getUTCDate() + 1);
  while (tmpD <= selLastTue) {
    if (tmpD.getUTCDay() !== 0 && tmpD.getUTCDay() !== 6) wd++;
    tmpD.setUTCDate(tmpD.getUTCDate() + 1);
  }
  if (wd < 5) {
    useMonth = (useMonth + 1) % 12;
    if (useMonth === 0) useYear++;
    const nextLastDay = new Date(Date.UTC(useYear, useMonth + 1, 0));
    selLastTue = new Date(Date.UTC(useYear, useMonth, nextLastDay.getUTCDate() - ((nextLastDay.getUTCDay() + 7 - 3) % 7 + 1)));
  }
  const monthLabel = MONTHS[useMonth];
  const yy = String(useYear).slice(2);
  const expiryDay = String(selLastTue.getUTCDate()).padStart(2, '0');
  const symbol = `NIFTY${expiryDay}${monthLabel}${yy}FUT`;
  const expiryLabel = `${expiryDay}${monthLabel}${yy}`;
  return { symbol, expiryLabel, useMonth, useYear, lastTue: selLastTue.toISOString().slice(0,10) };
}

let futuresTokenCache = null;
let futuresTokenCacheMap = new Map();
async function findFuturesToken(dateStr) {
  if (!dateStr) {
    if (futuresTokenCache) return futuresTokenCache;
  } else {
    const cached = futuresTokenCacheMap.get(dateStr);
    if (cached) return cached;
  }
  const contract = getFuturesContract(dateStr);
  const cacheKey = contract.symbol;
  // Check if we already have this contract cached for any date
  if (!dateStr && futuresTokenCache?.symbol === cacheKey) return futuresTokenCache;
  // For date-specific lookups, check the map by symbol
  for (const [, v] of futuresTokenCacheMap) { if (v.symbol === cacheKey && dateStr) { futuresTokenCacheMap.set(dateStr, v); return v; } }
  const master = await getInstrumentMaster();

  // Try multiple search strategies (instrument master field names vary)
  let fut = null;
  const strategies = [
    // 1: exch_seg + name + instrumenttype + symbol
    () => master.find(r =>
      r.exch_seg === 'NFO' && r.name === 'NIFTY' && r.instrumenttype === 'FUTIDX' && r.symbol === contract.symbol
    ),
    // 2: exch_seg + name + symbol (no instrumenttype)
    () => master.find(r =>
      r.exch_seg === 'NFO' && r.name === 'NIFTY' && r.symbol === contract.symbol
    ),
    // 3: exch_seg + symbol only
    () => master.find(r =>
      r.exch_seg === 'NFO' && r.symbol === contract.symbol
    ),
    // 4: exch_seg + name + FUTIDX + symbol contains month and FUT
    () => master.find(r =>
      r.exch_seg === 'NFO' && r.name === 'NIFTY' &&
      (r.instrumenttype === 'FUTIDX' || r.instrumenttype === 'FUT' || r.instrumenttype === 'FUTURE' || !r.instrumenttype) &&
      r.symbol && r.symbol.includes('FUT') && r.symbol.includes(contract.expiryLabel)
    ),
    // 5: exch_seg + symbol includes month + FUT
    () => master.find(r =>
      r.exch_seg === 'NFO' &&
      r.symbol && r.symbol.includes('FUT') && r.symbol.includes(contract.expiryLabel)
    ),
    // 6: exch_seg + symbol NIFTY + FUT + name missing/empty
    () => master.find(r =>
      r.exch_seg === 'NFO' &&
      r.symbol && r.symbol.startsWith('NIFTY') && r.symbol.endsWith('FUT')
    ),
  ];

  for (const s of strategies) {
    fut = s();
    if (fut) break;
  }

  if (!fut) {
    // Debug: log NIFTY future-like entries from master
    const niftyFuts = master.filter(r => r.exch_seg === 'NFO' && r.symbol && r.symbol.startsWith('NIFTY') && r.symbol.includes('FUT')).slice(0, 10);
    throw new Error(`Futures contract ${contract.symbol} not found. Found ${niftyFuts.length} NIFTY*FUT entries: ${JSON.stringify(niftyFuts.map(s => ({sym: s.symbol, name: s.name, type: s.instrumenttype, token: s.token, expiry: s.expiry})))}`);
  }

  futuresTokenCache = { ...contract, token: fut.token, lotSize: Number(fut.lotsize) || FUTURES_LOT_SIZE };
  if (dateStr) futuresTokenCacheMap.set(dateStr, futuresTokenCache);
  return futuresTokenCache;
}

function resetFuturesTokenCache() { futuresTokenCache = null; futuresTokenCacheMap = new Map(); }

async function fetch2DayFuturesOHLC(token, toDateStr) {
  const ck = `futures_ohlc2d_${token}_${toDateStr}`;
  const cached = diskGet(ck);
  if (cached) return cached;
  await login();
  const toDate = new Date(toDateStr);
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 10);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 09:15`;
  const fmtEnd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 15:30`;
  const res = await fetch(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ exchange: 'NFO', symboltoken: token, interval: 'ONE_DAY', fromdate: fmt(fromDate), todate: fmtEnd(toDate) }),
  });
  const json = await res.json();
  if (!json.status || !Array.isArray(json.data)) throw new Error(`Futures OHLC fetch failed: ${json.message}`);
  const candles = json.data.filter(c => c[2] && c[3]);
  // Exclude the target date's candle (it's incomplete for live or belongs to the current day)
  const prevCandles = candles.filter(c => !c[0]?.startsWith(toDateStr));
  if (prevCandles.length < 2) throw new Error('Not enough futures OHLC data (need 2 completed days before target date)');
  const last2 = prevCandles.slice(-2);
  const result = buildHistoricalResult(last2.map(c => ({ date: c[0] ? c[0].split('T')[0] : '', high: c[2], low: c[3] })));
  diskSet(ck, result);
  return result;
}

async function fetchFuturesLTP(token) {
  await login();
  const res = await fetch(`${BASE}/rest/secure/angelbroking/market/v1/quote/`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ mode: 'LTP', exchangeTokens: { NFO: [token] } }),
  });
  const json = await res.json();
  return json.data?.fetched?.[0]?.ltp ?? json.data?.fetched?.[0]?.lastPrice ?? 0;
}

async function calculateFuturesSignals() {
  const contract = await findFuturesToken();
  const dateStr = istDateString();
  const ohlc = await fetch2DayFuturesOHLC(contract.token, dateStr);
  const twoDHH = Math.max(ohlc.day1High, ohlc.day2High);
  const twoDLL = Math.min(ohlc.day1Low, ohlc.day2Low);
  const buyEntry  = MROUND(twoDHH * 1.00125);
  const buyTarget = MROUND(buyEntry * 1.0125);
  const buySL1    = MROUND(Math.max(buyEntry * 0.9875, twoDLL * 0.99875));
  const buySL2    = MROUND(Math.max(buyEntry, twoDLL * 0.99875));
  const sellEntry  = MROUND(twoDLL * 0.99875);
  const sellTarget = MROUND(sellEntry * 0.9875);
  const sellSL1    = MROUND(Math.min(sellEntry * 1.0125, twoDHH * 1.00125));
  const sellSL2    = MROUND(Math.min(sellEntry, twoDHH * 1.00125));
  const result = {
    date: dateStr, contract: contract.symbol, twoDHH, twoDLL,
    buyEntry, buyTarget, buySL1, buySL2,
    sellEntry, sellTarget, sellSL1, sellSL2,
    lastUpdated: new Date().toISOString(),
  };
  diskSet('futures-signals', result);
  return result;
}

function futuresLoadSignals() { return diskGet('futures-signals') || null; }
function futuresLoadPosition() { const d = diskGet('futures-position'); return d?.position || null; }
function futuresLoadPositionData() { return diskGet('futures-position') || { position: null, orders: null, lastOrderDate: '' }; }
function futuresSavePositionData(d) { diskSet('futures-position', d); }
function futuresSavePosition(pos) { const d = futuresLoadPositionData(); d.position = pos; futuresSavePositionData(d); }
function futuresDeletePosition() { const d = futuresLoadPositionData(); d.position = null; futuresSavePositionData(d); }
function futuresLoadHistory() { return diskGet('futures-history') || []; }
function futuresSaveHistory(h) { diskSet('futures-history', h); }

function futuresAddHistory(entry) {
  const hist = futuresLoadHistory();
  hist.push({ ...entry, closedAt: new Date().toISOString() });
  futuresSaveHistory(hist);
}

// ── Auto-place futures entry orders at 09:16 ────────────────────────────
let futuresGapBuy = false, futuresGapSell = false;

async function autoPlaceFuturesOrders() {
  const signals = futuresLoadSignals();
  if (!signals || signals.date !== istDateString()) return;
  const data = futuresLoadPositionData();
  if (data?.position) return;
  if (data?.orders && data.lastOrderDate === istDateString()) return;

  const contract = await findFuturesToken();
  const ltp = await fetchFuturesLTP(contract.token).catch(() => 0);
  if (!ltp) return;

  const orders = {};
  futuresGapBuy = ltp >= signals.buyEntry;
  futuresGapSell = ltp <= signals.sellEntry;

  if (!futuresGapBuy) orders.buy = { entryPrice: signals.buyEntry, status: 'PENDING', type: 'BUY' };
  if (!futuresGapSell) orders.sell = { entryPrice: signals.sellEntry, status: 'PENDING', type: 'SELL' };

  futuresSavePositionData({ position: null, orders, lastOrderDate: istDateString() });
  console.log(`[Futures] Orders: BUY=${orders.buy?'✅no-gap '+signals.buyEntry:'⏳gap-up'} SELL=${orders.sell?'✅no-gap '+signals.sellEntry:'⏳gap-down'}`);

  if (cfg.telegramToken) {
    const msg =
`📈 <b>NIFTY Futures — ${signals.date}</b>
━━━━━━━━━━━━━━━━━━
${signals.contract} · LTP ₹${ltp.toFixed(2)}
📗 BUY ${orders.buy ? '✅ @ ₹' + signals.buyEntry.toFixed(2) : '⏳ GAP UP — 09:30 recalc'}
📕 SELL ${orders.sell ? '✅ @ ₹' + signals.sellEntry.toFixed(2) : '⏳ GAP DOWN — 09:30 recalc'}
━━━━━━━━━━━━━━━━━━
🎯 Target: ₹${signals.buyTarget.toFixed(2)} / ₹${signals.sellTarget.toFixed(2)}
🛑 SL1: ₹${signals.buySL1.toFixed(2)} / ₹${signals.sellSL1.toFixed(2)}`;
    tgSendToAll(cfg.telegramToken, telegramTargets, msg).catch(() => {});
  }
}

async function gapRecalcFuturesOrders() {
  if (!futuresGapBuy && !futuresGapSell) return;
  const data = futuresLoadPositionData();
  if (data?.position) return;
  const signals = futuresLoadSignals();
  if (!signals) return;

  const candle = await fetchNifty15MinCandle(istDateString()).catch(() => null);
  if (!candle) return;
  const orders = { ...(data.orders || {}) };

  if (futuresGapBuy && candle.high) {
    const newEntry = MROUND(candle.high * 1.00125);
    orders.buy = {
      entryPrice: newEntry, status: 'PENDING', type: 'BUY', recalc: true,
      targetPrice: MROUND(newEntry * 1.0125),
      sl2: MROUND(Math.max(newEntry, signals.twoDLL * 0.99875)),
    };
    console.log(`[Futures] Buy gap-recalc: new entry ${newEntry} (15min high ${candle.high})`);
    futuresGapBuy = false;
  }
  if (futuresGapSell && candle.low) {
    const newEntry = MROUND(candle.low * 0.99875);
    orders.sell = {
      entryPrice: newEntry, status: 'PENDING', type: 'SELL', recalc: true,
      targetPrice: MROUND(newEntry * 0.9875),
      sl2: MROUND(Math.min(newEntry, signals.twoDHH * 1.00125)),
    };
    console.log(`[Futures] Sell gap-recalc: new entry ${newEntry} (15min low ${candle.low})`);
    futuresGapSell = false;
  }
  futuresSavePositionData({ ...data, orders });
}

// ── 09:16 — Gap-against check for carried futures positions ──────────────────
let futuresGapAgainstDate = '';

async function checkCarriedFuturesGap() {
  const dateStr = istDateString();
  if (futuresGapAgainstDate === dateStr) return;
  const data = futuresLoadPositionData();
  if (!data?.position) return;
  const pos = data.position;
  const ltp = await fetchFuturesLTP((await findFuturesToken()).token).catch(() => 0);
  if (!ltp) return;

  futuresGapAgainstDate = dateStr;
  if (!pos.lot1Exited) {
    const gapAgainst = (pos.side === 'BUY' && ltp < pos.currentSL) || (pos.side === 'SELL' && ltp > pos.currentSL);
    if (gapAgainst) {
      pos.gapAgainst = true;
      futuresSavePosition(pos);
      console.log(`[Futures] Gap-against detected for ${pos.side} position. Waiting for 09:30 recalc.`);
    }
  }
}

// ── 09:30 — Recalc SL for gap-against carried futures positions ──────────────
let futuresSLRecalcDate = '';

async function recalcCarriedFuturesSL() {
  const dateStr = istDateString();
  if (futuresSLRecalcDate === dateStr) return;
  const data = futuresLoadPositionData();
  if (!data?.position || !data.position.gapAgainst) return;

  futuresSLRecalcDate = dateStr;
  const pos = data.position;
  const candle = await fetchNifty15MinCandle(dateStr).catch(() => null);
  if (!candle) { pos.gapAgainst = false; futuresSavePosition(pos); return; }

  if (pos.side === 'BUY') {
    pos.currentSL = MROUND(candle.low * 0.99875);
  } else {
    pos.currentSL = MROUND(candle.high * 1.00125);
  }
  pos.gapAgainst = false;
  futuresSavePosition(pos);
  console.log(`[Futures] Gap-against SL recalc: new SL=${pos.currentSL} (15-min ${pos.side === 'BUY' ? 'low' : 'high'} ${pos.side === 'BUY' ? candle.low : candle.high})`);
}

// ── Auto-poll futures: check orders + position ─────────────────────────────
async function futuresPollPosition() {
  const data = futuresLoadPositionData();
  const signals = futuresLoadSignals();
  if (!signals) return;
  const ltp = await fetchFuturesLTP((await findFuturesToken()).token).catch(() => 0);
  if (!ltp) return;
  const dateStr = istDateString();
  const timeMins = istMinutes();
  const marketOpen = isMarketOpen();

  // ── Check pending orders for entry trigger ──
  if (data?.orders && !data.position) {
    const orders = data.orders;
    for (const side of ['buy', 'sell']) {
      const o = orders[side];
      if (!o || o.status !== 'PENDING') continue;
      const triggered = (side === 'buy' && ltp >= o.entryPrice) || (side === 'sell' && ltp <= o.entryPrice);
      if (marketOpen && triggered) {
        // Cancel opposite order
        const opp = side === 'buy' ? 'sell' : 'buy';
        if (orders[opp]) orders[opp].status = 'CANCELLED';

        // Create position (use recalculated levels if present for gap scenarios)
        const pos = {
          side: side === 'buy' ? 'BUY' : 'SELL', entryPrice: o.entryPrice,
          entryTime: new Date().toISOString(), lots: 2, lot1Exited: false,
          entryDate: dateStr, carryDays: 0, lotSize: futuresTokenCache?.lotSize || FUTURES_LOT_SIZE,
          targetPrice: o.targetPrice || (side === 'buy' ? signals.buyTarget : signals.sellTarget),
          currentSL: o.sl1 || (side === 'buy' ? signals.buySL1 : signals.sellSL1),
          slType: 'SL1',
          sl1: o.sl1 || (side === 'buy' ? signals.buySL1 : signals.sellSL1),
          sl2: o.sl2 || (side === 'buy' ? signals.buySL2 : signals.sellSL2),
          contract: signals.contract, ltp, runningPnl: 0,
        };
        o.status = 'TRIGGERED';
        futuresSavePositionData({ position: pos, orders, lastOrderDate: dateStr });
        console.log(`[Futures] ENTRY TRIGGERED: ${pos.side} @ ₹${pos.entryPrice}, SL1=${pos.currentSL}, Target=${pos.targetPrice}`);

        if (cfg.telegramToken) {
          tgSendToAll(cfg.telegramToken, telegramTargets,
`🔔 <b>NIFTY Futures — Entry Triggered</b>
━━━━━━━━━━━━━━━━━━
${pos.side} @ ₹${pos.entryPrice.toFixed(2)} · ${signals.contract}
🎯 Target: ₹${pos.targetPrice.toFixed(2)}
🛑 SL1: ₹${pos.currentSL.toFixed(2)}
💼 2 Lots × ${pos.lotSize || FUTURES_LOT_SIZE} qty`).catch(() => {});
        }
        return; // process one trigger per poll
      }
    }
    // Still pending — update orders in storage
    futuresSavePositionData({ ...data, orders });
    return;
  }

  // ── Active position monitoring ──
  const pos = data?.position;
  if (!pos) return;

  pos.ltp = ltp;
  pos.runningPnl = pos.side === 'BUY'
    ? (ltp - pos.entryPrice) * 2 * Number(pos.lotSize || FUTURES_LOT_SIZE)
    : (pos.entryPrice - ltp) * 2 * Number(pos.lotSize || FUTURES_LOT_SIZE);

  // Update carry days
  if (pos.entryDate && pos.entryDate < dateStr) {
    const diff = Math.floor((new Date(dateStr).getTime() - new Date(pos.entryDate).getTime()) / 86400000);
    pos.carryDays = Math.max(0, diff);
  }

  if (!pos.lot1Exited) {
    // Both lots open — check SL1
    if (marketOpen && pos.currentSL) {
      if ((pos.side === 'BUY' && ltp <= pos.currentSL) || (pos.side === 'SELL' && ltp >= pos.currentSL)) {
        pos.exitPrice = ltp; pos.exitReason = 'SL1'; pos.closedAt = new Date().toISOString();
        const pnl = (pos.entryPrice - ltp) * (pos.side === 'BUY' ? 1 : -1) * 2 * Number(pos.lotSize || FUTURES_LOT_SIZE);
        futuresAddHistory({ ...pos, pnl });
        futuresDeletePosition();
        console.log(`[Futures] SL1 HIT: ${pos.side} @ ₹${ltp}, P&L ₹${pnl.toFixed(0)}`);
        if (cfg.telegramToken) tgSendToAll(cfg.telegramToken, telegramTargets,
`🛑 <b>NIFTY Futures — SL1 Hit</b>
━━━━━━━━━━━━━━━━━━
${pos.side} Entry ₹${pos.entryPrice.toFixed(2)} → Exit ₹${ltp.toFixed(2)}
💰 P&L: <b>₹${pnl.toFixed(0)}</b>`).catch(() => {});
        return;
      }
    }
    // Check target
    if (marketOpen && pos.targetPrice) {
      if ((pos.side === 'BUY' && ltp >= pos.targetPrice) || (pos.side === 'SELL' && ltp <= pos.targetPrice)) {
        pos.lot1Exited = true;
        pos.targetHitAt = new Date().toISOString();
        pos.currentSL = pos.sl2;
        pos.slType = 'SL2';
        console.log(`[Futures] TARGET HIT: Lot 1 exits, Lot 2 continues with SL2=${pos.sl2}`);
        if (cfg.telegramToken) tgSendToAll(cfg.telegramToken, telegramTargets,
`🎯 <b>NIFTY Futures — Target Hit</b>
━━━━━━━━━━━━━━━━━━
${pos.side} Entry ₹${pos.entryPrice.toFixed(2)} → Target @ ₹${pos.targetPrice.toFixed(2)}
✅ Lot 1 exited · Lot 2 TSL active (SL2=${pos.sl2})`).catch(() => {});
      }
    }
  } else {
    // Lot 1 already exited — only Lot 2 running, check SL2
    if (marketOpen && pos.currentSL && pos.slType === 'SL2') {
      if ((pos.side === 'BUY' && ltp <= pos.currentSL) || (pos.side === 'SELL' && ltp >= pos.currentSL)) {
        pos.exitPrice = ltp; pos.exitReason = 'SL2'; pos.closedAt = new Date().toISOString();
        const pnl = (pos.entryPrice - ltp) * (pos.side === 'BUY' ? 1 : -1) * Number(pos.lotSize || FUTURES_LOT_SIZE);
        futuresAddHistory({ ...pos, pnl });
        futuresDeletePosition();
        console.log(`[Futures] SL2 HIT: ${pos.side} @ ₹${ltp}, P&L ₹${pnl.toFixed(0)}`);
        if (cfg.telegramToken) tgSendToAll(cfg.telegramToken, telegramTargets,
`🛑 <b>NIFTY Futures — SL2 (TSL) Hit</b>
━━━━━━━━━━━━━━━━━━
${pos.side} Entry ₹${pos.entryPrice.toFixed(2)} → Exit ₹${ltp.toFixed(2)}
💰 P&L: <b>₹${pnl.toFixed(0)}</b>`).catch(() => {});
        return;
      }
    }
  }

  // Daily TSL refresh for carried positions (morning only)
  if (pos.lot1Exited && signals && signals.date === dateStr) {
    if (pos.side === 'BUY') {
      const freshSL2 = MROUND(Math.max(pos.entryPrice, signals.twoDLL * 0.99875));
      pos.currentSL = freshSL2;
    } else {
      const freshSL2 = MROUND(Math.min(pos.entryPrice, signals.twoDHH * 1.00125));
      pos.currentSL = freshSL2;
    }
  }

  futuresSavePositionData({ ...data, position: pos });
}

// Schedule futures signal calc at 08:45
async function runFuturesAutoCalc() {
  try {
    resetFuturesTokenCache();
    const signals = await calculateFuturesSignals();
    console.log(`[Futures] Signals calculated for ${signals.contract}`);
    return signals;
  } catch (e) {
    console.error('[Futures] Auto-calc failed:', e.message);
    return null;
  }
}

// ── Futures Backtest (1-minute data) ──────────────────────────────────────
async function fetchIntradayCandles(dateStr, token) {
  const ck = token ? `intraday_1min_${token}_${dateStr}` : `intraday_1min_${dateStr}`;
  const hit = diskGet(ck);
  if (hit) return hit;
  await login();
  const fmt09 = `${dateStr} 09:15`;
  const fmt15 = `${dateStr} 15:30`;
  const exchange = token ? 'NFO' : 'NSE';
  const symbolToken = token || NIFTY_TOKEN;
  const res = await fetch(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ exchange, symboltoken: symbolToken, interval: 'ONE_MINUTE', fromdate: fmt09, todate: fmt15 }),
  });
  const json = await res.json();
  if (!json.status || !Array.isArray(json.data)) throw new Error(`Intraday fetch failed for ${dateStr}: ${json.message}`);
  const candles = json.data
    .filter(c => c[2] && c[3] && c[4])
    .map(c => ({ ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4] }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (candles.length < 5) throw new Error(`Not enough intraday data for ${dateStr}`);
  diskSet(ck, candles);
  return candles;
}

async function runFuturesBacktest(startDateStr, endDateStr) {
  // Fetch extra pre-start data so entry checks work from day 1 (need 2 prior days for 2DHH/2DLL)
  const bufStart = new Date(startDateStr);
  bufStart.setUTCDate(bufStart.getUTCDate() - 6);
  const bufStartStr = bufStart.toISOString().slice(0, 10);
  const raw = await (async () => {
    const api = `https://www.nseindia.com/api/historicalOR/indicesHistory?indexType=NIFTY%2050&from=${nseDate(bufStartStr)}&to=${nseDate(endDateStr)}`;
    const res = await fetch(api, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com/reports-indices-historical-index-data' },
    });
    const json = await res.json();
    if (!res.ok || !Array.isArray(json.data)) throw new Error(`NSE range fetch failed: ${res.status}`);
    return json.data
      .map(r => ({ date: parseNseDate(r.EOD_TIMESTAMP), high: Number(r.EOD_HIGH_INDEX_VAL), low: Number(r.EOD_LOW_INDEX_VAL) }))
      .filter(r => r.date && r.high && r.low && r.date >= bufStartStr && r.date <= endDateStr)
      .sort((a, b) => a.date.localeCompare(b.date));
  })();
  const firstEntryIdx = raw.findIndex(r => r.date >= startDateStr);
  if (firstEntryIdx < 2 || raw.length < 3) throw new Error('Need at least 3 days of data');

  // Pre-fetch futures tokens and 1-min candles for all trading days
  const tokenCache = new Map();
  const intra = new Map();
  const btLog = [`raw: ${raw.length} days, first=${raw[0]?.date} last=${raw[raw.length-1]?.date}`];
  let prevPct = -1;
  for (let i = 0; i < raw.length; i++) {
    const pct = Math.floor((i + 1) / raw.length * 100);
    if (pct !== prevPct && pct % 10 === 0) console.log(`[Backtest] Loading data... ${pct}%`);
    prevPct = pct;
    // Try futures 1-min first, fall back to spot
    let futToken = null;
    try {
      futToken = await findFuturesToken(raw[i].date);
      tokenCache.set(raw[i].date, futToken);
      btLog.push(`prefetch_${i}: token=${futToken.token} symbol=${futToken.symbol}`);
      const fc = await fetchIntradayCandles(raw[i].date, futToken.token);
      intra.set(raw[i].date, { candles: fc, isFutures: true });
      btLog.push(`prefetch_${i}: futures OK (${fc?.length || 0} candles)`);
      continue;
    } catch (e) {
      btLog.push(`prefetch_${i}: futures FAILED (${e.message})`);
      // Futures token or 1-min not available — try spot
      console.warn(`[Backtest] Futures data unavailable for ${raw[i].date}: ${e.message}. Trying spot...`);
      try {
        const sc = await fetchIntradayCandles(raw[i].date);
        if (sc) { intra.set(raw[i].date, { candles: sc, isFutures: false }); btLog.push(`prefetch_${i}: spot OK (${sc.length} candles)`); }
      } catch (e2) { btLog.push(`prefetch_${i}: spot ALSO FAILED (${e2.message})`); console.warn(`[Backtest] Skipping ${raw[i].date} (spot also failed): ${e2.message}`); }
    }
  }
  if (intra.size < 3) throw new Error('Not enough intraday data loaded');

  const trades = [];
  let position = null;
  let totalPnl = 0, wins = 0, losses = 0, maxDrawdown = 0, peakEquity = 0;
  let consecutiveLosses = 0, maxConsecutiveLosses = 0;

  for (let i = 2; i < raw.length; i++) {
    const todayEOD = raw[i];
    const dateStr = todayEOD.date;
    if (dateStr < startDateStr) continue; // skip setup-only days
    const entry = intra.get(dateStr);
    if (!entry) continue;
    const candles = entry.candles;
    const isFutures = entry.isFutures;

    // 2DHH/2DLL — prefer futures ONE_DAY data, fall back to spot EOD data
    let twoDHH, twoDLL;
    if (isFutures) {
      const token = tokenCache.get(dateStr)?.token;
      if (token) {
        try {
          const ohlc = await fetch2DayFuturesOHLC(token, dateStr);
          twoDHH = Math.max(ohlc.day1High, ohlc.day2High);
          twoDLL = Math.min(ohlc.day1Low, ohlc.day2Low);
        } catch (e) {
        }
      }
    }
    if (twoDHH === undefined) {
      twoDHH = Math.max(raw[i - 1].high, raw[i - 2].high);
      twoDLL = Math.min(raw[i - 1].low, raw[i - 2].low);
    }

    const buyEntry  = MROUND(twoDHH * 1.00125);
    const buyTarget = MROUND(buyEntry * 1.0125);
    const buySL1    = MROUND(Math.max(buyEntry * 0.9875, twoDLL * 0.99875));
    const buySL2    = MROUND(Math.max(buyEntry, twoDLL * 0.99875));
    const sellEntry  = MROUND(twoDLL * 0.99875);
    const sellTarget = MROUND(sellEntry * 0.9875);
    const sellSL1    = MROUND(Math.min(sellEntry * 1.0125, twoDHH * 1.00125));
    const sellSL2    = MROUND(Math.min(sellEntry, twoDHH * 1.00125));

    if (!position) {
      // ── No position — iterate candles for entry ──
      // ── Gap detection (first candle) ──
      let gapSide = null, gapEntry = null, gapTarget = null, gapSL2 = null;
      const fc = candles[0];
      if (fc) {
        const gapBuy = fc.high >= buyEntry;
        const gapSell = fc.low <= sellEntry;
        if (gapBuy || gapSell) {
          gapSide = gapBuy ? 'BUY' : 'SELL';
          // Aggregate 15-min high/low from candles[0..14] (09:15–09:30)
          let aggH = -Infinity, aggL = Infinity;
          const aggN = Math.min(15, candles.length);
          for (let j = 0; j < aggN; j++) { aggH = Math.max(aggH, candles[j].high); aggL = Math.min(aggL, candles[j].low); }
          if (gapSide === 'BUY') {
            gapEntry = MROUND(aggH * 1.00125);
            gapTarget = MROUND(gapEntry * 1.0125);
            gapSL2 = MROUND(Math.max(gapEntry, twoDLL * 0.99875));
          } else {
            gapEntry = MROUND(aggL * 0.99875);
            gapTarget = MROUND(gapEntry * 0.9875);
            gapSL2 = MROUND(Math.min(gapEntry, twoDHH * 1.00125));
          }
          btLog.push(`gap_detected: ${gapSide} origEntry=${gapSide==='BUY'?buyEntry.toFixed(2):sellEntry.toFixed(2)} gapEntry=${gapEntry.toFixed(2)}`);
        }
      }

      let entered = false;
      for (let ci = 0; ci < candles.length; ci++) {
        if (entered) break;
        const c = candles[ci];
        // If gap detected, skip candles before 09:30 (first 15)
        if (gapSide && ci < 15) continue;

        // Use gap-recalculated entry if applicable, otherwise original
        const effBuyEntry = gapSide === 'BUY' ? gapEntry : buyEntry;
        const effSellEntry = gapSide === 'SELL' ? gapEntry : sellEntry;
        const effBuyTarget = gapSide === 'BUY' ? gapTarget : buyTarget;
        const effSellTarget = gapSide === 'SELL' ? gapTarget : sellTarget;
        const effBuySL2 = gapSide === 'BUY' ? gapSL2 : buySL2;
        const effSellSL2 = gapSide === 'SELL' ? gapSL2 : sellSL2;
        // SL1 always from original signals (even for gap entries)
        const effBuySL1 = buySL1;
        const effSellSL1 = sellSL1;

        if (c.high >= effBuyEntry) {
          position = { side:'BUY', entryPrice:effBuyEntry, entryDate:dateStr, lots:2, lot1Exited:false, carryDays:0,
            targetPrice:effBuyTarget, currentSL:effBuySL1, slType:'SL1', sl1:effBuySL1, sl2:effBuySL2, lotSize:FUTURES_LOT_SIZE,
            twoDHH, twoDLL, gapSide:gapSide || null, gapEntry:gapEntry || null,
            entryCandle:c.ts, entryCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close} };
          entered = true;
          if (c.low <= position.sl1) {
            const pnl = (position.sl1 - position.entryPrice) * 2 * FUTURES_LOT_SIZE;
            totalPnl += pnl; (pnl>0)?(wins++,consecutiveLosses=0):(losses++,consecutiveLosses++,maxConsecutiveLosses=Math.max(maxConsecutiveLosses,consecutiveLosses));
            peakEquity=Math.max(peakEquity,totalPnl); maxDrawdown=Math.min(maxDrawdown,totalPnl-peakEquity);
            trades.push({...position, exitDate:dateStr, exitPrice:position.sl1, exitReason:'SL1', pnl, daysHeld:1, entryCandle:c.ts, exitCandle:c.ts, exitCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close}});
            position = null;
          } else if (c.high >= position.targetPrice) {
            const pnlLot1 = (position.targetPrice - position.entryPrice) * 1 * FUTURES_LOT_SIZE;
            totalPnl += pnlLot1; wins++; consecutiveLosses=0;
            peakEquity=Math.max(peakEquity,totalPnl); maxDrawdown=Math.min(maxDrawdown,totalPnl-peakEquity);
            trades.push({...position, exitDate:dateStr, exitPrice:position.targetPrice, exitReason:'TARGET_LOT1', pnl:pnlLot1, daysHeld:1, lotExit:1, entryCandle:c.ts, exitCandle:c.ts, exitCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close}});
            position.lot1Exited = true; position.currentSL = position.sl2; position.slType = 'SL2';
          }
          break;
        }
        if (c.low <= effSellEntry) {
          position = { side:'SELL', entryPrice:effSellEntry, entryDate:dateStr, lots:2, lot1Exited:false, carryDays:0,
            targetPrice:effSellTarget, currentSL:effSellSL1, slType:'SL1', sl1:effSellSL1, sl2:effSellSL2, lotSize:FUTURES_LOT_SIZE,
            twoDHH, twoDLL, gapSide:gapSide || null, gapEntry:gapEntry || null,
            entryCandle:c.ts, entryCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close} };
          entered = true;
          if (c.high >= position.sl1) {
            const pnl = (position.entryPrice - position.sl1) * 2 * FUTURES_LOT_SIZE;
            totalPnl += pnl; (pnl>0)?(wins++,consecutiveLosses=0):(losses++,consecutiveLosses++,maxConsecutiveLosses=Math.max(maxConsecutiveLosses,consecutiveLosses));
            peakEquity=Math.max(peakEquity,totalPnl); maxDrawdown=Math.min(maxDrawdown,totalPnl-peakEquity);
            trades.push({...position, exitDate:dateStr, exitPrice:position.sl1, exitReason:'SL1', pnl, daysHeld:1, entryCandle:c.ts, exitCandle:c.ts, exitCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close}});
            position = null;
          } else if (c.low <= position.targetPrice) {
            const pnlLot1 = (position.entryPrice - position.targetPrice) * 1 * FUTURES_LOT_SIZE;
            totalPnl += pnlLot1; wins++; consecutiveLosses=0;
            peakEquity=Math.max(peakEquity,totalPnl); maxDrawdown=Math.min(maxDrawdown,totalPnl-peakEquity);
            trades.push({...position, exitDate:dateStr, exitPrice:position.targetPrice, exitReason:'TARGET_LOT1', pnl:pnlLot1, daysHeld:1, lotExit:1, entryCandle:c.ts, exitCandle:c.ts, exitCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close}});
            position.lot1Exited = true; position.currentSL = position.sl2; position.slType = 'SL2';
          }
          break;
        }
      }
    } else {
      // ── Position exists — iterate candles for exit ──
      position.carryDays++;
      // At day start (first candle), refresh SL2 for carry
      if (position.lot1Exited && candles.length > 0) {
        if (position.side === 'BUY') position.currentSL = MROUND(Math.max(position.entryPrice, twoDLL * 0.99875));
        else position.currentSL = MROUND(Math.min(position.entryPrice, twoDHH * 1.00125));
      }
      for (const c of candles) {
        if (!position) break;
        if (!position.lot1Exited) {
          const slHit = position.side === 'BUY' ? c.low <= position.sl1 : c.high >= position.sl1;
          const targetHit = position.side === 'BUY' ? c.high >= position.targetPrice : c.low <= position.targetPrice;
          if (slHit) {
            const pnl = position.side === 'BUY' ? (position.sl1 - position.entryPrice) * 2 * FUTURES_LOT_SIZE : (position.entryPrice - position.sl1) * 2 * FUTURES_LOT_SIZE;
            totalPnl += pnl; (pnl>0)?(wins++,consecutiveLosses=0):(losses++,consecutiveLosses++,maxConsecutiveLosses=Math.max(maxConsecutiveLosses,consecutiveLosses));
            peakEquity=Math.max(peakEquity,totalPnl); maxDrawdown=Math.min(maxDrawdown,totalPnl-peakEquity);
            trades.push({...position, exitDate:dateStr, exitPrice:position.sl1, exitReason:'SL1', pnl, daysHeld:position.carryDays, exitCandle:c.ts, exitCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close}});
            position = null; break;
          }
          if (targetHit) {
            position.lot1Exited = true; position.currentSL = position.sl2; position.slType = 'SL2';
            const pnlLot1 = position.side === 'BUY' ? (position.targetPrice - position.entryPrice) * 1 * FUTURES_LOT_SIZE : (position.entryPrice - position.targetPrice) * 1 * FUTURES_LOT_SIZE;
            totalPnl += pnlLot1; wins++; consecutiveLosses=0;
            peakEquity=Math.max(peakEquity,totalPnl); maxDrawdown=Math.min(maxDrawdown,totalPnl-peakEquity);
            trades.push({...position, exitDate:dateStr, exitPrice:position.targetPrice, exitReason:'TARGET_LOT1', pnl:pnlLot1, daysHeld:position.carryDays, lotExit:1, exitCandle:c.ts, exitCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close}});
          }
        }
        if (position && position.lot1Exited) {
          const sl2Hit = position.side === 'BUY' ? c.low <= position.currentSL : c.high >= position.currentSL;
          if (sl2Hit) {
            const pnl = position.side === 'BUY' ? (position.currentSL - position.entryPrice) * 1 * FUTURES_LOT_SIZE : (position.entryPrice - position.currentSL) * 1 * FUTURES_LOT_SIZE;
            totalPnl += pnl; (pnl>0)?(wins++,consecutiveLosses=0):(losses++,consecutiveLosses++,maxConsecutiveLosses=Math.max(maxConsecutiveLosses,consecutiveLosses));
            peakEquity=Math.max(peakEquity,totalPnl); maxDrawdown=Math.min(maxDrawdown,totalPnl-peakEquity);
            trades.push({...position, exitDate:dateStr, exitPrice:position.currentSL, exitReason:'SL2', pnl, daysHeld:position.carryDays, lotExit:2, exitCandle:c.ts, exitCandleOHLC:{o:c.open,h:c.high,l:c.low,cl:c.close}});
            position = null; break;
          }
        }
      }
    }
  }

  if (position) trades.push({...position, exitDate:raw[raw.length-1].date, exitPrice:position.entryPrice, exitReason:'END_OF_DATA', pnl:0, daysHeld:position.carryDays+1, exitCandle:null, exitCandleOHLC:null});

  const closedTrades = trades.filter(t => t.exitReason !== 'CARRY' && t.exitReason !== 'END_OF_DATA');
  const totalTrades = closedTrades.length;
  const winTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
  const lossTrades = closedTrades.filter(t => (t.pnl || 0) < 0);
  const grossProfit = winTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + (t.pnl || 0), 0));

  return {
    trades: closedTrades,
    stats: {
      totalTrades,
      winRate: totalTrades > 0 ? (winTrades.length / totalTrades * 100).toFixed(1) + '%' : '0%',
      wins: winTrades.length, losses: lossTrades.length,
      totalPnl: Math.round(totalPnl),
      grossProfit: Math.round(grossProfit), grossLoss: Math.round(grossLoss),
      profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞',
      maxDrawdown: Math.round(Math.abs(maxDrawdown)),
      avgPnl: totalTrades > 0 ? Math.round(totalPnl / totalTrades) : 0,
      maxConsecutiveLosses,
      startDate: startDateStr, endDate: endDateStr,
      tradingDays: raw.length,
    },
  };
}
// ── Option Selling Backtest ──────────────────────────────────────────────
async function runOptionBacktest(startDateStr, endDateStr) {
  // Fetch extra days before startDate to ensure we have 2 prior trading days
  const start = new Date(startDateStr + 'T00:00:00+05:30');
  const fetchStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const raw = await fetchNseHistoricalRange(fetchStart, endDateStr);
  const firstIdx = raw.findIndex(r => r.date >= startDateStr);
  if (firstIdx < 2) throw new Error('Need at least 2 prior days of data');

  const trades = [];
  let totalPnl = 0, wins = 0, losses = 0;
  let maxDrawdown = 0, peakEquity = 0;
  let consecutiveLosses = 0, maxConsecutiveLosses = 0;
  const log = [];

  // state carried between days
  let ceCarry = null, peCarry = null;

  for (let i = firstIdx; i < raw.length; i++) {
    const dateStr = raw[i].date;
    if (raw.length === 0) continue;

    // 2DHH/2DLL from previous 2 trading days
    const d1 = raw[i - 1], d2 = raw[i - 2];
    const twoDHH = Math.max(d1.high, d2.high);
    const twoDLL = Math.min(d1.low, d2.low);

    log.push(`\n── ${dateStr} ── 2DHH=${twoDHH.toFixed(2)} 2DLL=${twoDLL.toFixed(2)}`);

    // Expiry: use first Thursday after today
    let expiry = null;
    try {
      const expiries = await computeNiftyExpiries(8);
      const d = new Date(dateStr + 'T00:00:00+05:30');
      const dTime = d.getTime();
      expiry = expiries.find(e => {
        const ed = parseExpiryToDate(e);
        return ed.getTime() >= dTime;
      });
      if (!expiry) { log.push('  skip: no expiry found'); continue; }
    } catch { log.push('  skip: expiry error'); continue; }
    log.push(`  expiry=${expiry}`);

    // Strike ranges
    const si = SRV_CFG.strikeInterval;
    const n = SRV_CFG.numStrikes;
    const callEnd = srvRoundStrike(twoDLL * (1 - SRV_CFG.strikeFactor), false);
    const putEnd  = srvRoundStrike(twoDHH * (1 + SRV_CFG.strikeFactor), true);
    const callRange = Array.from({length: n}, (_, i) => callEnd + (n - 1 - i) * si);
    const putRange  = Array.from({length: n}, (_, i) => putEnd  - (n - 1 - i) * si);

    // Find CE and PE strikes
    let ceTrade = null, peTrade = null;
    let ceToken = null, peToken = null;
    let ceMorningFail = false, peMorningFail = false;
    let ceRecalc = null, peRecalc = null;

    try {
      const refDate = getPreviousTradingDay(dateStr);
      const [ceChain, peChain] = await Promise.all([
        fetchOptionChain(expiry, callRange.join(','), refDate).catch(() => ({data:[]})),
        fetchOptionChain(expiry, putRange.join(','), refDate).catch(() => ({data:[]})),
      ]);
      const chainData = Array.isArray(ceChain?.data) ? ceChain.data : (Array.isArray(ceChain) ? ceChain : []);
      const peChainData = Array.isArray(peChain?.data) ? peChain.data : (Array.isArray(peChain) ? peChain : []);

      const ceFind = srvFindStrike(chainData, callRange, 'CE');
      const peFind = srvFindStrike(peChainData, putRange, 'PE');
      if (!ceFind && !peFind) { log.push('  no strikes found'); continue; }

      // Build trades using live system's buildTradeFromOptionHistory
      const master = await getInstrumentMaster();
      const findOpt = (strike, type, exp) => master.find(r =>
        r.exch_seg === 'NFO' && r.name === 'NIFTY' && r.instrumenttype === 'OPTIDX' &&
        r.expiry === exp && Math.round(Number(r.strike) / 100) === strike &&
        (type === 'CE' ? r.symbol.endsWith('CE') : r.symbol.endsWith('PE'))
      );

      if (ceFind) {
        const opt = findOpt(ceFind.strike, 'CE', expiry);
        if (opt?.token) {
          ceToken = opt.token;
          const bt = await buildTradeFromOptionHistory('CALL', ceFind.strike, expiry, opt.token, refDate);
          if (bt.isValid) ceTrade = bt;
        }
      }
      if (peFind) {
        const opt = findOpt(peFind.strike, 'PE', expiry);
        if (opt?.token) {
          peToken = opt.token;
          const bt = await buildTradeFromOptionHistory('PUT', peFind.strike, expiry, opt.token, refDate);
          if (bt.isValid) peTrade = bt;
        }
      }
      if (!ceTrade && !peTrade) { log.push('  no viable trade (OHLC/premium check)'); continue; }
    } catch (e) {
      log.push(`  strike error: ${e.message}`);
      continue;
    }

    // Morning check (F1): 10-min candle low vs entry (same as runMorningCheck)
    if (ceTrade) {
      try {
        const c10 = await fetchOptionWindowCandle(expiry, ceTrade.strike, 'CE', dateStr, 'TEN_MINUTE', '09:15', '09:25');
        ceMorningFail = !c10 || c10.low < ceTrade.entryPrice;
        log.push(`  CE ${ceTrade.strike} entry=${ceTrade.entryPrice?.toFixed(1)} 10mLow=${c10?.low?.toFixed?.(1)||'NA'} ${ceMorningFail?'GAP':'OK'}`);
      } catch { ceMorningFail = true; }
    }
    if (peTrade) {
      try {
        const c10 = await fetchOptionWindowCandle(expiry, peTrade.strike, 'PE', dateStr, 'TEN_MINUTE', '09:15', '09:25');
        peMorningFail = !c10 || c10.low < peTrade.entryPrice;
        log.push(`  PE ${peTrade.strike} entry=${peTrade.entryPrice?.toFixed(1)} 10mLow=${c10?.low?.toFixed?.(1)||'NA'} ${peMorningFail?'GAP':'OK'}`);
      } catch { peMorningFail = true; }
    }

    // Gap recalc (F3): use selectStrikeRecalcServer matching runGapDownRecalcServer
    if (ceMorningFail) {
      try {
        const c15 = await fetchNifty15MinCandle(dateStr).catch(() => null);
        if (c15) {
          const GAP_BUF = 0.00125;
          const ceBuffer = c15.low * (1 - GAP_BUF);
          const newEnd = srvRoundStrike(ceBuffer, false);
          const newRange = Array.from({length: n}, (_, i) => newEnd + (n - 1 - i) * si);
          const expiries = await computeNiftyExpiries(8);
          const startIdx = 0; // use current week
          const expiryList = expiries.slice(startIdx, startIdx + SRV_CFG.maxTries).map(e => e.toUpperCase());
          const rec = await selectStrikeRecalcServer('CE', expiryList, newRange, dateStr);
          if (rec) {
            ceRecalc = { strike: rec.strike, isRecalc: true };
            ceTrade = { type: 'CALL', strike: rec.strike, expiry: rec.expiry, entryPrice: rec.entryPrice, target: rec.target, stopLoss: rec.stopLoss, isValid: true };
            ceToken = (await findOptionContract(rec.expiry || expiry, rec.strike, 'CE'))?.token || ceToken;
            log.push(`  CE recalc: ${rec.strike} entry=${rec.entryPrice}`);
          }
        }
      } catch {}
    }
    if (peMorningFail) {
      try {
        const c15 = await fetchNifty15MinCandle(dateStr).catch(() => null);
        if (c15) {
          const GAP_BUF = 0.00125;
          const peBuffer = c15.high * (1 + GAP_BUF);
          const newEnd = srvRoundStrike(peBuffer, true);
          const newRange = Array.from({length: n}, (_, i) => newEnd - (n - 1 - i) * si);
          const expiries = await computeNiftyExpiries(8);
          const startIdx = 0;
          const expiryList = expiries.slice(startIdx, startIdx + SRV_CFG.maxTries).map(e => e.toUpperCase());
          const rec = await selectStrikeRecalcServer('PE', expiryList, newRange, dateStr);
          if (rec) {
            peRecalc = { strike: rec.strike, isRecalc: true };
            peTrade = { type: 'PUT', strike: rec.strike, expiry: rec.expiry, entryPrice: rec.entryPrice, target: rec.target, stopLoss: rec.stopLoss, isValid: true };
            peToken = (await findOptionContract(rec.expiry || expiry, rec.strike, 'PE'))?.token || peToken;
            log.push(`  PE recalc: ${rec.strike} entry=${rec.entryPrice}`);
          }
        }
      } catch {}
    }

    // If morning check failed and recalc didn't find a replacement, skip leg (matches live)
    if (ceMorningFail && !ceRecalc) ceTrade = null;
    if (peMorningFail && !peRecalc) peTrade = null;

    // Simulate trades for the day using option 1-min data
    const dayLog = [];
    const simTrade = async (optType, strike, entry, target, sl, token, carry) => {
      if (!strike || !token || !entry) return null;
      const name = optType;
      let candles = [];
      try { candles = await fetchIntradayCandles(dateStr, token); } catch { return null; }
      if (!candles.length) return null;

      let triggerCandle = null, targetCandle = null, slCandle = null;
      let triggered = false;

      // For carry trades, target/SL check from start
      if (carry) {
        for (const c of candles) {
          if (slCandle || targetCandle) break;
          if (c.low <= target) targetCandle = c;
          if (c.high >= sl) slCandle = c;
        }
      } else {
        // Check entry trigger
        for (const c of candles) {
          if (triggered) break;
          if (c.low <= entry) { triggerCandle = c; triggered = true; }
        }
        if (triggered) {
          for (const c of candles) {
            if (c.ts <= triggerCandle.ts) continue;
            if (slCandle || targetCandle) break;
            if (c.low <= target) targetCandle = c;
            if (c.high >= sl) slCandle = c;
          }
        }
      }

      let status, exitPrice, pnl;
      if (slCandle && targetCandle) {
        if (slCandle.ts < targetCandle.ts) {
          status = 'SL_HIT'; exitPrice = sl; pnl = (entry - sl) * SRV_CFG.lotSize;
        } else {
          status = 'TARGET_HIT'; exitPrice = target; pnl = (entry - target) * SRV_CFG.lotSize;
        }
      } else if (slCandle) {
        status = 'SL_HIT'; exitPrice = sl; pnl = (entry - sl) * SRV_CFG.lotSize;
      } else if (targetCandle) {
        status = 'TARGET_HIT'; exitPrice = target; pnl = (entry - target) * SRV_CFG.lotSize;
      } else if (triggered || carry) {
        status = 'CARRY'; exitPrice = null; pnl = 0;
      } else {
        status = 'NO_TRIGGER'; exitPrice = null; pnl = 0;
      }

      return { optType, strike, entry, target, sl, token, triggered: !!triggered, status, exitPrice, pnl, triggerCandle: triggerCandle?.ts, exitCandle: (targetCandle||slCandle)?.ts };
    };

    const [ceResult, peResult] = await Promise.all([
      simTrade('CE', ceTrade?.strike, ceCarry ? ceCarry.entry : ceTrade?.entryPrice, ceCarry ? ceCarry.target : ceTrade?.target, ceCarry ? ceCarry.sl : ceTrade?.stopLoss, ceToken, !!ceCarry),
      simTrade('PE', peTrade?.strike, peCarry ? peCarry.entry : peTrade?.entryPrice, peCarry ? peCarry.target : peTrade?.target, peCarry ? peCarry.sl : peTrade?.stopLoss, peToken, !!peCarry),
    ]);

    if (!ceResult && !peResult) { log.push('  no trades'); continue; }

    // Calculate combined PnL
    let dayPnl = 0;
    if (ceResult) {
      dayPnl += ceResult.pnl || 0;
      if (ceResult.status === 'CARRY') ceCarry = ceResult;
      else ceCarry = null;
    }
    if (peResult) {
      dayPnl += peResult.pnl || 0;
      if (peResult.status === 'CARRY') peCarry = peResult;
      else peCarry = null;
    }

    totalPnl += dayPnl;
    if (dayPnl > 0) { wins++; consecutiveLosses = 0; }
    else if (dayPnl < 0) { losses++; consecutiveLosses++; maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses); }
    peakEquity = Math.max(peakEquity, totalPnl);
    maxDrawdown = Math.min(maxDrawdown, totalPnl - peakEquity);

    trades.push({
      date: dateStr,
      twoDHH: Math.round(twoDHH * 100) / 100,
      twoDLL: Math.round(twoDLL * 100) / 100,
      ce: ceResult ? { strike: ceResult.strike, entry: ceResult.entry, target: ceResult.target, sl: ceResult.sl, status: ceResult.status, pnl: ceResult.pnl, exitPrice: ceResult.exitPrice, recalc: ceRecalc?.isRecalc || false } : null,
      pe: peResult ? { strike: peResult.strike, entry: peResult.entry, target: peResult.target, sl: peResult.sl, status: peResult.status, pnl: peResult.pnl, exitPrice: peResult.exitPrice, recalc: peRecalc?.isRecalc || false } : null,
      pnl: dayPnl,
    });
  }

  // Close any remaining carry trades
  if (ceCarry || peCarry) {
    let closePnl = 0;
    if (ceCarry) closePnl += ceCarry.entry * SRV_CFG.lotSize; // assume profit at expiry
    if (peCarry) closePnl += peCarry.entry * SRV_CFG.lotSize;
    totalPnl += closePnl;
    log.push(`\nCarry close PnL: ${closePnl}`);
  }

  const winTrades = trades.filter(t => (t.pnl || 0) > 0);
  const lossTrades = trades.filter(t => (t.pnl || 0) < 0);
  const grossProfit = winTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + (t.pnl || 0), 0));

  return {
    trades,
    log,
    stats: {
      totalTrades: trades.length,
      winRate: trades.length > 0 ? (winTrades.length / trades.length * 100).toFixed(1) + '%' : '0%',
      wins: winTrades.length, losses: lossTrades.length,
      totalPnl: Math.round(totalPnl),
      grossProfit: Math.round(grossProfit), grossLoss: Math.round(grossLoss),
      profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞',
      maxDrawdown: Math.round(Math.abs(maxDrawdown)),
      avgPnl: trades.length > 0 ? Math.round(totalPnl / trades.length) : 0,
      maxConsecutiveLosses,
      startDate: startDateStr, endDate: endDateStr,
      tradingDays: trades.length,
    },
  };
}

async function fetchNseHistoricalRange(startStr, endStr) {
  const api = `https://www.nseindia.com/api/historicalOR/indicesHistory?indexType=NIFTY%2050&from=${nseDate(startStr)}&to=${nseDate(endStr)}`;
  const res = await fetch(api, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
      'Referer': 'https://www.nseindia.com/reports-indices-historical-index-data' },
  });
  const json = await res.json();
  if (!res.ok || !Array.isArray(json.data)) throw new Error(`NSE range fetch failed: ${res.status}`);
  return json.data
    .map(r => ({
      date: parseNseDate(r.EOD_TIMESTAMP),
      high: Number(r.EOD_HIGH_INDEX_VAL),
      low: Number(r.EOD_LOW_INDEX_VAL),
      open: Number(r.EOD_OPEN_INDEX_VAL),
      close: Number(r.EOD_CLOSE_INDEX_VAL),
    }))
    .filter(r => r.date && r.high && r.low)
    .sort((a, b) => a.date.localeCompare(b.date));
}

let lastAutoCalcDate    = '';
let lastReminderDate    = '';
let lastMorningCheck    = '';
let lastGapRecalcDate   = '';
let lastFuturesPlaceDate = '';

async function checkSchedule() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day     = ist.getUTCDay();
  const hour    = ist.getUTCHours();
  const min     = ist.getUTCMinutes();
  const dateStr = ist.toISOString().slice(0, 10);

  if (day === 0 || day === 6) return; // skip weekends

  // 08:45 AM IST — auto-run EOD calculation + futures signals
  if (hour === 8 && min === 45 && lastAutoCalcDate !== dateStr) {
    lastAutoCalcDate = dateStr;
    console.log('[Schedule] 08:45 IST — running auto EOD calculation');
    await runAutoCalculation();
    console.log('[Schedule] 08:45 IST — running futures signal calculation');
    runFuturesAutoCalc().catch(e => console.error('[Schedule] Futures calc error:', e.message));
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
        if (!tok) return;

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

    await tgSendToAll(tok, telegramTargets, msg);
    console.log('[Telegram] 09:00 AM reminder sent');
  }

  // 09:16 AM IST — (1) Auto-place futures orders
  //                (2) Gap-against check for carried futures positions
  if (hour === 9 && min === 16 && lastFuturesPlaceDate !== dateStr) {
    lastFuturesPlaceDate = dateStr;
    console.log('[Schedule] 09:16 IST — futures orders + gap check');
    await autoPlaceFuturesOrders().catch(e => console.error('[Futures] Auto-place error:', e.message));
    await checkCarriedFuturesGap().catch(e => console.error('[Futures] Gap check error:', e.message));
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
    // Futures gap recalc (if gap detected at 09:16 placement)
    setTimeout(async () => {
      await gapRecalcFuturesOrders().catch(e => console.error('[Futures] Gap recalc error:', e.message));
    }, 1000);
    // Futures carried position gap-against SL recalc
    setTimeout(async () => {
      await recalcCarriedFuturesSL().catch(e => console.error('[Futures] Carried SL recalc error:', e.message));
    }, 1500);
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

    // GET /angel/option-candle?expiry=...&strike=...&type=CE&date=YYYY-MM-DD&interval=TEN_MINUTE&from=09:15&to=09:25
    if (url.pathname === '/angel/option-candle') {
      const expiry = url.searchParams.get('expiry');
      const strike = parseInt(url.searchParams.get('strike'));
      const type = url.searchParams.get('type');
      const date = url.searchParams.get('date');
      const interval = url.searchParams.get('interval');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!expiry || !strike || !type || !date || !interval || !from || !to) {
        return send(res, 400, { error: 'expiry, strike, type, date, interval, from, to required' });
      }
      const data = await fetchOptionWindowCandle(expiry, strike, type, date, interval, from, to);
      if (!data) return send(res, 404, { error: 'Option candle not found' });
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

    // POST /angel/recalculate-signals  — manual 09:30 recalc preview using candle-based strike logic
    if (url.pathname === '/angel/recalculate-signals' && req.method === 'POST') {
      const result = await runGapDownRecalcServer({ autoPlace: false, forceFreshMorningCheck: true, sendTelegram: false });
      if (!result) {
        return send(res, 400, {
          ok: false,
          error: 'No gap-triggered legs available for recalculation.',
          morningCheckResult,
          eodStore,
        });
      }
      return send(res, 200, { ok: true, ...result, eodStore });
    }

    // POST /angel/send-recalc-telegram  — manual send after reviewing recalculated signals
    if (url.pathname === '/angel/send-recalc-telegram' && req.method === 'POST') {
      const msg = eodStore?.recalcMeta?.telegramMessage;
      const tok = cfg.telegramToken;
      if (!msg) return send(res, 400, { ok: false, error: 'No recalculated signal message is ready to send.' });
      if (!tok) return send(res, 400, { ok: false, error: 'Telegram token is not configured.' });
      await tgSendToAll(tok, telegramTargets, msg);
      eodStore = {
        ...eodStore,
        recalcMeta: { ...eodStore.recalcMeta, telegramSentAt: new Date().toISOString() },
      };
      diskSet('eod_store', eodStore);
      return send(res, 200, { ok: true, telegramSentAt: eodStore.recalcMeta.telegramSentAt });
    }

    // GET /angel/paper-trades
    if (url.pathname === '/angel/paper-trades' && req.method === 'GET') {
      return send(res, 200, loadTrades());
    }

    // GET /angel/backups?type=paper-trades|eod_store  - list protected data backups
    if (url.pathname === '/angel/backups' && req.method === 'GET') {
      const type = url.searchParams.get('type');
      const backups = _backupFiles(type === 'paper-trades' || type === 'eod_store' ? type : null)
        .map(({ name, label, size, modifiedAt }) => ({ name, label, size, modifiedAt }));
      return send(res, 200, { backups });
    }

    // POST /angel/restore-backup?type=paper-trades|eod_store  - restore latest protected backup
    if (url.pathname === '/angel/restore-backup' && req.method === 'POST') {
      const type = url.searchParams.get('type');
      if (type !== 'paper-trades' && type !== 'eod_store') {
        return send(res, 400, { error: 'type must be paper-trades or eod_store' });
      }
      const restored = restoreLatestBackup(type);
      if (!restored) return send(res, 404, { error: `No ${type} backup found` });
      if (type === 'eod_store') eodStore = diskGet('eod_store');
      if (type === 'paper-trades') scheduleGoogleTradeSync();
      return send(res, 200, {
        ok: true,
        type,
        restored: { name: restored.name, modifiedAt: restored.modifiedAt, size: restored.size },
      });
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

    // DELETE /angel/paper-trades/today  - protected: never delete Trades page history
    if (url.pathname === '/angel/paper-trades/today' && req.method === 'DELETE') {
      const date = istDateString();
      console.warn(`[Trade] Delete blocked for ${date}; paper trade history is protected`);
      return send(res, 403, {
        ok: false,
        protected: true,
        date,
        error: 'Trades page history is protected and cannot be deleted by common cleanup.',
      });
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
        const tok = cfg.telegramToken;
        if (tok) tgSendToAll(tok, telegramTargets,
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

    // ── NIFTY Futures Endpoints ──────────────────────────────────────────────
    // GET /angel/futures — signals + position + history
    if (url.pathname === '/angel/futures' && req.method === 'GET') {
      const signals = futuresLoadSignals();
      const position = futuresLoadPosition();
      const history = futuresLoadHistory();
      let ltp = 0;
      try { ltp = await fetchFuturesLTP((await findFuturesToken()).token); } catch {}
      const contract = getFuturesContract();
      return send(res, 200, { signals, position, history, ltp, contract });
    }

    // POST /angel/futures/calculate — force recalculate signals
    if (url.pathname === '/angel/futures/calculate' && req.method === 'POST') {
      try {
        resetFuturesTokenCache();
        const signals = await calculateFuturesSignals();
        return send(res, 200, { ok: true, signals });
      } catch (e) {
        console.error('[Futures] Calculate error:', e);
        return send(res, 500, { error: e.message, stack: e.stack?.split('\n').slice(0,3).join(' ') });
      }
    }

    // POST /angel/futures/entry — mark entry triggered
    if (url.pathname === '/angel/futures/entry' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { side, entryPrice } = JSON.parse(body);
      if (!side || !entryPrice) return send(res, 400, { error: 'side (BUY/SELL) and entryPrice required' });
      const existing = futuresLoadPosition();
      if (existing) return send(res, 400, { error: 'Position already open', position: existing });
      const signals = futuresLoadSignals();
      if (!signals) return send(res, 400, { error: 'No signals calculated yet' });
      const contract = getFuturesContract();
      const position = {
        side, entryPrice: Number(entryPrice), lots: 2, lot1Exited: false,
        entryDate: istDateString(), carryDays: 0, lotSize: futuresTokenCache?.lotSize || FUTURES_LOT_SIZE,
        targetPrice: side === 'BUY' ? signals.buyTarget : signals.sellTarget,
        currentSL: side === 'BUY' ? signals.buySL1 : signals.sellSL1,
        slType: 'SL1',
        sl1: side === 'BUY' ? signals.buySL1 : signals.sellSL1,
        sl2: side === 'BUY' ? signals.buySL2 : signals.sellSL2,
        contract: contract.symbol,
        lastUpdated: new Date().toISOString(),
      };
      futuresSavePosition(position);
      console.log(`[Futures] Entry: ${side} @ ₹${entryPrice}, SL1=${position.currentSL}, Target=${position.targetPrice}`);
      return send(res, 200, { ok: true, position });
    }

    // POST /angel/futures/target-hit — mark Lot 1 target hit
    if (url.pathname === '/angel/futures/target-hit' && req.method === 'POST') {
      const pos = futuresLoadPosition();
      if (!pos) return send(res, 400, { error: 'No open position' });
      if (pos.lot1Exited) return send(res, 400, { error: 'Lot 1 already exited' });
      const signals = futuresLoadSignals();
      pos.lot1Exited = true;
      pos.targetHitAt = new Date().toISOString();
      pos.currentSL = pos.sl2 || (pos.side === 'BUY'
        ? MROUND(Math.max(pos.entryPrice, signals?.twoDLL * 0.99875 || 0))
        : MROUND(Math.min(pos.entryPrice, signals?.twoDHH * 1.00125 || 0)));
      pos.slType = 'SL2';
      futuresSavePosition(pos);
      console.log(`[Futures] Target hit (Lot 1 exits), Lot 2 SL2=${pos.currentSL}`);
      return send(res, 200, { ok: true, position: pos });
    }

    // POST /angel/futures/close  { exitPrice, exitReason }
    if (url.pathname === '/angel/futures/close' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { exitPrice, exitReason } = JSON.parse(body);
      const pos = futuresLoadPosition();
      if (!pos) return send(res, 400, { error: 'No open position' });
      pos.exitPrice = Number(exitPrice || pos.ltp || 0);
      pos.exitReason = exitReason || 'MANUAL';
      pos.closedAt = new Date().toISOString();
      const lots = pos.lot1Exited ? 1 : 2;
      const pnl = pos.side === 'BUY'
        ? (pos.exitPrice - pos.entryPrice) * lots * Number(pos.lotSize || FUTURES_LOT_SIZE)
        : (pos.entryPrice - pos.exitPrice) * lots * Number(pos.lotSize || FUTURES_LOT_SIZE);
      pos.pnl = pnl;
      futuresAddHistory(pos);
      futuresDeletePosition();
      console.log(`[Futures] Closed ${pos.side} @ ₹${pos.exitPrice}, P&L ₹${pnl.toFixed(0)}, reason: ${exitReason}`);
      return send(res, 200, { ok: true, pnl, position: pos });
    }

    // PUT /angel/futures/position — edit position fields (entryPrice, currentSL, targetPrice)
    if (url.pathname === '/angel/futures/position' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const updates = JSON.parse(body);
      const pos = futuresLoadPosition();
      if (!pos) return send(res, 400, { error: 'No open position' });
      Object.assign(pos, updates, { lastUpdated: new Date().toISOString() });
      futuresSavePosition(pos);
      return send(res, 200, { ok: true, position: pos });
    }

    // DELETE /angel/futures/position — delete position (force close) + cancel orders
    if (url.pathname === '/angel/futures/position' && req.method === 'DELETE') {
      const pos = futuresLoadPosition();
      if (pos) {
        const ltp = await fetchFuturesLTP((await findFuturesToken()).token).catch(() => null);
        futuresAddHistory({ ...pos, exitReason: 'DELETED', exitPrice: ltp ?? 0, closedAt: new Date().toISOString() });
      }
      futuresSavePositionData({ position: null, orders: null, lastOrderDate: '' });
      console.log('[Futures] Position + orders cleared');
      return send(res, 200, { ok: true });
    }

    // POST /angel/futures/backtest  { startDate, endDate }
    if (url.pathname === '/angel/futures/backtest' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { startDate, endDate } = JSON.parse(body);
      if (!startDate || !endDate) return send(res, 400, { error: 'startDate and endDate required (YYYY-MM-DD)' });
      const result = await runFuturesBacktest(startDate, endDate);
      return send(res, 200, result);
    }

    // POST /angel/options/backtest  { startDate, endDate }
    if (url.pathname === '/angel/options/backtest' && req.method === 'POST') {
      console.log('[Angel] Options backtest route hit');
      let body = '';
      for await (const chunk of req) body += chunk;
      console.log('[Angel] Options backtest body:', body);
      const { startDate, endDate } = JSON.parse(body);
      if (!startDate || !endDate) return send(res, 400, { error: 'startDate and endDate required (YYYY-MM-DD)' });
      console.log(`[Angel] Running option backtest ${startDate} → ${endDate}`);
      try {
        const result = await runOptionBacktest(startDate, endDate);
        return send(res, 200, result);
      } catch (e) {
        console.error('[Angel] Options backtest error:', e.message);
        return send(res, 500, { error: e.message });
      }
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
  console.log(`  GET /angel/futures`);
  console.log(`  POST /angel/futures/calculate`);
  console.log(`  POST /angel/futures/entry`);
  console.log(`  POST /angel/futures/close`);
  console.log(`  PUT /angel/futures/position`);
  console.log(`  DELETE /angel/futures/position`);
});


