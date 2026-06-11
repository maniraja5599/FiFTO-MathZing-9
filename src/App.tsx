import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from './utils/cn';

// ── Strategy Profiles ─────────────────────────────────────────────────────────
type Instrument = 'NIFTY' | 'BANKNIFTY';
type ExpiryType = 'WEEKLY' | 'MONTHLY';

interface StrategyProfile {
  id: string;
  name: string;           // display name shown in header + settings
  instrument: Instrument;
  expiry: ExpiryType;
  // Lot & OI
  lotSize: number;
  minOIContracts: number;
  // Strike selection
  strikeFactor: number;       // 0.0015 = 0.15%
  minPremiumFactor: number;   // 0.0085 = 0.85%
  strikeInterval: number;     // 50 for NIFTY, 100 for BankNifty
  numStrikes: number;         // strikes to scan per leg
  maxTries: number;           // max expiries to try
  // Entry / Exit
  entryDiscount: number;      // 0.10 = 10% below 2D Low
  targetProfit: number;       // 0.75 = exit at 25% of entry
  mslIncrease: number;        // 0.75 = 175% of entry (max SL)
  tslIncrease: number;        // 0.10 = 110% of 2DHH (trailing SL)
}

interface TelegramTarget {
  chatId: string;
  name: string;
}

// AppSettings stores all profiles + which one is active + telegram config
interface AppSettings {
  activeId: string;
  profiles: StrategyProfile[];
  telegramToken: string;
  telegramTargets: TelegramTarget[];
  ltpPollIntervalSec: number;
  settingsPin: string;
}

const DEFAULT_PROFILES: StrategyProfile[] = [
  {
    id: 'nifty-weekly',
    name: 'NIFTY Weekly Selling',
    instrument: 'NIFTY',
    expiry: 'WEEKLY',
    lotSize: 65,
    minOIContracts: 500,
    strikeFactor: 0.0015,
    minPremiumFactor: 0.0085,
    strikeInterval: 50,
    numStrikes: 10,
    maxTries: 5,
    entryDiscount: 0.10,
    targetProfit: 0.75,
    mslIncrease: 0.75,
    tslIncrease: 0.10,
  },
];

const DEFAULT_SETTINGS: AppSettings = {
  activeId: 'nifty-weekly',
  profiles: DEFAULT_PROFILES,
  telegramToken: '8649479337:AAFTjUdsMbTeRHrlpnDr14p17vsDqORTWfg',
  telegramTargets: [
    { chatId: '-1002453329307', name: 'Group 1' },
    { chatId: '', name: 'Group 2' },
  ],
  ltpPollIntervalSec: 60,
  settingsPin: '5599',
};

const normalizeTelegramTargets = (targets?: TelegramTarget[]) => {
  const list = (targets ?? []).slice(0, 2).map(t => ({ chatId: t?.chatId ?? '', name: t?.name ?? '' }));
  return [
    list[0] ?? { chatId: '', name: 'Group 1' },
    list[1] ?? { chatId: '', name: 'Group 2' },
  ];
};

const SETTINGS_KEY = 'fifto_settings_v5';

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings> & Partial<{ telegramChatId: string }>;
      // Merge saved profiles over defaults (add any new default profiles not saved yet)
      const savedProfiles: StrategyProfile[] = parsed.profiles ?? [];
      const merged = DEFAULT_PROFILES.map(dp => savedProfiles.find(sp => sp.id === dp.id) ?? dp);
      const targets = parsed.telegramTargets?.length
        ? normalizeTelegramTargets(parsed.telegramTargets)
        : parsed.telegramChatId
          ? normalizeTelegramTargets([{ chatId: parsed.telegramChatId, name: 'Group 1' }])
          : normalizeTelegramTargets(DEFAULT_SETTINGS.telegramTargets);
      return {
        activeId: parsed.activeId ?? 'nifty-weekly',
        profiles: merged,
        telegramToken: parsed.telegramToken || DEFAULT_SETTINGS.telegramToken,
        telegramTargets: targets,
        ltpPollIntervalSec: parsed.ltpPollIntervalSec ?? 60,
        settingsPin: parsed.settingsPin ?? '5599',
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS, profiles: DEFAULT_PROFILES.map(p => ({ ...p })) };
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function getActiveProfile(s: AppSettings): StrategyProfile {
  return s.profiles.find(p => p.id === s.activeId) ?? s.profiles[0];
}

// Round to nearest 0.5
const roundHalf = (v: number) => Math.round(v * 2) / 2;

const copyText = (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // Fallback for mobile HTTP / older browsers
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy') ? resolve() : reject(); } catch { reject(); }
    finally { document.body.removeChild(ta); }
  });
};

// Types
interface MarketData {
  day1High: number;
  day1Low: number;
  day2High: number;
  day2Low: number;
  day1Date?: string;
  day2Date?: string;
  preparationDate: string;
  preparationDay: string;
  preparationTime: string;
  nextTradingDate: string;
  nextTradingDay: string;
  fetched: boolean;
  fetchTimestamp?: string;
  effectiveDataDate?: string;
  marketWasOpen?: boolean;
  source?: string;
  warnings?: string[];
}

interface StrikeData {
  strike: number;
  callOI: number;
  putOI: number;
  callPremium?: number;
  putPremium?: number;
}

interface OptionOHLC {
  day1High: number; day1Low: number;
  day2High: number; day2Low: number;
  twoDHH: number; twoDLL: number;
}

interface TradeSignal {
  type: 'CALL' | 'PUT';
  strike: number;
  entryPrice: number;
  target: number;
  stopLoss: number;
  msl: number;
  tsl: number;
  optionOHLC: OptionOHLC | null;
  contractType: 'Current Week' | 'Next Week';
  reason: string;
  isValid: boolean;
  strikeRange: number[];
}

// ── Paper Trade types ─────────────────────────────────────────────────────────
type TradeStatus = 'PENDING' | 'TRIGGERED' | 'TARGET_HIT' | 'SL_HIT' | 'EXPIRED' | 'CANCELLED';

interface PaperTrade {
  id: string;
  date: string;
  type: 'CALL' | 'PUT';
  optType: 'CE' | 'PE';
  strike: number;
  expiry: string;
  strategyName: string;
  lotSize: number;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  status: TradeStatus;
  placedAt: string;
  triggeredAt?: string;
  triggeredLTP?: number;
  exitAt?: string;
  exitPrice?: number;
  pnl?: number;
  carryToNextDay: boolean;
  exitReason?: 'EXPIRY' | 'TARGET' | 'SL' | null;
  currentLTP?: number;
  runningPnl?: number;
  slNeedsRecalc?: boolean;
  // Server annotations (optional; older cached trades may not have these)
  signalSource?: 'EOD' | 'GAP_RECALC' | 'MANUAL';
  recalcScenario?: 'GAP_DOWN' | 'GAP_UP' | null;
}

// ── Morning Check & Gap-Down types ───────────────────────────────────────────
interface MorningCheck {
  ce10Low: number;
  pe10Low: number;
  callEntryEOD: number;
  putEntryEOD: number;
  callRecalcNeeded: boolean;
  putRecalcNeeded: boolean;
  checkedAt: string;
}

interface GapDownStrikeRow {
  strike: number;
  oi: number;
  premiumRef: number;
  minPrem: number;
  oiMet: boolean;
  premMet: boolean;
  f3Met?: boolean;
  selected: boolean;
}

interface GapDownResult {
  // Step 1 — single candle, both legs use it
  candle: { open: number; high: number; low: number; close: number; timestamp: string };
  // Which legs triggered (CE=gap-down, PE=gap-up)
  ceTriggered: boolean;
  peTriggered: boolean;
  // Step 2 — unified buffer for both legs using HIGH
  ceBuffer: number;   // MROUND(high × (1+0.125%), 1)
  peBuffer: number;   // MROUND(high × (1+0.125%), 1)
  // Step 3
  callEndStrike: number;
  putEndStrike: number;
  // Step 4
  callRange: number[];
  putRange: number[];
  // Step 5
  callRows: GapDownStrikeRow[];
  putRows: GapDownStrikeRow[];
  // Step 6
  callSelected: { strike: number; premiumRef: number } | null;
  putSelected:  { strike: number; premiumRef: number } | null;
  // Step 7
  callTrade: TradeSignal | null;
  putTrade:  TradeSignal | null;
  callExpiry: string;
  putExpiry:  string;
  calculatedAt: string;
}

interface CalculationResult {
  twoDHH: number;
  twoDLL: number;
  upperLevel: number;
  lowerLevel: number;
  putEndStrike: number;
  callEndStrike: number;
  callStartStrike: number;
  putStartStrike: number;
  callTrade: TradeSignal | null;
  putTrade: TradeSignal | null;
  noTradeReason?: string;
  filteredStrikes: { call: number[]; put: number[] };
  callStrikeRange: number[];
  putStrikeRange: number[];
  callStrikes: StrikeData[];
  putStrikes: StrikeData[];
}

// Runtime settings — updated when user saves in settings modal
let _appSettings = loadSettings();
const getCfg = () => getActiveProfile(_appSettings);
// Module-level getters used throughout calculation code
const MIN_OI             = () => getCfg().minOIContracts * getCfg().lotSize;
const STRIKE_FACTOR      = () => getCfg().strikeFactor;
const MIN_PREMIUM_FACTOR = () => getCfg().minPremiumFactor;
const ENTRY_DISCOUNT     = () => getCfg().entryDiscount;
const TARGET_PROFIT      = () => getCfg().targetProfit;
const MSL_INCREASE       = () => getCfg().mslIncrease;
const TSL_INCREASE       = () => getCfg().tslIncrease;
const STRIKE_INTERVAL    = () => getCfg().strikeInterval;
const NUM_STRIKES        = () => getCfg().numStrikes;

// ── Angel One API helpers ─────────────────────────────────────────────────────
const ANGEL = ''; // proxied through Vite on same port

interface AngelChainRecord {
  strikePrice: number;
  CE?: { lastPrice: number; openInterest: number };
  PE?: { lastPrice: number; openInterest: number };
}

const apiFetch = (url: string, ms = 15000) => {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
};

const getPreviousTradingDay = (dateStr: string) => {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

const fetchNiftyData = async (toDate: string): Promise<{ day1High: number; day1Low: number; day2High: number; day2Low: number; day1Date?: string; day2Date?: string; source?: string; warnings?: string[] } | null> => {
  try {
    const res = await apiFetch(`${ANGEL}/angel/historical?toDate=${toDate}`);
    if (!res.ok) throw new Error(`Historical fetch failed: ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Angel historical fetch error:', err);
    return null;
  }
};

const fetchExpiryDates = async (): Promise<string[]> => {
  try {
    const res = await apiFetch(`${ANGEL}/angel/expiry`, 90000);
    if (!res.ok) throw new Error(`Expiry fetch failed: ${res.status}`);
    const json = await res.json();
    return json.expiryDates ?? [];
  } catch (err) {
    console.error('Angel expiry fetch error:', err);
    return [];
  }
};

// ── Live/Morning API calls (no cache — always fresh) ─────────────────────────
const fetchLiveLTPs = async (
  ceExpiry: string, ceStrike: number,
  peExpiry: string, peStrike: number,
): Promise<{ ceLTP: number; peLTP: number }> => {
  try {
    const p = new URLSearchParams({ ceExpiry, ceStrike: String(ceStrike), peExpiry, peStrike: String(peStrike) });
    const res = await apiFetch(`${ANGEL}/angel/live-ltp?${p}`, 20000);
    if (!res.ok) throw new Error('live-ltp failed');
    return await res.json();
  } catch { return { ceLTP: 0, peLTP: 0 }; }
};

const fetchNiftyCandle = async (date: string): Promise<{ open: number; high: number; low: number; close: number; timestamp: string } | null> => {
  try {
    const res = await apiFetch(`${ANGEL}/angel/nifty-candle?date=${date}`, 20000);
    if (!res.ok) throw new Error('nifty-candle failed');
    return await res.json();
  } catch { return null; }
};

const fetchOptionCandle = async (
  expiry: string,
  strike: number,
  type: 'CE' | 'PE',
  date: string,
  interval: 'TEN_MINUTE' | 'FIFTEEN_MINUTE',
  from: string,
  to: string,
): Promise<{ open: number; high: number; low: number; close: number } | null> => {
  try {
    const p = new URLSearchParams({ expiry, strike: String(strike), type, date, interval, from, to });
    const res = await apiFetch(`${ANGEL}/angel/option-candle?${p}`, 20000);
    if (!res.ok) throw new Error('option-candle failed');
    return await res.json();
  } catch {
    return null;
  }
};



const fetchTrades = async (): Promise<PaperTrade[]> => {
  try { const r = await fetch('/angel/paper-trades'); return r.ok ? r.json() : []; } catch { return []; }
};
const cancelTrade = async (id: string, cancelReason: string) => {
  try { await fetch(`/angel/paper-trades/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'CANCELLED', cancelReason }) }); } catch { /* ignore */ }
};
const deleteTrade = async (id: string) => {
  try { const r = await fetch(`/angel/paper-trades/${id}`, { method: 'DELETE' }); return r.ok; } catch { return false; }
};
const updateTrade = async (id: string, updates: Partial<PaperTrade>) => {
  try { await fetch(`/angel/paper-trades/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) }); } catch { /* ignore */ }
};
const fetchEODStore = async () => {
  try { const r = await fetch('/angel/eod-store'); return r.ok ? r.json() : null; } catch { return null; }
};
const fetchCalcHistory = async (): Promise<string[]> => {
  try { const r = await fetch('/angel/calc-history'); return r.ok ? r.json() : []; } catch { return []; }
};
const fetchCalcDetail = async (date: string): Promise<any> => {
  try { const r = await fetch(`/angel/calc-history/${date}`); return r.ok ? r.json() : null; } catch { return null; }
};
const triggerServerRecalc = async () => {
  const r = await fetch('/angel/recalculate-signals', { method: 'POST' });
  let json: any = null;
  try { json = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error(json?.error || 'Recalculation failed');
  return json;
};
const sendServerRecalcTelegram = async () => {
  const r = await fetch('/angel/send-recalc-telegram', { method: 'POST' });
  let json: any = null;
  try { json = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error(json?.error || 'Telegram send failed');
  return json;
};
const syncSettings = (ltpPollIntervalSec: number, telegramToken?: string, telegramTargets?: { chatId: string; name: string }[]) => {
  const payload: Record<string, unknown> = { ltpPollIntervalSec };
  if (telegramToken !== undefined) payload.telegramToken = telegramToken;
  if (telegramTargets !== undefined) payload.telegramTargets = telegramTargets;
  fetch(`${ANGEL}/angel/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
};

const storeEOD = (payload: object) => {
  fetch(`${ANGEL}/angel/store-eod`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
};

const sendTelegramMsg = async (token: string, chatId: string, message: string): Promise<boolean> => {
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${ANGEL}/angel/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chatId, message }),
    });
    return res.ok;
  } catch { return false; }
};

const sendTelegramMsgToTargets = async (token: string, targets: TelegramTarget[], message: string): Promise<boolean[]> => {
  const validTargets = targets.filter(t => t.chatId.trim());
  if (!token || !validTargets.length) return [];
  return await Promise.all(validTargets.map(target => {
    const prefix = target.name?.trim() ? `📌 <b>${target.name.trim()}</b>\n` : '';
    return sendTelegramMsg(token, target.chatId.trim(), `${prefix}${message}`);
  }));
};

const fetchOptionChain = async (expiry: string, strikes: number[], toDate: string): Promise<AngelChainRecord[]> => {
  const cacheKey = `nifty_chain_${expiry}_${toDate}_${strikes.slice().sort().join('_')}`;
  const cached = lsGet<{ data: AngelChainRecord[]; ts: number }>(cacheKey);
  // Cache forever for a given date — EOD data never changes
  if (cached) {
    console.log('[Cache] Option chain hit for', expiry, toDate);
    return cached.data;
  }
  try {
    const strikesParam = strikes.length > 0 ? `&strikes=${strikes.join(',')}` : '';
    const res = await apiFetch(`${ANGEL}/angel/option-chain?expiry=${encodeURIComponent(expiry)}${strikesParam}&toDate=${toDate}`, 90000);
    if (!res.ok) throw new Error(`Option chain failed: ${res.status}`);
    const json = await res.json();
    const data: AngelChainRecord[] = json.data ?? [];
    if (data.length > 0) lsSet(cacheKey, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error('Angel option chain fetch error:', err);
    return [];
  }
};

// Helper functions
const roundToNearestStrike = (value: number, roundUp: boolean): number => {
  const si = STRIKE_INTERVAL();
  const strike = Math.round(value / si) * si;
  if (roundUp) {
    return strike >= value ? strike : strike + si;
  } else {
    return strike <= value ? strike : strike - si;
  }
};

const getNextTradingDay = (date: Date): { date: string; day: string } => {
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  
  // Skip weekends
  while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
    nextDay.setDate(nextDay.getDate() + 1);
  }
  
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const y = nextDay.getFullYear();
  const m = String(nextDay.getMonth() + 1).padStart(2, '0');
  const d = String(nextDay.getDate()).padStart(2, '0');
  return { date: `${y}-${m}-${d}`, day: days[nextDay.getDay()] };
};

const getDayName = (dateStr: string): string => {
  const date = new Date(dateStr);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[date.getDay()];
};

// Market open (IST = UTC+5:30) — 09:15 to 15:30 on weekdays
const isMarketOpen = (): boolean => {
  const utc = Date.now();
  const ist = new Date(utc + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
};

// Market closed and data final — after 3:45 PM IST on a trading day
const isMarketClosed = (): boolean => {
  const utc = Date.now();
  const ist = new Date(utc + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return true;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 15 * 60 + 45; // >= 15:45
};

// Returns the last market close date (YYYY-MM-DD, IST)
// After 3:45 PM weekday → today; before 3:45 PM → previous trading day; weekend → Friday
const getLastMarketCloseDate = (): string => {
  const utc = Date.now();
  const ist = new Date(utc + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const afterClose = mins >= 15 * 60 + 45;

  // Start from today in IST
  const d = new Date(ist);
  d.setUTCHours(0, 0, 0, 0);

  // If weekday but before 3:45 PM, last close was yesterday (or earlier)
  if (day >= 1 && day <= 5 && !afterClose) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  // If today is the result but it's weekend, go to Friday
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 2);
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  // If we landed on a weekday before 3:45 that's today, it should actually be prev trading day
  // (edge: Mon 9 AM — last close = Fri, not Mon)

  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};

// Returns the previous trading day (skip weekends) — uses local date to avoid UTC offset issues
const prevTradingDay = (dateStr: string): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d - 1); // local date, go back 1
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};

// Local today as YYYY-MM-DD (avoids UTC offset shifting the date)
const localToday = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

// Effective date to use for data fetch — always = last market close date
const getEffectiveDate = (selectedDate: string): { date: string; marketWasOpen: boolean } => {
  const today = localToday();
  const lastClose = getLastMarketCloseDate();
  if (selectedDate === today) {
    // Today selected — use last close date (which is today only after 3:45 PM)
    return { date: lastClose, marketWasOpen: lastClose < today };
  }
  // Past date selected — use as-is
  return { date: selectedDate, marketWasOpen: false };
};

const formatDisplayDate = (dateStr?: string): string => {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const getExpiryType = (day: string): 'Current Week' | 'Next Week' => {
  if (day === 'Monday' || day === 'Tuesday') {
    return 'Next Week';
  }
  return 'Current Week';
};


const fetchOptionOHLC = async (expiry: string, strike: number, type: 'CE' | 'PE', toDate: string): Promise<OptionOHLC | null> => {
  const cacheKey = `nifty_opt_ohlc_${expiry}_${strike}_${type}_${toDate}`;
  const cached = lsGet<OptionOHLC>(cacheKey);
  if (cached) { console.log('[Cache] Option OHLC hit', expiry, strike, type); return cached; }
  try {
    const res = await apiFetch(`${ANGEL}/angel/option-ohlc?expiry=${encodeURIComponent(expiry)}&strike=${strike}&type=${type}&toDate=${toDate}`, 30000);
    if (!res.ok) throw new Error(`Option OHLC ${res.status}`);
    const data: OptionOHLC = await res.json();
    lsSet(cacheKey, data);
    return data;
  } catch (err) {
    console.error('Option OHLC fetch error:', err);
    return null;
  }
};

// ── Local storage cache helpers ────────────────────────────────────────────────
const lsGet = <T,>(key: string): T | null => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
};
const lsSet = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};

// ── Strike selection — runs after real API data arrives ───────────────────────
const findValidStrikeFromData = (
  strikes: StrikeData[],
  type: 'CALL' | 'PUT'
): { strike: number; reason: string } | null => {
  for (const s of strikes) {
    const oi = type === 'CALL' ? s.callOI : s.putOI;
    const premium = type === 'CALL' ? s.callPremium : s.putPremium;
    // Skip if no real premium data yet
    if (!premium || premium <= 0) continue;
    const minPremium = s.strike * MIN_PREMIUM_FACTOR();
    if (premium < minPremium) continue;
    // OI check only when OI data is available (>0)
    if (oi > 0 && oi < MIN_OI()) continue;
    const oiNote = oi > 0 ? `OI: ${oi.toLocaleString()} (≥${MIN_OI().toLocaleString()}), ` : '';
    return {
      strike: s.strike,
      reason: `${oiNote}2D Low: ₹${premium.toFixed(2)} ≥ Min ₹${minPremium.toFixed(2)}`
    };
  }
  return null;
};

// Creates strike stubs — OI and premium are 0/undefined until real API data arrives
const generateStrikes = (
  startStrike: number,
  endStrike: number,
  step: number,
): StrikeData[] => {
  const strikes: StrikeData[] = [];
  const isCall = step > 0;
  for (let strike = startStrike; isCall ? strike <= endStrike : strike >= endStrike; strike += step) {
    strikes.push({ strike, callOI: 0, putOI: 0, callPremium: undefined, putPremium: undefined });
  }
  return strikes;
};

// Generate exactly 10 strikes for the range
const generateStrikeRange = (endStrike: number, direction: 'up' | 'down'): number[] => {
  const strikes: number[] = [];
  for (let i = 0; i < NUM_STRIKES(); i++) {
    if (direction === 'up') {
      strikes.push(endStrike + (i * STRIKE_INTERVAL()));
    } else {
      strikes.push(endStrike - (i * STRIKE_INTERVAL()));
    }
  }
  return strikes;
};

// Main calculation function
const calculateStrategy = (marketData: MarketData): CalculationResult => {
  const { day1High, day1Low, day2High, day2Low, preparationDay } = marketData;
  
  // Step 3: Calculate 2DHH and 2DLL
  const twoDHH = Math.max(day1High, day2High);
  const twoDLL = Math.min(day1Low, day2Low);
  
  // Step 4: Strike Factor Calculation
  const upperLevel = twoDHH * (1 + STRIKE_FACTOR());
  const lowerLevel = twoDLL * (1 - STRIKE_FACTOR());
  
  // Step 5: Strike Selection
  const putEndStrike = roundToNearestStrike(upperLevel, true);
  const callEndStrike = roundToNearestStrike(lowerLevel, false);
  
  // Step 6: Strike Range - Exactly 10 strikes
  // CALL: OTM = high strikes, ITM = low strikes. Range goes OTM→ITM (descending).
  // callEndStrike = lower boundary (ITM side), callStartStrike = highest (OTM side)
  const callStrikeRange = generateStrikeRange(callEndStrike, 'up').reverse(); // OTM first (high→low)
  const callStartStrike = callStrikeRange[0]; // highest strike (most OTM)

  // PUT: OTM = low strikes, ITM = high strikes. Range goes OTM→ITM (ascending).
  // putEndStrike = upper boundary (ITM side), putStartStrike = lowest (OTM side)
  const putStrikeRangeDesc = generateStrikeRange(putEndStrike, 'down'); // [high..low]
  const putStartStrike = putStrikeRangeDesc[NUM_STRIKES() - 1]; // lowest (most OTM)
  const putStrikeRange = [...putStrikeRangeDesc].reverse(); // OTM first (low→high)

  // Generate strike stubs — real OI/premium filled in after API fetch
  const callStrikes = generateStrikes(callStartStrike, callEndStrike, -STRIKE_INTERVAL()); // high→low
  const putStrikes  = generateStrikes(putStartStrike,  putEndStrike,   STRIKE_INTERVAL()); // low→high
  
  // Step 7 & 8 & 9: Filter and select strikes
  const callResult = findValidStrikeFromData(callStrikes, 'CALL');
  const putResult  = findValidStrikeFromData(putStrikes,  'PUT');
  
  // Filtered strikes for display
  const filteredCallStrikes = callStrikes.filter(s => s.callOI >= MIN_OI()).map(s => s.strike);
  const filteredPutStrikes = putStrikes.filter(s => s.putOI >= MIN_OI()).map(s => s.strike);
  
  // Step 12: Trade Execution Rules
  const calculateTradeSignal = (
    type: 'CALL' | 'PUT',
    strike: number | null,
    reason: string | null,
    strikeRange: number[]
  ): TradeSignal | null => {
    if (!strike || !reason) {
      return {
        type, strike: 0, entryPrice: 0, target: 0, stopLoss: 0, msl: 0, tsl: 0,
        optionOHLC: null, contractType: getExpiryType(preparationDay),
        reason: 'No valid strike found after checking 5 weekly contracts',
        isValid: false, strikeRange: []
      };
    }
    const contractType = getExpiryType(preparationDay);
    // Placeholder — real values computed from option's own OHLC after LTP fetch
    const entryPrice = roundHalf(twoDLL * (1 - ENTRY_DISCOUNT()));
    const target     = roundHalf(entryPrice * (1 - TARGET_PROFIT()));
    const msl        = roundHalf(entryPrice * (1 + MSL_INCREASE()));
    const tsl        = roundHalf(twoDHH * (1 + TSL_INCREASE()));
    const stopLoss   = roundHalf(Math.min(msl, tsl));
    return {
      type, strike, entryPrice, target, stopLoss, msl, tsl,
      optionOHLC: null, contractType, reason, isValid: true, strikeRange
    };
  };
  
  const callTrade = calculateTradeSignal('CALL', callResult?.strike ?? null, callResult?.reason ?? null, callStrikeRange);
  const putTrade = calculateTradeSignal('PUT', putResult?.strike ?? null, putResult?.reason ?? null, putStrikeRange);
  
  let noTradeReason: string | undefined;
  if (!callTrade?.isValid && !putTrade?.isValid) {
    noTradeReason = 'No valid strikes found in current or next 5 weekly contracts meeting OI and Premium criteria';
  }
  
  return {
    twoDHH,
    twoDLL,
    upperLevel,
    lowerLevel,
    putEndStrike,
    callEndStrike,
    callStartStrike,
    putStartStrike,
    callTrade,
    putTrade,
    noTradeReason,
    filteredStrikes: {
      call: filteredCallStrikes,
      put: filteredPutStrikes
    },
    callStrikeRange,
    putStrikeRange,
    callStrikes,
    putStrikes
  };
};

// Components
const Card: React.FC<{ children: React.ReactNode; className?: string; title?: string; icon?: string; badge?: { label: string; color: string; bg: string }; right?: React.ReactNode }> = ({
  children,
  className,
  title,
  icon,
  badge,
  right,
}) => (
  <div className={cn(
    "bg-gray-900 rounded-2xl shadow-lg border border-gray-700 overflow-hidden",
    className
  )}>
    {title && (
      <div className="px-4 sm:px-6 py-3 sm:py-4 bg-gray-800 border-b border-gray-700 flex items-center justify-between gap-2">
        <h3 className="text-base sm:text-lg font-semibold text-gray-100 flex items-center gap-2 flex-wrap min-w-0">
          {icon && <span>{icon}</span>}
          {title}
          {badge && (
            <span className={cn('px-2 py-0.5 rounded-full text-xs font-bold border', badge.color, badge.bg)}>
              {badge.label}
            </span>
          )}
        </h3>
        {right && <div className="shrink-0">{right}</div>}
      </div>
    )}
    <div className="p-6">{children}</div>
  </div>
);





