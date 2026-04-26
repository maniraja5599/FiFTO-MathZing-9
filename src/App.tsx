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

// AppSettings stores all profiles + which one is active + telegram config
interface AppSettings {
  activeId: string;
  profiles: StrategyProfile[];
  telegramToken: string;
  telegramChatId: string;
  ltpPollIntervalSec: number;
  settingsPin: string;
}

// BankNifty weekly options discontinued by SEBI/NSE from Nov 13 2024.
// NIFTY lot size: 65 (effective Jan 2026). BankNifty lot size: 30 (effective Jan 2026).
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
  {
    id: 'nifty-monthly',
    name: 'NIFTY Monthly Selling',
    instrument: 'NIFTY',
    expiry: 'MONTHLY',
    lotSize: 65,
    minOIContracts: 300,
    strikeFactor: 0.0020,
    minPremiumFactor: 0.0100,
    strikeInterval: 50,
    numStrikes: 10,
    maxTries: 3,
    entryDiscount: 0.12,
    targetProfit: 0.75,
    mslIncrease: 0.75,
    tslIncrease: 0.10,
  },
  {
    // BankNifty weekly discontinued Nov 13 2024 by SEBI. Monthly only remains.
    id: 'banknifty-monthly',
    name: 'BankNifty Monthly Selling',
    instrument: 'BANKNIFTY',
    expiry: 'MONTHLY',
    lotSize: 30,
    minOIContracts: 300,
    strikeFactor: 0.0020,
    minPremiumFactor: 0.0100,
    strikeInterval: 100,
    numStrikes: 10,
    maxTries: 3,
    entryDiscount: 0.12,
    targetProfit: 0.75,
    mslIncrease: 0.75,
    tslIncrease: 0.10,
  },
];

const DEFAULT_SETTINGS: AppSettings = {
  activeId: 'nifty-weekly',
  profiles: DEFAULT_PROFILES,
  telegramToken: '7657983245:AAEx45-05EZOKANiaEnJV9M4V1zeKqaSgBM',
  telegramChatId: '-1002453329307',
  ltpPollIntervalSec: 5,
  settingsPin: '5599',
};

const SETTINGS_KEY = 'fifto_settings_v5';

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      // Merge saved profiles over defaults (add any new default profiles not saved yet)
      const savedProfiles: StrategyProfile[] = parsed.profiles ?? [];
      const merged = DEFAULT_PROFILES.map(dp => savedProfiles.find(sp => sp.id === dp.id) ?? dp);
      return { activeId: parsed.activeId ?? 'nifty-weekly', profiles: merged, telegramToken: parsed.telegramToken ?? '', telegramChatId: parsed.telegramChatId ?? '', ltpPollIntervalSec: parsed.ltpPollIntervalSec ?? 5, settingsPin: parsed.settingsPin ?? '5599' };
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
}

// ── Morning Check & Gap-Down types ───────────────────────────────────────────
interface MorningCheck {
  ceLTP: number;
  peLTP: number;
  callEntryEOD: number;
  putEntryEOD: number;
  callGapDown: boolean;  // live LTP < EOD entry
  putGapDown: boolean;
  checkedAt: string;
}

interface GapDownStrikeRow {
  strike: number;
  oi: number;
  ltp: number;
  minPrem: number;
  oiMet: boolean;
  premMet: boolean;
  selected: boolean;
}