const TradeSignalCard: React.FC<{ signal: TradeSignal; expiry: string; prepDate?: string; prepDay?: string; eodDate?: string; onTelegramSend?: () => void; isSendingTg?: boolean }> = ({ signal, expiry, prepDate, prepDay, eodDate, onTelegramSend, isSendingTg }) => {
  const isCall = signal.type === 'CALL';
  const optType = isCall ? 'CE' : 'PE';
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const msg =
`📊 NIFTY ${signal.strike} ${optType} | ${expiry} | ${signal.contractType}
━━━━━━━━━━━━━━━━━━━━
🎯 Entry    : ₹${signal.entryPrice.toFixed(1)}
✅ Target   : ₹${signal.target.toFixed(1)}
🛑 Stop Loss: ₹${signal.stopLoss.toFixed(1)}
━━━━━━━━━━━━━━━━━━━━
📅 Prep Date: ${prepDate ?? ''}  (${prepDay ?? ''})
📆 EOD Data : ${eodDate ?? ''}`;
    copyText(msg).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-xl border border-gray-700 overflow-hidden">
      {/* ── Header: CE/PE strike + expiry + copy button ── */}
      <div className={cn(
        "px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2",
        isCall ? "bg-linear-to-r from-green-900/60 to-transparent" : "bg-linear-to-r from-red-900/60 to-transparent"
      )}>
        <div className="flex items-center gap-1.5 sm:gap-2.5 flex-wrap min-w-0">
          <span className={cn("px-2 py-0.5 rounded-full text-xs font-bold shrink-0", isCall ? "bg-green-600 text-white" : "bg-red-600 text-white")}>
            {signal.type}
          </span>
          <span className="text-xl sm:text-2xl font-black text-white">{signal.strike}</span>
          <span className="text-xs sm:text-sm font-bold text-gray-400">{optType}</span>
          {expiry && (
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-600">
              {expiry}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {onTelegramSend && (
            <button onClick={onTelegramSend} disabled={isSendingTg}
              title="Send to Telegram"
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all",
                isSendingTg
                  ? "bg-blue-900/40 text-blue-300"
                  : "bg-gray-800 text-gray-400 hover:bg-blue-900/50 hover:text-blue-300 border border-gray-600"
              )}>
              {isSendingTg ? (
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
              ) : (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.04 9.613c-.152.678-.554.843-1.12.524l-3.1-2.284-1.497 1.44c-.165.165-.304.304-.624.304l.223-3.162 5.76-5.203c.25-.223-.054-.347-.388-.124L7.15 14.066l-3.048-.951c-.662-.207-.675-.662.138-.98l11.91-4.593c.55-.2 1.032.134.852.706h-.44z"/></svg>
              )}
            </button>
          )}
          <button onClick={handleCopy}
            title="Copy for Telegram"
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all",
              copied
                ? "bg-green-700 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white border border-gray-600"
            )}>
            {copied ? (
              <span className="copy-pop flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>Copied!
              </span>
            ) : (
              <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" strokeWidth={2}/><path strokeLinecap="round" strokeWidth={2} d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>Copy</>
            )}
          </button>
        </div>
      </div>

      {signal.isValid ? (
        <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">
          {/* PDH / PDL table */}
          {signal.optionOHLC && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Price History</p>
              <div className="overflow-x-auto">
              <table className="w-full text-xs text-center min-w-max">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="pb-1.5 font-medium text-left">Day</th>
                    <th className="pb-1.5 font-medium">PDH</th>
                    <th className="pb-1.5 font-medium">PDL</th>
                  </tr>
                </thead>
                <tbody className="text-gray-200">
                  <tr className="border-b border-gray-800/50">
                    <td className="py-1.5 text-left text-gray-500">D-1</td>
                    <td className="py-1.5 font-semibold">{signal.optionOHLC.day1High}</td>
                    <td className="py-1.5 font-semibold">{signal.optionOHLC.day1Low}</td>
                  </tr>
                  <tr className="border-b border-gray-800/50">
                    <td className="py-1.5 text-left text-gray-500">D-2</td>
                    <td className="py-1.5 font-semibold">{signal.optionOHLC.day2High}</td>
                    <td className="py-1.5 font-semibold">{signal.optionOHLC.day2Low}</td>
                  </tr>
                  <tr>
                    <td className="pt-2 text-left text-gray-500 font-semibold">2D</td>
                    <td className="pt-2 font-bold text-orange-400">{signal.optionOHLC.twoDHH} <span className="text-gray-600 font-normal">(HH)</span></td>
                    <td className="pt-2 font-bold text-green-400">{signal.optionOHLC.twoDLL} <span className="text-gray-600 font-normal">(LL)</span></td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>
          )}

          {/* Entry / Target / SL — main values */}
          <div className="border-t border-gray-800 pt-3 grid grid-cols-3 gap-1 text-center">
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Entry</p>
              <p className="text-base sm:text-xl font-black text-white">₹{signal.entryPrice.toFixed(1)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Target</p>
              <p className="text-base sm:text-xl font-black text-green-400">₹{signal.target.toFixed(1)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Stop Loss</p>
              <p className="text-base sm:text-xl font-black text-red-400">₹{signal.stopLoss.toFixed(1)}</p>
            </div>
          </div>

          {/* Hidden details — collapsed */}
          <details className="border-t border-gray-800 pt-3">
            <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-400 select-none list-none flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
              More details
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-center text-xs">
                <div><p className="text-gray-500 mb-0.5">MSL (Entry × {(1 + getCfg().mslIncrease).toFixed(2)})</p><p className="font-bold text-orange-300">₹{signal.msl.toFixed(1)}</p></div>
                <div><p className="text-gray-500 mb-0.5">TSL (2DHH × {(1 + getCfg().tslIncrease).toFixed(2)})</p><p className="font-bold text-orange-300">₹{signal.tsl.toFixed(1)}</p></div>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Selection Reason:</p>
                <p className="text-xs text-gray-300">{signal.reason}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1.5">Strike Range:</p>
                <div className="flex flex-wrap gap-1">
                  {signal.strikeRange.map((s) => (
                    <span key={s} className={cn("px-2 py-0.5 rounded text-xs font-medium",
                      s === signal.strike ? (isCall ? "bg-green-600 text-white" : "bg-red-600 text-white") : "bg-gray-700 text-gray-300"
                    )}>{s}</span>
                  ))}
                </div>
              </div>
            </div>
          </details>
        </div>
      ) : (
        <div className="text-center py-6 px-4">
          <p className="text-gray-500 text-sm">{signal.reason}</p>
        </div>
      )}
    </div>
  );
};