interface GapDownResult {
  // Step 1 — single candle, both legs use it
  candle: { open: number; high: number; low: number; close: number; timestamp: string };
  // Which legs triggered (CE=gap-down, PE=gap-up)
  ceTriggered: boolean;
  peTriggered: boolean;
  // Step 2 — separate buffers per leg
  ceBuffer: number;   // MROUND(low  × (1−0.125%), 1)
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
  callSelected: { strike: number; ltp: number } | null;
  putSelected:  { strike: number; ltp: number } | null;
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

const fetchNiftyData = async (toDate: string): Promise<{ day1High: number; day1Low: number; day2High: number; day2Low: number } | null> => {
  const cacheKey = `nifty_ohlc_${toDate}`;
  const cached = lsGet<{ day1High: number; day1Low: number; day2High: number; day2Low: number }>(cacheKey);
  if (cached) { console.log('[Cache] OHLC hit for', toDate); return cached; }
  try {
    const res = await apiFetch(`${ANGEL}/angel/historical?toDate=${toDate}`);
    if (!res.ok) throw new Error(`Historical fetch failed: ${res.status}`);
    const data = await res.json();
    lsSet(cacheKey, data); // historical data never changes — cache forever
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

const fetchLiveChain = async (expiry: string, strikes: number[]): Promise<AngelChainRecord[]> => {
  try {
    const p = new URLSearchParams({ expiry, strikes: strikes.join(',') });
    const res = await apiFetch(`${ANGEL}/angel/live-chain?${p}`, 30000);
    if (!res.ok) throw new Error('live-chain failed');
    const json = await res.json();
    return json.data ?? [];
  } catch { return []; }
};

const fetchTrades = async (): Promise<PaperTrade[]> => {
  try { const r = await fetch('/angel/paper-trades'); return r.ok ? r.json() : []; } catch { return []; }
};
const cancelTrade = async (id: string, cancelReason: string) => {
  try { await fetch(`/angel/paper-trades/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'CANCELLED', cancelReason }) }); } catch { /* ignore */ }
};
const fetchEODStore = async () => {
  try { const r = await fetch('/angel/eod-store'); return r.ok ? r.json() : null; } catch { return null; }
};
const syncSettings = (ltpPollIntervalSec: number) => {
  fetch(`${ANGEL}/angel/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ltpPollIntervalSec }) }).catch(() => {});
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

// ── Market open detection (IST = UTC+5:30) ────────────────────────────────────
const isMarketOpen = (): boolean => {
  const utc = Date.now();
  const ist = new Date(utc + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
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

// Effective date to use for data fetch — if selected date is today or future & market open, step back one trading day
const getEffectiveDate = (selectedDate: string): { date: string; marketWasOpen: boolean } => {
  const today = localToday();
  if (selectedDate >= today && isMarketOpen()) {
    return { date: prevTradingDay(today), marketWasOpen: true };
  }
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

const InputField: React.FC<{
  label: string;
  value: number | string;
  onChange: (value: string) => void;
  type?: 'number' | 'text' | 'date';
  prefix?: string;
  min?: number;
  step?: number | 'any';
  disabled?: boolean;
  placeholder?: string;
}> = ({ label, value, onChange, type = 'number', prefix, min, step = 'any', disabled, placeholder }) => (
  <div className="space-y-1">
    <label className="text-sm font-medium text-gray-300">{label}</label>
    <div className="relative">
      {prefix && (
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
          {prefix}
        </span>
      )}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        className={cn(
          "w-full rounded-lg border border-gray-600 px-4 py-2.5 text-gray-100 bg-gray-800",
          "focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent",
          "transition-all duration-200",
          prefix && "pl-8",
          disabled && "bg-gray-700 cursor-not-allowed"
        )}
      />
    </div>
  </div>
);

const StatBox: React.FC<{ label: string; value: string | number; subValue?: string; color?: 'indigo' | 'emerald' | 'rose' | 'amber' | 'purple' }> = ({ 
  label, 
  value, 
  subValue,
  color = 'indigo'
}) => {
  const colorClasses = {
    indigo: 'from-green-700 to-green-800',
    emerald: 'from-green-600 to-green-700',
    rose: 'from-red-600 to-red-700',
    amber: 'from-orange-600 to-orange-700',
    purple: 'from-green-800 to-gray-900'
  };
  
  return (
    <div className={cn(
      "rounded-xl p-4 text-white bg-linear-to-br",
      colorClasses[color]
    )}>
      <p className="text-sm opacity-90">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {subValue && <p className="text-xs opacity-75 mt-1">{subValue}</p>}
    </div>
  );
};

const TradeSignalCard: React.FC<{ signal: TradeSignal; expiry: string; prepDate?: string; prepDay?: string; eodDate?: string }> = ({ signal, expiry, prepDate, prepDay, eodDate }) => {
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
        <button
          onClick={handleCopy}
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

const LoadingSpinner: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex flex-col items-center justify-center py-8">
    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500"></div>
    <p className="mt-4 text-gray-300">{message}</p>
  </div>
);

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
            <th className="pb-1 text-right">Live LTP</th>
            <th className="pb-1 text-right">Min Prem</th>
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
                  {r.ltp > 0 ? `₹${r.ltp.toFixed(1)}` : '—'}
                </td>
                <td className="py-1 text-right text-gray-600">₹{r.minPrem.toFixed(1)}</td>
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
              <h2 className="text-base font-black text-white">Gap-Down Recalculation</h2>
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

            {/* Step 2 — Separate buffers per leg */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={2} title="Buffer — End Strike Boundary (CE uses LOW · PE uses HIGH)" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {data.ceTriggered && (
                  <div className="rounded-lg bg-green-950/30 border border-green-900 p-2">
                    <p className="text-xs font-bold text-green-400 mb-1">CE Gap-Down → 9:30 LOW</p>
                    <p className="text-gray-500 font-mono text-xs">MROUND({data.candle.low.toFixed(2)} × (1−0.125%), 1)</p>
                    <p className="text-gray-500 font-mono text-xs">= MROUND({(data.candle.low * 0.99875).toFixed(4)}, 1)</p>
                    <p className="text-green-300 font-black text-lg">= {data.ceBuffer}</p>
                  </div>
                )}
                {data.peTriggered && (
                  <div className="rounded-lg bg-red-950/30 border border-red-900 p-2">
                    <p className="text-xs font-bold text-red-400 mb-1">PE Gap-Up → 9:30 HIGH</p>
                    <p className="text-gray-500 font-mono text-xs">MROUND({data.candle.high.toFixed(2)} × (1+0.125%), 1)</p>
                    <p className="text-gray-500 font-mono text-xs">= MROUND({(data.candle.high * 1.00125).toFixed(4)}, 1)</p>
                    <p className="text-red-300 font-black text-lg">= {data.peBuffer}</p>
                  </div>
                )}
              </div>
            </section>

            {/* Step 3 — End Strikes */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={3} title="New End Strikes (snap to nearest interval)" />
              <div className="grid grid-cols-2 gap-3">
                {data.ceTriggered && (
                  <div className="rounded-lg bg-green-950/40 border border-green-900 p-2 text-center">
                    <p className="text-xs text-gray-500 mb-1">CALL End Strike</p>
                    <p className="text-xs text-gray-600 font-mono">roundDown({data.ceBuffer}, {cfg.strikeInterval})</p>
                    <p className="text-green-400 font-black text-xl">{data.callEndStrike}</p>
                  </div>
                )}
                {data.peTriggered && (
                  <div className="rounded-lg bg-red-950/40 border border-red-900 p-2 text-center">
                    <p className="text-xs text-gray-500 mb-1">PUT End Strike</p>
                    <p className="text-xs text-gray-600 font-mono">roundUp({data.peBuffer}, {cfg.strikeInterval})</p>
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
              <StepHeader n={5} title={`Live OI + LTP · Min OI: ${MIN_OI().toLocaleString()} · Min Prem: ${(cfg.minPremiumFactor*100).toFixed(2)}%`} />
              <div className={cn('gap-4', data.ceTriggered && data.peTriggered ? 'grid grid-cols-1 sm:grid-cols-2' : 'flex flex-col')}>
                {data.ceTriggered && <div><p className="text-xs font-bold text-green-400 mb-2">CALL CE · {data.callExpiry}</p><StrikeTable rows={data.callRows} type="CE" /></div>}
                {data.peTriggered && <div><p className="text-xs font-bold text-red-400 mb-2">PUT PE · {data.putExpiry}</p><StrikeTable rows={data.putRows} type="PE" /></div>}
              </div>
            </section>

            {/* Step 6 — Selected */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={6} title="Selected Strikes (first passing OI + Premium filter)" />
              <div className="grid grid-cols-2 gap-3">
                {data.ceTriggered && (
                  <div className="rounded-lg bg-green-950/40 border border-green-900 p-2 text-center">
                    <p className="text-xs text-gray-500">CALL CE Selected</p>
                    {data.callSelected
                      ? <><p className="text-green-400 font-black text-xl">{data.callSelected.strike} CE</p><p className="text-xs text-gray-400">Live LTP: ₹{data.callSelected.ltp.toFixed(1)}</p></>
                      : <p className="text-red-400 text-sm font-semibold">No valid strike</p>}
                  </div>
                )}
                {data.peTriggered && (
                  <div className="rounded-lg bg-red-950/40 border border-red-900 p-2 text-center">
                    <p className="text-xs text-gray-500">PUT PE Selected</p>
                    {data.putSelected
                      ? <><p className="text-red-400 font-black text-xl">{data.putSelected.strike} PE</p><p className="text-xs text-gray-400">Live LTP: ₹{data.putSelected.ltp.toFixed(1)}</p></>
                      : <p className="text-red-400 text-sm font-semibold">No valid strike</p>}
                  </div>
                )}
              </div>
            </section>

            {/* Step 7 — New Trade Signals */}
            <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-3">
              <StepHeader n={7} title="New Trade Signals (Live LTP based)" />
              <p className="text-xs text-gray-500 mb-3">
                Entry = LTP×(1−{(cfg.entryDiscount*100).toFixed(0)}%) · Target = Entry×{((1-cfg.targetProfit)*100).toFixed(0)}% · MSL = Entry×{((1+cfg.mslIncrease)*100).toFixed(0)}% · TSL = LTP×{((1+cfg.tslIncrease)*100).toFixed(0)}% · Rounded ₹0.5
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
  telegramChatId: string;
}> = ({ onSuccess, onClose, correctPin, telegramToken, telegramChatId }) => {
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

  const handleForgot = async () => {
    if (!telegramToken || !telegramChatId) { alert('Telegram not configured'); return; }
    await sendTelegramMsg(telegramToken, telegramChatId,
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
  NIFTY:     { pill: 'bg-blue-600',   accent: 'text-blue-400',   border: 'border-blue-600' },
  BANKNIFTY: { pill: 'bg-purple-600', accent: 'text-purple-400', border: 'border-purple-600' },
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
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-200">{label}</p>
        <p className="text-xs text-gray-500">{sub}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <input type="number" step={step} min={min} value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className="w-24 text-right bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
        {suffix && <span className="text-xs text-gray-500 w-8">{suffix}</span>}
      </div>
    </div>
  );

  const PctField = ({ label, sub, value, onChange }: {
    label: string; sub: string; value: number; onChange: (v: number) => void;
  }) => (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-200">{label}</p>
        <p className="text-xs text-gray-500">{sub}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <input type="number" step="0.01" min="0" value={pct(value)}
          onChange={e => onChange(fPct(e.target.value))}
          className="w-24 text-right bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
        <span className="text-xs text-gray-500 w-8">%</span>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{background:'rgba(0,0,0,0.80)', backdropFilter:'blur(6px)'}}>
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">

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
          <div className="grid grid-cols-3 gap-2">
            {appCfg.profiles.map(p => {
              const c = INSTRUMENT_COLOR[p.instrument];
              const isActive = p.id === appCfg.activeId;
              const enabled = true; // all profiles editable in settings once opened (already PIN-protected)
              return (
                <button key={p.id}
                  disabled={!enabled}
                  onClick={() => { if (enabled) setAppCfg(prev => ({ ...prev, activeId: p.id })); }}
                  title={!enabled ? 'Coming soon' : undefined}
                  className={cn(
                    'rounded-xl px-3 py-2.5 text-left border transition-all relative',
                    !enabled
                      ? 'border-gray-800 bg-gray-900/40 opacity-40 cursor-not-allowed'
                      : isActive
                        ? `${c.border} bg-gray-800`
                        : 'border-gray-700 bg-gray-800/40 hover:bg-gray-800'
                  )}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={cn('text-xs font-black px-1.5 py-0.5 rounded text-white', enabled ? c.pill : 'bg-gray-700')}>{p.instrument}</span>
                    <span className="text-xs text-gray-500 font-semibold">{p.expiry}</span>
                    {!enabled && <span className="text-gray-700 text-xs ml-auto">🔒</span>}
                  </div>
                  <p className={cn('text-xs font-semibold leading-tight', isActive ? c.accent : 'text-gray-400')}>{p.name}</p>
                  <p className="text-xs text-gray-600 mt-0.5">Lot: {p.lotSize} · Interval: {p.strikeInterval}</p>
                </button>
              );
            })}
          </div>
          {/* Active profile badge */}
          <div className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border', colors.border, 'bg-gray-800/60')}>
            <span className={cn('text-xs font-bold', colors.accent)}>Editing:</span>
            <span className="text-sm font-black text-white">{activeProfile.name}</span>
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
              <NumField label="Strike Interval" sub={`Spacing between strikes (${activeProfile.instrument === 'NIFTY' ? '50 for NIFTY' : '100 for BankNifty'})`}
                value={activeProfile.strikeInterval} onChange={v => setProfile('strikeInterval', Math.max(1, Math.round(v)))} suffix="pts" step={activeProfile.instrument === 'NIFTY' ? 50 : 100} min={1} />
              <NumField label="Num Strikes" sub="Number of strikes to scan per leg (CALL + PUT)"
                value={activeProfile.numStrikes} onChange={v => setProfile('numStrikes', Math.max(1, Math.round(v)))} step={1} min={1} />
              <NumField label={`Max ${activeProfile.expiry === 'WEEKLY' ? 'Weekly' : 'Monthly'} Expiry Tries`}
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
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-200">Settings PIN</p>
                <p className="text-xs text-gray-500">4-digit PIN to access Settings. Send via Telegram if forgotten.</p>
              </div>
              <input type="password" maxLength={4} pattern="[0-9]*" inputMode="numeric"
                value={appCfg.settingsPin}
                onChange={e => setAppCfg(prev => ({ ...prev, settingsPin: e.target.value.replace(/\D/g,'').slice(0,4) }))}
                className="w-20 text-center bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500 font-mono tracking-widest" />
            </div>
          </section>

          {/* Paper Trade Settings */}
          <section>
            <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3">Paper Trade Tracking</p>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-200">LTP Poll Interval</p>
                <p className="text-xs text-gray-500">How often to refresh live LTP for open positions (min 5s)</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <input type="number" step="1" min="5" max="60" value={appCfg.ltpPollIntervalSec}
                  onChange={e => setAppCfg(prev => ({ ...prev, ltpPollIntervalSec: Math.max(5, parseInt(e.target.value) || 5) }))}
                  className="w-20 text-right bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
                <span className="text-xs text-gray-500 w-8">sec</span>
              </div>
            </div>
          </section>

          {/* Telegram Notifications */}
          <section>
            <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3">Telegram Notifications</p>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-200">Bot Token</p>
                  <p className="text-xs text-gray-500">From @BotFather — keep this private</p>
                </div>
                <input type="password" value={appCfg.telegramToken}
                  onChange={e => setAppCfg(prev => ({ ...prev, telegramToken: e.target.value }))}
                  placeholder="123456:ABC-..."
                  className="w-36 text-right bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-green-500 font-mono" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-200">Chat ID</p>
                  <p className="text-xs text-gray-500">Your user/group ID (use @userinfobot)</p>
                </div>
                <input type="text" value={appCfg.telegramChatId}
                  onChange={e => setAppCfg(prev => ({ ...prev, telegramChatId: e.target.value }))}
                  placeholder="-100123456"
                  className="w-36 text-right bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-green-500 font-mono" />
              </div>
              {appCfg.telegramToken && appCfg.telegramChatId && (
                <button onClick={async () => {
                    const ok = await sendTelegramMsg(appCfg.telegramToken, appCfg.telegramChatId,
                      '✅ <b>FiFTO Trading Secret</b>\nTelegram notifications are working!');
                    alert(ok ? '✅ Test message sent!' : '❌ Failed — check token and chat ID');
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
    syncSettings(s.ltpPollIntervalSec);
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
  const [tradesLoading, setTradesLoading] = useState(false);
  const [serverEOD, setServerEOD] = useState<{
    strategyName: string;
    callTrade: { strike: number; entryPrice: number; target: number; stopLoss: number; isValid: boolean } | null;
    putTrade:  { strike: number; entryPrice: number; target: number; stopLoss: number; isValid: boolean } | null;
    callExpiry: string; putExpiry: string;
    prepDate: string; prepDay: string; eodDate: string;
  } | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [showAddPosition, setShowAddPosition] = useState(false);
  const [addPositionUnlocked, setAddPositionUnlocked] = useState(false);
  const [showAddPinModal, setShowAddPinModal] = useState(false);
  const [strategiesUnlocked, setStrategiesUnlocked] = useState(false);
  const [showStrategyPinModal, setShowStrategyPinModal] = useState(false);
  const [detailTrade, setDetailTrade] = useState<PaperTrade | null>(null);
  const [addForm, setAddForm] = useState({
    optType: 'CE' as 'CE' | 'PE',
    strike: '',
    expiry: '',
    entryPrice: '',
    entryDate: '',
    entryTime: '09:40',
    lotSize: String(getCfg().lotSize),
    targetPrice: '',
    stopLoss: '',
  });
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

  // ── Toast notifications ───────────────────────────────────────────────────
  interface Toast { id: number; type: 'success'|'warning'|'danger'|'info'; title: string; body: string; }
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((type: Toast['type'], title: string, body: string) => {
    const id = ++toastIdRef.current;
    setToasts(p => [...p.slice(-2), { id, type, title, body }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 5000);
  }, []);

  // Track previous trade states to detect changes
  const prevTradesRef = useRef<PaperTrade[]>([]);
  const nearAlertedRef = useRef<Set<string>>(new Set());
  const [expirySearchStatus, setExpirySearchStatus] = useState<string>('');
  // Manual OHLC override (optional — filled before Run to skip auto-fetch)
  const [manualOHLC, setManualOHLC] = useState({ d1h: '', d1l: '', d2h: '', d2l: '' });
  const [showManual, setShowManual] = useState(false);
  // Morning check & gap-down
  const [morningCheck, setMorningCheck]   = useState<MorningCheck | null>(null);
  const [isCheckingLTP, setIsCheckingLTP] = useState(false);
  const [gapDownData, setGapDownData]     = useState<GapDownResult | null>(null);
  const [isGapDownCalc, setIsGapDownCalc] = useState(false);
  const [showGapDown, setShowGapDown]     = useState(false);
  
  // Default to today's date (or restore saved date if available)
  useEffect(() => {
    setNextTradingDate(_saved?.marketData?.effectiveDataDate ?? localToday());
  }, []);

  // Poll trades every N seconds when on Trades page
  useEffect(() => {
    if (activePage !== 'trades') return;
    const refresh = async () => {
      setTradesLoading(true);
      const [trades, eod] = await Promise.all([fetchTrades(), fetchEODStore()]);
      setPaperTrades(trades);
      setServerEOD(eod);
      setTradesLoading(false);

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
    const iv = setInterval(refresh, (appSettings.ltpPollIntervalSec ?? 5) * 1000);
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

    // ── Step 1: Fetch NIFTY OHLC (or reuse edited marketData values) ────────
    const { date: effectiveDate, marketWasOpen } = getEffectiveDate(nextTradingDate);

    // If marketData already loaded for this date, use its current values (may have been edited inline)
    const existingForDate = marketData?.effectiveDataDate === effectiveDate;

    let data: { day1High: number; day1Low: number; day2High: number; day2Low: number; day1Date?: string; day2Date?: string } | null = null;
    if (existingForDate && marketData) {
      data = { day1High: marketData.day1High, day1Low: marketData.day1Low, day2High: marketData.day2High, day2Low: marketData.day2Low, day1Date: marketData.day1Date, day2Date: marketData.day2Date };
    } else {
      setIsFetching(true);
      data = await fetchNiftyData(effectiveDate);
      setIsFetching(false);
    }

    if (!data) {
      setFetchError('Failed to fetch NIFTY data from Angel One. Check angel-config.json.');
      return;
    }

    const today = new Date();
    const todayStr = localToday();
    // Preparation date = next trading day after the EOD data date
    // e.g. EOD = Friday → preparation = Monday → strike selection uses Next Week
    const { date: prepDate, day: prepDay } = getNextTradingDay(new Date(effectiveDate));
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
        const optDLL = ohlc?.twoDLL ?? calcResult.twoDLL;
        const optDHH = ohlc?.twoDHH ?? calcResult.twoDHH;
        const entryPrice = roundHalf(optDLL * (1 - ENTRY_DISCOUNT()));
        const target     = roundHalf(entryPrice * (1 - TARGET_PROFIT()));
        const msl        = roundHalf(entryPrice * (1 + MSL_INCREASE()));
        const tsl        = roundHalf(optDHH * (1 + TSL_INCREASE()));
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
      }
    } catch {
      setLtpFetchStatus('error');
      setExpirySearchStatus('');
    } finally {
      setIsFetchingLTPs(false);
    }
  };
  
  const updateMarketData = (field: keyof MarketData, value: string) => {
    setMarketData(prev => {
      if (!prev) return null;
      // Convert to number for numeric fields, preserving decimals
      const numericFields: (keyof MarketData)[] = ['day1High', 'day1Low', 'day2High', 'day2Low'];
      if (numericFields.includes(field)) {
        const numValue = parseFloat(value) || 0;
        return { ...prev, [field]: numValue };
      }
      return { ...prev, [field]: value };
    });
  };

  // ── Morning Check: fetch live LTP vs EOD entry ──────────────────────────────
  const handleMorningCheck = async () => {
    if (!result?.callTrade?.isValid && !result?.putTrade?.isValid) return;
    setIsCheckingLTP(true);
    try {
      const { ceLTP, peLTP } = await fetchLiveLTPs(
        callExpiryUsed, result?.callTrade?.strike ?? 0,
        putExpiryUsed,  result?.putTrade?.strike  ?? 0,
      );
      const callEntry = result?.callTrade?.entryPrice ?? 0;
      const putEntry  = result?.putTrade?.entryPrice  ?? 0;
      const callGapDown = result?.callTrade?.isValid ? ceLTP < callEntry : false;
      const putGapDown  = result?.putTrade?.isValid  ? peLTP  < putEntry  : false;
      const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      setMorningCheck({ ceLTP, peLTP, callEntryEOD: callEntry, putEntryEOD: putEntry, callGapDown, putGapDown, checkedAt: now });

      // ── Telegram notification ──────────────────────────────────────────────
      const { telegramToken: tok, telegramChatId: cid } = appSettings;
      if (tok && cid) {
        const profile = getCfg();
        const ceStrike = result?.callTrade?.strike;
        const peStrike = result?.putTrade?.strike;
        const ceExp = callExpiryUsed || expiryUsed;
        const peExp = putExpiryUsed  || expiryUsed;

        let msg = `🔔 <b>FiFTO Trading Secret</b>\n📊 <b>${profile.name} — Morning Check</b>\n⏰ ${now}\n━━━━━━━━━━━━━━━━━━━━\n`;

        if (result?.callTrade?.isValid) {
          msg += callGapDown
            ? `📉 <b>CE ${ceStrike} · ${ceExp}</b>\nLTP ₹${ceLTP.toFixed(1)} &lt; Entry ₹${callEntry.toFixed(1)} → <b>⚠️ Gap-Down — Skip</b>\n`
            : `✅ <b>CE ${ceStrike} · ${ceExp}</b>\nLTP ₹${ceLTP.toFixed(1)} ≥ Entry ₹${callEntry.toFixed(1)} → <b>Safe to Enter</b>\n`;
        }
        msg += `\n`;
        if (result?.putTrade?.isValid) {
          msg += putGapDown
            ? `📈 <b>PE ${peStrike} · ${peExp}</b>\nLTP ₹${peLTP.toFixed(1)} &lt; Entry ₹${putEntry.toFixed(1)} → <b>⚠️ Gap-Up — Skip</b>\n`
            : `✅ <b>PE ${peStrike} · ${peExp}</b>\nLTP ₹${peLTP.toFixed(1)} ≥ Entry ₹${putEntry.toFixed(1)} → <b>Safe to Enter</b>\n`;
        }
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        if (!callGapDown && !putGapDown) {
          msg += `✅ <b>Both legs safe — place orders at EOD entry prices</b>`;
        } else {
          msg += `⚡ Running recalculation for triggered leg(s)…`;
        }
        sendTelegramMsg(tok, cid, msg);
      }
    } finally {
      setIsCheckingLTP(false);
    }
  };

  // ── Gap-Down (CE) / Gap-Up (PE) Recalculation ───────────────────────────────
  const handleGapDownRecalc = async () => {
    if (!marketData || !morningCheck) return;
    setIsGapDownCalc(true);
    setShowGapDown(true);
    try {
      const cfg = getCfg();
      const GAP_BUFFER = 0.00125; // 0.125%
      const callExpiry = callExpiryUsed || expiryUsed;
      const putExpiry  = putExpiryUsed  || expiryUsed;
      const ceTriggered = morningCheck.callGapDown;
      const peTriggered = morningCheck.putGapDown;

      // Step 1 — fetch NIFTY 09:15–09:30 candle (one fetch covers both legs)
      const candle = await fetchNiftyCandle(marketData.preparationDate);
      if (!candle) { setIsGapDownCalc(false); return; }

      // Step 2 — separate buffers
      // CE (gap-down): use candle LOW  → MROUND(low  × (1 − 0.125%), 1)
      // PE (gap-up):   use candle HIGH → MROUND(high × (1 + 0.125%), 1)
      const ceBuffer = Math.round(candle.low  * (1 - GAP_BUFFER));
      const peBuffer = Math.round(candle.high * (1 + GAP_BUFFER));

      // Step 3 — snap to nearest strike interval
      const callEndStrike = roundToNearestStrike(ceBuffer, false); // round down
      const putEndStrike  = roundToNearestStrike(peBuffer, true);  // round up

      // Step 4 — generate 10-strike ranges OTM → ITM
      // CALL: high (OTM) → callEndStrike (ITM)
      const callRange = ceTriggered
        ? generateStrikeRange(callEndStrike, 'up').reverse()
        : [];
      // PUT: low (OTM) → putEndStrike (ITM)
      const putRange = peTriggered
        ? generateStrikeRange(putEndStrike - (NUM_STRIKES() - 1) * STRIKE_INTERVAL(), 'up')
        : [];

      // Step 5 — fetch live chain only for triggered legs
      const [ceChain, peChain] = await Promise.all([
        ceTriggered ? fetchLiveChain(callExpiry, callRange) : Promise.resolve([]),
        peTriggered ? fetchLiveChain(putExpiry,  putRange)  : Promise.resolve([]),
      ]);

      type OptData = { lastPrice: number; openInterest: number } | undefined;
      const toMap = (chain: AngelChainRecord[], type: 'CE' | 'PE') =>
        new Map<number, OptData>(chain.map(r => [r.strikePrice, type === 'CE' ? r.CE : r.PE]));
      const ceMap = toMap(ceChain, 'CE');
      const peMap = toMap(peChain, 'PE');

      const minOI = MIN_OI();
      const minPF = MIN_PREMIUM_FACTOR();

      const buildRows = (range: number[], map: Map<number, OptData>, selStrike: number | null): GapDownStrikeRow[] =>
        range.map(strike => {
          const d = map.get(strike);
          const ltp = d?.lastPrice ?? 0;
          const oi  = d?.openInterest ?? 0;
          const minPrem = strike * minPF;
          return { strike, oi, ltp, minPrem, oiMet: oi === 0 || oi >= minOI, premMet: ltp >= minPrem, selected: strike === selStrike };
        });

      // Step 6 — select first valid strike
      const selectStrike = (range: number[], map: Map<number, OptData>) => {
        for (const strike of range) {
          const d = map.get(strike);
          if (!d || !d.lastPrice || d.lastPrice <= 0) continue;
          if (d.openInterest > 0 && d.openInterest < minOI) continue;
          if (d.lastPrice < strike * minPF) continue;
          return { strike, ltp: d.lastPrice };
        }
        return null;
      };

      const callSel = ceTriggered ? selectStrike(callRange, ceMap) : null;
      const putSel  = peTriggered ? selectStrike(putRange,  peMap) : null;

      // Step 7 — trade signals (live LTP based)
      const buildGapTrade = (
        type: 'CALL' | 'PUT',
        sel: { strike: number; ltp: number } | null,
        triggered: boolean,
        expiry: string,
        range: number[],
        scenario: string,
      ): TradeSignal | null => {
        if (!triggered) return null; // leg not triggered — keep EOD signal
        if (!sel) return { type, strike: 0, entryPrice: 0, target: 0, stopLoss: 0, msl: 0, tsl: 0, optionOHLC: null, contractType: 'Current Week', reason: `No valid strike found after ${scenario} recalc`, isValid: false, strikeRange: range };
        const entryPrice = roundHalf(sel.ltp * (1 - cfg.entryDiscount));
        const target     = roundHalf(entryPrice * (1 - cfg.targetProfit));
        const msl        = roundHalf(entryPrice * (1 + cfg.mslIncrease));
        const tsl        = roundHalf(sel.ltp    * (1 + cfg.tslIncrease));
        const stopLoss   = roundHalf(Math.min(msl, tsl));
        const contractType: 'Current Week' | 'Next Week' = expiry === (callExpiryUsed || expiryUsed) ? 'Current Week' : 'Next Week';
        return { type, strike: sel.strike, entryPrice, target, stopLoss, msl, tsl, optionOHLC: null, contractType, reason: `${scenario} Recalc | Live LTP: ₹${sel.ltp}`, isValid: true, strikeRange: range };
      };

      const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

      // ── Telegram notification ──────────────────────────────────────────────
      const { telegramToken: tok2, telegramChatId: cid2 } = appSettings;
      if (tok2 && cid2) {
        const profile = getCfg();
        let msg = `🔔 <b>FiFTO Trading Secret</b>\n⚡ <b>${profile.name} — Recalculated Signals</b>\n⏰ ${now}\n━━━━━━━━━━━━━━━━━━━━\n`;
        const callT = ceTriggered ? buildGapTrade('CALL', callSel, true, callExpiry, callRange, 'Gap-Down CE') : null;
        const putT  = peTriggered ? buildGapTrade('PUT',  putSel,  true, putExpiry,  putRange,  'Gap-Up PE')  : null;
        if (callT) {
          msg += callT.isValid
            ? `📉 <b>CE Gap-Down → ${callT.strike} CE · ${callExpiry}</b>\n🎯 Entry ₹${callT.entryPrice.toFixed(1)} | Target ₹${callT.target.toFixed(1)} | SL ₹${callT.stopLoss.toFixed(1)}\n`
            : `📉 CE Gap-Down → No valid strike found\n`;
          msg += `\n`;
        }
        if (putT) {
          msg += putT.isValid
            ? `📈 <b>PE Gap-Up → ${putT.strike} PE · ${putExpiry}</b>\n🎯 Entry ₹${putT.entryPrice.toFixed(1)} | Target ₹${putT.target.toFixed(1)} | SL ₹${putT.stopLoss.toFixed(1)}\n`
            : `📈 PE Gap-Up → No valid strike found\n`;
        }
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `📅 Prep: ${marketData?.preparationDate ?? ''} (${marketData?.preparationDay ?? ''})`;
        sendTelegramMsg(tok2, cid2, msg);
      }

      setGapDownData({
        candle: { ...candle, timestamp: String(candle.timestamp) },
        ceTriggered, peTriggered,
        ceBuffer, peBuffer,
        callEndStrike, putEndStrike,
        callRange, putRange,
        callRows: buildRows(callRange, ceMap, callSel?.strike ?? null),
        putRows:  buildRows(putRange,  peMap, putSel?.strike  ?? null),
        callSelected: callSel, putSelected: putSel,
        callTrade: buildGapTrade('CALL', callSel, ceTriggered, callExpiry, callRange, 'Gap-Down CE'),
        putTrade:  buildGapTrade('PUT',  putSel,  peTriggered, putExpiry,  putRange,  'Gap-Up PE'),
        callExpiry, putExpiry,
        calculatedAt: now,
      });
    } finally {
      setIsGapDownCalc(false);
    }
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
        telegramChatId={appSettings.telegramChatId}
        onClose={() => setShowStrategyPinModal(false)}
        onSuccess={() => { setStrategiesUnlocked(true); setShowStrategyPinModal(false); }}
      />}
      {showAddPinModal && <PinModal
        correctPin={appSettings.settingsPin}
        telegramToken={appSettings.telegramToken}
        telegramChatId={appSettings.telegramChatId}
        onClose={() => setShowAddPinModal(false)}
        onSuccess={() => { setAddPositionUnlocked(true); setShowAddPinModal(false); setShowAddPosition(true); }}
      />}
      {showPinModal && <PinModal
        correctPin={appSettings.settingsPin}
        telegramToken={appSettings.telegramToken}
        telegramChatId={appSettings.telegramChatId}
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
                  {t.exitReason === 'EXPIRY' && <Row label="Exit Reason" value="Nifty Weekly Rollover (03:00 PM)" valueClass="text-violet-400" />}
                  {t.slNeedsRecalc && <Row label="SL Status" value="⚠️ Flagged for 09:30:01 recalc" valueClass="text-amber-400" />}
                  {t.carryToNextDay && <Row label="Carry" value="📅 Carried · Target:09:15 · SL:09:25" valueClass="text-amber-400" />}
                </div>

                {/* Timestamps */}
                <p className="text-xs font-bold text-gray-600 uppercase tracking-widest mt-3 mb-1">Timeline</p>
                <div className="rounded-xl bg-gray-800/50 border border-gray-700 px-3 divide-y divide-gray-800">
                  <Row label="Placed" value={fmt(t.placedAt)} />
                  {t.triggeredAt && <Row label="Triggered" value={`${fmt(t.triggeredAt)}  @  ₹${t.triggeredLTP?.toFixed(1) ?? '—'}`} valueClass="text-blue-400" />}
                  {t.exitAt && <Row label="Closed" value={`${fmt(t.exitAt)}  @  ₹${t.exitPrice?.toFixed(1) ?? '—'}`} valueClass={t.pnl !== undefined && t.pnl >= 0 ? 'text-green-400' : 'text-red-400'} />}
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
          const open = paperTrades.filter(t => t.status === 'PENDING' || t.status === 'TRIGGERED');
          const closed = paperTrades.filter(t => !['PENDING','TRIGGERED'].includes(t.status));
          const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
          const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;

          const CANCEL_REASONS = ['Gap-Down','Gap-Up','Low OI','Low Volume','Manual Override','Wrong Strike','Market Condition','Other'];

          const TradeCard = ({ t }: { t: PaperTrade }) => {
            const m = STATUS_META[t.status];
            const isCall = t.optType === 'CE';
            const orderAmt = (t.entryPrice * t.lotSize).toFixed(0);
            const isCanceling = cancelingId === t.id;
            const isOpen = t.status === 'PENDING' || t.status === 'TRIGGERED';

            const doCancel = async () => {
              if (!cancelReason.trim()) return;
              await cancelTrade(t.id, cancelReason.trim());
              setCancelingId(null); setCancelReason('');
              setPaperTrades(await fetchTrades());
            };

            return (
              <div className={cn('rounded-xl border overflow-hidden cursor-pointer', m.border)} onClick={() => setDetailTrade(t)}>
                <div className={cn('p-3 space-y-2', m.bg)}>
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
                    {t.status === 'PENDING' && (
                      <button onClick={e => { e.stopPropagation(); setCancelingId(isCanceling ? null : t.id); setCancelReason(''); }}
                        className={cn('text-xs font-semibold border px-2.5 py-1 rounded-lg transition-all', isCanceling ? 'border-red-600 text-red-400 bg-red-950/30' : 'border-gray-700 text-gray-500 hover:border-red-700 hover:text-red-400')}>
                        {isCanceling ? '✕ Close' : 'Cancel Order'}
                      </button>
                    )}
                  </div>

                  {/* Prices */}
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

                  {/* Footer */}
                  <div className="flex items-center justify-between text-xs text-gray-500 flex-wrap gap-1">
                    <span>💼 1 Lot ({t.lotSize} qty) · ₹{orderAmt}</span>
                    {t.pnl !== undefined && <span className={cn('font-black text-sm', t.pnl >= 0 ? 'text-green-400' : 'text-red-400')}>{t.pnl >= 0 ? '+' : ''}₹{t.pnl.toFixed(0)}</span>}
                    {t.exitPrice && <span>Closed ₹{t.exitPrice.toFixed(1)} · ₹{(t.exitPrice * t.lotSize).toFixed(0)}{t.exitReason === 'EXPIRY' ? ' · Expiry 03:00 PM' : ''}</span>}
                    <span>{t.carryToNextDay ? 'Carried from previous day' : `Placed ${new Date(t.placedAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})} IST`}</span>
                  </div>
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
                      <span className="text-xs text-green-600">Prepared · pending morning check</span>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-black text-green-400">{serverEOD.prepDate}</p>
                      <p className="text-xs text-green-700">{serverEOD.prepDay} · Execute at <span className="text-green-400 font-bold">09:25 AM</span></p>
                    </div>
                  </div>
                  <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {([
                      { trade: serverEOD.callTrade, expiry: serverEOD.callExpiry, optType: 'CE', color: 'border-green-800 bg-green-950/20' },
                      { trade: serverEOD.putTrade,  expiry: serverEOD.putExpiry,  optType: 'PE', color: 'border-red-800   bg-red-950/20'   },
                    ] as const).map(({ trade, expiry, optType, color }) => {
                      if (!trade?.isValid) return null;
                      const isCE = optType === 'CE';
                      const openTrade = open.find(t => t.optType === optType);
                      const alreadyPlaced = !!openTrade;
                      // If open trade exists, show its actual values; otherwise show EOD planned values
                      const dispStrike  = alreadyPlaced ? openTrade!.strike                 : trade.strike;
                      const dispExpiry  = alreadyPlaced ? openTrade!.expiry                 : expiry;
                      const dispEntry   = alreadyPlaced ? openTrade!.entryPrice             : trade.entryPrice;
                      const dispTarget  = alreadyPlaced ? openTrade!.targetPrice            : (trade.target ?? 0);
                      const dispSL      = alreadyPlaced ? openTrade!.stopLoss               : trade.stopLoss;
                      const dispLTP     = alreadyPlaced ? (openTrade!.currentLTP ?? null)   : null;
                      const isRecalc    = alreadyPlaced && openTrade!.strike !== trade.strike;
                      return (
                        <div key={optType}
                          className={cn('rounded-xl border p-3 transition-all', color)}
                          style={alreadyPlaced ? { boxShadow: isCE ? '0 0 16px rgba(34,197,94,0.35), inset 0 0 12px rgba(34,197,94,0.08)' : '0 0 16px rgba(239,68,68,0.35), inset 0 0 12px rgba(239,68,68,0.08)' } : {}}>
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span className={cn('px-2 py-0.5 rounded-full text-xs font-black text-white', isCE ? 'bg-green-600' : 'bg-red-600')}>{optType}</span>
                            <span className="text-white font-black text-xl">{dispStrike}</span>
                            <span className="text-gray-500 text-xs">{dispExpiry}</span>
                            {alreadyPlaced && <span className="text-xs font-bold px-1.5 py-0.5 rounded-full border" style={isCE ? {color:'#4ade80',borderColor:'#16a34a',background:'rgba(22,163,74,0.15)'} : {color:'#f87171',borderColor:'#dc2626',background:'rgba(220,38,38,0.15)'}}>✓ Order Active</span>}
                            {isRecalc && (
                              <span className="text-xs font-bold px-1.5 py-0.5 rounded-full border border-amber-700 text-amber-400" style={{background:'rgba(180,83,9,0.15)'}}>
                                ⚡ Gap-Down Recalc
                              </span>
                            )}
                            {alreadyPlaced && dispLTP != null && (
                              <span className="text-xs font-semibold text-gray-400">LTP: <span className={dispLTP <= dispTarget ? 'text-green-400' : dispLTP >= dispSL ? 'text-red-400' : 'text-white'}>₹{dispLTP.toFixed(1)}</span></span>
                            )}
                          </div>
                          {isRecalc && (
                            <div className="mb-2 px-2 py-1 rounded-lg text-xs text-amber-600 border border-amber-900/50" style={{background:'rgba(120,53,15,0.12)'}}>
                              📋 EOD planned <span className="font-bold text-amber-500">{optType} {trade.strike}</span> → recalculated to <span className="font-bold text-amber-300">{optType} {openTrade!.strike}</span> after Gap-Down
                            </div>
                          )}
                          <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
                            <div className="rounded bg-gray-800/50 py-1.5"><p className="text-gray-500">Entry</p><p className="font-black text-white">₹{dispEntry.toFixed(1)}</p></div>
                            <div className="rounded bg-gray-800/50 py-1.5"><p className="text-gray-500">Target</p><p className="font-black text-green-400">₹{dispTarget.toFixed(1)}</p></div>
                            <div className="rounded bg-gray-800/50 py-1.5"><p className="text-gray-500">SL</p><p className="font-black text-red-400">₹{dispSL.toFixed(1)}</p></div>
                          </div>
                          <p className="text-xs text-gray-600 mt-1.5 text-center">
                            {alreadyPlaced
                              ? `Open · Triggered ${openTrade!.triggeredAt ? new Date(openTrade!.triggeredAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false}) : ''} IST · ${openTrade!.strategyName}`
                              : `EOD: ${serverEOD.eodDate} · ${serverEOD.strategyName}`}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Open Positions */}
              <div className="rounded-2xl border border-gray-700 overflow-hidden">
                <div className="px-4 py-3 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-base">📊</span>
                    <h2 className="text-sm font-black text-white">Open Positions</h2>
                    {tradesLoading && <span className="text-xs text-gray-600 animate-pulse">refreshing…</span>}
                  </div>
                  <button onClick={() => {
                      if (showAddPosition) { setShowAddPosition(false); return; }
                      if (addPositionUnlocked) { setShowAddPosition(true); }
                      else { setShowAddPinModal(true); }
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border border-gray-600 text-gray-400 hover:border-green-700 hover:text-green-400 transition-all">
                    {showAddPosition ? '✕ Close' : (
                      <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={addPositionUnlocked ? 'M8 11V7a4 4 0 018 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z' : 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z'}/></svg>+ Add Position</>
                    )}
                  </button>
                </div>
                {/* Add Position Form */}
                {showAddPosition && (() => {
                  const cfg2 = getCfg();
                  const calcFromEntry = (ep: number) => ({
                    targetPrice: String(roundHalf(ep * (1 - cfg2.targetProfit))),
                    stopLoss:    String(roundHalf(ep * (1 + cfg2.mslIncrease))),
                  });
                  const setField = (k: keyof typeof addForm, v: string) =>
                    setAddForm(prev => {
                      const next = { ...prev, [k]: v };
                      if (k === 'entryPrice') {
                        const ep = parseFloat(v);
                        if (ep > 0) Object.assign(next, calcFromEntry(ep));
                      }
                      return next;
                    });

                  const handleAdd = async () => {
                    const ep = parseFloat(addForm.entryPrice);
                    if (!addForm.strike || !addForm.expiry || !ep || !addForm.entryDate) return;
                    const istOffset = 5.5 * 60 * 60 * 1000;
                    const dt = new Date(`${addForm.entryDate}T${addForm.entryTime}:00`);
                    const trade: PaperTrade = {
                      id: `manual_${Date.now()}`,
                      date: addForm.entryDate,
                      type: addForm.optType === 'CE' ? 'CALL' : 'PUT',
                      optType: addForm.optType,
                      strike: parseInt(addForm.strike),
                      expiry: addForm.expiry.toUpperCase(),
                      strategyName: getCfg().name ?? 'NIFTY Weekly Selling',
                      lotSize: parseInt(addForm.lotSize) || cfg2.lotSize,
                      entryPrice: ep,
                      targetPrice: parseFloat(addForm.targetPrice) || roundHalf(ep * (1 - cfg2.targetProfit)),
                      stopLoss:    parseFloat(addForm.stopLoss)    || roundHalf(ep * (1 + cfg2.mslIncrease)),
                      status: 'TRIGGERED',
                      placedAt: new Date(dt.getTime() - istOffset).toISOString(),
                      triggeredAt: new Date(dt.getTime() - istOffset).toISOString(),
                      triggeredLTP: ep,
                      carryToNextDay: addForm.entryDate < new Date().toISOString().slice(0,10),
                    };
                    const r = await fetch('/angel/paper-trades', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(trade) });
                    if (!r.ok) { alert('Failed to save trade'); return; }
                    setShowAddPosition(false);
                    setAddForm({ optType:'CE', strike:'', expiry:'', entryPrice:'', entryDate:'', entryTime:'09:40', lotSize: String(cfg2.lotSize), targetPrice:'', stopLoss:'' });
                    setPaperTrades(await fetchTrades());
                    setServerEOD(await fetchEODStore());
                  };

                  return (
                    <div className="border-b border-gray-700 bg-gray-800/40 px-3 py-3 space-y-3">
                      <p className="text-xs font-bold text-green-400 uppercase tracking-widest">Add Existing Position</p>
                      {/* CE / PE toggle */}
                      <div className="flex gap-2">
                        {(['CE','PE'] as const).map(o => (
                          <button key={o} onClick={() => setField('optType', o)}
                            className={cn('flex-1 py-1.5 rounded-lg text-xs font-black border transition-all', addForm.optType === o ? (o==='CE' ? 'bg-green-700 border-green-600 text-white' : 'bg-red-700 border-red-600 text-white') : 'border-gray-700 text-gray-500 hover:text-gray-300')}>
                            {o}
                          </button>
                        ))}
                      </div>
                      {/* Fields grid */}
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          { key:'strike',     label:'Strike',       ph:'24000',        type:'number' },
                          { key:'expiry',     label:'Expiry',       ph:'28APR2026',    type:'text'   },
                          { key:'entryPrice', label:'Entry Price ₹', ph:'186',         type:'number' },
                          { key:'entryDate',  label:'Entry Date',   ph:'',             type:'date'   },
                          { key:'entryTime',  label:'Entry Time',   ph:'09:40',        type:'time'   },
                          { key:'lotSize',    label:'Lot Size',     ph:'65',           type:'number' },
                          { key:'targetPrice',label:'Target ₹',     ph:'auto-calc',   type:'number' },
                          { key:'stopLoss',   label:'Stop Loss ₹',  ph:'auto-calc',   type:'number' },
                        ] as const).map(({ key, label, ph, type }) => (
                          <div key={key} className="rounded-lg bg-gray-900 border border-gray-700 px-2.5 py-2 focus-within:border-green-700 transition-all">
                            <p className="text-xs text-gray-500 mb-1">{label}</p>
                            <input type={type} value={addForm[key]} onChange={e => setField(key, e.target.value)}
                              placeholder={ph}
                              className="w-full bg-transparent text-white text-sm outline-none font-mono placeholder-gray-700" />
                          </div>
                        ))}
                      </div>
                      {/* Preview */}
                      {addForm.strike && addForm.entryPrice && (
                        <div className="rounded-lg bg-gray-900 border border-gray-700 px-3 py-2 text-xs text-gray-400 flex flex-wrap gap-3">
                          <span className={cn('font-black', addForm.optType==='CE' ? 'text-green-400' : 'text-red-400')}>{addForm.optType} {addForm.strike}</span>
                          <span>Entry ₹{addForm.entryPrice}</span>
                          <span className="text-green-400">Target ₹{addForm.targetPrice}</span>
                          <span className="text-red-400">SL ₹{addForm.stopLoss}</span>
                          <span>× {addForm.lotSize} = ₹{(parseFloat(addForm.entryPrice||'0') * parseInt(addForm.lotSize||'0')).toFixed(0)}</span>
                        </div>
                      )}
                      <button onClick={handleAdd}
                        disabled={!addForm.strike || !addForm.expiry || !addForm.entryPrice || !addForm.entryDate}
                        className="w-full py-2 rounded-lg text-xs font-black text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                        style={{background:'linear-gradient(135deg,#16a34a,#15803d)'}}>
                        Add Position to Trades
                      </button>
                    </div>
                  );
                })()}

                <div className="p-3 space-y-3">
                  {open.length === 0 ? (
                    <p className="text-center text-gray-600 text-sm py-6">No open positions</p>
                  ) : (
                    open.map(t => <TradeCard key={t.id} t={t} />)
                  )}
                </div>
              </div>

              {/* History */}
              {closed.length > 0 && (
                <div className="rounded-2xl border border-gray-700 overflow-hidden">
                  <div className="px-4 py-3 bg-gray-800 border-b border-gray-700 flex items-center gap-2">
                    <span className="text-base">📜</span>
                    <h2 className="text-sm font-black text-white">Trade History</h2>
                    <span className="text-xs text-gray-600">({closed.length} trades)</span>
                  </div>
                  <div className="p-3 space-y-2">
                    {[...closed].reverse().map(t => <TradeCard key={t.id} t={t} />)}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Document Page ── */}
        {activePage === 'schedule' && (
          <div className="space-y-4 max-w-3xl mx-auto">

            {/* Title */}
            <div className="rounded-2xl border border-green-900/50 overflow-hidden" style={{background:'linear-gradient(135deg,#052e16,#111827)'}}>
              <div className="px-5 py-4">
                <div className="flex items-center gap-3 mb-1">
                  <div className="h-9 w-9 rounded-lg bg-white flex items-center justify-center shadow overflow-hidden shrink-0">
                    <img src="/fifto-logo.png" alt="FiFTO" className="h-full w-full object-contain" />
                  </div>
                  <div>
                    <h1 className="text-lg font-black text-white">FiFTO Trading Secret</h1>
                    <p className="text-green-400 text-xs">NIFTY Weekly Option Selling — System Documentation</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-2">Strategy: Sell OTM CE & PE based on 2-day price levels. Entry via breakout sell limit. Exit at Target or Stop Loss.</p>
              </div>
            </div>

            {/* ── Daily Schedule ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">🕐 Automated Daily Schedule <span className="text-gray-500 font-normal text-xs ml-1">All IST · Weekdays only</span></h2>
              </div>
              <div className="divide-y divide-gray-800/60">
                {([
                  { time:'Boot / Login', badge:'Server',  badgeColor:'bg-gray-700',        icon:'🖥️', color:'text-gray-300', rows:[
                    'Auto-starts on ports 3001 (Angel) & 8008 (Vite)',
                    'Loads last EOD signals from server-cache/eod_store.json',
                    'Starts LTP polling every 5 sec for open paper trades',
                  ], tg: null },
                  { time:'08:45 AM', badge:'Auto',    badgeColor:'bg-blue-700',         icon:'⚙️', color:'text-blue-300', rows:[
                    'Fetches NIFTY 2-day OHLC from Angel One',
                    'Calculates 2DHH · 2DLL → strike boundaries (±0.15%)',
                    'Generates 10-strike range for CE & PE',
                    'Fetches option chain → OI filter (≥32,500) + Premium filter (≥0.85% of strike)',
                    'Selects first valid strike OTM→ITM',
                    'Fetches selected option 2D OHLC → Entry/Target/SL (rounded ₹0.5)',
                    'Saves to disk. Skips leg if that option type is already in holding',
                  ], tg: null },
                  { time:'09:00 AM', badge:'Telegram', badgeColor:'bg-green-700',        icon:'🔔', color:'text-green-300', rows:[
                    'Sends morning reminder with full EOD signals',
                  ], tg:'Strike · Entry · Target · SL for CE & PE\nPrep date · EOD data date' },
                  { time:'09:25 AM', badge:'Auto',    badgeColor:'bg-yellow-700',       icon:'🔍', color:'text-yellow-300', rows:[
                    'Fetches live LTP of selected CE & PE strikes',
                    'CE: if LTP < EOD Entry → Gap-Down (market fell, CE cheaper)',
                    'PE: if LTP < EOD Entry → Gap-Up   (market rose, PE cheaper)',
                    'Safe legs → paper trade order placed immediately (PENDING)',
                  ], tg:'✅ Both safe — orders placed at EOD entry\nOR ⚠️ CE Gap-Down / PE Gap-Up — skip, recalculating' },
                  { time:'09:30:01 AM', badge:'Auto', badgeColor:'bg-amber-700',        icon:'⚡', color:'text-amber-300', rows:[
                    'Only if gap detected at 09:25',
                    '1 sec after 09:30 candle closes → fetches NIFTY 15-min candle',
                    'CE Gap-Down: buffer = MROUND(9:30 Low  × (1−0.125%), 1) → roundDown 50',
                    'PE Gap-Up:   buffer = MROUND(9:30 High × (1+0.125%), 1) → roundUp 50',
                    'New 10-strike range → live OI + LTP → select valid strike',
                    'New Entry/Target/SL from live LTP → paper trade order placed',
                  ], tg:'⚡ Recalculated strike · Entry · Target · SL' },
                  { time:'Every 5 sec', badge:'Poll',  badgeColor:'bg-purple-700',       icon:'🔄', color:'text-purple-300', rows:[
                    'Server polls live LTP for all PENDING + TRIGGERED trades',
                    'PENDING:   LTP ≤ Entry → status → TRIGGERED',
                    'TRIGGERED: LTP ≤ Target → TARGET_HIT  |  LTP ≥ SL → SL_HIT',
                    'Carried trades: Target check from 09:15 next day · SL from 09:25',
                  ], tg:'✅ Triggered at ₹X\n🎯 Target Hit +₹PnL\n🛑 SL Hit ₹PnL' },
                  { time:'09:25 AM', badge:'SL Check', badgeColor:'bg-cyan-800', icon:'🛑', color:'text-cyan-300', rows:[
                    'For each carried (held) CE & PE position:',
                    'Fetch 09:15–09:25 option 10-min candle HIGH',
                    '✅  10m HIGH  <  SL  →  SL is safe, keep it as-is',
                    '⚠️  10m HIGH  ≥  SL  →  Flag slNeedsRecalc, wait for 15-min candle',
                    'Same check applies for both CE and PE positions',
                  ], tg:'✅ SL Maintained ₹X (10m High < SL)\nOR ⚠️ 10m High ≥ SL → Recalculating at 09:30:01' },
                  { time:'09:30:01 AM', badge:'SL Recalc', badgeColor:'bg-cyan-700', icon:'🔄', color:'text-cyan-200', rows:[
                    'Only for positions flagged at 09:25 (10m high ≥ SL)',
                    'Fetch 09:15–09:30 option 15-min candle HIGH',
                    'New SL = round_to_₹0.5( 15m HIGH × 1.10 )',
                    'Example: 15m high ₹200 → New SL = ₹220',
                    'Update trade SL · carryToNextDay = false',
                    'Same formula for CE and PE — each uses its own option candle',
                  ], tg:'🔄 SL Recalculated · New SL ₹X (15m High ₹Y × 1.10) · Was ₹Z' },
                  { time:'03:00 PM', badge:'Rollover', badgeColor:'bg-violet-700',       icon:'🔄', color:'text-violet-300', rows:[
                    '0DTE check — if any TRIGGERED trade expires today:',
                    'Fetch live LTP → close position at market price',
                    'Calculate P&L → mark as Nifty Weekly Rollover',
                    'Next day setup runs normally from 08:45 AM',
                  ], tg:'🔄 Nifty Weekly Rollover · Strike · Exit Price · P&L' },
                  { time:'15:30 PM', badge:'EOD',     badgeColor:'bg-gray-600',         icon:'🌙', color:'text-gray-300', rows:[
                    'PENDING orders → EXPIRED (order did not trigger today)',
                    'TRIGGERED positions → marked carryToNextDay = true',
                    'Next day: Target active from 09:15 · SL active from 09:25',
                  ], tg:'📋 EOD summary: N expired · N carrying to next day' },
                ] as const).map(({ time, badge, badgeColor, icon, color, rows, tg }) => (
                  <div key={time} className="px-4 py-3.5 flex gap-3">
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
                      {tg && (
                        <div className="mt-2 flex items-start gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-950/40 border border-blue-900/40">
                          <svg className="w-3 h-3 text-blue-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.04 9.613c-.152.678-.554.843-1.12.524l-3.1-2.284-1.497 1.44c-.165.165-.304.304-.624.304l.223-3.162 5.76-5.203c.25-.223-.054-.347-.388-.124L7.15 14.066l-3.048-.951c-.662-.207-.675-.662.138-.98l11.91-4.593c.55-.2 1.032.134.852.706h-.44z"/></svg>
                          <p className="text-xs text-blue-300 whitespace-pre-line">{tg}</p>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Strike Selection Rules ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">📐 Strike Selection Rules</h2>
              </div>
              <div className="px-4 py-4 space-y-3 text-xs text-gray-400">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { label:'2DHH / 2DLL', val:'max(D1H, D2H) / min(D1L, D2L)' },
                    { label:'Strike Factor', val:'±0.15% of 2DHH / 2DLL' },
                    { label:'CALL end strike', val:'roundDown(2DLL × 0.9985, 50)' },
                    { label:'PUT end strike',  val:'roundUp(2DHH × 1.0015, 50)' },
                    { label:'Range direction', val:'CALL: high→low (OTM→ITM)\nPUT: low→high (OTM→ITM)' },
                    { label:'Num strikes', val:'10 per leg · interval 50 pts' },
                    { label:'OI filter', val:'≥ 500 × 65 = 32,500 (0 is skipped)' },
                    { label:'Premium filter', val:'2D Low ≥ 0.85% of strike price' },
                    { label:'Selection', val:'First strike passing both filters (OTM→ITM)' },
                    { label:'Max expiry tries', val:'5 (Mon/Tue start from next week)' },
                  ].map(({ label, val }) => (
                    <div key={label} className="flex gap-2">
                      <span className="text-gray-600 shrink-0 w-28">{label}</span>
                      <span className="text-gray-200 whitespace-pre-line font-mono text-xs">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Entry / Exit Rules ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">💰 Entry / Exit Calculation</h2>
              </div>
              <div className="px-4 py-4 space-y-2 text-xs text-gray-400">
                {[
                  { label:'Entry',      formula:'2D Low  × (1 − 10%)  → round ₹0.5',  note:'Sell limit price' },
                  { label:'Target',     formula:'Entry   × (1 − 75%)  → round ₹0.5',  note:'Buy back at 25% of entry' },
                  { label:'MSL',        formula:'Entry   × (1 + 75%)  → round ₹0.5',  note:'Max stop loss' },
                  { label:'TSL',        formula:'2D High × (1 + 10%)  → round ₹0.5',  note:'Trailing stop loss' },
                  { label:'Stop Loss',  formula:'min(MSL, TSL)',                         note:'Tighter of the two' },
                ].map(({ label, formula, note }) => (
                  <div key={label} className="flex items-baseline gap-3 py-1 border-b border-gray-800/50">
                    <span className="text-gray-500 w-16 shrink-0">{label}</span>
                    <span className="text-white font-mono flex-1">{formula}</span>
                    <span className="text-gray-600 shrink-0 hidden sm:block">{note}</span>
                  </div>
                ))}
                <div className="pt-2 space-y-1">
                  <p className="text-gray-500">Gap-Down/Gap-Up Recalc (09:30):</p>
                  <p>CE: Entry = live LTP × (1 − 10%) &nbsp;|&nbsp; PE: Entry = live LTP × (1 − 10%)</p>
                  <p className="text-gray-600">All values rounded to nearest ₹0.5 for easy order entry.</p>
                </div>
              </div>
            </div>

            {/* ── Paper Trade Rules ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">📋 Paper Trade Rules</h2>
              </div>
              <div className="px-4 py-4 space-y-2 text-xs text-gray-400">
                {[
                  { s:'PENDING',    c:'text-yellow-400', d:'Sell limit order placed. Waiting for LTP to fall to entry price.' },
                  { s:'TRIGGERED',  c:'text-blue-400',   d:'Entry filled. Tracking target and SL every 5 seconds.' },
                  { s:'TARGET_HIT', c:'text-green-400',  d:'LTP ≤ Target. Trade closed. Profit = (Entry − Exit) × Lot.' },
                  { s:'SL_HIT',     c:'text-red-400',    d:'LTP ≥ Stop Loss. Trade closed. Loss = (Entry − Exit) × Lot.' },
                  { s:'EXPIRED',    c:'text-gray-500',   d:'Order not triggered by 15:30. Discarded.' },
                ].map(({ s, c, d }) => (
                  <div key={s} className="flex gap-3 py-1 border-b border-gray-800/50">
                    <span className={cn('w-24 shrink-0 font-semibold', c)}>{s}</span>
                    <span>{d}</span>
                  </div>
                ))}
                <div className="pt-2 space-y-1">
                  <p className="font-semibold text-gray-300">Position Logic for Next Day:</p>
                  <p>• CE holding (TRIGGERED) → skip CE tomorrow, calculate PE only</p>
                  <p>• PE holding (TRIGGERED) → skip PE tomorrow, calculate CE only</p>
                  <p>• Both holding → no trade tomorrow · Telegram notification sent</p>
                  <p>• Carry: Target checks from 09:15 AM · SL order at 09:25 AM</p>
                  <p>• SL adjustment: 10-min candle check at 09:25 → if high ≥ SL → recalc from 15-min candle at 09:31</p>
                </div>
              </div>
            </div>

            {/* ── Manual Actions ── */}
            <div className="rounded-2xl border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
                <h2 className="text-sm font-black text-white">🖱️ Manual Actions</h2>
              </div>
              <div className="divide-y divide-gray-800/60">
                {[
                  { icon:'▶',  label:'Run',                          desc:'Trigger EOD calc manually. Overrides 08:45 auto-calc. Stores on server.' },
                  { icon:'✏️', label:'Manual OHLC Override',         desc:'Enter D1/D2 High/Low before Run to skip Angel One fetch.' },
                  { icon:'📨', label:'Telegram icon (Signal header)', desc:'Send current EOD signals to Telegram on demand.' },
                  { icon:'🔍', label:'Check LTP (09:25)',             desc:'Manual morning check. Compare live LTP vs EOD entry.' },
                  { icon:'⚡', label:'Recalculate (Gap-Down/Gap-Up)', desc:'Manual recalc after 09:30 if gap detected.' },
                  { icon:'📋', label:'Cancel trade',                  desc:'Cancel a PENDING paper trade order from the Trades page.' },
                  { icon:'📱', label:'Mobile LAN access',             desc:'http://192.168.1.50:8008 — served from server disk cache instantly.' },
                ].map(({ icon, label, desc }) => (
                  <div key={label} className="px-4 py-2.5 flex gap-3">
                    <span className="text-sm shrink-0 w-5 mt-0.5">{icon}</span>
                    <div>
                      <span className="text-xs font-semibold text-gray-200">{label} </span>
                      <span className="text-xs text-gray-500">{desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── System Info ── */}
            <div className="rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {[
                ['🖥️ Frontend',   'localhost:8008'],
                ['⚙️ Angel API',  '127.0.0.1:3001'],
                ['📱 Mobile LAN', '192.168.1.50:8008'],
                ['📁 Cache',      'server-cache/'],
                ['📋 Trades',     'server-cache/paper-trades.json'],
                ['💾 EOD Store',  'server-cache/eod_store.json'],
                ['🔑 Config',     'angel-config.json'],
                ['🚀 Auto-start', 'Windows Startup → start-fifto.vbs'],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-gray-600 shrink-0 w-24">{k}</span>
                  <span className="text-white font-mono">{v}</span>
                </div>
              ))}
            </div>

          </div>
        )}

        {/* ── Strategy Page (existing content) ── */}
        {activePage === 'strategy' && <>

        {/* ── Setup Card ── */}
        <Card title="⚡ Strategy Setup" badge={{
          label: activeProfile.name,
          color: INSTRUMENT_COLOR[activeProfile.instrument].accent,
          bg: activeProfile.instrument === 'NIFTY' ? 'border-blue-700 bg-blue-900/30' : 'border-purple-700 bg-purple-900/30',
        }} right={isCalculated ? (
          <button onClick={() => {
            localStorage.removeItem('fifto_run_v1');
            setResult(null); setIsCalculated(false); setMarketData(null);
            setLtpFetchStatus('idle'); setExpiryUsed(''); setCallExpiryUsed(''); setPutExpiryUsed('');
            setMorningCheck(null); setGapDownData(null); setFetchError(null);
          }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-gray-500 border border-gray-700 hover:border-red-700 hover:text-red-400 transition-all">
            ✕ Reset
          </button>
        ) : undefined}>
          <div className="space-y-3">

            {/* ── Strategy Selector ── */}
            <div className="flex flex-wrap gap-1.5">
              {appSettings.profiles.map(p => {
                const c = INSTRUMENT_COLOR[p.instrument];
                const isActive = p.id === appSettings.activeId;
                const isDefault = p.id === 'nifty-weekly';
                const enabled = isDefault || strategiesUnlocked;
                return (
                  <button key={p.id}
                    onClick={() => {
                      if (!enabled) { setShowStrategyPinModal(true); return; }
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
                      !enabled
                        ? 'border-gray-700 bg-gray-900 text-gray-600 opacity-60'
                        : isActive
                          ? `${c.border} bg-gray-800 ${c.accent}`
                          : 'border-gray-700 bg-gray-800/40 text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                    )}>
                    <span className={cn('text-xs font-black px-1 py-0 rounded text-white', enabled ? c.pill : 'bg-gray-700')}>
                      {p.instrument === 'BANKNIFTY' ? 'BNF' : 'NF'}
                    </span>
                    {p.expiry === 'WEEKLY' ? 'Weekly' : 'Monthly'}
                    <span className="font-normal opacity-50">·</span>
                    <span className={isActive ? 'text-gray-400' : 'text-gray-600'}>L:{p.lotSize}</span>
                    {!enabled && <svg className="w-3 h-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>}
                  </button>
                );
              })}
            </div>

            {/* Date input + run */}
            <div className="flex items-center gap-2">
              {/* Date picker */}
              <div className="flex items-center gap-2 rounded-xl px-3 py-2 flex-1" style={{background:'#1f2937', border:'1px solid #374151'}}>
                <span className="text-gray-500 text-sm">📅</span>
                <input type="date" value={nextTradingDate} onChange={e => setNextTradingDate(e.target.value)}
                  className="bg-transparent text-white text-sm outline-none flex-1" />
                {nextTradingDate && (
                  <span className="text-xs text-green-500 font-semibold shrink-0">
                    {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(nextTradingDate).getDay()]}
                  </span>
                )}
              </div>

              {/* Run button */}
              <button onClick={handleRun} disabled={isFetching || isFetchingLTPs || !nextTradingDate}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-black transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white shrink-0"
                style={{background:(isFetching||isFetchingLTPs) ? '#1f2937' : 'linear-gradient(135deg,#16a34a,#15803d)', boxShadow:(isFetching||isFetchingLTPs)?'none':'0 0 14px rgba(22,163,74,0.4)'}}>
                {isFetching ? <><span className="animate-spin inline-block">↻</span> Fetching…</> : isFetchingLTPs ? <><span className="animate-spin inline-block">↻</span> Loading…</> : <>▶ Run</>}
              </button>
            </div>

            {/* Error */}
            {fetchError && <div className="bg-red-950 border border-red-800 rounded-lg p-2.5 text-red-400 text-xs">⚠️ {fetchError}</div>}

            {/* Trade Setup Confirmation — compact single row */}
            {marketData?.fetched && (() => {
              const isNextWk = marketData.preparationDay === 'Monday' || marketData.preparationDay === 'Tuesday';
              const isMonthly = activeProfile.expiry === 'MONTHLY';
              const contractLabel = isMonthly ? 'Monthly Expiry' : (isNextWk ? 'Next Week' : 'Current Week');
              const contractColor = isMonthly ? 'bg-blue-900/50 text-blue-300' : (isNextWk ? 'bg-amber-900/50 text-amber-300' : 'bg-purple-900/50 text-purple-300');
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
                {/* Re-run hint if values were edited */}
                <p className="text-xs text-gray-700 text-center">✏️ Edit any value then click Run to recalculate</p>
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
                    {/* Telegram send */}
                    {(result.callTrade?.isValid || result.putTrade?.isValid) && (() => {
                      const { telegramToken: tok, telegramChatId: cid } = appSettings;
                      if (!tok || !cid) return null;
                      const handleTgSend = async () => {
                        const ce = result.callTrade;
                        const pe = result.putTrade;
                        const ceExp = callExpiryUsed || expiryUsed;
                        const peExp = putExpiryUsed  || expiryUsed;
                        const prof = getCfg();
                        const fmtT = (t: typeof ce, exp: string) =>
                          t?.isValid
                            ? `Strike: <b>${t.strike} ${t.type === 'CALL' ? 'CE' : 'PE'}</b> · ${exp}\n🎯 Entry: ₹${t!.entryPrice.toFixed(1)} | Target: ₹${t!.target.toFixed(1)} | SL: ₹${t!.stopLoss.toFixed(1)}`
                            : 'No valid strike';
                        const msg =
`🔔 <b>FiFTO Trading Secret</b>
📊 <b>${prof.name} — EOD Signals</b>
━━━━━━━━━━━━━━━━━━━━
📅 Prep: ${marketData?.preparationDate} (${marketData?.preparationDay})
📆 EOD Data: ${marketData?.effectiveDataDate}
━━━━━━━━━━━━━━━━━━━━
📈 CALL (CE)
${fmtT(ce, ceExp)}

📉 PUT (PE)
${fmtT(pe, peExp)}
━━━━━━━━━━━━━━━━━━━━
⏰ Reminder at 09:00 AM`;
                        const ok = await sendTelegramMsg(tok, cid, msg);
                        if (ok) { setTgSent(true); setTimeout(() => setTgSent(false), 3000); }
                      };
                      return (
                        <button onClick={handleTgSend}
                          className={cn(
                            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all duration-200 border text-xs font-semibold',
                            tgSent
                              ? 'bg-blue-700 border-blue-600 text-white scale-105'
                              : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-blue-900/50 hover:border-blue-700 hover:text-blue-300 active:scale-95'
                          )} title="Send to Telegram">
                          {tgSent ? (
                            <>
                              <svg className="w-3.5 h-3.5 animate-bounce-once" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                              <span>Sent!</span>
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
                        if (ce?.isValid) {
                          lines.push(`🟢 CALL ${ce.strike} CE | ${ceExp} | ${ce.contractType}`);
                          lines.push(`   🎯 Entry    : ₹${ce.entryPrice.toFixed(2)}`);
                          lines.push(`   ✅ Target   : ₹${ce.target.toFixed(2)}`);
                          lines.push(`   🛑 Stop Loss: ₹${ce.stopLoss.toFixed(2)}`);
                        }
                        if (ce?.isValid && pe?.isValid) lines.push('');
                        if (pe?.isValid) {
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
                    {result.callTrade && <TradeSignalCard signal={result.callTrade} expiry={callExpiryUsed || expiryUsed} prepDate={formatDisplayDate(marketData?.preparationDate)} prepDay={marketData?.preparationDay} eodDate={formatDisplayDate(marketData?.effectiveDataDate)} />}
                    {result.putTrade && <TradeSignalCard signal={result.putTrade} expiry={putExpiryUsed || expiryUsed} prepDate={formatDisplayDate(marketData?.preparationDate)} prepDay={marketData?.preparationDay} eodDate={formatDisplayDate(marketData?.effectiveDataDate)} />}
                  </div>
                  {/* ── Morning Check Panel ── */}
                  <div className="border-t border-gray-700 px-3 sm:px-4 py-3 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Morning Entry Check</p>
                        <p className="text-xs text-gray-600">CE: LTP &lt; EOD Entry → Gap-Down &nbsp;|&nbsp; PE: LTP &lt; EOD Entry → Gap-Up</p>
                      </div>
                      <button onClick={handleMorningCheck} disabled={isCheckingLTP}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-yellow-700 text-yellow-400 hover:bg-yellow-900/30 disabled:opacity-50 transition-all shrink-0">
                        {isCheckingLTP ? <><span className="animate-spin">↻</span> Checking…</> : '🔍 Check LTP (09:25)'}
                      </button>
                    </div>

                    {morningCheck && (
                      <div className="rounded-xl border border-gray-700 overflow-hidden">
                        <div className="grid grid-cols-2 divide-x divide-gray-700">
                          {([
                            {
                              label: 'CE (CALL)', scenario: 'Gap-Down',
                              ltp: morningCheck.ceLTP, entry: morningCheck.callEntryEOD,
                              triggered: morningCheck.callGapDown,
                              valid: result.callTrade?.isValid, strike: result.callTrade?.strike,
                              ref: 'Recalc uses 9:30 LOW',
                            },
                            {
                              label: 'PE (PUT)', scenario: 'Gap-Up',
                              ltp: morningCheck.peLTP, entry: morningCheck.putEntryEOD,
                              triggered: morningCheck.putGapDown,
                              valid: result.putTrade?.isValid, strike: result.putTrade?.strike,
                              ref: 'Recalc uses 9:30 HIGH',
                            },
                          ]).map(({ label, scenario, ltp, entry, triggered, valid, strike, ref }) => (
                            <div key={label} className={cn('px-3 py-3', !valid ? 'opacity-40' : triggered ? 'bg-red-950/20' : 'bg-green-950/10')}>
                              <p className="text-xs text-gray-500 font-semibold mb-1">{label} {strike ? `· ${strike}` : ''}</p>
                              <div className="flex items-end gap-2 flex-wrap">
                                <div>
                                  <p className="text-xs text-gray-600">Live LTP</p>
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
                                  {triggered ? `⚠️ ${scenario} — Skip · ${ref}` : '✅ Safe to Enter'}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="border-t border-gray-700 px-3 py-2 flex items-center justify-between bg-gray-800/40">
                          <p className="text-xs text-gray-600">Checked at {morningCheck.checkedAt}</p>
                          {(morningCheck.callGapDown || morningCheck.putGapDown) && (
                            <button onClick={handleGapDownRecalc} disabled={isGapDownCalc}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black bg-amber-600 hover:bg-amber-500 text-black disabled:opacity-50 transition-all">
                              {isGapDownCalc
                                ? <><span className="animate-spin">↻</span> Calculating…</>
                                : `⚡ Recalculate${morningCheck.callGapDown && morningCheck.putGapDown ? ' Both' : morningCheck.callGapDown ? ' CE (Gap-Down)' : ' PE (Gap-Up)'}`
                              }
                            </button>
                          )}
                          {!morningCheck.callGapDown && !morningCheck.putGapDown && (
                            <p className="text-xs text-green-500 font-semibold">✅ Both legs safe — place at EOD entry</p>
                          )}
                        </div>
                      </div>
                    )}

                    {gapDownData && (
                      <button onClick={() => setShowGapDown(true)}
                        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-amber-700 text-amber-400 text-xs font-bold hover:bg-amber-900/20 transition-all">
                        ⚡ View Gap-Down Calculation Steps
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
                          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold bg-black/30 text-green-200 border border-green-600/50">
                            <span className="opacity-60">LTP</span> {callExpiryUsed}
                            <span className="opacity-60 ml-1">{result.callTrade?.contractType ?? (callExpiryUsed === expiryUsed ? 'Current Week' : 'Next Week')}</span>
                          </span>
                        )}
                      </div>
                      {result.callTrade?.isValid && (
                        <span className="text-xs bg-green-600 text-white px-2 py-1 rounded-full font-bold">
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
                          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold bg-black/30 text-red-200 border border-red-500/50">
                            <span className="opacity-60">LTP</span> {putExpiryUsed}
                            <span className="opacity-60 ml-1">{result.putTrade?.contractType ?? (putExpiryUsed === expiryUsed ? 'Current Week' : 'Next Week')}</span>
                          </span>
                        )}
                      </div>
                      {result.putTrade?.isValid && (
                        <span className="text-xs bg-red-600 text-white px-2 py-1 rounded-full font-bold">
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