// ── Gap-Down Recalculation Modal ──────────────────────────────────────────────
const GapDownModal: React.FC<{ data: GapDownResult | null; loading: boolean; onClose: () => void }> = ({ data, loading, onClose }) => {
  const cfg = getCfg();

  const StepHeader = ({ n, title }: { n: number; title: string }) => (
    <div className="flex items-center gap-2 mb-2">
      <span className="w-6 h-6 rounded-full bg-amber-500 text-black text-xs font-black flex items-center justify-center shrink-0">{n}</span>
      <p className="text-xs font-bold text-amber-400 uppercase tracking-widest">{title}</p>
    </div>
  );

  const StrikeTable = ({ rows, type }: { rows: GapDownStrikeRow[]; type: 'CE' | 'PE' }) => (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="pb-1 text-left">Strike</th>
            <th className="pb-1 text-right">OI</th>
            <th className="pb-1 text-right">2D Low</th>
            <th className="pb-1 text-right">Min Prem</th>
            <th className="pb-1 text-center">F3</th>
            <th className="pb-1 text-center">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const bothMet = r.oiMet && r.premMet;
            const rowCls = r.selected
              ? (type === 'CE' ? 'bg-green-500/20 border-l-2 border-green-400' : 'bg-red-500/20 border-l-2 border-red-400')
              : bothMet ? 'bg-green-950/20' : '';
            return (
              <tr key={r.strike} className={cn('border-b border-gray-800/40', rowCls)}>
                <td className={cn('py-1 font-mono font-semibold', r.selected ? (type === 'CE' ? 'text-green-400' : 'text-red-400') : 'text-gray-300')}>
                  {r.strike} {r.selected && '★'}
                </td>
                <td className={cn('py-1 text-right', r.oiMet ? 'text-gray-300' : 'text-red-400')}>
                  {r.oi > 0 ? (r.oi / 1000).toFixed(1) + 'K' : '—'}
                </td>
                <td className={cn('py-1 text-right font-semibold', r.premMet ? 'text-white' : 'text-red-400')}>
                  {r.premiumRef > 0 ? `₹${r.premiumRef.toFixed(1)}` : '—'}
                </td>
                <td className="py-1 text-right text-gray-600">₹{r.minPrem.toFixed(1)}</td>
                <td className="py-1 text-center">{r.f3Met === undefined ? '—' : r.f3Met ? '✅' : '❌'}</td>
                <td className="py-1 text-center">
                  {r.selected ? '✅' : bothMet ? '🟢' : r.oiMet || r.premMet ? '🟡' : '🔴'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)' }}>
      <div className="w-full max-w-2xl bg-gray-900 border border-amber-900/50 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[94vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-amber-900/50 shrink-0"
          style={{ background: 'linear-gradient(90deg,#78350f22,#111827)' }}>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-lg">⚡</span>
              <h2 className="text-base font-black text-white">09:30 Recalculation</h2>
            </div>
            {data && <p className="text-xs text-amber-600 mt-0.5">Calculated at {data.calculatedAt}</p>}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          {loading && (
            <div className="flex flex-col items-center py-12 gap-3">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-amber-500" />
              <p className="text-amber-400 text-sm">Fetching NIFTY 9:30 candle + live option chain…</p>
            </div>
          )}

          {!loading && data && (<>
            {/* Step 1 — Candle */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={1} title="NIFTY First 15-min Candle (09:15 – 09:30)" />
              <div className="grid grid-cols-4 gap-2 text-center">
                {[['Open', data.candle.open], ['High', data.candle.high], ['Low', data.candle.low], ['Close', data.candle.close]].map(([l, v]) => (
                  <div key={l as string} className={cn('rounded-lg px-2 py-2', l === 'Low' ? 'bg-amber-900/40 border border-amber-700' : 'bg-gray-800')}>
                    <p className="text-xs text-gray-500">{l}</p>
                    <p className={cn('font-black text-sm', l === 'Low' ? 'text-amber-300' : 'text-white')}>{(v as number).toFixed(2)}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Step 2 — Buffer for both legs */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={2} title="New Spot Buffers (CE uses LOW, PE uses HIGH)" />
              <div className="rounded-lg bg-amber-950/30 border border-amber-900 p-2">
                <p className="text-xs font-bold text-amber-400 mb-1">CE End from 15m Low, PE End from 15m High</p>
                <p className="text-gray-500 font-mono text-xs">CE floor({data.candle.low.toFixed(2)} × 0.99875, {cfg.strikeInterval}) → {data.callEndStrike}</p>
                <p className="text-gray-500 font-mono text-xs">PE ceil({data.candle.high.toFixed(2)} × 1.00125, {cfg.strikeInterval}) → {data.putEndStrike}</p>
              </div>
            </section>

            {/* Step 3 — End Strikes */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={3} title="New End Strikes" />
              <div className="grid grid-cols-2 gap-3">
                {data.ceTriggered && (
                  <div className="rounded-lg bg-green-950/40 border border-green-900 p-2 text-center">
                    <p className="text-xs text-gray-500 mb-1">CALL End Strike</p>
                    <p className="text-xs text-gray-600 font-mono">floor(low × 0.99875)</p>
                    <p className="text-green-400 font-black text-xl">{data.callEndStrike}</p>
                  </div>
                )}
                {data.peTriggered && (
                  <div className="rounded-lg bg-red-950/40 border border-red-900 p-2 text-center">
                    <p className="text-xs text-gray-500 mb-1">PUT End Strike</p>
                    <p className="text-xs text-gray-600 font-mono">ceil(high × 1.00125)</p>
                    <p className="text-red-400 font-black text-xl">{data.putEndStrike}</p>
                  </div>
                )}
              </div>
            </section>

            {/* Step 4 — Strike Ranges */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={4} title={`Strike Ranges (${cfg.numStrikes} strikes, OTM → ITM)`} />
              <div className="space-y-2">
                {data.ceTriggered && data.callRange.length > 0 && (
                  <div>
                    <p className="text-xs text-green-400 font-semibold mb-1">CALL (CE) — Gap-Down</p>
                    <div className="flex flex-wrap gap-1">
                      {data.callRange.map((s, i) => (
                        <span key={s} className={cn('px-1.5 py-0.5 rounded text-xs font-mono',
                          s === data.callSelected?.strike ? 'bg-green-600 text-white font-bold' : i === 0 ? 'bg-gray-700 text-amber-400' : 'bg-gray-800 text-gray-400')}>{s}</span>
                      ))}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">{data.callRange[0]} (OTM) → {data.callRange[data.callRange.length-1]} (ITM)</p>
                  </div>
                )}
                {data.peTriggered && data.putRange.length > 0 && (
                  <div>
                    <p className="text-xs text-red-400 font-semibold mb-1">PUT (PE) — Gap-Up</p>
                    <div className="flex flex-wrap gap-1">
                      {data.putRange.map((s, i) => (
                        <span key={s} className={cn('px-1.5 py-0.5 rounded text-xs font-mono',
                          s === data.putSelected?.strike ? 'bg-red-600 text-white font-bold' : i === 0 ? 'bg-gray-700 text-amber-400' : 'bg-gray-800 text-gray-400')}>{s}</span>
                      ))}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">{data.putRange[0]} (OTM) → {data.putRange[data.putRange.length-1]} (ITM)</p>
                  </div>
                )}
              </div>
            </section>

            {/* Step 5 — Live Chain */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={5} title={`F1 + F2 + F3 Scan · Min OI: ${MIN_OI().toLocaleString()} · Min Prem: ${(cfg.minPremiumFactor*100).toFixed(2)}%`} />
              <div className={cn('gap-4', data.ceTriggered && data.peTriggered ? 'grid grid-cols-1 sm:grid-cols-2' : 'flex flex-col')}>
                {data.ceTriggered && <div><p className="text-xs font-bold text-green-400 mb-2">CALL CE · {data.callExpiry}</p><StrikeTable rows={data.callRows} type="CE" /></div>}
                {data.peTriggered && <div><p className="text-xs font-bold text-red-400 mb-2">PUT PE · {data.putExpiry}</p><StrikeTable rows={data.putRows} type="PE" /></div>}
              </div>
            </section>

            {/* Step 6 — Selected */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={6} title="Selected Strikes (first passing F1 + F2 + F3)" />
              <div className="grid grid-cols-2 gap-3">
                {data.ceTriggered && (
                  <div className="rounded-lg bg-green-950/40 border border-green-900 p-2 text-center">
                    <p className="text-xs text-gray-500">CALL CE Selected</p>
                    {data.callSelected
                      ? <><p className="text-green-400 font-black text-xl">{data.callSelected.strike} CE</p><p className="text-xs text-gray-400">2D Low: ₹{data.callSelected.premiumRef.toFixed(1)} · {data.callExpiry}</p></>
                      : <p className="text-red-400 text-sm font-semibold">No valid strike</p>}
                  </div>
                )}
                {data.peTriggered && (
                  <div className="rounded-lg bg-red-950/40 border border-red-900 p-2 text-center">
                    <p className="text-xs text-gray-500">PUT PE Selected</p>
                    {data.putSelected
                      ? <><p className="text-red-400 font-black text-xl">{data.putSelected.strike} PE</p><p className="text-xs text-gray-400">2D Low: ₹{data.putSelected.premiumRef.toFixed(1)} · {data.putExpiry}</p></>
                      : <p className="text-red-400 text-sm font-semibold">No valid strike</p>}
                  </div>
                )}
              </div>
            </section>

            {/* Step 7 — Recalc semantics */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={7} title="Recalc Rules" />
              <div className="text-xs text-gray-400">
                Recalc scans all strikes across allowed expiries. Entry stays based on option 2D Low, and F3 passes only when 15-minute option low stays above entry.
              </div>
            </section>

            {/* Step 8 — New Trade Signals */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={8} title="New Trade Signals (2D-Low based)" />
              <p className="text-xs text-gray-500 mb-3">
                Entry = Option 2D Low × (1−{(cfg.entryDiscount*100).toFixed(0)}%) · Target = Entry×{((1-cfg.targetProfit)*100).toFixed(0)}% · TSL = Option 2D High × {((1+cfg.tslIncrease)*100).toFixed(0)}% · Rounded ₹0.5
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { trade: data.callTrade, triggered: data.ceTriggered, scenario: 'Gap-Down' },
                  { trade: data.putTrade,  triggered: data.peTriggered, scenario: 'Gap-Up'   },
                ].map(({ trade: t, triggered, scenario }) => {
                  if (!triggered || !t) return null;
                  const isCall = t.type === 'CALL';
                  return (
                    <div key={t.type} className={cn('rounded-xl border p-3', isCall ? 'border-green-800 bg-green-950/20' : 'border-red-800 bg-red-950/20')}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-bold text-white', isCall ? 'bg-green-600' : 'bg-red-600')}>{t.type}</span>
                        <span className="text-white font-black">{t.strike}</span>
                        <span className="text-gray-500 text-xs">{isCall ? 'CE' : 'PE'} · {t.isValid ? data[isCall ? 'callExpiry' : 'putExpiry'] : ''}</span>
                        <span className="ml-auto text-xs text-amber-500 font-semibold">{scenario}</span>
                      </div>
                      {t.isValid ? (
                        <div className="grid grid-cols-3 gap-1 text-center">
                          <div><p className="text-xs text-gray-500">Entry</p><p className="font-black text-white">₹{t.entryPrice.toFixed(1)}</p></div>
                          <div><p className="text-xs text-gray-500">Target</p><p className="font-black text-green-400">₹{t.target.toFixed(1)}</p></div>
                          <div><p className="text-xs text-gray-500">SL</p><p className="font-black text-red-400">₹{t.stopLoss.toFixed(1)}</p></div>
                        </div>
                      ) : <p className="text-xs text-gray-500">{t.reason}</p>}
                    </div>
                  );
                })}
              </div>
            </section>
          </>)}
        </div>
      </div>
    </div>
  );
};

// ── Settings PIN Modal ────────────────────────────────────────────────────────
const PinModal: React.FC<{
  onSuccess: () => void;
  onClose: () => void;
  correctPin: string;
  telegramToken: string;
  telegramTargets: TelegramTarget[];
}> = ({ onSuccess, onClose, correctPin, telegramToken, telegramTargets }) => {
  const [entered, setEntered] = useState('');
  const [shake, setShake] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const press = (d: string) => {
    if (entered.length >= 4) return;
    const next = entered + d;
    setEntered(next);
    if (next.length === 4) {
      if (next === correctPin) {
        onSuccess();
      } else {
        setShake(true);
        setTimeout(() => { setShake(false); setEntered(''); }, 600);
      }
    }
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Enter' && entered.length === 4) { press(entered[3]); return; }
      if (e.key === 'Backspace') { setEntered(p => p.slice(0, -1)); return; }
      if (/^[0-9]$/.test(e.key)) { press(e.key); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [entered, onClose]);

  const handleForgot = async () => {
    const targets = telegramTargets.filter(t => t.chatId.trim());
    if (!telegramToken || !targets.length) { alert('Telegram not configured'); return; }
    await sendTelegramMsgToTargets(telegramToken, targets,
      `🔔 <b>FiFTO Trading Secret</b>\n🔐 <b>Settings PIN Reminder</b>\n━━━━━━━━━━━━━━━━━━━━\nYour settings PIN is: <b>${correctPin}</b>`);
    setForgotSent(true);
    setTimeout(() => setForgotSent(false), 3000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-xs bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-4 py-3 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
            </svg>
            <span className="text-sm font-black text-white">Settings PIN</span>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-white transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* PIN dots */}
          <div className={cn('flex justify-center gap-3 transition-all', shake ? 'animate-bounce' : '')}>
            {[0,1,2,3].map(i => (
              <div key={i} className={cn(
                'w-4 h-4 rounded-full border-2 transition-all',
                i < entered.length ? 'bg-green-500 border-green-500 scale-110' : 'bg-transparent border-gray-600'
              )} />
            ))}
          </div>

          {/* Keypad */}
          <div className="grid grid-cols-3 gap-2">
            {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, i) => (
              k === '' ? <div key={i} /> :
              <button key={k} onClick={() => k === '⌫' ? setEntered(p => p.slice(0,-1)) : press(k)}
                className={cn(
                  'h-12 rounded-xl text-lg font-black transition-all active:scale-95',
                  k === '⌫'
                    ? 'bg-gray-800 text-gray-500 hover:bg-gray-700 hover:text-white border border-gray-700'
                    : 'bg-gray-800 text-white hover:bg-gray-700 border border-gray-700 hover:border-green-700'
                )}>
                {k}
              </button>
            ))}
          </div>

          {/* Forgot */}
          <button onClick={handleForgot}
            className={cn('w-full text-xs py-2 rounded-lg border transition-all', forgotSent ? 'border-green-700 text-green-400' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300')}>
            {forgotSent ? '✅ PIN sent to Telegram' : '🔑 Forgot PIN? Send to Telegram'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Settings Modal ────────────────────────────────────────────────────────────
const INSTRUMENT_COLOR: Record<Instrument, { pill: string; accent: string; border: string }> = {
  NIFTY:      { pill: 'bg-blue-600',   accent: 'text-blue-400',   border: 'border-blue-600' },
  BANKNIFTY:  { pill: 'bg-purple-600', accent: 'text-purple-400', border: 'border-purple-600' },
};

const SettingsModal: React.FC<{ onClose: () => void; onSave: (s: AppSettings) => void; initial: AppSettings }> = ({ onClose, onSave, initial }) => {
  const [appCfg, setAppCfg] = useState<AppSettings>(() => ({
    ...initial,
    profiles: initial.profiles.map(p => ({ ...p })),
  }));
  const activeProfile = appCfg.profiles.find(p => p.id === appCfg.activeId) ?? appCfg.profiles[0];
  const colors = INSTRUMENT_COLOR[activeProfile.instrument];

  const setProfile = <K extends keyof StrategyProfile>(k: K, v: StrategyProfile[K]) => {
    setAppCfg(prev => ({
      ...prev,
      profiles: prev.profiles.map(p => p.id === prev.activeId ? { ...p, [k]: v } : p),
    }));
  };

  const resetActiveProfile = () => {
    const def = DEFAULT_PROFILES.find(d => d.id === appCfg.activeId);
    if (!def) return;
    setAppCfg(prev => ({
      ...prev,
      profiles: prev.profiles.map(p => p.id === prev.activeId ? { ...def } : p),
    }));
  };

  const pct  = (v: number) => (v * 100).toFixed(2);
  const fPct = (v: string) => parseFloat(v) / 100 || 0;

  const NumField = ({ label, sub, value, onChange, suffix = '', step = 1, min = 0 }: {
    label: string; sub: string; value: number; onChange: (v: number) => void;
    suffix?: string; step?: number; min?: number;
  }) => (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-200 truncate">{label}</p>
        <p className="text-[10px] text-gray-500 leading-tight mt-0.5">{sub}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <input type="number" step={step} min={min} value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className="w-20 text-right bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
        {suffix && <span className="text-[10px] text-gray-500 w-6 shrink-0">{suffix}</span>}
      </div>
    </div>
  );

  const PctField = ({ label, sub, value, onChange }: {
    label: string; sub: string; value: number; onChange: (v: number) => void;
  }) => (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-200 truncate">{label}</p>
        <p className="text-[10px] text-gray-500 leading-tight mt-0.5">{sub}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <input type="number" step="0.01" min="0" value={pct(value)}
          onChange={e => onChange(fPct(e.target.value))}
          className="w-20 text-right bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
        <span className="text-[10px] text-gray-500 w-5 shrink-0">%</span>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-3" style={{background:'rgba(0,0,0,0.80)', backdropFilter:'blur(6px)'}}>
      <div className="w-full sm:max-w-lg bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[94vh]">

        {/* ── Modal Header ── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-800 shrink-0">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
            <h2 className="text-base font-black text-white">Strategy Settings</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        {/* ── Profile Selector ── */}
        <div className="px-4 pt-4 pb-0 shrink-0 space-y-2">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Active Strategy</p>
          <div className="grid grid-cols-3 gap-1.5">
            {appCfg.profiles.map(p => {
              const c = INSTRUMENT_COLOR[p.instrument];
              const isActive = p.id === appCfg.activeId;
              const enabled = true;
              return (
                <button key={p.id}
                  disabled={!enabled}
                  onClick={() => { if (enabled) setAppCfg(prev => ({ ...prev, activeId: p.id })); }}
                  className={cn(
                    'rounded-xl px-2 py-2 text-left border transition-all relative overflow-hidden',
                    !enabled ? 'border-gray-800 bg-gray-900/40 opacity-40 cursor-not-allowed'
                      : isActive ? `${c.border} bg-gray-800`
                        : 'border-gray-700 bg-gray-800/40 hover:bg-gray-800'
                  )}>
                  <div className="flex items-center gap-1 mb-1">
                    <span className={cn('text-[10px] font-black px-1 py-0.5 rounded text-white', enabled ? c.pill : 'bg-gray-700')}>{p.instrument}</span>
                    <span className="text-[10px] text-gray-500 font-semibold">{p.expiry}</span>
                  </div>
                  <p className={cn('text-[11px] font-semibold leading-tight truncate', isActive ? c.accent : 'text-gray-400')}>{p.name}</p>
                  <p className="text-[9px] text-gray-600 mt-0.5 truncate">Lot {p.lotSize} · {p.strikeInterval}pts</p>
                </button>
              );
            })}
          </div>
          <div className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border', colors.border, 'bg-gray-800/60')}>
            <span className={cn('text-xs font-bold shrink-0', colors.accent)}>Editing:</span>
            <span className="text-sm font-black text-white truncate">{activeProfile.name}</span>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto flex-1 p-4 space-y-5">

          {/* Lot & OI */}
          <section>
            <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3">Lot & Open Interest</p>
            <div className="space-y-3">
              <NumField label="Lot Size" sub={`Units per lot for ${activeProfile.instrument}`}
                value={activeProfile.lotSize} onChange={v => setProfile('lotSize', Math.max(1, Math.round(v)))} suffix="units" step={1} min={1} />
              <NumField label="Min OI (contracts)" sub="Strike must have OI ≥ this many contracts"
                value={activeProfile.minOIContracts} onChange={v => setProfile('minOIContracts', Math.max(1, Math.round(v)))} step={1} min={1} />
              <div className="px-3 py-2 rounded-lg bg-gray-800 text-xs text-gray-400">
                Effective MIN OI = <span className="text-white font-semibold">{(activeProfile.lotSize * activeProfile.minOIContracts).toLocaleString()}</span>
                <span className="text-gray-600"> ({activeProfile.minOIContracts} × {activeProfile.lotSize})</span>
              </div>
            </div>
          </section>

          {/* Strike Selection */}
          <section>
            <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3">Strike Selection</p>
            <div className="space-y-3">
              <PctField label="Strike Factor" sub="Buffer % from 2DHH/2DLL to derive strike boundaries"
                value={activeProfile.strikeFactor} onChange={v => setProfile('strikeFactor', v)} />
              <PctField label="Min Premium Factor" sub="Option 2D Low must be ≥ this % of strike price"
                value={activeProfile.minPremiumFactor} onChange={v => setProfile('minPremiumFactor', v)} />
              <NumField label="Strike Interval" sub="Spacing between strikes (50 for NIFTY)"
                value={activeProfile.strikeInterval} onChange={v => setProfile('strikeInterval', Math.max(1, Math.round(v)))} suffix="pts" step={50} min={1} />
              <NumField label="Num Strikes" sub="Number of strikes to scan per leg (CALL + PUT)"
                value={activeProfile.numStrikes} onChange={v => setProfile('numStrikes', Math.max(1, Math.round(v)))} step={1} min={1} />
              <NumField label="Max Expiry Tries"
                sub="Try next N expiries if no valid strike found in current"
                value={activeProfile.maxTries} onChange={v => setProfile('maxTries', Math.max(1, Math.round(v)))} step={1} min={1} />
            </div>
          </section>

          {/* Entry / Exit */}
          <section>
            <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3">Entry / Exit Parameters</p>
            <div className="space-y-3">
              <PctField label="Entry Discount" sub="Entry = 2D Low × (1 − X%). More % = more conservative entry"
                value={activeProfile.entryDiscount} onChange={v => setProfile('entryDiscount', v)} />
              <PctField label="Target Profit" sub={`Target = Entry × (1 − X%). ${(activeProfile.targetProfit*100).toFixed(0)}% → exit at ${(100 - activeProfile.targetProfit*100).toFixed(0)}% of entry`}
                value={activeProfile.targetProfit} onChange={v => setProfile('targetProfit', v)} />
              <PctField label="MSL Increase (Max SL)" sub={`Entry × (1 + X%) = ${(1 + activeProfile.mslIncrease).toFixed(2)}× entry`}
                value={activeProfile.mslIncrease} onChange={v => setProfile('mslIncrease', v)} />
              <PctField label="TSL Increase (Trailing SL)" sub={`2DHH × (1 + X%) = ${(1 + activeProfile.tslIncrease).toFixed(2)}× 2-day high`}
                value={activeProfile.tslIncrease} onChange={v => setProfile('tslIncrease', v)} />
            </div>
            <div className="mt-3 px-3 py-2 rounded-lg bg-gray-800 text-xs text-gray-500">
              Entry / SL / Target all round to nearest <span className="text-white font-semibold">₹0.5</span>
            </div>
          </section>

          {/* Security */}
          <section>
            <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3">Security</p>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-200 truncate">Settings PIN</p>
                <p className="text-[10px] text-gray-500 leading-tight mt-0.5">4-digit PIN for Settings access</p>
              </div>
              <input type="password" maxLength={4} pattern="[0-9]*" inputMode="numeric"
                value={appCfg.settingsPin}
                onChange={e => setAppCfg(prev => ({ ...prev, settingsPin: e.target.value.replace(/\D/g,'').slice(0,4) }))}
                className="w-16 text-center bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500 font-mono tracking-widest" />
            </div>
          </section>

          {/* Paper Trade Settings */}
          <section>
            <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3">Paper Trade Tracking</p>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-200 truncate">LTP Poll Interval</p>
                <p className="text-[10px] text-gray-500 leading-tight mt-0.5">Refresh rate for open positions (min 5s)</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <input type="number" step="1" min="30" max="300" value={appCfg.ltpPollIntervalSec}
                  onChange={e => setAppCfg(prev => ({ ...prev, ltpPollIntervalSec: Math.max(30, parseInt(e.target.value) || 30) }))}
                  className="w-16 text-right bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
                <span className="text-[10px] text-gray-500 w-6 shrink-0">sec</span>
              </div>
            </div>
          </section>

          {/* Telegram Notifications */}
          <section>
            <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3">Telegram Notifications</p>
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-gray-200">Bot Token</p>
                <input type="password" value={appCfg.telegramToken}
                  onChange={e => setAppCfg(prev => ({ ...prev, telegramToken: e.target.value }))}
                  placeholder="123456:ABC-..."
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-green-500 font-mono" />
              </div>
              <div className="grid gap-3">
                {appCfg.telegramTargets.map((target, idx) => (
                  <div key={idx} className="space-y-2 rounded-xl border border-gray-700 p-3 bg-gray-900/80">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-gray-200">Group {idx + 1} Name</p>
                      <input type="text" value={target.name}
                        onChange={e => setAppCfg(prev => ({
                          ...prev,
                          telegramTargets: prev.telegramTargets.map((t, i) => i === idx ? { ...t, name: e.target.value } : t),
                        }))}
                        placeholder={`Group ${idx + 1}`}
                        className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-green-500 font-mono" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-gray-200">Chat ID</p>
                      <input type="text" value={target.chatId}
                        onChange={e => setAppCfg(prev => ({
                          ...prev,
                          telegramTargets: prev.telegramTargets.map((t, i) => i === idx ? { ...t, chatId: e.target.value } : t),
                        }))}
                        placeholder="-100123456"
                        className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-green-500 font-mono" />
                    </div>
                  </div>
                ))}
              </div>
              {appCfg.telegramToken && appCfg.telegramTargets.some(t => t.chatId.trim()) && (
                <button onClick={async () => {
                    const results = await sendTelegramMsgToTargets(appCfg.telegramToken, appCfg.telegramTargets,
                      '✅ <b>FiFTO Trading Secret</b>\nTelegram notifications are working!');
                    const ok = results.some(Boolean);
                    alert(ok ? '✅ Test message sent!' : '❌ Failed — check token and at least one chat ID');
                  }}
                  className="w-full py-1.5 rounded-lg text-xs font-semibold text-blue-400 border border-blue-800 hover:bg-blue-900/20 transition-all">
                  📨 Send Test Message
                </button>
              )}
              <div className="px-3 py-2 rounded-lg bg-gray-800 text-xs text-gray-500 space-y-1">
                <p>Notifications sent after <span className="text-white">Morning Check</span> and <span className="text-white">Gap-Down Recalc</span>.</p>
                <p>To get your Chat ID: message <span className="text-blue-400">@userinfobot</span> on Telegram.</p>
              </div>
            </div>
          </section>
        </div>

        {/* ── Footer ── */}
        <div className="flex gap-2 px-4 py-3 border-t border-gray-700 bg-gray-800 shrink-0">
          <button onClick={resetActiveProfile}
            className="flex-1 py-2 rounded-lg text-sm font-semibold text-gray-400 border border-gray-600 hover:border-gray-400 hover:text-white transition-all">
            Reset This Profile
          </button>
          <button onClick={() => { onSave(appCfg); onClose(); }}
            className="flex-1 py-2 rounded-lg text-sm font-black text-white transition-all"
            style={{background:'linear-gradient(135deg,#16a34a,#15803d)', boxShadow:'0 0 12px rgba(22,163,74,0.3)'}}>
            Save & Apply
          </button>
        </div>
      </div>
    </div>
  );
};

// Main App Component
export default function App() {
  // Load saved run state once (before any useState that references it)
  const _saved = (() => { try { const r = localStorage.getItem('fifto_run_v1'); return r ? JSON.parse(r) : null; } catch { return null; } })();

  const [nextTradingDate, setNextTradingDate] = useState<string>('');
  const [marketData, setMarketData] = useState<MarketData | null>(_saved?.marketData ?? null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinUnlocked, setPinUnlocked] = useState(false); // session-only
  const [appSettings, setAppSettings] = useState<AppSettings>(() => loadSettings());

  const handleSaveSettings = useCallback((s: AppSettings) => {
    _appSettings = s;
    setAppSettings(s);
    saveSettings(s);
    syncSettings(s.ltpPollIntervalSec, s.telegramToken, s.telegramTargets);
  }, []);

  const activeProfile = getActiveProfile(appSettings);

  // ── Persist active page across refresh ───────────────────────────────────
  const [activePage, setActivePage] = useState<'strategy' | 'trades' | 'schedule'>(
    () => (localStorage.getItem('fifto_page') as 'strategy' | 'trades' | 'schedule') ?? 'strategy'
  );
  const switchPage = (p: 'strategy' | 'trades' | 'schedule') => {
    setActivePage(p); localStorage.setItem('fifto_page', p);
  };
  const [paperTrades, setPaperTrades] = useState<PaperTrade[]>([]);
  const [historyVisibleCount, setHistoryVisibleCount] = useState(10);
  const [historyFilter, setHistoryFilter] = useState<'live' | 'expired'>('live');
  const historySentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setHistoryVisibleCount(10);
  }, [paperTrades]);
  useEffect(() => {
    const el = historySentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setHistoryVisibleCount(prev => prev + 10);
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [paperTrades]);
  const [serverEOD, setServerEOD] = useState<{
    strategyName: string;
    callTrade: { strike: number; entryPrice: number; target: number; stopLoss: number; isValid: boolean } | null;
    putTrade:  { strike: number; entryPrice: number; target: number; stopLoss: number; isValid: boolean } | null;
    recalculatedSignals?: {
      callTrade: { strike: number; entryPrice: number; target?: number; targetPrice?: number; stopLoss: number; isValid: boolean } | null;
      putTrade:  { strike: number; entryPrice: number; target?: number; targetPrice?: number; stopLoss: number; isValid: boolean } | null;
      callExpiry: string;
      putExpiry: string;
    } | null;
    recalcMeta?: { candle?: { high: number; low: number }; telegramSentAt?: string } | null;
    recalculatedAt?: string;
    callExpiry: string; putExpiry: string;
    prepDate: string; prepDay: string; eodDate: string;
  } | null>(null);
  const [nextExecuteLTPs, setNextExecuteLTPs] = useState<{ ce: number | null; pe: number | null }>({ ce: null, pe: null });
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [showNextEditPinModal, setShowNextEditPinModal] = useState(false);
  const [nextEditUnlocked, setNextEditUnlocked] = useState(false);
  const [isEditingNext, setIsEditingNext] = useState(false);
  const [nextEditForm, setNextEditForm] = useState<Record<string, string>>({});
  const [strategiesUnlocked, setStrategiesUnlocked] = useState(false);
  const [showStrategyPinModal, setShowStrategyPinModal] = useState(false);
  const [detailTrade, setDetailTrade] = useState<PaperTrade | null>(null);
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [calcHistoryDates, setCalcHistoryDates] = useState<string[]>([]);
  const [calcHistoryDetail, setCalcHistoryDetail] = useState<any>(null);
  const [selectedCalcDate, setSelectedCalcDate] = useState<string | null>(null);
  // ── Restore last run state from localStorage ─────────────────────────────
  const [result, setResult] = useState<CalculationResult | null>(_saved?.result ?? null);
  const [isCalculated, setIsCalculated] = useState<boolean>(_saved?.isCalculated ?? false);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetchingLTPs, setIsFetchingLTPs] = useState(false);
  const [ltpFetchStatus, setLtpFetchStatus] = useState<'idle'|'success'|'error'>(_saved ? 'success' : 'idle');
  const [expiryUsed, setExpiryUsed] = useState<string>(_saved?.expiryUsed ?? '');
  const [callExpiryUsed, setCallExpiryUsed] = useState<string>(_saved?.callExpiryUsed ?? '');
  const [putExpiryUsed, setPutExpiryUsed] = useState<string>(_saved?.putExpiryUsed ?? '');
  const [bothCopied, setBothCopied] = useState(false);
  const [tgSent, setTgSent] = useState(false);
  const [isSendingTg, setIsSendingTg] = useState(false);
  const [nexTgSent, setNexTgSent] = useState(false);
  const [isSendingNexTg, setIsSendingNexTg] = useState(false);
  const isOpenPaperTrade = (t: PaperTrade) => t.status === 'TRIGGERED' || (t.status === 'PENDING' && t.date === localToday());

  // ── Toast notifications ───────────────────────────────────────────────────
  interface Toast { id: number; type: 'success'|'warning'|'danger'|'info'; title: string; body: string; }
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((type: Toast['type'], title: string, body: string) => {
    const id = ++toastIdRef.current;
    setToasts(p => [...p.slice(-2), { id, type, title, body }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 5000);
  }, []);

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSettings(false); setShowPinModal(false);
        setShowStrategyPinModal(false); setShowNextEditPinModal(false);
        setShowGapDown(false); setDetailTrade(null);
        setIsEditingNext(false); setEditingTradeId(null); setCancelingId(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Track previous trade states to detect changes
  const prevTradesRef = useRef<PaperTrade[]>([]);
  const nearAlertedRef = useRef<Set<string>>(new Set());
  const [expirySearchStatus, setExpirySearchStatus] = useState<string>('');
  // Morning check & gap-down
  const [morningCheck, setMorningCheck]   = useState<MorningCheck | null>(null);
  const [isCheckingLTP, setIsCheckingLTP] = useState(false);
  const [gapDownData, setGapDownData]     = useState<GapDownResult | null>(null);
  const [isGapDownCalc, setIsGapDownCalc] = useState(false);
  const [showGapDown, setShowGapDown]     = useState(false);
  const [isServerRecalc, setIsServerRecalc] = useState(false);
  const [isSendingRecalcTelegram, setIsSendingRecalcTelegram] = useState(false);
  
  // Default to last market close date (today after 3:45 PM, else previous trading day)
  const defaultDate = getLastMarketCloseDate();
  const yesterdayDate = prevTradingDay(localToday());
  useEffect(() => {
    setNextTradingDate(defaultDate);
    fetchCalcHistory().then(setCalcHistoryDates);
    // Push stored Telegram config to server on startup so 9AM auto-send works
    const s = loadSettings();
    syncSettings(s.ltpPollIntervalSec, s.telegramToken, s.telegramTargets);
  }, []);

  // Poll trades every N seconds (all pages) — skip LTP fetch after market close
  useEffect(() => {
    const refresh = async () => {
      const [trades, eod] = await Promise.all([fetchTrades(), fetchEODStore()]);
      setPaperTrades(trades);
      setServerEOD(eod);
      if (eod && (eod.callTrade?.isValid || eod.putTrade?.isValid) && isMarketOpen()) {
        const plannedCall = eod.recalculatedSignals?.callTrade?.isValid ? eod.recalculatedSignals.callTrade : eod.callTrade;
        const plannedPut  = eod.recalculatedSignals?.putTrade?.isValid  ? eod.recalculatedSignals.putTrade  : eod.putTrade;
        const plannedCallExpiry = eod.recalculatedSignals?.callTrade?.isValid ? eod.recalculatedSignals.callExpiry : eod.callExpiry;
        const plannedPutExpiry  = eod.recalculatedSignals?.putTrade?.isValid  ? eod.recalculatedSignals.putExpiry  : eod.putExpiry;
        const live = await fetchLiveLTPs(
          plannedCallExpiry, plannedCall?.strike ?? 0,
          plannedPutExpiry,  plannedPut?.strike  ?? 0,
        );
        setNextExecuteLTPs({
          ce: live.ceLTP > 0 ? live.ceLTP : null,
          pe: live.peLTP > 0 ? live.peLTP : null,
        });
      } else {
        setNextExecuteLTPs({ ce: null, pe: null });
      }

      // ── Detect status changes → push toasts ────────────────────────────
      const prev = prevTradesRef.current;
      for (const t of trades) {
        const old = prev.find(p => p.id === t.id);
        const tag = `${t.strike} ${t.optType}`;

        // Status change toasts
        if (old && old.status !== t.status) {
          if (t.status === 'TRIGGERED')
            pushToast('success', '✅ Order Executed', `${tag} · Entry ₹${t.triggeredLTP?.toFixed(1) ?? t.entryPrice.toFixed(1)}`);
          if (t.status === 'TARGET_HIT')
            pushToast('success', '🎯 Target Hit!', `${tag} · P&L +₹${t.pnl?.toFixed(0) ?? '—'}`);
          if (t.status === 'SL_HIT')
            pushToast('danger', '🛑 Stop Loss Hit', `${tag} · P&L ₹${t.pnl?.toFixed(0) ?? '—'}`);
        }

        // Near alerts (TRIGGERED positions only, once per threshold)
        if (t.status === 'TRIGGERED' && t.currentLTP) {
          const ltp = t.currentLTP;
          const targetDist = (ltp - t.targetPrice) / t.entryPrice;
          const slDist = (t.stopLoss - ltp) / t.entryPrice;
          const tKey = `target_near_${t.id}`, sKey = `sl_near_${t.id}`;

          if (targetDist <= 0.08 && !nearAlertedRef.current.has(tKey)) {
            nearAlertedRef.current.add(tKey);
            pushToast('info', '🎯 Target Near', `${tag} · LTP ₹${ltp.toFixed(1)} → Target ₹${t.targetPrice.toFixed(1)}`);
          }
          if (slDist <= 0.08 && !nearAlertedRef.current.has(sKey)) {
            nearAlertedRef.current.add(sKey);
            pushToast('warning', '⚠️ SL Near', `${tag} · LTP ₹${ltp.toFixed(1)} → SL ₹${t.stopLoss.toFixed(1)}`);
          }
          // Reset near alert if moved away
          if (targetDist > 0.15) nearAlertedRef.current.delete(tKey);
          if (slDist > 0.15)     nearAlertedRef.current.delete(sKey);
        }
      }
      prevTradesRef.current = trades;
    };
    refresh();
    const iv = setInterval(refresh, (appSettings.ltpPollIntervalSec ?? 60) * 1000);
    return () => clearInterval(iv);
  }, [activePage, appSettings.ltpPollIntervalSec, pushToast]);
  
  // Single combined action: fetch NIFTY data → calculate → fetch options → show results
  const handleRun = async () => {
    if (!nextTradingDate) { setFetchError('Please select a date first'); return; }
    setFetchError(null);
    setResult(null);
    setIsCalculated(false);
    setLtpFetchStatus('idle');
    setExpiryUsed('');
    setCallExpiryUsed('');
    setPutExpiryUsed('');
    setExpirySearchStatus('');

    // ── Step 1: Fetch fresh NIFTY OHLC from Angel One ────────
    const { date: effectiveDate, marketWasOpen } = getEffectiveDate(nextTradingDate);

    let data: { day1High: number; day1Low: number; day2High: number; day2Low: number; day1Date?: string; day2Date?: string; source?: string; warnings?: string[] } | null = null;
    setIsFetching(true);
    data = await fetchNiftyData(effectiveDate);
    setIsFetching(false);

    if (!data) {
      setFetchError('Failed to fetch NIFTY data from Angel One. Check angel-config.json and network.');
      return;
    }

    const today = new Date();
    // For manual calc: prep date = user-selected date (nextTradingDate), normalized to trading day
    const d = new Date(nextTradingDate + 'T12:00:00');
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const prepDate = `${y}-${m}-${dd}`;
    const prepDay = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
    const mData: MarketData = {
      ...data,
      preparationDate: prepDate,
      preparationDay: prepDay,
      preparationTime: today.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      nextTradingDate: getNextTradingDay(new Date(nextTradingDate)).date,
      nextTradingDay: getNextTradingDay(new Date(nextTradingDate)).day,
      fetched: true,
      fetchTimestamp: new Date().toLocaleString(),
      effectiveDataDate: effectiveDate,
      marketWasOpen,
    };
    setMarketData(mData);

    // ── Step 2: Calculate ranges + fetch options ──────────────────────────────
    setIsFetchingLTPs(true);
    const calcResult = calculateStrategy(mData);
    setResult(calcResult);
    setIsCalculated(true);

    try {
      const expiryDates = await fetchExpiryDates();
      if (expiryDates.length === 0) { setLtpFetchStatus('error'); return; }

      // Start from current week (or next week on Mon/Tue), try up to 5 expiries per leg
      const startIdx = (mData.preparationDay === 'Monday' || mData.preparationDay === 'Tuesday') ? 1 : 0;
      const expiriesToTry = expiryDates.slice(startIdx, startIdx + 5);
      const MAX_TRIES = getCfg().maxTries;

      // Per-leg state — each leg independently searches across expiries
      let callRes: { strike: number; reason: string } | null = null;
      let callFoundExpiry = '';
      let callUpdatedStrikes = calcResult.callStrikes;

      let putRes: { strike: number; reason: string } | null = null;
      let putFoundExpiry = '';
      let putUpdatedStrikes = calcResult.putStrikes;

      for (let i = 0; i < Math.min(MAX_TRIES, expiriesToTry.length); i++) {
        const expiry = expiriesToTry[i];
        const needCall = !callRes;
        const needPut  = !putRes;
        if (!needCall && !needPut) break;

        setExpirySearchStatus(`Checking expiry ${i + 1}/${Math.min(MAX_TRIES, expiriesToTry.length)}: ${expiry.toUpperCase()}`);

        // Fetch option chain only for the legs still searching
        const strikesToFetch = [...new Set([
          ...(needCall ? calcResult.callStrikeRange : []),
          ...(needPut  ? calcResult.putStrikeRange  : []),
        ])];
        const records = await fetchOptionChain(expiry, strikesToFetch, effectiveDate);

        const ceLTPs = new Map<number, number>();
        const peLTPs = new Map<number, number>();
        const ceOIs  = new Map<number, number>();
        const peOIs  = new Map<number, number>();
        for (const d of records) {
          if (d.CE?.lastPrice)    ceLTPs.set(d.strikePrice, d.CE.lastPrice);
          if (d.PE?.lastPrice)    peLTPs.set(d.strikePrice, d.PE.lastPrice);
          if (d.CE?.openInterest) ceOIs.set(d.strikePrice, d.CE.openInterest);
          if (d.PE?.openInterest) peOIs.set(d.strikePrice, d.PE.openInterest);
        }

        if (needCall) {
          const updated = calcResult.callStrikes.map(s => ({
            ...s,
            callPremium: ceLTPs.has(s.strike) ? ceLTPs.get(s.strike)! : s.callPremium,
            callOI:      ceOIs.has(s.strike)  ? ceOIs.get(s.strike)!  : s.callOI,
          }));
          const found = findValidStrikeFromData(updated, 'CALL');
          if (found) { callRes = found; callFoundExpiry = expiry.toUpperCase(); callUpdatedStrikes = updated; }
        }

        if (needPut) {
          const updated = calcResult.putStrikes.map(s => ({
            ...s,
            putPremium: peLTPs.has(s.strike) ? peLTPs.get(s.strike)! : s.putPremium,
            putOI:      peOIs.has(s.strike)  ? peOIs.get(s.strike)!  : s.putOI,
          }));
          const found = findValidStrikeFromData(updated, 'PUT');
          if (found) { putRes = found; putFoundExpiry = expiry.toUpperCase(); putUpdatedStrikes = updated; }
        }
      }

      setExpirySearchStatus('');

      // Show expiry in header — combined if same, separate if different
      const displayExpiry = callFoundExpiry === putFoundExpiry && callFoundExpiry
        ? callFoundExpiry
        : [callFoundExpiry, putFoundExpiry].filter(Boolean).join(' / ') || expiriesToTry[0]?.toUpperCase() || '';
      setExpiryUsed(displayExpiry);
      setCallExpiryUsed(callFoundExpiry || expiriesToTry[0]?.toUpperCase() || '');
      setPutExpiryUsed(putFoundExpiry   || expiriesToTry[0]?.toUpperCase() || '');

      const [callOHLC, putOHLC] = await Promise.all([
        callRes ? fetchOptionOHLC(callFoundExpiry || expiriesToTry[0], callRes.strike, 'CE', effectiveDate) : Promise.resolve(null),
        putRes  ? fetchOptionOHLC(putFoundExpiry  || expiriesToTry[0], putRes.strike,  'PE', effectiveDate) : Promise.resolve(null),
      ]);

      const buildSignal = (
        type: 'CALL' | 'PUT',
        res: { strike: number; reason: string } | null,
        ohlc: OptionOHLC | null,
        foundExpiry: string,
        strikeRange: number[],
        triedExpiries: number,
      ): TradeSignal => {
        if (!res) return {
          type, strike: 0, entryPrice: 0, target: 0, stopLoss: 0, msl: 0, tsl: 0,
          optionOHLC: null, contractType: 'Current Week',
          reason: `No valid strike found after checking ${triedExpiries} expir${triedExpiries === 1 ? 'y' : 'ies'}`,
          isValid: false, strikeRange: [],
        };
        const contractType: 'Current Week' | 'Next Week' =
          foundExpiry === expiriesToTry[0]?.toUpperCase() ? (startIdx === 1 ? 'Next Week' : 'Current Week') : 'Next Week';
        if (!ohlc) return {
          type, strike: res.strike, entryPrice: 0, target: 0, stopLoss: 0, msl: 0, tsl: 0,
          optionOHLC: null, contractType,
          reason: `No 2D OHLC data for ${res.strike} ${type === 'CALL' ? 'CE' : 'PE'}`,
          isValid: false, strikeRange,
        };
        const entryPrice = roundHalf(ohlc.twoDLL * (1 - ENTRY_DISCOUNT()));
        const target     = roundHalf(entryPrice * (1 - TARGET_PROFIT()));
        const msl        = roundHalf(entryPrice * (1 + MSL_INCREASE()));
        const tsl        = roundHalf(ohlc.twoDHH * (1 + TSL_INCREASE()));
        const stopLoss   = roundHalf(Math.min(msl, tsl));
        return { type, strike: res.strike, entryPrice, target, stopLoss, msl, tsl, optionOHLC: ohlc, contractType, reason: res.reason, isValid: true, strikeRange };
      };

      const triedCount = Math.min(MAX_TRIES, expiriesToTry.length);
      const callSignal = buildSignal('CALL', callRes, callOHLC, callFoundExpiry, calcResult.callStrikeRange, triedCount);
      const putSignal  = buildSignal('PUT',  putRes,  putOHLC,  putFoundExpiry,  calcResult.putStrikeRange,  triedCount);

      setResult({
        ...calcResult,
        noTradeReason: (callSignal.isValid || putSignal.isValid) ? undefined : `No valid strikes found after checking ${triedCount} expiries`,
        callStrikes: callUpdatedStrikes,
        putStrikes:  putUpdatedStrikes,
        callTrade: callSignal,
        putTrade:  putSignal,
      });
      setLtpFetchStatus(callRes || putRes ? 'success' : 'error');

      // ── Persist run state so refresh restores it ──────────────────────────
      if (callSignal.isValid || putSignal.isValid) {
        try {
          localStorage.setItem('fifto_run_v1', JSON.stringify({
            marketData: mData,
            result: { ...calcResult, callStrikes: callUpdatedStrikes, putStrikes: putUpdatedStrikes, callTrade: callSignal, putTrade: putSignal },
            isCalculated: true,
            expiryUsed:     expiriesToTry[0]?.toUpperCase() ?? '',
            callExpiryUsed: callFoundExpiry || expiriesToTry[0]?.toUpperCase() || '',
            putExpiryUsed:  putFoundExpiry  || expiriesToTry[0]?.toUpperCase() || '',
          }));
        } catch { /* quota exceeded — ignore */ }
      }

      // ── Store EOD for 09:00 AM reminder + send immediate Telegram ────────
      if (callSignal.isValid || putSignal.isValid) {
        const prof = getCfg();
        const ceExp = callFoundExpiry || expiriesToTry[0]?.toUpperCase() || '';
        const peExp = putFoundExpiry  || expiriesToTry[0]?.toUpperCase() || '';
        const eodPayload = {
          strategyName: prof.name,
          callTrade: callSignal, putTrade: putSignal,
          callExpiry: ceExp, putExpiry: peExp,
          prepDate: mData.preparationDate, prepDay: mData.preparationDay,
          eodDate: effectiveDate,
        };
        storeEOD(eodPayload); // server stores for 09:00 AM auto-reminder
        fetchCalcHistory().then(setCalcHistoryDates); // refresh calc history
      }
    } catch {
      setLtpFetchStatus('error');
      setExpirySearchStatus('');
    } finally {
      setIsFetchingLTPs(false);
    }
  };

  // ── Morning Check: F3 validation using 09:15–09:25 option low ───────────────
  const handleMorningCheck = async () => {
    if ((!result?.callTrade?.isValid && !result?.putTrade?.isValid) || !marketData?.preparationDate) return;
    setIsCheckingLTP(true);
    try {
      const [ce10, pe10] = await Promise.all([
        result?.callTrade?.isValid
          ? fetchOptionCandle(callExpiryUsed, result.callTrade.strike, 'CE', marketData.preparationDate, 'TEN_MINUTE', '09:15', '09:25')
          : Promise.resolve(null),
        result?.putTrade?.isValid
          ? fetchOptionCandle(putExpiryUsed, result.putTrade.strike, 'PE', marketData.preparationDate, 'TEN_MINUTE', '09:15', '09:25')
          : Promise.resolve(null),
      ]);
      const callEntry = result?.callTrade?.entryPrice ?? 0;
      const putEntry  = result?.putTrade?.entryPrice  ?? 0;
      const callRecalcNeeded = result?.callTrade?.isValid ? !ce10 || ce10.low < callEntry : false;
      const putRecalcNeeded  = result?.putTrade?.isValid  ? !pe10 || pe10.low < putEntry  : false;
      const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      setMorningCheck({
        ce10Low: ce10?.low ?? 0,
        pe10Low: pe10?.low ?? 0,
        callEntryEOD: callEntry,
        putEntryEOD: putEntry,
        callRecalcNeeded,
        putRecalcNeeded,
        checkedAt: now,
      });

      // ── Telegram notification ──────────────────────────────────────────────
      const { telegramToken: tok, telegramTargets } = appSettings;
      const targets = telegramTargets.filter(t => t.chatId.trim());
      if (tok && targets.length) {
        const profile = getCfg();
        const ceStrike = result?.callTrade?.strike;
        const peStrike = result?.putTrade?.strike;
        const ceExp = callExpiryUsed || expiryUsed;
        const peExp = putExpiryUsed  || expiryUsed;

        let msg = `🔔 <b>FiFTO Trading Secret</b>\n📊 <b>${profile.name} — Morning Check</b>\n⏰ ${now}\n━━━━━━━━━━━━━━━━━━━━\n`;

        if (result?.callTrade?.isValid) {
          msg += callRecalcNeeded
            ? `📉 <b>CE ${ceStrike} · ${ceExp}</b>\n10m Low ₹${(ce10?.low ?? 0).toFixed(1)} &lt; Entry ₹${callEntry.toFixed(1)} → <b>F3 Fail · Recalc @ 09:30</b>\n`
            : `✅ <b>CE ${ceStrike} · ${ceExp}</b>\n10m Low ₹${(ce10?.low ?? 0).toFixed(1)} ≥ Entry ₹${callEntry.toFixed(1)} → <b>F3 OK</b>\n`;
        }
        msg += `\n`;
        if (result?.putTrade?.isValid) {
          msg += putRecalcNeeded
            ? `📈 <b>PE ${peStrike} · ${peExp}</b>\n10m Low ₹${(pe10?.low ?? 0).toFixed(1)} &lt; Entry ₹${putEntry.toFixed(1)} → <b>F3 Fail · Recalc @ 09:30</b>\n`
            : `✅ <b>PE ${peStrike} · ${peExp}</b>\n10m Low ₹${(pe10?.low ?? 0).toFixed(1)} ≥ Entry ₹${putEntry.toFixed(1)} → <b>F3 OK</b>\n`;
        }
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        if (!callRecalcNeeded && !putRecalcNeeded) {
          msg += `✅ <b>F3 passed — keep original EOD entry prices</b>`;
        } else {
          msg += `⚡ Running 09:30 recalculation for F3-fail leg(s)…`;
        }
        sendTelegramMsgToTargets(tok, targets, msg);
      }
    } finally {
      setIsCheckingLTP(false);
    }
  };

  // ── 09:30 Recalculation: only for legs where F3 failed at 09:25 ────────────
  const handleGapDownRecalc = async () => {
    if (!marketData || !morningCheck?.checkedAt) return;
    setIsGapDownCalc(true);
    setShowGapDown(true);
    try {
      const cfg = getCfg();
      const GAP_BUFFER = 0.00125; // 0.125%
      const refDate = marketData.effectiveDataDate || getPreviousTradingDay(marketData.preparationDate);
      const ceTriggered = morningCheck.callRecalcNeeded;
      const peTriggered = morningCheck.putRecalcNeeded;
      const expiryDates = await fetchExpiryDates();
      const startIdx = (marketData.preparationDay === 'Monday' || marketData.preparationDay === 'Tuesday') ? 1 : 0;
      const expiriesToTry = expiryDates.slice(startIdx, startIdx + getCfg().maxTries);

      // Step 1 — wait for 09:30 AM and fetch NIFTY 09:15–09:30 candle
      const now = new Date();
      const nineThirty = new Date(now);
      nineThirty.setHours(9, 30, 1, 0);
      if (now < nineThirty) {
        await new Promise(resolve => setTimeout(resolve, nineThirty.getTime() - now.getTime()));
      }
      const candle = await fetchNiftyCandle(marketData.preparationDate);
      if (!candle) { setIsGapDownCalc(false); return; }

      // Step 2 — fresh watchlists from 15-minute spot candle
      const callEndStrike = roundToNearestStrike(candle.low * (1 - GAP_BUFFER), false);
      const putEndStrike  = roundToNearestStrike(candle.high * (1 + GAP_BUFFER), true);

      // Step 4 — generate 10-strike ranges OTM → ITM
      const callRange = ceTriggered
        ? generateStrikes(callEndStrike + (NUM_STRIKES() - 1) * STRIKE_INTERVAL(), callEndStrike, -STRIKE_INTERVAL()).map(s => s.strike)
        : [];
      const putRange = peTriggered
        ? generateStrikes(putEndStrike - (NUM_STRIKES() - 1) * STRIKE_INTERVAL(), putEndStrike, STRIKE_INTERVAL()).map(s => s.strike)
        : [];

      const minOI = MIN_OI();
      const minPF = MIN_PREMIUM_FACTOR();
      const buildTrade = async (type: 'CALL' | 'PUT', range: number[]) => {
        const optType = type === 'CALL' ? 'CE' : 'PE';
        const rows: GapDownStrikeRow[] = [];
        for (const expiry of expiriesToTry) {
          const chain = await fetchOptionChain(expiry, range, refDate);
          for (const strike of range) {
            const row = chain.find(r => r.strikePrice === strike);
            const side = optType === 'CE' ? row?.CE : row?.PE;
            const oi = side?.openInterest ?? 0;
            const ohlc = await fetchOptionOHLC(expiry, strike, optType, refDate);
            const premiumRef = ohlc?.twoDLL ?? 0;
            const minPrem = strike * minPF;
            const oiMet = oi > minOI;
            const premMet = premiumRef >= minPrem;
            const entryPrice = roundHalf(premiumRef * (1 - cfg.entryDiscount));
            const option15 = await fetchOptionCandle(expiry, strike, optType, marketData.preparationDate, 'FIFTEEN_MINUTE', '09:15', '09:30');
            const f3Met = !!option15 && option15.low >= entryPrice;
            rows.push({ strike, oi, premiumRef, minPrem, oiMet, premMet, f3Met, selected: false });

            if (ohlc && oiMet && premMet && f3Met) {
              const target = roundHalf(entryPrice * (1 - cfg.targetProfit));
              const msl = roundHalf(entryPrice * (1 + cfg.mslIncrease));
              const tsl = roundHalf(ohlc.twoDHH * (1 + cfg.tslIncrease));
              const stopLoss = roundHalf(Math.min(msl, tsl));
              return {
                expiry,
                rows: rows.map(r => r.strike === strike ? { ...r, selected: true } : r),
                selected: { strike, premiumRef },
                trade: {
                  type,
                  strike,
                  entryPrice,
                  target,
                  stopLoss,
                  msl,
                  tsl,
                  optionOHLC: ohlc,
                  contractType: expiry === expiriesToTry[0]?.toUpperCase() ? 'Current Week' : 'Next Week',
                  reason: `09:30 Recalc | 15m Low ≥ Entry`,
                  isValid: true,
                  strikeRange: range,
                } as TradeSignal,
              };
            }
          }
        }
        return {
          expiry: expiriesToTry[0]?.toUpperCase() || '',
          rows,
          selected: null,
          trade: {
            type,
            strike: 0,
            entryPrice: 0,
            target: 0,
            stopLoss: 0,
            msl: 0,
            tsl: 0,
            optionOHLC: null,
            contractType: 'Current Week',
            reason: `No valid strike found after 09:30 recalc`,
            isValid: false,
            strikeRange: range,
          } as TradeSignal,
        };
      };

      const [callResult, putResult] = await Promise.all([
        ceTriggered ? buildTrade('CALL', callRange) : Promise.resolve(null),
        peTriggered ? buildTrade('PUT', putRange) : Promise.resolve(null),
      ]);

      const calcTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

      // ── Telegram notification ──────────────────────────────────────────────
      const { telegramToken: tok2, telegramTargets } = appSettings;
      const targets2 = telegramTargets.filter(t => t.chatId.trim());
      if (tok2 && targets2.length) {
        const profile = getCfg();
        let msg = `🔔 <b>FiFTO Trading Secret</b>\n⚡ <b>${profile.name} — Recalculated Signals</b>\n⏰ ${calcTime}\n━━━━━━━━━━━━━━━━━━━━\n`;
        const callT = ceTriggered ? callResult?.trade ?? null : null;
        const putT  = peTriggered ? putResult?.trade ?? null : null;
        if (callT) {
          msg += callT.isValid
            ? `📉 <b>CE Recalc → ${callT.strike} CE · ${callResult?.expiry}</b>\n🎯 Entry ₹${callT.entryPrice.toFixed(1)} | Target ₹${callT.target.toFixed(1)} | SL ₹${callT.stopLoss.toFixed(1)}\n`
            : `📉 CE Recalc → No valid strike found\n`;
          msg += `\n`;
        }
        if (putT) {
          msg += putT.isValid
            ? `📈 <b>PE Recalc → ${putT.strike} PE · ${putResult?.expiry}</b>\n🎯 Entry ₹${putT.entryPrice.toFixed(1)} | Target ₹${putT.target.toFixed(1)} | SL ₹${putT.stopLoss.toFixed(1)}\n`
            : `📈 PE Recalc → No valid strike found\n`;
        }
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `📅 Prep: ${marketData?.preparationDate ?? ''} (${marketData?.preparationDay ?? ''})`;
        sendTelegramMsgToTargets(tok2, targets2, msg);
      }

      setGapDownData({
        candle: { ...candle, timestamp: String(candle.timestamp) },
        ceTriggered, peTriggered,
        ceBuffer: callEndStrike, peBuffer: putEndStrike,
        callEndStrike, putEndStrike,
        callRange, putRange,
        callRows: callResult?.rows ?? [],
        putRows:  putResult?.rows ?? [],
        callSelected: callResult?.selected ?? null,
        putSelected:  putResult?.selected ?? null,
        callTrade: callResult?.trade ?? null,
        putTrade:  putResult?.trade ?? null,
        callExpiry: callResult?.expiry ?? (callExpiryUsed || expiryUsed),
        putExpiry:  putResult?.expiry  ?? (putExpiryUsed || expiryUsed),
        calculatedAt: calcTime,
      });
    } finally {
      setIsGapDownCalc(false);
    }
  };

  const handleServerRecalc = async () => {
    setIsServerRecalc(true);
    try {
      await triggerServerRecalc();
      const [trades, eod] = await Promise.all([fetchTrades(), fetchEODStore()]);
      setPaperTrades(trades);
      setServerEOD(eod);
      if (eod) {
        const plannedCall = eod.recalculatedSignals?.callTrade?.isValid ? eod.recalculatedSignals.callTrade : eod.callTrade;
        const plannedPut  = eod.recalculatedSignals?.putTrade?.isValid  ? eod.recalculatedSignals.putTrade  : eod.putTrade;
        const plannedCallExpiry = eod.recalculatedSignals?.callTrade?.isValid ? eod.recalculatedSignals.callExpiry : eod.callExpiry;
        const plannedPutExpiry  = eod.recalculatedSignals?.putTrade?.isValid  ? eod.recalculatedSignals.putExpiry  : eod.putExpiry;
        const live = await fetchLiveLTPs(
          plannedCallExpiry, plannedCall?.strike ?? 0,
          plannedPutExpiry, plannedPut?.strike ?? 0,
        );
        setNextExecuteLTPs({
          ce: live.ceLTP > 0 ? live.ceLTP : null,
          pe: live.peLTP > 0 ? live.peLTP : null,
        });
      }
      pushToast('success', 'Recalculated', 'Preview updated. Telegram is waiting for manual send.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Recalculation failed';
      pushToast('warning', 'Recalc skipped', msg);
    } finally {
      setIsServerRecalc(false);
    }
  };

  const handleSendRecalcTelegram = async () => {
    setIsSendingRecalcTelegram(true);
    try {
      await sendServerRecalcTelegram();
      setServerEOD(await fetchEODStore());
      pushToast('success', 'Telegram sent', 'Recalculated signal message sent manually.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Telegram send failed';
      pushToast('warning', 'Telegram not sent', msg);
    } finally {
      setIsSendingRecalcTelegram(false);
    }
  };

  const handleSendTradeSignal = async (trade: TradeSignal, optType: string, expiry: string) => {
    const { telegramToken: tok, telegramTargets } = appSettings;
    const targets = telegramTargets.filter(t => t.chatId.trim());
    if (!tok || !targets.length) return;
    if (isSendingTg) return;
    setIsSendingTg(true);
    try {
      const active = paperTrades.find(p => p.optType === optType && isOpenPaperTrade(p));
      const tradeInfo = active
        ? `${active.status === 'TRIGGERED' ? '✅ Order Active' : '⏳ Pending Order'}: <b>${active.strike} ${optType}</b> · ${active.expiry}\n🎯 Entry: ₹${active.entryPrice.toFixed(1)} | Target: ₹${active.targetPrice.toFixed(1)} | SL: ₹${active.stopLoss.toFixed(1)}${active.runningPnl != null ? ` · P&L: ${active.runningPnl >= 0 ? '+' : ''}₹${active.runningPnl.toFixed(0)}` : ''}\nNo duplicate order will be placed.`
        : `Strike: <b>${trade.strike} ${optType}</b> · ${expiry}\n🎯 Entry: ₹${trade.entryPrice.toFixed(1)} | Target: ₹${trade.target.toFixed(1)} | SL: ₹${trade.stopLoss.toFixed(1)}`;
      const icon = optType === 'CE' ? '📈' : '📉';
      const msg =
`🔔 <b>FiFTO Trading Secret</b>
📊 <b>${getCfg().name} — ${optType} Signal</b>
━━━━━━━━━━━━━━━━━━━━
📅 Prep: ${marketData?.preparationDate} (${marketData?.preparationDay})
📆 EOD Data: ${marketData?.effectiveDataDate}
━━━━━━━━━━━━━━━━━━━━
${icon} ${optType === 'CE' ? 'CALL (CE)' : 'PUT (PE)'}
${tradeInfo}
━━━━━━━━━━━━━━━━━━━━
⏰ Execute at 09:25 AM IST`;
      const results = await sendTelegramMsgToTargets(tok, targets, msg);
      if (results.some(Boolean)) { setTgSent(true); setTimeout(() => setTgSent(false), 3000); }
    } finally { setIsSendingTg(false); }
  };

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header — sticky, always visible */}
      <header className="sticky top-0 z-30 text-white border-b border-green-900/60 shadow-lg"
        style={{background:'linear-gradient(90deg,#14532d 0%,#111827 60%,#000 100%)', backdropFilter:'blur(8px)'}}>
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5">
          <div className="flex items-center justify-between gap-2">
            {/* Brand */}
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-lg bg-white flex items-center justify-center shadow overflow-hidden shrink-0">
                <img src="/fifto-logo.png" alt="FiFTO" className="h-full w-full object-contain" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm sm:text-base font-black leading-tight truncate">FiFTO Trading Secret</h1>
                <p className="text-gray-400 mt-0.5" style={{fontSize:'9px',letterSpacing:'0.03em'}}>Your trusted partner in financial growth</p>
              </div>
            </div>
            {/* Centre: page tabs + settings gear */}
            <div className="flex items-center gap-0.5 sm:gap-1 bg-gray-800/60 rounded-lg p-0.5 border border-gray-700">
              {([
                { id: 'strategy', label: '📊', labelFull: 'Strategy' },
                { id: 'trades',   label: '📋', labelFull: 'Trades'   },
                { id: 'schedule', label: '📄', labelFull: 'Docs'     },
              ] as const).map(({ id, label, labelFull }) => (
                <button key={id} onClick={() => switchPage(id)}
                  className={cn(
                    'px-2 sm:px-2.5 py-1 rounded-md font-semibold transition-all flex flex-col items-center leading-tight',
                    activePage === id
                      ? 'bg-green-700 text-white shadow'
                      : 'text-gray-400 hover:text-white'
                  )}>
                  <span className="text-sm">{label}</span>
                  <span style={{fontSize:'9px'}} className="opacity-70 tracking-wide">{labelFull}</span>
                </button>
              ))}
              <div className="w-px h-4 bg-gray-700 mx-0.5" />
              <button onClick={() => pinUnlocked ? setShowSettings(true) : setShowPinModal(true)} title="Settings"
                className="flex items-center justify-center w-7 h-7 rounded-md text-gray-500 hover:text-white hover:bg-gray-700 transition-all">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </button>
            </div>

            {/* Right: prep date only */}
            {marketData?.preparationDate && (
              <div className="text-right hidden sm:block shrink-0">
                <p className="text-green-400 text-xs leading-tight">{marketData.preparationDay}</p>
                <p className="text-xs font-semibold text-white leading-tight">{formatDisplayDate(marketData.preparationDate)}</p>
              </div>
            )}
          </div>
        </div>
      </header>
      {showStrategyPinModal && <PinModal
        correctPin={appSettings.settingsPin}
        telegramToken={appSettings.telegramToken}
        telegramTargets={appSettings.telegramTargets}
        onClose={() => setShowStrategyPinModal(false)}
        onSuccess={() => { setStrategiesUnlocked(true); setShowStrategyPinModal(false); }}
      />}
      {showNextEditPinModal && <PinModal
        correctPin={appSettings.settingsPin}
        telegramToken={appSettings.telegramToken}
        telegramTargets={appSettings.telegramTargets}
        onClose={() => setShowNextEditPinModal(false)}
        onSuccess={() => { setNextEditUnlocked(true); setShowNextEditPinModal(false); setIsEditingNext(true); }}
      />}
      {showPinModal && <PinModal
        correctPin={appSettings.settingsPin}
        telegramToken={appSettings.telegramToken}
        telegramTargets={appSettings.telegramTargets}
        onClose={() => setShowPinModal(false)}
        onSuccess={() => { setPinUnlocked(true); setShowPinModal(false); setShowSettings(true); }}
      />}
      {showSettings && <SettingsModal initial={appSettings} onClose={() => setShowSettings(false)} onSave={(s) => { handleSaveSettings(s); setPinUnlocked(false); }} />}
      {showGapDown && <GapDownModal data={gapDownData} loading={isGapDownCalc} onClose={() => setShowGapDown(false)} />}

      {/* Trade Detail Modal */}
      {detailTrade && (() => {
        const t = detailTrade;
        const SM: Record<TradeStatus, { label: string; color: string; bg: string; border: string }> = {
          PENDING:    { label:'Pending',     color:'text-yellow-400', bg:'bg-yellow-900/20', border:'border-yellow-800' },
          TRIGGERED:  { label:'In Position', color:'text-blue-400',   bg:'bg-blue-900/20',   border:'border-blue-800'   },
          TARGET_HIT: { label:'Target Hit',  color:'text-green-400',  bg:'bg-green-900/20',  border:'border-green-800'  },
          SL_HIT:     { label:'SL Hit',      color:'text-red-400',    bg:'bg-red-900/20',    border:'border-red-800'    },
          EXPIRED:    { label:'Expired',     color:'text-gray-500',   bg:'bg-gray-800/20',   border:'border-gray-700'   },
          CANCELLED:  { label:'Cancelled',   color:'text-gray-500',   bg:'bg-gray-800/20',   border:'border-gray-700'   },
        };
        const m = SM[t.status];
        const isCall = t.optType === 'CE';
        const runPnl = t.runningPnl ?? 0;
        const fmt = (iso?: string) => iso ? new Date(iso).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false, timeZone:'Asia/Kolkata' }) : '—';
        const Row = ({ label, value, valueClass = 'text-white' }: { label: string; value: string; valueClass?: string }) => (
          <div className="flex items-center justify-between py-2 border-b border-gray-800/60">
            <span className="text-xs text-gray-500">{label}</span>
            <span className={cn('text-xs font-semibold', valueClass)}>{value}</span>
          </div>
        );
        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" style={{background:'rgba(0,0,0,0.80)', backdropFilter:'blur(6px)'}} onClick={() => setDetailTrade(null)}>
            <div className="w-full sm:max-w-md bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]" onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div className={cn('px-4 py-3 flex items-center justify-between', m.bg, 'border-b border-gray-700')}>
                <div className="flex items-center gap-2.5">
                  <span className={cn('px-2.5 py-0.5 rounded-full text-sm font-black text-white', isCall ? 'bg-green-600' : 'bg-red-600')}>{t.optType}</span>
                  <span className="text-white font-black text-2xl">{t.strike}</span>
                  <span className="text-gray-400 text-sm font-semibold">{t.expiry}</span>
                  <span className={cn('px-2 py-0.5 rounded-full text-xs font-bold border', m.color, m.border)}>{m.label}</span>
                </div>
                <button onClick={() => setDetailTrade(null)} className="text-gray-500 hover:text-white transition-colors p-1">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
              </div>

              {/* Running P&L banner — TRIGGERED only */}
              {t.status === 'TRIGGERED' && t.currentLTP !== undefined && (
                <div className={cn('px-4 py-3 flex items-center justify-between', runPnl >= 0 ? 'bg-green-950/40 border-b border-green-900/40' : 'bg-red-950/40 border-b border-red-900/40')}>
                  <div>
                    <p className="text-xs text-gray-500 mb-0.5">Live LTP</p>
                    <p className="text-2xl font-black text-white">₹{t.currentLTP.toFixed(1)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500 mb-0.5">Running P&L</p>
                    <p className={cn('text-2xl font-black', runPnl >= 0 ? 'text-green-400' : 'text-red-400')}>{runPnl >= 0 ? '+' : ''}₹{runPnl.toFixed(0)}</p>
                    <p className={cn('text-xs', runPnl >= 0 ? 'text-green-600' : 'text-red-600')}>{runPnl >= 0 ? '+' : ''}₹{(runPnl / t.lotSize).toFixed(1)} / unit</p>
                  </div>
                </div>
              )}

              {/* Body */}
              <div className="overflow-y-auto flex-1 px-4 py-2">

                {/* Price levels */}
                <p className="text-xs font-bold text-gray-600 uppercase tracking-widest mt-2 mb-1">Price Levels</p>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    { label:'Entry', val:`₹${t.entryPrice.toFixed(1)}`, cls:'text-white' },
                    { label:'Target', val:`₹${t.targetPrice.toFixed(1)}`, cls:'text-green-400' },
                    { label:'Stop Loss', val:`₹${t.stopLoss.toFixed(1)}`, cls:'text-red-400' },
                  ].map(s => (
                    <div key={s.label} className="rounded-xl bg-gray-800 border border-gray-700 px-2 py-2.5 text-center">
                      <p className="text-xs text-gray-500 mb-1">{s.label}</p>
                      <p className={cn('font-black text-base', s.cls)}>{s.val}</p>
                    </div>
                  ))}
                </div>

                {/* Details */}
                <p className="text-xs font-bold text-gray-600 uppercase tracking-widest mb-1">Details</p>
                <div className="rounded-xl bg-gray-800/50 border border-gray-700 px-3 divide-y divide-gray-800">
                  <Row label="Strategy" value={t.strategyName} />
                  <Row label="Type" value={`${t.type} · ${t.optType}`} valueClass={isCall ? 'text-green-400' : 'text-red-400'} />
                  <Row label="Lot Size" value={`1 Lot · ${t.lotSize} qty`} />
                  <Row label="Order Amount" value={`₹${(t.entryPrice * t.lotSize).toFixed(0)}`} />
                  {t.exitPrice && <Row label="Exit Amount" value={`₹${(t.exitPrice * t.lotSize).toFixed(0)}`} />}
                  {t.pnl !== undefined && <Row label="Realised P&L" value={`${t.pnl >= 0 ? '+' : ''}₹${t.pnl.toFixed(0)}`} valueClass={t.pnl >= 0 ? 'text-green-400' : 'text-red-400'} />}
                  {t.exitReason && <Row label="Exit Reason" value={{
                    'TARGET': '🎯 Target Hit',
                    'SL': '🛑 Stop Loss Hit',
                    'EXPIRY': '🔄 Weekly Rollover (03:00 PM)',
                    'NOT_TRIGGERED': '⏰ Did not trigger',
                  }[t.exitReason] || t.exitReason} valueClass={{
                    'TARGET': 'text-green-400',
                    'SL': 'text-red-400',
                    'EXPIRY': 'text-violet-400',
                    'NOT_TRIGGERED': 'text-gray-400',
                  }[t.exitReason] || 'text-gray-400'} />}
                  {((placedAt: string, exitAt?: string) => {
                    if (!exitAt) return null;
                    const start = new Date(placedAt).getTime();
                    const end = new Date(exitAt).getTime();
                    const days = Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)));
                    return <Row label="Days Held" value={`${days} day${days > 1 ? 's' : ''}`} valueClass="text-amber-400" />;
                  })(t.placedAt, t.exitAt)}
                  {t.signalSource && <Row label="Signal Source" value={{
                    'EOD': '📊 EOD Preparation',
                    'GAP_RECALC': '⚡ Gap Recalculation',
                    'MANUAL': '✋ Manually Added',
                  }[t.signalSource] || t.signalSource} valueClass="text-blue-400" />}
                  {t.recalcScenario && <Row label="Recalc Scenario" value={t.recalcScenario === 'GAP_DOWN' ? '📉 Gap-Down' : '📈 Gap-Up'} valueClass="text-amber-400" />}
                  {t.slNeedsRecalc && <Row label="SL Status" value="⚠️ Flagged for 09:30:01 recalc" valueClass="text-amber-400" />}
                  {t.carryToNextDay && <Row label="Carry" value="📅 Carried · Target:09:15 · SL:09:25" valueClass="text-amber-400" />}
                </div>

                {/* Timestamps */}
                <p className="text-xs font-bold text-gray-600 uppercase tracking-widest mt-3 mb-1">Timeline</p>
                <div className="rounded-xl bg-gray-800/50 border border-gray-700 px-3 divide-y divide-gray-800">
                  <Row label="Placed" value={fmt(t.placedAt)} />
                  <Row label="Date" value={t.date} />
                  {t.triggeredAt && <Row label="Triggered" value={`${fmt(t.triggeredAt)}  @  ₹${t.triggeredLTP?.toFixed(1) ?? '—'}`} valueClass="text-blue-400" />}
                  {t.exitAt && <Row label="Closed" value={`${fmt(t.exitAt)}  @  ₹${t.exitPrice?.toFixed(1) ?? '—'}`} valueClass={t.pnl !== undefined && t.pnl >= 0 ? 'text-green-400' : 'text-red-400'} />}
                </div>

                {/* Edit & Delete buttons in detail modal */}
                <div className="flex gap-2 mt-4 px-3 mb-2">
                  <button onClick={async (e) => {
                    e.stopPropagation(); setDetailTrade(null);
                    setEditingTradeId(t.id);
                    setEditForm({
                      strike: String(t.strike), expiry: t.expiry,
                      entryPrice: String(t.entryPrice), targetPrice: String(t.targetPrice),
                      stopLoss: String(t.stopLoss),
                    });
                  }}
                    className="flex-1 py-2.5 rounded-xl border border-green-700 text-green-400 bg-green-950/20 text-xs font-bold hover:bg-green-900/40 transition-all">
                    ✏️ Edit
                  </button>
                  <button onClick={async (e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete ${t.optType} ${t.strike} permanently?`)) {
                      const ok = await deleteTrade(t.id);
                      if (ok) { setDetailTrade(null); setPaperTrades(await fetchTrades()); }
                    }
                  }}
                    className="flex-1 py-2.5 rounded-xl border border-red-900/50 text-red-500 bg-red-950/20 text-xs font-bold hover:bg-red-900/40 transition-all flex items-center justify-center gap-2">
                    🗑️ Delete
                  </button>
                </div>

              </div>

              {/* Footer drag handle (mobile) */}
              <div className="sm:hidden flex justify-center py-2">
                <div className="w-10 h-1 rounded-full bg-gray-700" />
              </div>
            </div>
          </div>
        );
      })()}
      
      <main className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-5 space-y-3 sm:space-y-5">

        {/* ── Trades Page ── */}
        {activePage === 'trades' && (() => {
          const STATUS_META: Record<TradeStatus, { label: string; color: string; bg: string; border: string }> = {
            PENDING:    { label: 'Pending',    color: 'text-yellow-400', bg: 'bg-yellow-900/30',  border: 'border-yellow-800' },
            TRIGGERED:  { label: 'In Position',color: 'text-blue-400',   bg: 'bg-blue-900/30',    border: 'border-blue-800'   },
            TARGET_HIT: { label: 'Target Hit', color: 'text-green-400',  bg: 'bg-green-900/30',   border: 'border-green-800'  },
            SL_HIT:     { label: 'SL Hit',     color: 'text-red-400',    bg: 'bg-red-900/30',     border: 'border-red-800'    },
            EXPIRED:    { label: 'Expired',    color: 'text-gray-500',   bg: 'bg-gray-800/30',    border: 'border-gray-700'   },
            CANCELLED:  { label: 'Cancelled',  color: 'text-gray-500',   bg: 'bg-gray-800/30',    border: 'border-gray-700'   },
          };
          const open = paperTrades.filter(isOpenPaperTrade);
          const closed = paperTrades.filter(t => !isOpenPaperTrade(t));
          const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
          const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;

          const CANCEL_REASONS = ['Gap-Down','Gap-Up','Low OI','Low Volume','Manual Override','Wrong Strike','Market Condition','Other'];

          const TradeCard = ({ t, compact }: { t: PaperTrade; compact?: boolean }) => {
            const m = STATUS_META[t.status];
            const isCall = t.optType === 'CE';
            const orderAmt = (t.entryPrice * t.lotSize).toFixed(0);
            const isCanceling = cancelingId === t.id;
            const isOpen = t.status === 'PENDING' || t.status === 'TRIGGERED';

            const handleClick = () => {
              setDetailTrade(t);
            };

            const doCancel = async () => {
              if (!cancelReason.trim()) return;
              await cancelTrade(t.id, cancelReason.trim());
              setCancelingId(null); setCancelReason('');
              setPaperTrades(await fetchTrades());
            };

            return (
              <div className={cn('rounded-xl border overflow-hidden cursor-pointer hover:bg-gray-800/40 transition-all', m.border)} onClick={handleClick}>
                  <div className={cn('p-3', compact ? '' : 'space-y-2', m.bg)}>
                    {/* Header row */}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-black text-white', isCall ? 'bg-green-600' : 'bg-red-600')}>{t.optType}</span>
                        <span className="text-white font-black text-lg">{t.strike}</span>
                        <span className="text-gray-500 text-xs font-semibold">{t.expiry}</span>
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-bold border', m.color, m.border)}>{m.label}</span>
                        {t.carryToNextDay && <span className="text-xs text-amber-400 font-semibold">📅 Carry · Target 09:15 · SL 09:25</span>}
                        {t.exitReason === 'EXPIRY' && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-violet-900/50 border border-violet-700 text-violet-300">🔄 Rollover</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        {t.pnl !== undefined && (
                          <span className={cn('font-black text-sm', t.pnl >= 0 ? 'text-green-400' : 'text-red-400')}>
                            {t.pnl >= 0 ? '+' : ''}₹{t.pnl.toFixed(0)}
                          </span>
                        )}
                        {t.status === 'PENDING' && (
                          <button onClick={e => { e.stopPropagation(); setCancelingId(isCanceling ? null : t.id); setCancelReason(''); }}
                            className={cn('text-xs font-semibold border px-2.5 py-1 rounded-lg transition-all', isCanceling ? 'border-red-600 text-red-400 bg-red-950/30' : 'border-gray-700 text-gray-500 hover:border-red-700 hover:text-red-400')}>
                            {isCanceling ? '✕ Close' : 'Cancel Order'}
                          </button>
                        )}
                      </div>
                    </div>

                    {!compact && (<>
                  {(() => {
                    const ltp = t.currentLTP;
                    const profitAmt = (t.entryPrice - t.targetPrice) * t.lotSize;
                    const lossAmt   = (t.stopLoss - t.entryPrice)   * t.lotSize;
                    const remToTgt  = ltp != null ? (ltp - t.targetPrice)  : null; // points left to fall to target
                    const remToSL   = ltp != null ? (t.stopLoss - ltp)     : null; // points buffer before SL
                    return (
                      <div className="grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-lg bg-gray-800/60 px-2 py-1.5">
                          <p className="text-gray-500 mb-0.5">Entry</p>
                          <p className="font-black text-white">₹{t.entryPrice.toFixed(1)}</p>
                          {t.triggeredLTP && <p className="text-gray-600 text-xs">filled ₹{t.triggeredLTP.toFixed(1)}</p>}
                        </div>
                        <div className="rounded-lg bg-gray-800/60 px-2 py-1.5">
                          <p className="text-gray-500 mb-0.5">Target</p>
                          <p className="font-black text-green-400">₹{t.targetPrice.toFixed(1)}</p>
                          <p className="text-green-700" style={{fontSize:'9px'}}>+₹{profitAmt.toFixed(0)} profit</p>
                          {remToTgt != null && remToTgt > 0 && (
                            <p className="text-green-900 font-semibold" style={{fontSize:'9px'}}>↓ {remToTgt.toFixed(1)} pts · ₹{(remToTgt * t.lotSize).toFixed(0)} to go</p>
                          )}
                          {remToTgt != null && remToTgt <= 0 && (
                            <p className="text-green-400 font-bold" style={{fontSize:'9px'}}>✅ Target hit!</p>
                          )}
                        </div>
                        <div className="rounded-lg bg-gray-800/60 px-2 py-1.5">
                          <p className="text-gray-500 mb-0.5">SL</p>
                          <p className="font-black text-red-400">₹{t.stopLoss.toFixed(1)}</p>
                          <p className="text-red-900" style={{fontSize:'9px'}}>−₹{lossAmt.toFixed(0)} if hit</p>
                          {remToSL != null && remToSL > 0 && (
                            <p className="text-orange-900 font-semibold" style={{fontSize:'9px'}}>↑ {remToSL.toFixed(1)} pts buffer · ₹{(remToSL * t.lotSize).toFixed(0)}</p>
                          )}
                          {remToSL != null && remToSL <= 0 && (
                            <p className="text-red-400 font-bold" style={{fontSize:'9px'}}>🛑 SL triggered!</p>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Running P&L — TRIGGERED only */}
                  {t.status === 'TRIGGERED' && t.currentLTP !== undefined && (
                    <div className="rounded-lg border px-3 py-2 flex items-center justify-between gap-3 flex-wrap"
                      style={{ borderColor: (t.runningPnl ?? 0) >= 0 ? '#166534' : '#991b1b', background: (t.runningPnl ?? 0) >= 0 ? 'rgba(22,101,52,0.15)' : 'rgba(153,27,27,0.15)' }}>
                      <div className="flex items-center gap-3">
                        <div>
                          <p className="text-xs text-gray-500">Live LTP</p>
                          <p className="text-base font-black text-white">₹{t.currentLTP.toFixed(1)}</p>
                        </div>
                        <div className="text-gray-700">→</div>
                        <div>
                          <p className="text-xs text-gray-500">Running P&L</p>
                          <p className={cn('text-base font-black', (t.runningPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400')}>
                            {(t.runningPnl ?? 0) >= 0 ? '+' : ''}₹{(t.runningPnl ?? 0).toFixed(0)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-gray-600">per unit</p>
                        <p className={cn('text-xs font-semibold', (t.runningPnl ?? 0) >= 0 ? 'text-green-600' : 'text-red-600')}>
                          {(t.runningPnl ?? 0) >= 0 ? '+' : ''}₹{((t.runningPnl ?? 0) / t.lotSize).toFixed(1)}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* SL → Target progress bar — TRIGGERED only */}
                  {t.status === 'TRIGGERED' && t.currentLTP !== undefined && (() => {
                    const range = t.stopLoss - t.targetPrice;
                    const pct = ((t.stopLoss - t.currentLTP) / range) * 100;
                    const clamped = Math.min(100, Math.max(0, pct));
                    const color = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
                    return (
                      <div className="space-y-1">
                        <div className="relative h-2.5 rounded-full bg-gray-700 overflow-hidden">
                          <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${clamped}%` }} />
                        </div>
                        <div className="flex justify-between text-[10px] text-gray-500">
                          <span>SL ₹{t.stopLoss.toFixed(1)}</span>
                          <span className={cn('font-semibold', pct >= 100 ? 'text-green-400' : pct <= 0 ? 'text-red-400' : 'text-gray-300')}>
                            ₹{t.currentLTP.toFixed(1)} · {clamped.toFixed(0)}%
                          </span>
                          <span>Target ₹{t.targetPrice.toFixed(1)}</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Footer */}
                  <div className="flex items-center justify-between text-xs text-gray-500 flex-wrap gap-1">
                    <span>💼 1 Lot ({t.lotSize} qty) · ₹{orderAmt}</span>
                    {t.pnl !== undefined && <span className={cn('font-black text-sm', t.pnl >= 0 ? 'text-green-400' : 'text-red-400')}>{t.pnl >= 0 ? '+' : ''}₹{t.pnl.toFixed(0)}</span>}
                    {t.exitPrice && <span>Closed ₹{t.exitPrice.toFixed(1)} · ₹{(t.exitPrice * t.lotSize).toFixed(0)}{t.exitReason === 'EXPIRY' ? ' · Expiry 03:00 PM' : ''}</span>}
                    <span>{t.carryToNextDay ? 'Carried from previous day' : `Placed ${new Date(t.placedAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})} IST`}</span>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-2 pt-2">
                    {isOpen && (
                      <button onClick={e => {
                        e.stopPropagation();
                        if (editingTradeId !== t.id) {
                          setEditForm({ strike: String(t.strike), expiry: t.expiry, entryPrice: String(t.entryPrice), targetPrice: String(t.targetPrice), stopLoss: String(t.stopLoss) });
                        }
                        setEditingTradeId(editingTradeId === t.id ? null : t.id);
                      }}
                        className={cn('flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-all',
                          editingTradeId === t.id ? 'border-green-600 text-green-400 bg-green-950/30' : 'border-gray-600 text-gray-400 hover:border-green-700 hover:text-green-400')}>
                        {editingTradeId === t.id ? '✕ Close Edit' : '✏️ Edit'}
                      </button>
                    )}
                    <button onClick={async (e) => {
                      e.stopPropagation();
                      if (window.confirm(`Delete ${t.optType} ${t.strike} permanently?`)) {
                        const ok = await deleteTrade(t.id);
                        if (ok) setPaperTrades(await fetchTrades());
                      }
                    }}
                      className={cn('flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-all',
                        'border-red-900/50 text-red-500 hover:bg-red-900/30')}>
                      🗑️ Delete
                    </button>
                  </div>

                  {/* Inline Edit Form */}
                  {editingTradeId === t.id && isOpen && (
                    <div className="border-t border-gray-700 pt-3 mt-2 space-y-2" onClick={e => e.stopPropagation()}>
                      <p className="text-xs font-bold text-green-400">Edit {t.optType} {t.strike}</p>
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          { key: 'strike', label: 'Strike', val: String(t.strike), type: 'number' },
                          { key: 'expiry', label: 'Expiry', val: t.expiry, type: 'text' },
                          { key: 'entryPrice', label: 'Entry ₹', val: String(t.entryPrice), type: 'number', step: '0.5' },
                          { key: 'targetPrice', label: 'Target ₹', val: String(t.targetPrice), type: 'number', step: '0.5' },
                          { key: 'stopLoss', label: 'SL ₹', val: String(t.stopLoss), type: 'number', step: '0.5' },
                        ] as const).map(f => (
                          <div key={f.key} className="rounded-lg bg-gray-900 border border-gray-700 px-2.5 py-2 focus-within:border-green-700">
                            <p className="text-[10px] text-gray-500 mb-0.5">{f.label}</p>
                            <input type={f.type} step={(f as any).step} value={editForm[f.key] ?? f.val}
                              onChange={e => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                              className="w-full bg-transparent text-white text-xs outline-none font-mono" />
                          </div>
                        ))}
                      </div>
                      <button onClick={async () => {
                        const updates: Partial<PaperTrade> = {};
                        const strike = parseInt(editForm.strike);
                        if (!isNaN(strike)) updates.strike = strike;
                        updates.expiry = editForm.expiry.toUpperCase();
                        const ep = parseFloat(editForm.entryPrice);
                        if (!isNaN(ep)) updates.entryPrice = ep;
                        const tp = parseFloat(editForm.targetPrice);
                        if (!isNaN(tp)) updates.targetPrice = tp;
                        const sl = parseFloat(editForm.stopLoss);
                        if (!isNaN(sl)) updates.stopLoss = sl;
                        await updateTrade(t.id, updates);
                        setEditingTradeId(null);
                        setPaperTrades(await fetchTrades());
                      }}
                        className="w-full py-2 rounded-lg text-xs font-black text-white transition-all"
                        style={{background:'linear-gradient(135deg,#16a34a,#15803d)'}}>
                        Save Changes
                      </button>
                    </div>
                  )}
                </>)}
                </div>

                {/* Cancel reason panel */}
                {isCanceling && (
                  <div className="border-t border-red-900/50 bg-red-950/20 px-3 py-3 space-y-2" onClick={e => e.stopPropagation()}>
                    <p className="text-xs font-semibold text-red-300">Select cancellation reason:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {CANCEL_REASONS.map(r => (
                        <button key={r} onClick={() => setCancelReason(r)}
                          className={cn('text-xs px-2.5 py-1 rounded-lg border transition-all', cancelReason === r ? 'border-red-500 bg-red-900/50 text-red-200 font-semibold' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300')}>
                          {r}
                        </button>
                      ))}
                    </div>
                    <input value={cancelReason} onChange={e => setCancelReason(e.target.value)}
                      placeholder="Or type custom reason…"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-600" />
                    <div className="flex gap-2">
                      <button onClick={() => { setCancelingId(null); setCancelReason(''); }}
                        className="flex-1 py-1.5 rounded-lg text-xs text-gray-500 border border-gray-700 hover:text-gray-300 transition-all">
                        Keep Order
                      </button>
                      <button onClick={doCancel} disabled={!cancelReason.trim()}
                        className="flex-1 py-1.5 rounded-lg text-xs font-bold text-white bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                        Confirm Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          };

          return (
            <div className="space-y-4">
              {/* Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: 'Open', value: String(open.length), color: 'text-blue-400' },
                  { label: 'Running P&L', value: (() => { const r = open.filter(t=>t.status==='TRIGGERED').reduce((s,t)=>s+(t.runningPnl??0),0); return `${r>=0?'+':''}₹${r.toFixed(0)}`; })(), color: open.filter(t=>t.status==='TRIGGERED').reduce((s,t)=>s+(t.runningPnl??0),0)>=0?'text-green-400':'text-red-400' },
                  { label: 'Closed P&L', value: `${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(0)}`, color: totalPnl >= 0 ? 'text-green-400' : 'text-red-400' },
                  { label: 'Win Rate', value: closed.length ? `${wins}/${closed.length}` : '—', color: 'text-amber-400' },
                ].map(s => (
                  <div key={s.label} className="rounded-xl bg-gray-800/60 border border-gray-700 px-3 py-2.5 text-center">
                    <p className="text-xs text-gray-500 mb-0.5">{s.label}</p>
                    <p className={cn('text-xl font-black', s.color)}>{s.value}</p>
                  </div>
                ))}
              </div>

              {/* ── Next Execute Strike ── */}
              {serverEOD && (serverEOD.callTrade?.isValid || serverEOD.putTrade?.isValid) && (
                <div className="rounded-2xl border border-green-900/60 overflow-hidden" style={{background:'linear-gradient(135deg,#052e1620,#11182720)'}}>
                  <div className="px-4 py-3 bg-green-950/40 border-b border-green-900/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-base">🎯</span>
                      <h2 className="text-sm font-black text-white">Next Execute Strike</h2>
                      <span className="text-xs text-green-600">
                        {serverEOD.recalculatedSignals ? 'Recalculated from 09:30 candle' : 'Prepared · pending morning check'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => {
                          if (isEditingNext) {
                            // Save edit form values back to serverEOD
                            const nextEod = JSON.parse(JSON.stringify(serverEOD));
                            const ceS = parseInt(nextEditForm.ceStrike), peS = parseInt(nextEditForm.peStrike);
                            if (!isNaN(ceS)) { nextEod.callTrade.strike = ceS; if (!nextEod.callTrade.isValid && ceS > 0) nextEod.callTrade.isValid = true; }
                            if (!isNaN(peS)) { nextEod.putTrade.strike = peS; if (!nextEod.putTrade.isValid && peS > 0) nextEod.putTrade.isValid = true; }
                            if (nextEditForm.ceExpiry) nextEod.callExpiry = nextEditForm.ceExpiry.toUpperCase();
                            if (nextEditForm.peExpiry) nextEod.putExpiry = nextEditForm.peExpiry.toUpperCase();
                            const ceE = parseFloat(nextEditForm.ceEntry); if (!isNaN(ceE)) nextEod.callTrade.entryPrice = ceE;
                            const peE = parseFloat(nextEditForm.peEntry); if (!isNaN(peE)) nextEod.putTrade.entryPrice = peE;
                            const ceT = parseFloat(nextEditForm.ceTarget); if (!isNaN(ceT)) nextEod.callTrade.target = ceT;
                            const peT = parseFloat(nextEditForm.peTarget); if (!isNaN(peT)) nextEod.putTrade.target = peT;
                            const ceS2 = parseFloat(nextEditForm.ceSL); if (!isNaN(ceS2)) nextEod.callTrade.stopLoss = ceS2;
                            const peS2 = parseFloat(nextEditForm.peSL); if (!isNaN(peS2)) nextEod.putTrade.stopLoss = peS2;
                            setServerEOD(nextEod);
                            storeEOD(nextEod);
                            setIsEditingNext(false); setNextEditUnlocked(false); setNextEditForm({}); return;
                          }
                          if (nextEditUnlocked) {
                            // Initialize edit form from current serverEOD values
                            setNextEditForm({
                              ceStrike: String(serverEOD?.callTrade?.strike ?? ''),
                              peStrike: String(serverEOD?.putTrade?.strike ?? ''),
                              ceExpiry: serverEOD?.callExpiry ?? '',
                              peExpiry: serverEOD?.putExpiry ?? '',
                              ceEntry: String(serverEOD?.callTrade?.entryPrice ?? ''),
                              peEntry: String(serverEOD?.putTrade?.entryPrice ?? ''),
                              ceTarget: String(serverEOD?.callTrade?.target ?? ''),
                              peTarget: String(serverEOD?.putTrade?.target ?? ''),
                              ceSL: String(serverEOD?.callTrade?.stopLoss ?? ''),
                              peSL: String(serverEOD?.putTrade?.stopLoss ?? ''),
                            });
                            setIsEditingNext(true);
                          }
                          else { setShowNextEditPinModal(true); }
                        }}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-green-800 text-green-400 hover:bg-green-900/30 transition-all"
                      >
                        {isEditingNext ? '✕ Done' : '✏️ Edit'}
                      </button>
                      <button
                        onClick={handleServerRecalc}
                        disabled={isServerRecalc}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-amber-700 text-amber-300 hover:bg-amber-900/20 disabled:opacity-50 transition-all"
                        title="Recalculate using the 09:15-09:30 candle without using the current spot price for strike base"
                      >
                        {isServerRecalc ? <><span className="animate-spin">↻</span> Recalculating…</> : '⚡ Re-Calc'}
                      </button>
                      {/* Always-visible Send button — 9AM reminder format */}
                      {(() => {
                        const { telegramToken: tok, telegramTargets } = appSettings;
                        const hasTg = !!(tok && telegramTargets.some(t => t.chatId.trim()));
                        const handleNexSend = async () => {
                          if (!hasTg || isSendingNexTg) return;
                          setIsSendingNexTg(true);
                          try {
                            const r = await fetch(`${ANGEL}/angel/send-morning-reminder`, { method: 'POST' });
                            if (r.ok) { setNexTgSent(true); setTimeout(() => setNexTgSent(false), 3000); }
                            else {
                              const j = await r.json().catch(() => ({})) as { error?: string };
                              pushToast('danger', 'Telegram Failed', j?.error || 'Could not send');
                            }
                          } catch { pushToast('danger', 'Telegram Error', 'Network error'); }
                          finally { setIsSendingNexTg(false); }
                        };
                        return (
                          <button onClick={handleNexSend}
                            disabled={!hasTg || isSendingNexTg}
                            title={hasTg ? 'Send morning reminder to Telegram' : 'Configure Telegram in Settings first'}
                            className={cn(
                              'relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all overflow-hidden',
                              !hasTg
                                ? 'border-gray-700 bg-transparent text-gray-600 cursor-not-allowed opacity-50'
                                : nexTgSent
                                  ? 'border-blue-500 bg-blue-700/60 text-white scale-105 shadow-md shadow-blue-900/50'
                                  : isSendingNexTg
                                    ? 'border-blue-700 bg-blue-900/30 text-blue-300'
                                    : 'border-blue-800 text-blue-400 hover:bg-blue-900/30 hover:border-blue-600'
                            )}>
                            {isSendingNexTg && <span className="absolute inset-0 rounded-lg animate-ping bg-blue-600/20 pointer-events-none" />}
                            {nexTgSent ? (
                              <>
                                <svg className="w-3.5 h-3.5 animate-bounce-once" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                                <span>Sent!</span>
                              </>
                            ) : isSendingNexTg ? (
                              <>
                                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                                <span>Sending…</span>
                              </>
                            ) : (
                              <>
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.04 9.613c-.152.678-.554.843-1.12.524l-3.1-2.284-1.497 1.44c-.165.165-.304.304-.624.304l.223-3.162 5.76-5.203c.25-.223-.054-.347-.388-.124L7.15 14.066l-3.048-.951c-.662-.207-.675-.662.138-.98l11.91-4.593c.55-.2 1.032.134.852.706h-.44z"/>
                                </svg>
                                <span>Send</span>
                              </>
                            )}
                          </button>
                        );
                      })()}
                      {serverEOD.recalculatedSignals && (
                        <button
                          onClick={handleSendRecalcTelegram}
                          disabled={isSendingRecalcTelegram || !!serverEOD.recalcMeta?.telegramSentAt}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-blue-700 text-blue-300 hover:bg-blue-900/20 disabled:opacity-50 transition-all"
                          title="Send the reviewed recalculated signal to Telegram"
                        >
                          {serverEOD.recalcMeta?.telegramSentAt
                            ? '✓ Sent'
                            : isSendingRecalcTelegram
                              ? <><span className="animate-spin">↻</span> Sending…</>
                              : '⚡ Re-Calc Sent'}
                        </button>
                      )}
                      <div className="text-right">
                        <p className="text-xs font-black text-green-400">{serverEOD.prepDate}</p>
                        <p className="text-xs text-green-700">{serverEOD.prepDay} · Execute at <span className="text-green-400 font-bold">09:25 AM</span></p>
                      </div>
                    </div>
                  </div>
                  <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {([
                      { trade: serverEOD.callTrade, expiry: serverEOD.callExpiry, optType: 'CE', color: 'border-green-800 bg-green-950/20' },
                      { trade: serverEOD.putTrade,  expiry: serverEOD.putExpiry,  optType: 'PE', color: 'border-red-800   bg-red-950/20'   },
                    ] as const).map(({ trade, expiry, optType, color }) => {
                      const isCE = optType === 'CE';
                      const openTrade = (() => {
                        const candidates = open.filter(t => t.optType === optType);
                        if (!candidates.length) return null;
                        const score = (t: PaperTrade) => (t.status === 'TRIGGERED' ? 0 : 1);
                        return [...candidates].sort((a, b) => {
                          const sa = score(a), sb = score(b);
                          if (sa !== sb) return sa - sb;
                          const ta = Date.parse(a.triggeredAt ?? a.placedAt ?? '') || 0;
                          const tb = Date.parse(b.triggeredAt ?? b.placedAt ?? '') || 0;
                          return tb - ta; // newest first
                        })[0];
                      })();
                      // Show if open trade exists OR EOD has a valid plan
                      if (!trade?.isValid && !openTrade) return null;
                      const alreadyPlaced = !!openTrade;
                      const recalcPlan = optType === 'CE'
                        ? serverEOD.recalculatedSignals?.callTrade
                        : serverEOD.recalculatedSignals?.putTrade;
                      const recalcExpiry = optType === 'CE'
                        ? serverEOD.recalculatedSignals?.callExpiry
                        : serverEOD.recalculatedSignals?.putExpiry;
                      const plannedTrade = !alreadyPlaced && recalcPlan?.isValid ? recalcPlan : trade;
                      const plannedExpiry = !alreadyPlaced && recalcPlan?.isValid ? recalcExpiry : expiry;
                      // If open trade exists, show its actual values; otherwise show EOD planned values
                      const dispStrike  = alreadyPlaced ? openTrade!.strike                 : plannedTrade.strike;
                      const dispExpiry  = alreadyPlaced ? openTrade!.expiry                 : plannedExpiry;
                      const dispEntry   = alreadyPlaced ? openTrade!.entryPrice             : plannedTrade.entryPrice;
                      const dispTarget  = alreadyPlaced ? openTrade!.targetPrice            : ((plannedTrade as any).targetPrice ?? plannedTrade.target ?? 0);
                      const dispSL      = alreadyPlaced ? openTrade!.stopLoss               : plannedTrade.stopLoss;
                      const plannedLTP  = isCE ? nextExecuteLTPs.ce : nextExecuteLTPs.pe;
                      const dispLTP     = alreadyPlaced ? (openTrade!.currentLTP ?? plannedLTP) : plannedLTP;
                      const waitsForTrigger = !alreadyPlaced || openTrade!.status === 'PENDING';
                      const triggerGap = waitsForTrigger && dispLTP != null ? dispLTP - dispEntry : null;
                      const recalcScenario = alreadyPlaced
                        ? (openTrade!.recalcScenario ?? null)
                        : (recalcPlan?.isValid ? (optType === 'CE' ? 'GAP_DOWN' : 'GAP_UP') : null);
                      const isRecalc = !!recalcScenario;
                      const statusLabel = openTrade?.status === 'TRIGGERED' ? 'Triggered' : openTrade?.status === 'PENDING' ? 'Pending' : '';
                      const statusStyle = openTrade?.status === 'TRIGGERED'
                        ? { color:'#60a5fa', borderColor:'#2563eb', background:'rgba(37,99,235,0.15)' }
                        : { color:'#fbbf24', borderColor:'#b45309', background:'rgba(180,83,9,0.15)' };
                      return alreadyPlaced ? (
                        <TradeCard key={optType} t={openTrade!} />
                      ) : (
                        <div key={optType}
                          className={cn('rounded-xl border p-3 transition-all', color)}
                          style={alreadyPlaced ? { boxShadow: isCE ? '0 0 16px rgba(34,197,94,0.35), inset 0 0 12px rgba(34,197,94,0.08)' : '0 0 16px rgba(239,68,68,0.35), inset 0 0 12px rgba(239,68,68,0.08)' } : {}}>
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span className={cn('px-2 py-0.5 rounded-full text-xs font-black text-white', isCE ? 'bg-green-600' : 'bg-red-600')}>{optType}</span>
                            {isEditingNext && !alreadyPlaced ? (
                              <input type="text" inputMode="numeric" value={nextEditForm[isCE ? 'ceStrike' : 'peStrike'] ?? String(dispStrike ?? '')}
                                onChange={e => setNextEditForm(prev => ({ ...prev, [isCE ? 'ceStrike' : 'peStrike']: e.target.value }))}
                                className="bg-gray-900 text-white font-black text-xl w-24 px-1 rounded outline-none border border-gray-700 focus:border-green-600" />
                            ) : (
                              <span className="text-white font-black text-xl cursor-pointer hover:text-green-400 transition-colors"
                                onClick={() => navigator.clipboard.writeText(`${dispStrike} ${dispExpiry}`).then(() => pushToast('success', `📋 ${dispStrike} ${dispExpiry}`, 'Copied to clipboard')).catch(() => {})}
                                title="Click to copy strike + expiry">
                                {dispStrike}
                              </span>
                            )}
                            {isEditingNext && !alreadyPlaced ? (
                              <input type="text" value={nextEditForm[isCE ? 'ceExpiry' : 'peExpiry'] ?? dispExpiry}
                                onChange={e => setNextEditForm(prev => ({ ...prev, [isCE ? 'ceExpiry' : 'peExpiry']: e.target.value }))}
                                className="bg-gray-900 text-gray-400 text-xs w-20 px-1 rounded outline-none border border-gray-700 focus:border-green-600 font-mono" />
                            ) : (
                              <span className="text-gray-500 text-xs cursor-pointer hover:text-green-400 transition-colors"
                                onClick={() => navigator.clipboard.writeText(`${dispStrike} ${dispExpiry}`).then(() => pushToast('success', `📋 ${dispStrike} ${dispExpiry}`, 'Copied to clipboard')).catch(() => {})}
                                title="Click to copy strike + expiry">
                                {dispExpiry}
                              </span>
                            )}
                            {alreadyPlaced && (
                              <>
                                <span className="text-xs font-bold px-1.5 py-0.5 rounded-full border" style={isCE ? {color:'#4ade80',borderColor:'#16a34a',background:'rgba(22,163,74,0.15)'} : {color:'#f87171',borderColor:'#dc2626',background:'rgba(220,38,38,0.15)'}}>✓ Order Active</span>
                                <span className="text-xs font-bold px-1.5 py-0.5 rounded-full border" style={statusStyle}>{statusLabel}</span>
                              </>
                            )}
                            {isRecalc && (
                              <span className="text-xs font-bold px-1.5 py-0.5 rounded-full border border-amber-700 text-amber-400" style={{background:'rgba(180,83,9,0.15)'}}>
                                ⚡ {recalcScenario === 'GAP_DOWN' ? 'Gap-Down' : 'Gap-Up'} Recalc
                              </span>
                            )}
                            {dispLTP != null && (
                              <span className="text-xs font-semibold text-gray-400">LTP: <span className={dispLTP <= dispTarget ? 'text-green-400' : dispLTP >= dispSL ? 'text-red-400' : 'text-white'}>₹{dispLTP.toFixed(1)}</span></span>
                            )}
                          </div>
                          {isRecalc && (
                            <div className="mb-2 px-2 py-1 rounded-lg text-xs text-amber-600 border border-amber-900/50" style={{background:'rgba(120,53,15,0.12)'}}>
                              📋 EOD planned <span className="font-bold text-amber-500">{optType} {trade?.strike ?? dispStrike}</span> → recalculated to <span className="font-bold text-amber-300">{optType} {dispStrike}</span> after {recalcScenario === 'GAP_DOWN' ? 'Gap-Down' : 'Gap-Up'}
                            </div>
                          )}
                          <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
                            <div className="rounded bg-gray-800/50 py-1.5">
                              <p className="text-gray-500">Entry</p>
                              {isEditingNext && !alreadyPlaced ? (
                                <input type="text" inputMode="decimal" value={nextEditForm[isCE ? 'ceEntry' : 'peEntry'] ?? String(dispEntry ?? '')}
                                  onChange={e => setNextEditForm(prev => ({ ...prev, [isCE ? 'ceEntry' : 'peEntry']: e.target.value }))}
                                  className="w-full bg-transparent text-center font-black text-white outline-none" />
                              ) : <p className="font-black text-white">₹{dispEntry.toFixed(1)}</p>}
                            </div>
                            <div className="rounded bg-gray-800/50 py-1.5">
                              <p className="text-gray-500">Target</p>
                              {isEditingNext && !alreadyPlaced ? (
                                <input type="text" inputMode="decimal" value={nextEditForm[isCE ? 'ceTarget' : 'peTarget'] ?? String(dispTarget ?? '')}
                                  onChange={e => setNextEditForm(prev => ({ ...prev, [isCE ? 'ceTarget' : 'peTarget']: e.target.value }))}
                                  className="w-full bg-transparent text-center font-black text-green-400 outline-none" />
                              ) : <p className="font-black text-green-400">₹{dispTarget.toFixed(1)}</p>}
                            </div>
                            <div className="rounded bg-gray-800/50 py-1.5">
                              <p className="text-gray-500">SL</p>
                              {isEditingNext && !alreadyPlaced ? (
                                <input type="text" inputMode="decimal" value={nextEditForm[isCE ? 'ceSL' : 'peSL'] ?? String(dispSL ?? '')}
                                  onChange={e => setNextEditForm(prev => ({ ...prev, [isCE ? 'ceSL' : 'peSL']: e.target.value }))}
                                  className="w-full bg-transparent text-center font-black text-red-400 outline-none" />
                              ) : <p className="font-black text-red-400">₹{dispSL.toFixed(1)}</p>}
                            </div>
                          </div>
                          {waitsForTrigger && dispLTP != null && (
                            <div className="mt-2 rounded-lg border border-gray-800 bg-gray-950/30 px-2 py-1.5 text-center">
                              <p className="text-xs text-gray-500">Live LTP: <span className="font-black text-white">₹{dispLTP.toFixed(1)}</span></p>
                              {triggerGap != null && triggerGap > 0 ? (
                                <p className="text-xs font-semibold text-amber-400">↓ {triggerGap.toFixed(1)} pts to trigger sell order</p>
                              ) : (
                                <p className="text-xs font-bold text-green-400">Ready to trigger at entry</p>
                              )}
                            </div>
                          )}
                          <p className="text-xs text-gray-600 mt-1.5 text-center">
                            {serverEOD.recalculatedSignals
                              ? `09:30 candle recalc · ${serverEOD.strategyName}`
                              : `EOD: ${serverEOD.eodDate} · ${serverEOD.strategyName}`}
                          </p>
                          {!alreadyPlaced && (
                            <button onClick={async () => {
                              const cfg = getCfg();
                              const newTrade: PaperTrade = {
                                id: `next_exec_${Date.now()}_${optType}`,
                                date: new Date().toISOString().slice(0, 10),
                                type: isCE ? 'CALL' : 'PUT',
                                optType,
                                strike: dispStrike,
                                expiry: dispExpiry ?? '',
                                strategyName: serverEOD.strategyName || cfg.name,
                                lotSize: cfg.lotSize,
                                entryPrice: dispEntry,
                                targetPrice: dispTarget,
                                stopLoss: dispSL,
                                status: 'PENDING',
                                placedAt: new Date().toISOString(),
                                carryToNextDay: false,
                                signalSource: serverEOD.recalculatedSignals ? 'GAP_RECALC' : 'EOD',
                              };
                              await fetch('/angel/paper-trades', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(newTrade) });
                              setPaperTrades(await fetchTrades());
                              setServerEOD(await fetchEODStore());
                            }}
                              className="mt-2 w-full py-1.5 rounded-lg text-xs font-black text-white transition-all border bg-green-700 border-green-600 hover:bg-green-600 active:scale-[0.97]">
                              + Add {optType} {dispStrike} to Portfolio
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {}

              {/* History */}
              {(() => {
                const liveClosed = closed.filter(t => t.status !== 'EXPIRED');
                const expiredClosed = closed.filter(t => t.status === 'EXPIRED');
                const displayed = historyFilter === 'live' ? liveClosed : expiredClosed;
                if (closed.length === 0) return null;
                return (
                <div className="rounded-2xl border border-gray-700 overflow-hidden">
                  <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-base">📜</span>
                        <h2 className="text-sm font-black text-white">Trade History</h2>
                        <span className="text-xs text-gray-600">({closed.length} trades)</span>
                      </div>
                      <div className="flex rounded-lg border border-gray-700 overflow-hidden bg-gray-900">
                        <button onClick={() => setHistoryFilter('live')}
                          className={cn('px-3 py-1.5 text-xs font-semibold transition-all', historyFilter === 'live' ? 'bg-green-700 text-white' : 'text-gray-500 hover:text-gray-300')}>
                          Live ({liveClosed.length})
                        </button>
                        <button onClick={() => setHistoryFilter('expired')}
                          className={cn('px-3 py-1.5 text-xs font-semibold transition-all', historyFilter === 'expired' ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300')}>
                          Expired ({expiredClosed.length})
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="p-3 space-y-2 max-h-[400px] overflow-y-auto history-scroll">
                    {(() => {
                      const reversed = [...displayed].reverse();
                      const shown = reversed.slice(0, historyVisibleCount);
                      return shown.map(t => <TradeCard key={t.id} t={t} compact />);
                    })()}
                    {historyVisibleCount < displayed.length && <div ref={historySentinelRef} className="h-4" />}
                    {historyVisibleCount >= displayed.length && displayed.length > 10 && (
                      <p className="text-xs text-gray-600 text-center py-2">All {displayed.length} trades loaded</p>
                    )}
                  </div>
                </div>
                );
              })()}
            </div>
          );
        })()}

        {/* ── Document Page ── */}
        {activePage === 'schedule' && (
          <div className="space-y-4 max-w-3xl mx-auto pb-8">

            {/* ── Title ── */}
            <div className="rounded-2xl border border-green-900/50 overflow-hidden" style={{background:'linear-gradient(135deg,#052e16,#111827)'}}>
              <div className="px-5 py-4">
                <div className="flex items-center gap-3 mb-1">
                  <div className="h-9 w-9 rounded-lg bg-white flex items-center justify-center shadow overflow-hidden shrink-0">
                    <img src="/fifto-logo.png" alt="FiFTO" className="h-full w-full object-contain" />
                  </div>
                  <div>
                    <h1 className="text-lg font-black text-white">FiFTO Trading Secret</h1>
                    <p className="text-green-400 text-xs">NIFTY Options — Full Documentation</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-2">Automated Short Strangle on NIFTY Options — sells OTM Calls &amp; Puts based on 2-day price levels. Runs daily 08:45 AM to 15:30 PM IST.</p>
              </div>
            </div>

            {/* ── Pages Overview ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">📄 Pages Overview</h2>
              </div>
              <div className="divide-y divide-gray-800/60 text-xs text-gray-400">
                  {[
                    { icon:'📊', name:'Strategy', desc:'Main page. Select date → Run → get CE & PE trade signals with Entry/Target/SL. Shows OHLC data, strike range, morning check panel, gap-down recalc.' },
                    { icon:'📋', name:'Trades', desc:'Paper trade management. View open positions, running P&L, trade history. Add/cancel/delete trades. Next Execute Strike panel shows planned EOD trades.' },
                    { icon:'📄', name:'Docs', desc:'This page — complete system documentation covering schedule, strategy rules, shortcuts, and system info.' },
                  ].map(({ icon, name, desc }) => (
                  <div key={name} className="px-4 py-2.5 flex gap-3">
                    <span className="text-sm shrink-0">{icon}</span>
                    <div><span className="font-semibold text-gray-200">{name}</span><span className="text-gray-500"> — {desc}</span></div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Keyboard Shortcuts + Buttons ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">⌨️ Keyboard Shortcuts</h2>
              </div>
              <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {[
                  ['Esc', 'Close any open modal/popup'],
                  ['0-9 keys', 'Type PIN digits (on PIN modal)'],
                  ['Backspace', 'Delete last PIN digit'],
                  ['Enter', 'Submit PIN (when 4 digits entered)'],
                ].map(([key, desc]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="bg-gray-800 border border-gray-600 px-2 py-0.5 rounded font-mono text-white font-bold text-xs">{key}</span>
                    <span className="text-gray-400">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">🔘 Key Buttons Explained</h2>
              </div>
              <div className="divide-y divide-gray-800/60 text-xs text-gray-400">
                {[
                  { btn:'▶ Run', loc:'Strategy', desc:'Fetches NIFTY 2-day OHLC from Angel One → calculates strike ranges → searches expiry chains for valid strikes → shows Entry/Target/SL.' },
                  { btn:'↻ Refresh Date', loc:'Strategy', desc:'Fetches latest available EOD date from Angel One.' },
                  { btn:'✕ Reset', loc:'Strategy', desc:'Clears all calculated signals and restores default state.' },
                  { btn:'📨 Send', loc:'Strategy', desc:'Sends current trade signals to Telegram.' },
                  { btn:'Copy', loc:'Strategy', desc:'Copies CE+PE trade signals formatted for Telegram.' },
                  { btn:'+ Add CE/PE to Portfolio', loc:'Strategy', desc:'One-click add the calculated signal as a PENDING paper trade. Button greys out if already in portfolio.' },
                  { btn:'🔍 Check F3', loc:'Strategy', desc:'Morning check — fetches option 10-min low vs EOD entry price.' },
                  { btn:'⚡ Recalculate', loc:'Strategy', desc:'After F3 fails, recalculates new strikes using 09:30 candle.' },
                  { btn:'+ Add Position', loc:'Trades', desc:'Manually add a position (PIN needed). Fill strike, expiry, entry price, date.' },
                  { btn:'✏️ Edit', loc:'Trades', desc:'Edit EOD planned strike/expiry/entry/target/SL directly.' },
                  { btn:'Cancel Order', loc:'Trades', desc:'Cancel a PENDING paper trade with a reason.' },
                  { btn:'Delete Position', loc:'Trades', desc:'Permanently delete a trade from history.' },
                  { btn:'⚙️ Settings', loc:'Header', desc:'PIN-protected settings page. Configure strategy profiles, Telegram, PIN, poll interval.' },
                ].map(({ btn, loc, desc }) => (
                  <div key={btn} className="px-4 py-2 flex gap-3">
                    <div className="shrink-0 w-40"><span className="font-mono text-white font-semibold text-[11px]">{btn}</span><span className="text-gray-700 ml-1 text-[10px]">({loc})</span></div>
                    <span className="text-gray-500">{desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Strategy Profile ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">🎯 Strategy Profile</h2>
              </div>
              <div className="px-4 py-3 text-xs space-y-2 text-gray-400">
                <p>One active strategy profile (configurable from Strategy → Settings):</p>
                <div className="mt-2">
                  <div className="rounded-xl border bg-blue-900/20 border-blue-800 p-3">
                    <p className="text-xs font-black text-blue-400">NF · NIFTY Weekly</p>
                    <p className="text-gray-500 text-[10px] mt-1">Lot 65 · Int 50 · Min OI 500 contracts</p>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Daily Automated Schedule ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">🕐 Automated Daily Schedule <span className="text-gray-500 font-normal text-xs ml-1">All IST · Weekdays only</span></h2>
              </div>
              <div className="divide-y divide-gray-800/60">
                {([
                  { time:'Boot / Login', badge:'Server',  badgeColor:'bg-gray-700',        icon:'🖥️', color:'text-gray-300', rows:[
                    'Angel server (port 3001) + Vite (port 8008) start automatically',
                    'Loads cached instrument master & saved EOD signals from disk',
                    'LTP polling starts every 5s for open paper trades',
                  ]},
                  { time:'08:45 AM', badge:'Auto',    badgeColor:'bg-blue-700',         icon:'⚙️', color:'text-blue-300', rows:[
                    'Fetches NIFTY 2-day OHLC from Angel One historical API',
                    'Calculates 2DHH = max(D1H, D2H), 2DLL = min(D1L, D2L)',
                    'Applies ±0.15% buffer → strike boundaries → 10-strike range per leg',
                    'Fetches option chain → OI + Premium filter → selects first valid strike',
                    'Fetches selected option 2D OHLC → Entry/Target/SL (rounded ₹0.5)',
                    'Stores EOD signals for 09:00 AM reminder on disk (survives restart)',
                  ]},
                  { time:'09:00 AM', badge:'Telegram', badgeColor:'bg-green-700',        icon:'🔔', color:'text-green-300', rows:[
                    'Sends morning reminder with full EOD signals to Telegram',
                  ]},
                  { time:'09:25 AM', badge:'Auto 1',    badgeColor:'bg-yellow-700',       icon:'🔍', color:'text-yellow-300', rows:[
                    'Fetches option 10-min low (09:15-09:25 candle) for selected CE & PE',
                    'F1 = 10m low ≥ EOD Entry? Yes → safe, place order | No → F2 trigger',
                    'Safe legs → paper trade placed as PENDING immediately',
                    'Also: SL check for carried positions (10-min high vs current SL)',
                  ]},
                  { time:'09:30:01 AM', badge:'Auto 2', badgeColor:'bg-amber-700',        icon:'⚡', color:'text-amber-300', rows:[
                    'Only for legs where F1 failed at 09:25',
                    'Fetches NIFTY 09:15-09:30 15-min candle',
                    'F2 = option 15-min low ≥ EOD Entry? Yes → place at EOD entry | No → F3',
                    'If F2 also fails → run full gap-down recalc',
                  ]},
                  { time:'09:31 AM', badge:'Auto 3', badgeColor:'bg-red-700',        icon:'🔄', color:'text-red-300', rows:[
                    'Gap-down recalc for legs failing F1+F2',
                    'NIFTY 15-min candle → new buffer → new strike range',
                    'Fetches live OI+LTP → selects first valid strike → Entry/Target/SL',
                    'Also: SL recalc for flagged carried positions (15-min high × 1.10)',
                  ]},
                  { time:'Every 5s', badge:'Poll',  badgeColor:'bg-purple-700',       icon:'🔄', color:'text-purple-300', rows:[
                    'Server polls live LTP for all PENDING + TRIGGERED paper trades',
                    'PENDING: LTP ≤ Entry → status changes to TRIGGERED (Telegram alert)',
                    'TRIGGERED: LTP ≤ Target → TARGET_HIT | LTP ≥ SL → SL_HIT (Telegram alert)',
                    'Carried trades: Target check from 09:15, SL check from 09:25 next day',
                  ]},
                  { time:'03:00 PM', badge:'Rollover', badgeColor:'bg-violet-700',       icon:'🔄', color:'text-violet-300', rows:[
                    '0DTE expiry close — any TRIGGERED trade expiring today is closed',
                    'Fetches live LTP → calculates P&L → marks as Weekly Rollover',
                    'Next day setup runs normally from 08:45 AM',
                  ]},
                  { time:'15:30 PM', badge:'EOD',     badgeColor:'bg-gray-600',         icon:'🌙', color:'text-gray-300', rows:[
                    'PENDING orders → EXPIRED (did not trigger today)',
                    'TRIGGERED positions → marked carryToNextDay = true',
                    'Next day: Target active from 09:15, SL active from 09:25',
                    'Telegram EOD summary sent',
                  ]},
                ] as const).map(({ time, badge, badgeColor, icon, color, rows }) => (
                  <div key={time} className="px-4 py-3 flex gap-3">
                    <div className="shrink-0 w-24 pt-0.5">
                      <p className={cn('text-xs font-black leading-tight', color)}>{time}</p>
                      <span className={cn('inline-block mt-1 text-xs font-semibold px-1.5 py-0 rounded text-white', badgeColor)}>{badge}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-1.5">
                        <span className="text-sm shrink-0">{icon}</span>
                        <ul className="space-y-0.5">
                          {rows.map((r, i) => <li key={i} className="text-xs text-gray-400 leading-relaxed">{r}</li>)}
                        </ul>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Strike Selection ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">📐 Strike Selection Logic</h2>
              </div>
              <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                {[
                  ['2DHH / 2DLL', 'max(D1H, D2H) / min(D1L, D2L) — 2 day high & low'],
                  ['Strike Factor', '±0.15% buffer applied to 2DHH/2DLL'],
                  ['CALL end strike', 'roundDown(2DLL × 0.9985, to nearest 50)'],
                  ['PUT end strike', 'roundUp(2DHH × 1.0015, to nearest 50)'],
                  ['CALL range', '10 strikes descending: OTM (high) → ITM (low)'],
                  ['PUT range', '10 strikes ascending: OTM (low) → ITM (high)'],
                  ['OI filter', 'Open Interest ≥ 500 contracts × 65 lot = 32,500 (0 = skip check)'],
                  ['Premium filter', '2D Low ≥ 0.85% of strike price'],
                  ['Selection', 'First strike from OTM side passing BOTH filters'],
                  ['Expiry search', 'Tries up to 5 weekly expiries. Mon/Tue start from next week'],
                  ['Entry', 'option 2DLL × (1 − 10%), rounded ₹0.5'],
                  ['Target', 'Entry × (1 − 75%) = 25% of entry price, rounded ₹0.5'],
                  ['MSL', 'Entry × (1 + 75%) = 1.75× entry — max stop loss'],
                  ['TSL', '2DHH × (1 + 10%) = 1.10× 2-day high — trailing SL'],
                  ['Stop Loss', 'min(MSL, TSL) — the tighter of the two'],
                ].map(([label, val]) => (
                  <div key={label} className="flex gap-2 py-1 border-b border-gray-800/40">
                    <span className="text-gray-600 shrink-0 w-24">{label}</span>
                    <span className="text-gray-300 font-mono text-[11px]">{val}</span>
                  </div>
                ))}
              </div>
            </div>




            {/* ── Paper Trade Lifecycle ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">📋 Paper Trade Lifecycle</h2>
              </div>
              <div className="px-4 py-3 space-y-2 text-xs text-gray-400">
                <div className="flex items-center gap-2 text-yellow-400"><span className="font-black">PENDING</span><span className="text-gray-500">→</span><span className="text-gray-400">Sell limit placed. Waiting for LTP to reach entry price.</span></div>
                <div className="flex items-center gap-2 text-blue-400"><span className="font-black">TRIGGERED</span><span className="text-gray-500">→</span><span className="text-gray-400">Entry filled. Monitoring Target & SL every 5 seconds. Running P&L shown live.</span></div>
                <div className="flex items-center gap-2 text-green-400"><span className="font-black">TARGET_HIT</span><span className="text-gray-500">→</span><span className="text-gray-400">LTP ≤ Target. Profit booked. P&L = (Entry − Exit) × Lot size.</span></div>
                <div className="flex items-center gap-2 text-red-400"><span className="font-black">SL_HIT</span><span className="text-gray-500">→</span><span className="text-gray-400">LTP ≥ Stop Loss. Loss booked. P&L = (Entry − Exit) × Lot size.</span></div>
                <div className="flex items-center gap-2 text-gray-500"><span className="font-black">EXPIRED</span><span className="text-gray-500">→</span><span className="text-gray-400">PENDING order not triggered by 15:30. Discarded.</span></div>
                <div className="flex items-center gap-2 text-gray-500"><span className="font-black">CANCELLED</span><span className="text-gray-500">→</span><span className="text-gray-400">Manually cancelled by user from Trades page.</span></div>
                <div className="pt-3 border-t border-gray-800 mt-3 space-y-1">
                  <p className="font-semibold text-gray-300">Multi-Day Carry:</p>
                  <p>• TRIGGERED at 15:30 → marked carryToNextDay. Target active from 09:15, SL from 09:25 next day.</p>
                  <p>• SL adjusted at 09:25 using 10-min candle. If 10m high ≥ SL → recalc SL from 15-min candle at 09:30:01.</p>
                  <p>• CE holding → skip CE next day (calc PE only). PE holding → skip PE. Both holding → no new trade.</p>
                </div>
              </div>
            </div>


            {/* ── Settings Explained ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">⚙️ Settings Explained</h2>
              </div>
              <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                {[
                  ['Lot Size', 'Contract multiplier (NIFTY=65). Affects OI filter & P&L.'],
                  ['Min OI Contracts', 'Minimum OI in contracts. Effective = lots × contracts.'],
                  ['Strike Factor', 'Buffer % from 2DHH/2DLL for strike boundary (default 0.15%).'],
                  ['Min Premium Factor', 'Option 2D Low must be ≥ this % of strike (default 0.85%).'],
                  ['Strike Interval', 'Spacing between strikes (NIFTY=50).'],
                  ['Num Strikes', 'How many strikes to scan per leg (default 10).'],
                  ['Max Expiry Tries', 'How many weekly expiries to search (default 5).'],
                  ['Entry Discount', 'Entry = 2DLL × (1 − X%) (default 10%).'],
                  ['Target Profit', 'Target = Entry × (1 − X%). 75% → exit at 25% of entry.'],
                  ['MSL Increase', 'MSL = Entry × (1 + X%). 75% → 1.75× entry.'],
                  ['TSL Increase', 'TSL = 2DHH × (1 + X%). 10% → 1.10× 2DHH.'],
                  ['Settings PIN', '4-digit PIN to protect settings access. Send via Telegram if forgotten.'],
                  ['LTP Poll Interval', 'Seconds between live LTP refreshes for open trades (min 5).'],
                  ['Telegram Bot Token', 'From @BotFather. Required for notifications.'],
                  ['Telegram Chat ID', 'Group/user ID from @userinfobot. Supports multiple groups.'],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-2 py-1 border-b border-gray-800/40">
                    <span className="text-gray-600 shrink-0 w-24">{label}</span>
                    <span className="text-gray-400">{desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Auto-Start Setup (shared) ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">🚀 Auto-Start on PC Boot</h2>
              </div>
              <div className="px-4 py-3 text-xs text-gray-400 space-y-2">
                <p>Two redundant methods ensure servers start automatically:</p>
                <div className="flex gap-2"><span className="text-green-400 font-semibold shrink-0">1. Startup Folder</span><span><code className="text-white font-mono text-[11px]">%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\FiFTO Servers.bat</code></span></div>
                <div className="flex gap-2"><span className="text-amber-400 font-semibold shrink-0">2. Registry Run</span><span><code className="text-white font-mono text-[11px]">HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\FiFTO Servers</code></span></div>
                <p className="text-gray-600">The batch file runs <code className="text-gray-400">node.exe angel-server.mjs</code> (port 3001) and <code className="text-gray-400">node.exe vite</code> (port 8008) in separate minimized windows.</p>
              </div>
            </div>

            {/* ── System Info (shared) ── */}
            <div className="rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {[
                ['🖥️ Frontend', 'http://localhost:8008'],
                ['⚙️ Angel API', 'http://127.0.0.1:3001'],
                ['📁 Cache', './server-cache/'],
                ['📋 Trades', './server-cache/paper-trades.json'],
                ['💾 EOD Store', './server-cache/eod_store.json'],
                ['🔑 Config', './angel-config.json'],
                ['📦 GitHub', 'https://github.com/maniraja5599/FiFTO-WOP-NIFTY-TS'],
                ['🚀 Auto-start', 'Startup Folder + Registry Run'],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-gray-600 shrink-0 w-24">{k}</span>
                  <span className="text-white font-mono text-[11px]">{v}</span>
                </div>
              ))}
            </div>

            {/* ── Backtest Documentation ── */}
            <div className="rounded-2xl border border-blue-800/50 overflow-hidden" style={{background:'linear-gradient(135deg,#0c1a2e,#111827)'}}>
              <div className="px-4 py-3 bg-blue-900/30 border-b border-blue-800/50 flex items-center justify-between gap-2">
                <h2 className="text-sm font-black text-white flex items-center gap-2">
                  <span>🧪</span> Backtest Documentation
                </h2>
                <a href="/FiFTO_Trading_Secret_Strategy.md" download
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-blue-600 text-blue-300 hover:bg-blue-800/50 hover:text-blue-200 transition-all">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                  Download .md
                </a>
              </div>
              <div className="px-4 py-3 text-xs text-gray-400 space-y-2">
                <p>Complete FiFTO Trading Secret strategy documentation with full formulas, code examples, and data structures — ready to give to an AI for backtesting.</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">📊 Strike Selection</span>
                  <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">🎯 Entry/Target/SL</span>
                  <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">🔍 F3 Morning Check</span>
                  <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">⚡ Gap Recalc</span>
                  <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">📈 P&amp;L Simulation</span>
                  <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">📝 Full Code Examples</span>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* ── Strategy Page ── */}
        {activePage === 'strategy' && <>

        {/* ── Setup Card ── */}
        <Card title="⚡ Strategy Setup" badge={{
          label: activeProfile.name,
          color: INSTRUMENT_COLOR[activeProfile.instrument].accent,
          bg: 'border-blue-700 bg-blue-900/30',
        }} right={
          <div className="flex items-center gap-2">
            <button onClick={() => {
              const el = document.getElementById('calc-history');
              if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth' }); }
            }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-gray-400 border border-gray-700 hover:border-blue-500 hover:text-blue-400 transition-all">
              📐 History
            </button>
            {isCalculated && (
              <button onClick={() => {
                localStorage.removeItem('fifto_run_v1');
                setResult(null); setIsCalculated(false); setMarketData(null);
                setLtpFetchStatus('idle'); setExpiryUsed(''); setCallExpiryUsed(''); setPutExpiryUsed('');
                setMorningCheck(null); setGapDownData(null); setFetchError(null);
              }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-gray-500 border border-gray-700 hover:border-red-700 hover:text-red-400 transition-all">
                ✕ Reset
              </button>
            )}
          </div>
        }>
          <div className="space-y-3">

            {/* ── Strategy Selector ── */}
            <div className="flex flex-wrap gap-1.5">
              {appSettings.profiles.map(p => {
                const c = INSTRUMENT_COLOR[p.instrument];
                const isActive = p.id === appSettings.activeId;
                const enabled = true;
                return (
                  <button key={p.id}
                    onClick={() => {
                      const updated = { ...appSettings, activeId: p.id };
                      _appSettings = updated;
                      setAppSettings(updated);
                      saveSettings(updated);
                      setResult(null);
                      setIsCalculated(false);
                    }}
                    title={p.name}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all',
                      isActive
                        ? `${c.border} bg-gray-800 ${c.accent}`
                        : 'border-gray-700 bg-gray-800/40 text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                    )}>
                    <span className={cn('text-xs font-black px-1 py-0 rounded text-white', c.pill)}>
                      {p.instrument === 'BANKNIFTY' ? 'BNF' : 'NF'}
                    </span>
                    {p.expiry === 'WEEKLY' ? 'Weekly' : 'Monthly'}
                    <span className="font-normal opacity-50">·</span>
                    <span className={isActive ? 'text-gray-400' : 'text-gray-600'}>L:{p.lotSize}</span>
                  </button>
                );
              })}
            </div>

            {/* Date input + run */}
            <div className="flex items-center gap-2">
              {/* Date picker */}
              <div className="flex items-center gap-2 rounded-xl px-3 py-2 flex-1" style={{background:'#1f2937', border:'1px solid #374151'}}>
                <span className="text-gray-500 text-sm">📅</span>
                <input type="date" value={nextTradingDate}
                  max={localToday()}
                  onChange={e => setNextTradingDate(e.target.value)}
                  className="bg-transparent text-white text-sm outline-none flex-1" />
                {nextTradingDate && (
                  <span className="text-xs text-green-500 font-semibold shrink-0">
                    {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(nextTradingDate).getDay()]}
                  </span>
                )}
              </div>

              {/* Run button */}
              <button onClick={handleRun} disabled={isFetching || isFetchingLTPs || !nextTradingDate || (nextTradingDate === localToday() && !isMarketClosed())}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-black transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white shrink-0"
                style={{background:(isFetching||isFetchingLTPs) ? '#1f2937' : 'linear-gradient(135deg,#16a34a,#15803d)', boxShadow:(isFetching||isFetchingLTPs)?'none':'0 0 14px rgba(22,163,74,0.4)'}}>
                {isFetching ? <><span className="animate-spin inline-block">↻</span> Fetching…</> : isFetchingLTPs ? <><span className="animate-spin inline-block">↻</span> Loading…</> : <>▶ Run</>}
              </button>
            </div>

            {/* Warning: today selected but market not yet closed — data not final */}
            {nextTradingDate === localToday() && !isMarketClosed() && (
              <div className="bg-yellow-950 border border-yellow-800 rounded-lg p-2.5 text-yellow-400 text-xs mt-1">
                ⏳ Market closes at 3:30 PM IST. Today's data is final after 3:45 PM. Run again after 3:45 PM for today's EOD calculation.
              </div>
            )}

            {/* Info: today selected, market closed — using today's EOD data */}
            {nextTradingDate === localToday() && isMarketClosed() && (
              <div className="bg-green-950 border border-green-800 rounded-lg p-2.5 text-green-400 text-xs mt-1">
                ✅ Market closed — using today's EOD data for preparation.
              </div>
            )}

            {/* Error */}
            {fetchError && <div className="bg-red-950 border border-red-800 rounded-lg p-2.5 text-red-400 text-xs">⚠️ {fetchError}</div>}

            {/* Trade Setup Confirmation — compact single row */}
            {marketData?.fetched && (() => {
              const isNextWk = marketData.preparationDay === 'Monday' || marketData.preparationDay === 'Tuesday';
              const contractLabel = isNextWk ? 'Next Week' : 'Current Week';
              const contractColor = isNextWk ? 'bg-amber-900/50 text-amber-300' : 'bg-purple-900/50 text-purple-300';
              return (
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl text-xs" style={{background:'#161b22', border:'1px solid #30363d'}}>
                  <span className={cn('text-xs font-black px-1.5 py-0.5 rounded text-white', INSTRUMENT_COLOR[activeProfile.instrument].pill)}>
                    {activeProfile.instrument}
                  </span>
                  <span className="h-3 w-px bg-gray-700 shrink-0" />
                  <span className="text-gray-500">EOD</span>
                  <span className="font-bold text-white">{formatDisplayDate(marketData.effectiveDataDate)}</span>
                  <span className="text-gray-600">{getDayName(marketData.effectiveDataDate ?? '').slice(0,3)}</span>
                  {marketData.marketWasOpen && <span className="text-orange-400 font-semibold">· Live</span>}
                  {marketData.source && <span className="text-blue-400 font-semibold">· {marketData.source}</span>}
                  {marketData.warnings?.length ? <span className="text-amber-400 font-semibold" title={marketData.warnings.join('\n')}>· Checked</span> : null}
                  <span className="h-3 w-px bg-gray-700 shrink-0" />
                  <span className="text-gray-500">Prep</span>
                  <span className="font-bold text-green-400">{formatDisplayDate(marketData.preparationDate)}</span>
                  <span className="text-green-600">{marketData.preparationDay?.slice(0,3)}</span>
                  <span className="h-3 w-px bg-gray-700 shrink-0" />
                  <span className={`font-bold px-2 py-0.5 rounded-full text-xs ${contractColor}`}>
                    {contractLabel}
                  </span>
                </div>
              );
            })()}

            {/* OHLC strip — editable after data loaded */}
            {marketData?.fetched && (
              <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { field: 'day1High' as const, label: 'PDH',     date: marketData.day1Date, color: 'text-green-400',  border: 'focus-within:border-green-700' },
                    { field: 'day1Low'  as const, label: 'PDL',     date: marketData.day1Date, color: 'text-red-400',    border: 'focus-within:border-red-700'   },
                    { field: 'day2High' as const, label: 'D-2 High',date: marketData.day2Date, color: 'text-green-500',  border: 'focus-within:border-green-800' },
                    { field: 'day2Low'  as const, label: 'D-2 Low', date: marketData.day2Date, color: 'text-red-500',    border: 'focus-within:border-red-800'   },
                  ]).map(({ field, label, date, color, border }) => (
                    <div key={field} className={cn('bg-gray-800 rounded-lg px-2 py-1.5 flex items-center justify-between border border-gray-700 transition-all', border)}>
                      <div className="shrink-0">
                        <p className={cn('text-xs font-bold leading-tight', color)}>{label}</p>
                        <p className="text-gray-600 leading-tight" style={{fontSize:'9px'}}>{formatDisplayDate(date)}</p>
                      </div>
                      <input
                        type="number" step="0.05" min="0"
                        value={marketData[field]}
                        onChange={e => {
                          const v = parseFloat(e.target.value) || 0;
                          setMarketData(prev => prev ? { ...prev, [field]: v } : null);
                        }}
                        className="w-20 sm:w-28 text-right bg-transparent text-white font-bold text-sm outline-none font-mono"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-700 text-center">Run fetches fresh data each time</p>
              </div>
            )}
          </div>
        </Card>

        {/* ── HERO: Trade Signals at top ────────────────────────────────────── */}
        {isCalculated && result && (
          <>
            {/* Loading overlay while fetching options */}
            {isFetchingLTPs && (
              <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 flex items-center gap-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500 shrink-0"></div>
                <div>
                  <p className="text-white font-semibold">Fetching option data…</p>
                  <p className="text-gray-400 text-sm">{expirySearchStatus || 'Fetching live OI + 2D Low prices from Angel One…'}</p>
                </div>
              </div>
            )}

            {/* Trade Signals — hero section */}
            {!isFetchingLTPs && (
              <div className="bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden">
                {/* Header bar */}
                <div className="px-3 sm:px-5 py-2.5 sm:py-3 bg-gray-800 border-b border-gray-700 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                    <span className="text-base shrink-0">🚀</span>
                    <span className="font-bold text-white text-sm sm:text-base truncate">Trade Execution Signals</span>
                    {expiryUsed && <span className="hidden sm:inline text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded-full font-semibold shrink-0">{expiryUsed}</span>}
                    {marketData?.preparationDate && (
                      <span className="hidden sm:flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-900/40 border border-green-800/50 text-green-300 shrink-0">
                        <span className="text-green-600">Prep</span>
                        <span className="font-semibold">{formatDisplayDate(marketData.preparationDate)}</span>
                        <span className="text-green-600">{marketData.preparationDay?.slice(0,3)}</span>
                      </span>
                    )}
                    {marketData?.day1Date && (
                      <span className="hidden sm:flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-700/50 border border-gray-700 text-gray-400 shrink-0">
                        <span className="text-gray-600">EOD</span>
                        <span>{formatDisplayDate(marketData.day2Date)}</span>
                        <span className="text-gray-600">&</span>
                        <span>{formatDisplayDate(marketData.day1Date)}</span>
                      </span>
                    )}
                  </div>
                  {/* Action buttons — Telegram + Copy */}
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Telegram Send — always visible, disabled if not configured */}
                    {(result.callTrade?.isValid || result.putTrade?.isValid) && (() => {
                      const { telegramToken: tok, telegramTargets } = appSettings;
                      const targets = telegramTargets.filter(t => t.chatId.trim());
                      const hasTg = !!(tok && targets.length);
                      const handleTgSend = async () => {
                        if (!hasTg || isSendingTg) return;
                        setIsSendingTg(true);
                        try {
                          const ce = result.callTrade;
                          const pe = result.putTrade;
                          const ceExp = callExpiryUsed || expiryUsed;
                          const peExp = putExpiryUsed  || expiryUsed;
                          const prof = getCfg();
                          const fmtT = (t: typeof ce, exp: string, optType: 'CE' | 'PE') => {
                            const active = paperTrades.find(p => p.optType === optType && isOpenPaperTrade(p));
                            if (active) {
                              const status = active.status === 'TRIGGERED' ? '✅ Order Active' : '⏳ Pending Order';
                              const pnl = active.runningPnl != null ? ` · P&L: ${active.runningPnl >= 0 ? '+' : ''}₹${active.runningPnl.toFixed(0)}` : '';
                              return `${status}: <b>${active.strike} ${active.optType}</b> · ${active.expiry}\n🎯 Entry: ₹${active.entryPrice.toFixed(1)} | Target: ₹${active.targetPrice.toFixed(1)} | SL: ₹${active.stopLoss.toFixed(1)}${pnl}\nNo duplicate order will be placed.`;
                            }
                            return t?.isValid
                              ? `Strike: <b>${t.strike} ${t.type === 'CALL' ? 'CE' : 'PE'}</b> · ${exp}\n🎯 Entry: ₹${t!.entryPrice.toFixed(1)} | Target: ₹${t!.target.toFixed(1)} | SL: ₹${t!.stopLoss.toFixed(1)}`
                              : '❌ No valid strike found';
                          };
                          const msg =
`🔔 <b>FiFTO Trading Secret</b>
📊 <b>${prof.name} — EOD Signals</b>
━━━━━━━━━━━━━━━━━━━━
📅 Prep: ${marketData?.preparationDate} (${marketData?.preparationDay})
📆 EOD Data: ${marketData?.effectiveDataDate}
━━━━━━━━━━━━━━━━━━━━
📈 CALL (CE)
${fmtT(ce, ceExp, 'CE')}

📉 PUT (PE)
${fmtT(pe, peExp, 'PE')}
━━━━━━━━━━━━━━━━━━━━
⏰ Execute at 09:25 AM IST`;
                          const results = await sendTelegramMsgToTargets(tok, targets, msg);
                          if (results.some(Boolean)) { setTgSent(true); setTimeout(() => setTgSent(false), 3000); }
                        } finally { setIsSendingTg(false); }
                      };
                      return (
                        <button onClick={handleTgSend}
                          disabled={!hasTg || isSendingTg}
                          title={hasTg ? 'Send signals to Telegram' : 'Configure Telegram in Settings first'}
                          className={cn(
                            'relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all duration-200 border text-xs font-semibold overflow-hidden',
                            !hasTg
                              ? 'border-gray-700 bg-gray-900 text-gray-600 cursor-not-allowed opacity-60'
                              : tgSent
                                ? 'border-blue-500 bg-blue-700 text-white scale-105 shadow-lg shadow-blue-900/50'
                                : isSendingTg
                                  ? 'border-blue-700 bg-blue-900/40 text-blue-300'
                                  : 'border-gray-600 bg-gray-700/80 text-gray-300 hover:bg-blue-900/50 hover:border-blue-700 hover:text-blue-300 active:scale-95'
                          )}>
                          {isSendingTg && <span className="absolute inset-0 rounded-lg animate-ping bg-blue-600/20 pointer-events-none" />}
                          {tgSent ? (
                            <>
                              <svg className="w-3.5 h-3.5 animate-bounce-once" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                              <span>Sent!</span>
                            </>
                          ) : isSendingTg ? (
                            <>
                              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                              <span>Sending…</span>
                            </>
                          ) : (
                            <>
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.04 9.613c-.152.678-.554.843-1.12.524l-3.1-2.284-1.497 1.44c-.165.165-.304.304-.624.304l.223-3.162 5.76-5.203c.25-.223-.054-.347-.388-.124L7.15 14.066l-3.048-.951c-.662-.207-.675-.662.138-.98l11.91-4.593c.55-.2 1.032.134.852.706h-.44z"/>
                              </svg>
                              <span>Send</span>
                            </>
                          )}
                        </button>
                      );
                    })()}
                    {/* Copy Both CE+PE */}
                    {(result.callTrade?.isValid || result.putTrade?.isValid) && (
                      <button onClick={() => {
                        const ce = result.callTrade;
                        const pe = result.putTrade;
                        const prepInfo = marketData?.preparationDate
                          ? `\n📅 Prep Date : ${formatDisplayDate(marketData.preparationDate)} (${marketData.preparationDay})\n📆 EOD Data  : ${formatDisplayDate(marketData.effectiveDataDate)}`
                          : '';
                        const ceExp = callExpiryUsed || expiryUsed;
                        const peExp = putExpiryUsed  || expiryUsed;
                        const lines: string[] = [`📊 NIFTY Trade Signal`, `━━━━━━━━━━━━━━━━━━━━`];
                        const ceActive = paperTrades.find(p => p.optType === 'CE' && isOpenPaperTrade(p));
                        const peActive = paperTrades.find(p => p.optType === 'PE' && isOpenPaperTrade(p));
                        if (ceActive) {
                          lines.push(`🟢 CALL ${ceActive.strike} CE | ${ceActive.expiry} | ${ceActive.status === 'TRIGGERED' ? 'Order Active' : 'Pending Order'}`);
                          lines.push(`   🎯 Entry    : ₹${ceActive.entryPrice.toFixed(2)}`);
                          lines.push(`   ✅ Target   : ₹${ceActive.targetPrice.toFixed(2)}`);
                          lines.push(`   🛑 Stop Loss: ₹${ceActive.stopLoss.toFixed(2)}`);
                          lines.push(`   No duplicate order will be placed.`);
                        } else if (ce?.isValid) {
                          lines.push(`🟢 CALL ${ce.strike} CE | ${ceExp} | ${ce.contractType}`);
                          lines.push(`   🎯 Entry    : ₹${ce.entryPrice.toFixed(2)}`);
                          lines.push(`   ✅ Target   : ₹${ce.target.toFixed(2)}`);
                          lines.push(`   🛑 Stop Loss: ₹${ce.stopLoss.toFixed(2)}`);
                        }
                        if ((ceActive || ce?.isValid) && (peActive || pe?.isValid)) lines.push('');
                        if (peActive) {
                          lines.push(`🔴 PUT ${peActive.strike} PE | ${peActive.expiry} | ${peActive.status === 'TRIGGERED' ? 'Order Active' : 'Pending Order'}`);
                          lines.push(`   🎯 Entry    : ₹${peActive.entryPrice.toFixed(2)}`);
                          lines.push(`   ✅ Target   : ₹${peActive.targetPrice.toFixed(2)}`);
                          lines.push(`   🛑 Stop Loss: ₹${peActive.stopLoss.toFixed(2)}`);
                          lines.push(`   No duplicate order will be placed.`);
                        } else if (pe?.isValid) {
                          lines.push(`🔴 PUT ${pe.strike} PE | ${peExp} | ${pe.contractType}`);
                          lines.push(`   🎯 Entry    : ₹${pe.entryPrice.toFixed(2)}`);
                          lines.push(`   ✅ Target   : ₹${pe.target.toFixed(2)}`);
                          lines.push(`   🛑 Stop Loss: ₹${pe.stopLoss.toFixed(2)}`);
                        }
                        lines.push(`━━━━━━━━━━━━━━━━━━━━${prepInfo}`);
                        copyText(lines.join('\n')).then(() => {
                          setBothCopied(true);
                          setTimeout(() => setBothCopied(false), 2000);
                        });
                      }}
                        className={cn(
                          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all duration-200 text-xs font-semibold border',
                          bothCopied
                            ? 'bg-green-700 border-green-600 text-white scale-105'
                            : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600 hover:text-white active:scale-95'
                        )} title="Copy CE+PE">
                        {bothCopied ? (
                          <>
                            <svg className="w-3.5 h-3.5 animate-bounce-once" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                            <span>Copied!</span>
                          </>
                        ) : (
                          <>
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" strokeWidth={2}/><path strokeLinecap="round" strokeWidth={2} d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {result.noTradeReason ? (
                  <div className="p-8 text-center">
                    <span className="text-4xl block mb-3">⚠️</span>
                    <p className="text-xl font-bold text-gray-200 mb-1">No Trade Today</p>
                    <p className="text-gray-400 text-sm">{result.noTradeReason}</p>
                  </div>
                ) : (
                  <>
                  <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-700">
                    {result.callTrade && <div>
                       <TradeSignalCard signal={result.callTrade} expiry={callExpiryUsed || expiryUsed} prepDate={formatDisplayDate(marketData?.preparationDate)} prepDay={marketData?.preparationDay} eodDate={formatDisplayDate(marketData?.effectiveDataDate)} onTelegramSend={() => handleSendTradeSignal(result.callTrade!, 'CE', callExpiryUsed || expiryUsed)} isSendingTg={isSendingTg} />
                      {(() => {
                        const t = result.callTrade!;
                        const already = paperTrades.find(p => p.optType === 'CE' && (p.status === 'PENDING' || p.status === 'TRIGGERED'));
                        return (
                          <button onClick={async () => {
                            const newTrade: PaperTrade = {
                              id: `portfolio_${Date.now()}_CE`,
                              date: new Date().toISOString().slice(0, 10),
                              type: 'CALL', optType: 'CE',
                              strike: t.strike, expiry: callExpiryUsed || expiryUsed,
                              strategyName: getCfg().name,
                              lotSize: getCfg().lotSize,
                              entryPrice: t.entryPrice,
                              targetPrice: t.target,
                              stopLoss: t.stopLoss,
                              status: 'PENDING',
                              placedAt: new Date().toISOString(),
                              carryToNextDay: false,
                            };
                            await fetch('/angel/paper-trades', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(newTrade) });
                            setPaperTrades(await fetchTrades());
                            setServerEOD(await fetchEODStore());
                          }}
                            disabled={!!already}
                            className={cn(
                              'mx-3 mb-3 w-[calc(100%-24px)] py-2 rounded-lg text-xs font-black text-white transition-all border',
                              already ? 'bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed' : 'bg-green-700 border-green-600 hover:bg-green-600 active:scale-[0.97]'
                            )}>
                            {already ? `✅ ${t.strike} CE Already in Portfolio` : `+ Add ${t.strike} CE to Portfolio`}
                          </button>
                        );
                      })()}
                    </div>}
                    {result.putTrade && <div>
                       <TradeSignalCard signal={result.putTrade} expiry={putExpiryUsed || expiryUsed} prepDate={formatDisplayDate(marketData?.preparationDate)} prepDay={marketData?.preparationDay} eodDate={formatDisplayDate(marketData?.effectiveDataDate)} onTelegramSend={() => handleSendTradeSignal(result.putTrade!, 'PE', putExpiryUsed || expiryUsed)} isSendingTg={isSendingTg} />
                      {(() => {
                        const t = result.putTrade!;
                        const already = paperTrades.find(p => p.optType === 'PE' && (p.status === 'PENDING' || p.status === 'TRIGGERED'));
                        return (
                          <button onClick={async () => {
                            const newTrade: PaperTrade = {
                              id: `portfolio_${Date.now()}_PE`,
                              date: new Date().toISOString().slice(0, 10),
                              type: 'PUT', optType: 'PE',
                              strike: t.strike, expiry: putExpiryUsed || expiryUsed,
                              strategyName: getCfg().name,
                              lotSize: getCfg().lotSize,
                              entryPrice: t.entryPrice,
                              targetPrice: t.target,
                              stopLoss: t.stopLoss,
                              status: 'PENDING',
                              placedAt: new Date().toISOString(),
                              carryToNextDay: false,
                            };
                            await fetch('/angel/paper-trades', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(newTrade) });
                            setPaperTrades(await fetchTrades());
                            setServerEOD(await fetchEODStore());
                          }}
                            disabled={!!already}
                            className={cn(
                              'mx-3 mb-3 w-[calc(100%-24px)] py-2 rounded-lg text-xs font-black text-white transition-all border',
                              already ? 'bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed' : 'bg-red-700 border-red-600 hover:bg-red-600 active:scale-[0.97]'
                            )}>
                            {already ? `✅ ${t.strike} PE Already in Portfolio` : `+ Add ${t.strike} PE to Portfolio`}
                          </button>
                        );
                      })()}
                    </div>}
                  </div>
                  {/* ── Morning Check Panel ── */}
                  <div className="border-t border-gray-700 px-3 sm:px-4 py-3 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Morning Entry Check</p>
                        <p className="text-xs text-gray-600">F3 check: option 10-minute low must stay above EOD entry till 09:25.</p>
                      </div>
                      <button onClick={handleMorningCheck} disabled={isCheckingLTP}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-yellow-700 text-yellow-400 hover:bg-yellow-900/30 disabled:opacity-50 transition-all shrink-0">
                        {isCheckingLTP ? <><span className="animate-spin">↻</span> Checking…</> : '🔍 Check F3 (09:25)'}
                      </button>
                    </div>

                    {morningCheck && (
                      <div className="rounded-xl border border-gray-700 overflow-hidden">
                        <div className="grid grid-cols-2 divide-x divide-gray-700">
                          {([
                            {
                              label: 'CE (CALL)', scenario: 'Recalc',
                              ltp: morningCheck.ce10Low, entry: morningCheck.callEntryEOD,
                              triggered: morningCheck.callRecalcNeeded,
                              valid: result.callTrade?.isValid, strike: result.callTrade?.strike,
                              ref: '15m option low check',
                            },
                            {
                              label: 'PE (PUT)', scenario: 'Recalc',
                              ltp: morningCheck.pe10Low, entry: morningCheck.putEntryEOD,
                              triggered: morningCheck.putRecalcNeeded,
                              valid: result.putTrade?.isValid, strike: result.putTrade?.strike,
                              ref: '15m option low check',
                            },
                          ]).map(({ label, scenario, ltp, entry, triggered, valid, strike, ref }) => (
                            <div key={label} className={cn('px-3 py-3', !valid ? 'opacity-40' : triggered ? 'bg-red-950/20' : 'bg-green-950/10')}>
                              <p className="text-xs text-gray-500 font-semibold mb-1">{label} {strike ? `· ${strike}` : ''}</p>
                              <div className="flex items-end gap-2 flex-wrap">
                                <div>
                                  <p className="text-xs text-gray-600">10m Low</p>
                                  <p className={cn('text-lg font-black', triggered ? 'text-red-400' : 'text-white')}>
                                    {valid ? (ltp > 0 ? `₹${ltp.toFixed(1)}` : '—') : '—'}
                                  </p>
                                </div>
                                <div className="text-gray-700 text-sm mb-0.5">vs</div>
                                <div>
                                  <p className="text-xs text-gray-600">EOD Entry</p>
                                  <p className="text-lg font-black text-gray-300">{valid ? `₹${entry.toFixed(1)}` : '—'}</p>
                                </div>
                              </div>
                              {valid && (
                                <div className={cn('mt-2 px-2 py-1 rounded-lg text-xs font-bold text-center', triggered ? 'bg-red-900/50 text-red-300' : 'bg-green-900/40 text-green-300')}>
                                  {triggered ? `⚠️ F3 Fail — ${scenario} @ 09:30 · ${ref}` : '✅ F3 OK'}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="border-t border-gray-700 px-3 py-2 flex items-center justify-between bg-gray-800/40">
                          <p className="text-xs text-gray-600">Checked at {morningCheck.checkedAt}</p>
                          {(morningCheck.callRecalcNeeded || morningCheck.putRecalcNeeded) && (
                            <button onClick={handleGapDownRecalc} disabled={isGapDownCalc}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black bg-amber-600 hover:bg-amber-500 text-black disabled:opacity-50 transition-all">
                              {isGapDownCalc
                                ? <><span className="animate-spin">↻</span> Calculating…</>
                                : `⚡ Recalculate${morningCheck.callRecalcNeeded && morningCheck.putRecalcNeeded ? ' Both' : morningCheck.callRecalcNeeded ? ' CE' : ' PE'}`
                              }
                            </button>
                          )}
                          {!morningCheck.callRecalcNeeded && !morningCheck.putRecalcNeeded && (
                            <p className="text-xs text-green-500 font-semibold">✅ Both legs passed F3 — place at EOD entry</p>
                          )}
                        </div>
                      </div>
                    )}

                    {gapDownData && (
                      <button onClick={() => setShowGapDown(true)}
                        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-amber-700 text-amber-400 text-xs font-bold hover:bg-amber-900/20 transition-all">
                        ⚡ View 09:30 Recalc Steps
                      </button>
                    )}
                  </div>
                  </>
                )}
              </div>
            )}

            {/* ── Key Levels — 2×2 on mobile, 4 cols on desktop ── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label:'2DHH', value: result.twoDHH.toFixed(2),     sub:'Highest High', color:'#f59e0b', bg:'rgba(245,158,11,0.1)',   border:'rgba(245,158,11,0.3)' },
                { label:'2DLL', value: result.twoDLL.toFixed(2),      sub:'Lowest Low',   color:'#34d399', bg:'rgba(52,211,153,0.1)',   border:'rgba(52,211,153,0.3)' },
                { label:'Upper', value: result.upperLevel.toFixed(2), sub:'×1.0015',      color:'#94a3b8', bg:'rgba(148,163,184,0.08)', border:'rgba(148,163,184,0.2)' },
                { label:'Lower', value: result.lowerLevel.toFixed(2), sub:'×0.9985',      color:'#94a3b8', bg:'rgba(148,163,184,0.08)', border:'rgba(148,163,184,0.2)' },
              ].map(k => (
                <div key={k.label} className="flex flex-col px-3 py-2 rounded-lg"
                  style={{background: k.bg, border:`1px solid ${k.border}`}}>
                  <span className="text-xs font-semibold mb-0.5" style={{color: k.color}}>{k.label}</span>
                  <span className="text-sm font-black text-white leading-tight">{k.value}</span>
                  <span className="text-xs text-gray-600 mt-0.5">{k.sub}</span>
                </div>
              ))}
            </div>

            {/* Strike Tables */}
            <Card title="Strike Filter Tables">
              {ltpFetchStatus === 'error' && (
                <div className="mb-3 bg-orange-950 border border-orange-800 rounded-lg px-4 py-2.5 text-orange-400 text-sm">
                  ⚠️ Could not fetch prices — check angel-config.json (expiry: {expiryUsed})
                </div>
              )}
              <div className="flex items-center gap-4 mb-3 text-xs text-gray-400 flex-wrap">
                <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-green-600"></span> Pass (OI ≥ 32,500 & 2D Low ≥ Min)</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-orange-600"></span> One fails</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-gray-600"></span> Both fail</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-green-400"></span> Selected ▶</span>
              </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

                  {/* ── CALL TABLE ── */}
                  <div className="rounded-xl overflow-hidden border border-green-800">
                    <div className="bg-linear-to-r from-green-800 to-green-950 px-3 sm:px-4 py-2.5 sm:py-3 flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-white text-xs sm:text-sm">📈 CALL (CE) · {result.callStartStrike} → {result.callEndStrike}</span>
                        {callExpiryUsed && (
                          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold bg-black/30 text-green-200 border border-green-600/50 cursor-pointer hover:bg-green-900/40 transition-colors"
                            onClick={() => { if (result.callTrade?.strike) navigator.clipboard.writeText(`${result.callTrade.strike} ${callExpiryUsed}`).then(() => pushToast('success', `📋 ${result.callTrade.strike} ${callExpiryUsed}`, 'Copied')).catch(() => {}); }}
                            title="Click to copy strike + expiry">
                            <span className="opacity-60">LTP</span> {callExpiryUsed}
                            <span className="opacity-60 ml-1">{result.callTrade?.contractType ?? (callExpiryUsed === expiryUsed ? 'Current Week' : 'Next Week')}</span>
                          </span>
                        )}
                      </div>
                      {result.callTrade?.isValid && (
                        <span className="text-xs bg-green-600 text-white px-2 py-1 rounded-full font-bold cursor-pointer hover:bg-green-500 transition-colors"
                          onClick={() => navigator.clipboard.writeText(`${result.callTrade.strike} ${callExpiryUsed}`).then(() => pushToast('success', `📋 ${result.callTrade.strike} ${callExpiryUsed}`, 'Copied')).catch(() => {})}
                          title="Click to copy strike + expiry">
                          Selected: {result.callTrade.strike}
                        </span>
                      )}
                    </div>
                    <div className="overflow-x-auto">
                    <table className="w-full text-xs sm:text-sm">
                      <thead>
                        <tr style={{borderBottom:'1px solid oklch(0.34 0 0)'}} className="bg-gray-800 text-xs">
                          <th className="px-2 sm:px-3 py-2 sm:py-2.5 text-left text-gray-300 font-semibold">Strike</th>
                          <th className="px-2 sm:px-3 py-2 sm:py-2.5 text-right text-gray-300 font-semibold">OI</th>
                          <th className="px-2 sm:px-3 py-2 sm:py-2.5 text-right text-gray-300 font-semibold">2D Low</th>
                          <th className="px-2 sm:px-3 py-2 sm:py-2.5 text-right text-gray-300 font-semibold">Min Prem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.callStrikeRange.map((strike) => {
                          const minPremium = strike * MIN_PREMIUM_FACTOR();
                          const strikeData = result.callStrikes.find(d => d.strike === strike);
                          const ceOI = strikeData?.callOI || 0;
                          const ceLTP = strikeData?.callPremium || 0;
                          const oiMet = ceOI >= MIN_OI();
                          const premMet = ceLTP >= minPremium;
                          const isSelected = result.callTrade?.strike === strike;
                          const rowBg = isSelected
                            ? 'bg-green-500/20 border-l-4 border-green-400 shadow-[inset_0_0_12px_rgba(34,197,94,0.15)]'
                            : oiMet && premMet
                              ? 'bg-green-950/30 border-l-4 border-green-800'
                              : oiMet || premMet
                                ? 'bg-orange-950/20 border-l-4 border-orange-800'
                                : 'border-l-4 border-transparent';
                          return (
                            <tr key={strike} style={{borderBottom:'1px solid oklch(0.34 0 0)'}} className={`${rowBg} ${!isSelected ? 'hover:bg-gray-800/40' : ''}`}>
                              <td className={`px-2 sm:px-3 py-2 sm:py-2.5 font-bold ${isSelected ? 'text-green-300' : oiMet && premMet ? 'text-green-400' : 'text-gray-300'}`}>
                                {strike}
                                {isSelected && <span className="ml-1 text-green-400 text-xs font-black">▶</span>}
                              </td>
                              <td className={`px-2 sm:px-3 py-2 sm:py-2.5 text-right font-medium ${ceOI > 0 ? (oiMet ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`}>
                                {ceOI > 0 ? (ceOI >= 1000 ? (ceOI / 1000).toFixed(0) + 'K' : ceOI) : '—'}
                              </td>
                              <td className={`px-2 sm:px-3 py-2 sm:py-2.5 text-right font-semibold ${premMet ? 'text-green-300' : 'text-gray-300'}`}>
                                ₹{ceLTP > 0 ? ceLTP.toFixed(2) : '—'}
                              </td>
                              <td className="px-2 sm:px-3 py-2 sm:py-2.5 text-right text-gray-400 text-xs">
                                ₹{minPremium.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  </div>

                  {/* ── PUT TABLE ── */}
                  <div className="rounded-xl overflow-hidden border border-red-800">
                    <div className="bg-linear-to-r from-red-800 to-red-950 px-3 sm:px-4 py-2.5 sm:py-3 flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-white text-xs sm:text-sm">📉 PUT (PE) · {result.putStartStrike} → {result.putEndStrike}</span>
                        {putExpiryUsed && (
                          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold bg-black/30 text-red-200 border border-red-500/50 cursor-pointer hover:bg-red-900/40 transition-colors"
                            onClick={() => { if (result.putTrade?.strike) navigator.clipboard.writeText(`${result.putTrade.strike} ${putExpiryUsed}`).then(() => pushToast('success', `📋 ${result.putTrade.strike} ${putExpiryUsed}`, 'Copied')).catch(() => {}); }}
                            title="Click to copy strike + expiry">
                            <span className="opacity-60">LTP</span> {putExpiryUsed}
                            <span className="opacity-60 ml-1">{result.putTrade?.contractType ?? (putExpiryUsed === expiryUsed ? 'Current Week' : 'Next Week')}</span>
                          </span>
                        )}
                      </div>
                      {result.putTrade?.isValid && (
                        <span className="text-xs bg-red-600 text-white px-2 py-1 rounded-full font-bold cursor-pointer hover:bg-red-500 transition-colors"
                          onClick={() => navigator.clipboard.writeText(`${result.putTrade.strike} ${putExpiryUsed}`).then(() => pushToast('success', `📋 ${result.putTrade.strike} ${putExpiryUsed}`, 'Copied')).catch(() => {})}
                          title="Click to copy strike + expiry">
                          Selected: {result.putTrade.strike}
                        </span>
                      )}
                    </div>
                    <div className="overflow-x-auto">
                    <table className="w-full text-xs sm:text-sm">
                      <thead>
                        <tr style={{borderBottom:'1px solid oklch(0.34 0 0)'}} className="bg-gray-800 text-xs">
                          <th className="px-2 sm:px-3 py-2 sm:py-2.5 text-left text-gray-300 font-semibold">Strike</th>
                          <th className="px-2 sm:px-3 py-2 sm:py-2.5 text-right text-gray-300 font-semibold">OI</th>
                          <th className="px-2 sm:px-3 py-2 sm:py-2.5 text-right text-gray-300 font-semibold">2D Low</th>
                          <th className="px-2 sm:px-3 py-2 sm:py-2.5 text-right text-gray-300 font-semibold">Min Prem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.putStrikeRange.map((strike) => {
                          const minPremium = strike * MIN_PREMIUM_FACTOR();
                          const strikeData = result.putStrikes.find(d => d.strike === strike);
                          const peOI = strikeData?.putOI || 0;
                          const peLTP = strikeData?.putPremium || 0;
                          const oiMet = peOI >= MIN_OI();
                          const premMet = peLTP >= minPremium;
                          const isSelected = result.putTrade?.strike === strike;
                          const rowBg = isSelected
                            ? 'bg-red-500/20 border-l-4 border-red-400 shadow-[inset_0_0_12px_rgba(239,68,68,0.15)]'
                            : oiMet && premMet
                              ? 'bg-red-950/30 border-l-4 border-red-800'
                              : oiMet || premMet
                                ? 'bg-orange-950/20 border-l-4 border-orange-800'
                                : 'border-l-4 border-transparent';
                          return (
                            <tr key={strike} style={{borderBottom:'1px solid oklch(0.34 0 0)'}} className={`${rowBg} ${!isSelected ? 'hover:bg-gray-800/40' : ''}`}>
                              <td className={`px-2 sm:px-3 py-2 sm:py-2.5 font-bold ${isSelected ? 'text-red-300' : oiMet && premMet ? 'text-red-400' : 'text-gray-300'}`}>
                                {strike}
                                {isSelected && <span className="ml-1 text-red-400 text-xs font-black">▶</span>}
                              </td>
                              <td className={`px-2 sm:px-3 py-2 sm:py-2.5 text-right font-medium ${peOI > 0 ? (oiMet ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`}>
                                {peOI > 0 ? (peOI >= 1000 ? (peOI / 1000).toFixed(0) + 'K' : peOI) : '—'}
                              </td>
                              <td className={`px-2 sm:px-3 py-2 sm:py-2.5 text-right font-semibold ${premMet ? 'text-red-300' : 'text-gray-300'}`}>
                                ₹{peLTP > 0 ? peLTP.toFixed(2) : '—'}
                              </td>
                              <td className="px-2 sm:px-3 py-2 sm:py-2.5 text-right text-gray-400 text-xs">
                                ₹{minPremium.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  </div>

                </div>
            </Card>

            {/* Summary Card */}
            <Card title="📋 Strategy Summary">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left py-3 px-4 text-gray-400 font-medium">Parameter</th>
                      <th className="text-left py-3 px-4 text-gray-400 font-medium">CALL</th>
                      <th className="text-left py-3 px-4 text-gray-400 font-medium">PUT</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-800">
                      <td className="py-3 px-4 text-gray-400">Selected Strike</td>
                      <td className="py-3 px-4 font-medium text-gray-200">{result.callTrade?.strike || 'N/A'}</td>
                      <td className="py-3 px-4 font-medium text-gray-200">{result.putTrade?.strike || 'N/A'}</td>
                    </tr>
                    <tr className="border-b border-gray-800">
                      <td className="py-3 px-4 text-gray-400">Entry Price</td>
                      <td className="py-3 px-4 font-medium text-gray-200">₹{result.callTrade?.entryPrice.toFixed(2) || 'N/A'}</td>
                      <td className="py-3 px-4 font-medium text-gray-200">₹{result.putTrade?.entryPrice.toFixed(2) || 'N/A'}</td>
                    </tr>
                    <tr className="border-b border-gray-800">
                      <td className="py-3 px-4 text-gray-400">Target (75% profit)</td>
                      <td className="py-3 px-4 font-medium text-green-400">₹{result.callTrade?.target.toFixed(2) || 'N/A'}</td>
                      <td className="py-3 px-4 font-medium text-green-400">₹{result.putTrade?.target.toFixed(2) || 'N/A'}</td>
                    </tr>
                    <tr className="border-b border-gray-800">
                      <td className="py-3 px-4 text-gray-400">Stop Loss</td>
                      <td className="py-3 px-4 font-medium text-red-400">₹{result.callTrade?.stopLoss.toFixed(2) || 'N/A'}</td>
                      <td className="py-3 px-4 font-medium text-red-400">₹{result.putTrade?.stopLoss.toFixed(2) || 'N/A'}</td>
                    </tr>
                    <tr className="border-b border-gray-800">
                      <td className="py-3 px-4 text-gray-400">Expiry</td>
                      <td className="py-3 px-4 font-medium text-green-300">{callExpiryUsed || expiryUsed || 'N/A'}</td>
                      <td className="py-3 px-4 font-medium text-green-300">{putExpiryUsed  || expiryUsed || 'N/A'}</td>
                    </tr>
                    <tr className="border-b border-gray-800">
                      <td className="py-3 px-4 text-gray-400">Contract Type</td>
                      <td className="py-3 px-4 font-medium text-gray-200">{result.callTrade?.contractType || 'N/A'}</td>
                      <td className="py-3 px-4 font-medium text-gray-200">{result.putTrade?.contractType || 'N/A'}</td>
                    </tr>
                    <tr className="border-b border-gray-800">
                      <td className="py-3 px-4 text-gray-400">Preparation Date</td>
                      <td className="py-3 px-4 font-medium text-green-300" colSpan={2}>
                        {formatDisplayDate(marketData?.preparationDate)} &nbsp;
                        <span className="text-gray-500 text-xs">({marketData?.preparationDay})</span>
                      </td>
                    </tr>
                    <tr className="border-b border-gray-800">
                      <td className="py-3 px-4 text-gray-400">EOD Data Date</td>
                      <td className="py-3 px-4 font-medium text-blue-300" colSpan={2}>
                        {formatDisplayDate(marketData?.effectiveDataDate)} &nbsp;
                        <span className="text-gray-500 text-xs">({getDayName(marketData?.effectiveDataDate ?? '')})</span>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-3 px-4 text-gray-400">Strike Range</td>
                      <td className="py-3 px-4 font-medium text-gray-200">
                        {result.callTrade?.strikeRange.length ? `${result.callTrade.strikeRange[9]}-${result.callTrade.strikeRange[0]}` : 'N/A'}
                      </td>
                      <td className="py-3 px-4 font-medium text-gray-200">
                        {result.putTrade?.strikeRange.length ? `${result.putTrade.strikeRange[9]}-${result.putTrade.strikeRange[0]}` : 'N/A'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
        
        {/* ── Calculation History ── */}
        {calcHistoryDates.length > 0 && (
          <div className="rounded-2xl border border-gray-700 overflow-hidden">
            <details id="calc-history" className="group">
              <summary className="px-4 py-3 bg-gray-800 border-b border-gray-700 flex items-center gap-2 cursor-pointer hover:bg-gray-750 transition-all list-none">
                <span className="text-base">📐</span>
                <h2 className="text-sm font-black text-white flex-1">Calculation History</h2>
                <span className="text-xs text-gray-600">{calcHistoryDates.length} days</span>
                <svg className="w-4 h-4 text-gray-500 group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
              </summary>
              <div className="divide-y divide-gray-800 max-h-[500px] overflow-y-auto">
                {calcHistoryDates.map(date => {
                  const isSelected = selectedCalcDate === date;
                  return (
                    <div key={date}>
                      <button onClick={async () => {
                        if (isSelected) { setSelectedCalcDate(null); setCalcHistoryDetail(null); return; }
                        setSelectedCalcDate(date);
                        const detail = await fetchCalcDetail(date);
                        setCalcHistoryDetail(detail);
                      }}
                        className={cn('w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-gray-800/40 transition-all', isSelected ? 'bg-gray-800/60' : '')}>
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-semibold text-white">{date}</span>
                          {isSelected && <span className="text-xs text-green-400">▼</span>}
                        </div>
                        <span className="text-xs text-gray-600">📊 Strategy</span>
                      </button>
                      {isSelected && calcHistoryDetail && (
                        <div className="px-4 py-3 bg-gray-900/50 border-t border-gray-800 space-y-3">
                          <div className="flex items-center gap-2 text-xs text-gray-400">
                            <span className="font-semibold text-white">{calcHistoryDetail.strategyName || 'NIFTY Weekly Selling'}</span>
                            {calcHistoryDetail.eodDate && <span>· EOD: {calcHistoryDetail.eodDate}</span>}
                            {calcHistoryDetail.prepDate && <span>· Prep: {calcHistoryDetail.prepDate}</span>}
                            {calcHistoryDetail.prepDay && <span>· {calcHistoryDetail.prepDay}</span>}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {calcHistoryDetail.callTrade?.isValid && (
                              <div className="rounded-xl border border-green-800 bg-green-950/20 p-3">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="px-2 py-0.5 rounded-full text-xs font-black text-white bg-green-600">CE</span>
                                  <span className="text-white font-black text-lg">{calcHistoryDetail.callTrade.strike}</span>
                                  <span className="text-gray-500 text-xs">{calcHistoryDetail.callExpiry}</span>
                                </div>
                                <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
                                  <div className="rounded bg-gray-800/60 py-1.5">
                                    <p className="text-gray-500">Entry</p>
                                    <p className="font-black text-white">₹{calcHistoryDetail.callTrade.entryPrice.toFixed(1)}</p>
                                  </div>
                                  <div className="rounded bg-gray-800/60 py-1.5">
                                    <p className="text-gray-500">Target</p>
                                    <p className="font-black text-green-400">₹{(calcHistoryDetail.callTrade.target ?? calcHistoryDetail.callTrade.targetPrice ?? 0).toFixed(1)}</p>
                                  </div>
                                  <div className="rounded bg-gray-800/60 py-1.5">
                                    <p className="text-gray-500">SL</p>
                                    <p className="font-black text-red-400">₹{calcHistoryDetail.callTrade.stopLoss.toFixed(1)}</p>
                                  </div>
                                </div>
                              </div>
                            )}
                            {calcHistoryDetail.putTrade?.isValid && (
                              <div className="rounded-xl border border-red-800 bg-red-950/20 p-3">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="px-2 py-0.5 rounded-full text-xs font-black text-white bg-red-600">PE</span>
                                  <span className="text-white font-black text-lg">{calcHistoryDetail.putTrade.strike}</span>
                                  <span className="text-gray-500 text-xs">{calcHistoryDetail.putExpiry}</span>
                                </div>
                                <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
                                  <div className="rounded bg-gray-800/60 py-1.5">
                                    <p className="text-gray-500">Entry</p>
                                    <p className="font-black text-white">₹{calcHistoryDetail.putTrade.entryPrice.toFixed(1)}</p>
                                  </div>
                                  <div className="rounded bg-gray-800/60 py-1.5">
                                    <p className="text-gray-500">Target</p>
                                    <p className="font-black text-green-400">₹{(calcHistoryDetail.putTrade.target ?? calcHistoryDetail.putTrade.targetPrice ?? 0).toFixed(1)}</p>
                                  </div>
                                  <div className="rounded bg-gray-800/60 py-1.5">
                                    <p className="text-gray-500">SL</p>
                                    <p className="font-black text-red-400">₹{calcHistoryDetail.putTrade.stopLoss.toFixed(1)}</p>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                          {calcHistoryDetail.recalculatedSignals && (
                            <div className="rounded-lg border border-amber-700 bg-amber-950/20 p-3">
                              <p className="text-xs font-bold text-amber-400 mb-2">⚡ Recalculated Signals</p>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {calcHistoryDetail.recalculatedSignals.callTrade?.isValid && (
                                  <div className="rounded bg-gray-800/60 p-2 text-xs">
                                    <span className="font-bold text-green-400">CE {calcHistoryDetail.recalculatedSignals.callTrade.strike}</span>
                                    <span className="text-gray-500 ml-2">{calcHistoryDetail.recalculatedSignals.callExpiry}</span>
                                    <div className="text-gray-400 mt-1">Entry ₹{calcHistoryDetail.recalculatedSignals.callTrade.entryPrice.toFixed(1)} · Target ₹{(calcHistoryDetail.recalculatedSignals.callTrade.target ?? calcHistoryDetail.recalculatedSignals.callTrade.targetPrice ?? 0).toFixed(1)} · SL ₹{calcHistoryDetail.recalculatedSignals.callTrade.stopLoss.toFixed(1)}</div>
                                  </div>
                                )}
                                {calcHistoryDetail.recalculatedSignals.putTrade?.isValid && (
                                  <div className="rounded bg-gray-800/60 p-2 text-xs">
                                    <span className="font-bold text-red-400">PE {calcHistoryDetail.recalculatedSignals.putTrade.strike}</span>
                                    <span className="text-gray-500 ml-2">{calcHistoryDetail.recalculatedSignals.putExpiry}</span>
                                    <div className="text-gray-400 mt-1">Entry ₹{calcHistoryDetail.recalculatedSignals.putTrade.entryPrice.toFixed(1)} · Target ₹{(calcHistoryDetail.recalculatedSignals.putTrade.target ?? calcHistoryDetail.recalculatedSignals.putTrade.targetPrice ?? 0).toFixed(1)} · SL ₹{calcHistoryDetail.recalculatedSignals.putTrade.stopLoss.toFixed(1)}</div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {calcHistoryDetail.calculatedAt && (
                            <p className="text-xs text-gray-600">Calculated: {new Date(calcHistoryDetail.calculatedAt).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12: false, timeZone:'Asia/Kolkata' })} IST</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          </div>
        )}

        {/* Strategy Notes — accordion */}
        <div className="rounded-2xl border border-gray-700 overflow-hidden" style={{background:'#0f1117'}}>
          <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-2" style={{background:'#161b22'}}>
            <span className="text-sm">📋</span>
            <span className="font-bold text-white text-sm">Strategy Notes</span>
            <span className="text-xs text-gray-600 hidden sm:inline">— FiFTO NIFTY Option Selling Rules</span>
          </div>
          <div className="divide-y divide-gray-800">

            {/* Step 1 */}
            <details className="group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none select-none">
                <div className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-full bg-green-900 flex items-center justify-center text-xs font-black text-green-400 shrink-0">1</span>
                  <span className="text-sm font-semibold text-white">Market Data</span>
                  <span className="text-xs text-gray-600 hidden sm:inline">Fetch 2-day NIFTY OHLC</span>
                </div>
                <span className="text-gray-600 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 pt-1 space-y-2 text-sm">
                <div className="flex gap-2 items-start bg-gray-800/50 rounded-lg p-3">
                  <span className="text-green-500 shrink-0 mt-0.5">●</span>
                  <span className="text-gray-300">Fetch last <strong className="text-white">2 trading days</strong> NIFTY OHLC — Day-1 = most recent, Day-2 = previous</span>
                </div>
                <div className="flex gap-2 items-start bg-gray-800/50 rounded-lg p-3">
                  <span className="text-amber-500 shrink-0 mt-0.5">●</span>
                  <span className="text-gray-300">If market is currently <strong className="text-white">open</strong>, auto step back 1 trading day for accurate EOD data</span>
                </div>
                <div className="flex gap-2 items-start bg-gray-800/50 rounded-lg p-3">
                  <span className="text-blue-400 shrink-0 mt-0.5">●</span>
                  <span className="text-gray-300"><strong className="text-white">Preparation Date</strong> = next trading day after EOD date &nbsp;·&nbsp; e.g. EOD Friday → Prep Monday</span>
                </div>
              </div>
            </details>

            {/* Step 2 */}
            <details className="group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none select-none">
                <div className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-full bg-amber-900 flex items-center justify-center text-xs font-black text-amber-400 shrink-0">2</span>
                  <span className="text-sm font-semibold text-white">2-Day Levels</span>
                  <span className="text-xs text-gray-600 hidden sm:inline">2DHH & 2DLL calculation</span>
                </div>
                <span className="text-gray-600 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 pt-1 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-amber-400 font-bold text-xs mb-1">2DHH — Highest High</p>
                  <p className="text-white font-mono text-sm">max(D1 High, D2 High)</p>
                  <p className="text-gray-500 text-xs mt-1">Used for PUT strike range upper boundary</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-green-400 font-bold text-xs mb-1">2DLL — Lowest Low</p>
                  <p className="text-white font-mono text-sm">min(D1 Low, D2 Low)</p>
                  <p className="text-gray-500 text-xs mt-1">Used for CALL strike range lower boundary</p>
                </div>
              </div>
            </details>

            {/* Step 3 */}
            <details className="group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none select-none">
                <div className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-full bg-sky-900 flex items-center justify-center text-xs font-black text-sky-400 shrink-0">3</span>
                  <span className="text-sm font-semibold text-white">Strike Range</span>
                  <span className="text-xs text-gray-600 hidden sm:inline">10 strikes × 50pt interval</span>
                </div>
                <span className="text-gray-600 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 pt-1 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-sky-400 font-bold text-xs mb-2">📈 CALL (CE)</p>
                  <p className="text-gray-300">End = <span className="text-white font-mono">2DLL × 0.9985</span></p>
                  <p className="text-gray-400 text-xs mt-1">10 strikes OTM → ITM (high to low)</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-rose-400 font-bold text-xs mb-2">📉 PUT (PE)</p>
                  <p className="text-gray-300">End = <span className="text-white font-mono">2DHH × 1.0015</span></p>
                  <p className="text-gray-400 text-xs mt-1">10 strikes OTM → ITM (low to high)</p>
                </div>
              </div>
            </details>

            {/* Step 4 */}
            <details className="group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none select-none">
                <div className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-full bg-purple-900 flex items-center justify-center text-xs font-black text-purple-400 shrink-0">4</span>
                  <span className="text-sm font-semibold text-white">Eligibility Filters</span>
                  <span className="text-xs text-gray-600 hidden sm:inline">OI + Premium — both must pass</span>
                </div>
                <span className="text-gray-600 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 pt-1 space-y-2 text-sm">
                <p className="text-gray-500 text-xs">Strikes checked OTM → ITM. First strike passing <strong className="text-white">both</strong> filters is selected.</p>
                <div className="bg-gray-800/50 rounded-lg p-3 flex gap-3 items-start">
                  <span className="text-xs font-black text-purple-300 bg-purple-900/50 px-2 py-0.5 rounded shrink-0">OI</span>
                  <div>
                    <p className="text-white text-xs font-bold">Open Interest ≥ 32,500 contracts</p>
                    <p className="text-gray-500 text-xs">500 lots × 65 lot size · ensures liquidity</p>
                  </div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3 flex gap-3 items-start">
                  <span className="text-xs font-black text-purple-300 bg-purple-900/50 px-2 py-0.5 rounded shrink-0">₹</span>
                  <div>
                    <p className="text-white text-xs font-bold">2D Low ≥ 0.85% of strike price</p>
                    <p className="text-gray-500 text-xs">e.g. Strike 24000 → min ₹204 premium</p>
                  </div>
                </div>
              </div>
            </details>

            {/* Step 5 */}
            <details className="group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none select-none">
                <div className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-full bg-orange-900 flex items-center justify-center text-xs font-black text-orange-400 shrink-0">5</span>
                  <span className="text-sm font-semibold text-white">Multi-Expiry Fallback</span>
                  <span className="text-xs text-gray-600 hidden sm:inline">Up to 5 expiries tried</span>
                </div>
                <span className="text-gray-600 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 pt-1 space-y-2 text-sm">
                <p className="text-gray-400 text-xs">If all 10 strikes fail → auto-try next weekly expiry. Up to <strong className="text-orange-300">5 expiries</strong> per leg.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="bg-gray-800/50 rounded-lg p-2.5 text-center text-xs">
                    <p className="text-green-400 font-bold mb-1">CALL leg</p>
                    <p className="text-gray-400">Searches independently</p>
                  </div>
                  <div className="bg-gray-800/50 rounded-lg p-2.5 text-center text-xs">
                    <p className="text-red-400 font-bold mb-1">PUT leg</p>
                    <p className="text-gray-400">Searches independently</p>
                  </div>
                  <div className="bg-gray-800/50 rounded-lg p-2.5 text-center text-xs">
                    <p className="text-amber-400 font-bold mb-1">Mon / Tue</p>
                    <p className="text-gray-400">Start from Next Week</p>
                  </div>
                </div>
              </div>
            </details>

            {/* Step 6 */}
            <details className="group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none select-none">
                <div className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-full bg-emerald-900 flex items-center justify-center text-xs font-black text-emerald-400 shrink-0">6</span>
                  <span className="text-sm font-semibold text-white">Trade Values</span>
                  <span className="text-xs text-gray-600 hidden sm:inline">Entry · Target · Stop Loss</span>
                </div>
                <span className="text-gray-600 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 pt-1 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-white font-bold text-xs mb-1">Entry</p>
                  <p className="font-mono text-sm text-gray-200">2D Low × 0.90</p>
                  <p className="text-gray-500 text-xs">10% below option's 2-day low</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-green-400 font-bold text-xs mb-1">Target</p>
                  <p className="font-mono text-sm text-gray-200">Entry × 0.25</p>
                  <p className="text-gray-500 text-xs">75% profit on premium</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-orange-300 font-bold text-xs mb-1">MSL</p>
                  <p className="font-mono text-sm text-gray-200">Entry × 1.75</p>
                  <p className="text-gray-500 text-xs">Max stop loss — 75% above entry</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-orange-300 font-bold text-xs mb-1">TSL</p>
                  <p className="font-mono text-sm text-gray-200">2D HH × 1.10</p>
                  <p className="text-gray-500 text-xs">Trailing — 10% above 2-day high</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3 sm:col-span-2">
                  <p className="text-red-400 font-bold text-xs mb-1">Stop Loss</p>
                  <p className="font-mono text-sm text-gray-200">min(MSL, TSL)</p>
                  <p className="text-gray-500 text-xs">Tighter of the two — dynamic protection</p>
                </div>
              </div>
            </details>

          </div>
        </div>

        </> /* end strategy page */}

      </main>

      {/* Footer */}
      <footer className="mt-10 border-t border-gray-800" style={{background:'#0a0a0a'}}>
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            {/* Brand */}
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-white flex items-center justify-center overflow-hidden shrink-0">
                <img src="/fifto-logo.png" alt="FiFTO" className="h-full w-full object-contain" />
              </div>
              <div>
                <p className="text-sm font-bold text-white">FiFTO Trading Secret</p>
                <p className="text-xs text-gray-600">© 2026 · NIFTY Option Selling Strategy</p>
              </div>
            </div>
            {/* Founder */}
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <p className="text-xs text-gray-600">Founder</p>
                <p className="text-sm font-bold text-white">Mani Raja</p>
              </div>
              <a href="tel:+918300030123"
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white transition-all"
                style={{background:'linear-gradient(135deg,#16a34a,#15803d)', boxShadow:'0 0 16px rgba(22,163,74,0.3)'}}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
                </svg>
                +91-8300030123
              </a>
            </div>
          </div>
        </div>
      </footer>

      {/* ── Toast Notifications ── */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 w-full max-w-sm px-4 pointer-events-none">
          {toasts.map(t => {
            const styles: Record<Toast['type'], { border: string; bg: string; title: string }> = {
              success: { border:'border-green-700', bg:'#052e1690', title:'text-green-300' },
              warning: { border:'border-amber-700', bg:'#44190090', title:'text-amber-300' },
              danger:  { border:'border-red-700',   bg:'#450a0a90', title:'text-red-300'   },
              info:    { border:'border-blue-700',  bg:'#0c1a3390', title:'text-blue-300'  },
            };
            const s = styles[t.type];
            return (
              <div key={t.id}
                className={cn('toast-enter w-full rounded-2xl border overflow-hidden shadow-2xl pointer-events-auto', s.border)}
                style={{background:s.bg, backdropFilter:'blur(16px)'}}>
                <div className="px-4 py-3">
                  <p className={cn('text-sm font-black', s.title)}>{t.title}</p>
                  <p className="text-xs text-gray-300 mt-0.5">{t.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


