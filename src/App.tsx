import { useState, useEffect } from 'react';
import { cn } from './utils/cn';

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

// Constants
const NIFTY_LOT_SIZE = 65;
const MIN_OI_CONTRACTS = 500;
const MIN_OI = MIN_OI_CONTRACTS * NIFTY_LOT_SIZE; // 32500
const STRIKE_FACTOR = 0.0015; // 0.15%
const MIN_PREMIUM_FACTOR = 0.0085; // 0.85%
const ENTRY_DISCOUNT = 0.10; // 10%
const TARGET_PROFIT = 0.75; // 75%
const MSL_INCREASE = 0.75; // 75%
const TSL_INCREASE = 0.10; // 10%
const STRIKE_INTERVAL = 50;
const NUM_STRIKES = 10; // Exactly 10 strikes

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
  const strike = Math.round(value / STRIKE_INTERVAL) * STRIKE_INTERVAL;
  if (roundUp) {
    return strike >= value ? strike : strike + STRIKE_INTERVAL;
  } else {
    return strike <= value ? strike : strike - STRIKE_INTERVAL;
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
    const minPremium = s.strike * MIN_PREMIUM_FACTOR;
    if (premium < minPremium) continue;
    // OI check only when OI data is available (>0)
    if (oi > 0 && oi < MIN_OI) continue;
    const oiNote = oi > 0 ? `OI: ${oi.toLocaleString()} (≥${MIN_OI.toLocaleString()}), ` : '';
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
  for (let i = 0; i < NUM_STRIKES; i++) {
    if (direction === 'up') {
      strikes.push(endStrike + (i * STRIKE_INTERVAL));
    } else {
      strikes.push(endStrike - (i * STRIKE_INTERVAL));
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
  const upperLevel = twoDHH * (1 + STRIKE_FACTOR);
  const lowerLevel = twoDLL * (1 - STRIKE_FACTOR);
  
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
  const putStartStrike = putStrikeRangeDesc[NUM_STRIKES - 1]; // lowest (most OTM)
  const putStrikeRange = [...putStrikeRangeDesc].reverse(); // OTM first (low→high)

  // Generate strike stubs — real OI/premium filled in after API fetch
  const callStrikes = generateStrikes(callStartStrike, callEndStrike, -STRIKE_INTERVAL); // high→low
  const putStrikes  = generateStrikes(putStartStrike,  putEndStrike,   STRIKE_INTERVAL); // low→high
  
  // Step 7 & 8 & 9: Filter and select strikes
  const callResult = findValidStrikeFromData(callStrikes, 'CALL');
  const putResult  = findValidStrikeFromData(putStrikes,  'PUT');
  
  // Filtered strikes for display
  const filteredCallStrikes = callStrikes.filter(s => s.callOI >= MIN_OI).map(s => s.strike);
  const filteredPutStrikes = putStrikes.filter(s => s.putOI >= MIN_OI).map(s => s.strike);
  
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
    const entryPrice = Math.round(twoDLL * (1 - ENTRY_DISCOUNT) * 100) / 100;
    const target     = Math.round(entryPrice * (1 - TARGET_PROFIT) * 100) / 100;
    const msl        = Math.round(entryPrice * (1 + MSL_INCREASE) * 100) / 100;
    const tsl        = Math.round(twoDHH * (1 + TSL_INCREASE) * 100) / 100;
    const stopLoss   = Math.round(Math.min(msl, tsl) * 100) / 100;
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
const Card: React.FC<{ children: React.ReactNode; className?: string; title?: string; icon?: string }> = ({ 
  children, 
  className,
  title,
  icon
}) => (
  <div className={cn(
    "bg-gray-900 rounded-2xl shadow-lg border border-gray-700 overflow-hidden",
    className
  )}>
    {title && (
      <div className="px-6 py-4 bg-gray-800 border-b border-gray-700">
        <h3 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
          {icon && <span>{icon}</span>}
          {title}
        </h3>
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
🎯 Entry    : ₹${signal.entryPrice.toFixed(2)}
✅ Target   : ₹${signal.target.toFixed(2)}
🛑 Stop Loss: ₹${signal.stopLoss.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━
📅 Prep Date: ${prepDate ?? ''}  (${prepDay ?? ''})
📆 EOD Data : ${eodDate ?? ''}`;
    navigator.clipboard.writeText(msg).then(() => {
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
            <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>Copied</>
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
              <p className="text-base sm:text-xl font-black text-white">₹{signal.entryPrice.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Target</p>
              <p className="text-base sm:text-xl font-black text-green-400">₹{signal.target.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Stop Loss</p>
              <p className="text-base sm:text-xl font-black text-red-400">₹{signal.stopLoss.toFixed(2)}</p>
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
                <div><p className="text-gray-500 mb-0.5">MSL (Entry × 1.75)</p><p className="font-bold text-orange-300">₹{signal.msl.toFixed(2)}</p></div>
                <div><p className="text-gray-500 mb-0.5">TSL (2DHH × 1.10)</p><p className="font-bold text-orange-300">₹{signal.tsl.toFixed(2)}</p></div>
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

// Main App Component
export default function App() {
  const [nextTradingDate, setNextTradingDate] = useState<string>('');
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [result, setResult] = useState<CalculationResult | null>(null);
  const [isCalculated, setIsCalculated] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetchingLTPs, setIsFetchingLTPs] = useState(false);
  const [ltpFetchStatus, setLtpFetchStatus] = useState<'idle'|'success'|'error'>('idle');
  const [expiryUsed, setExpiryUsed] = useState<string>('');
  const [callExpiryUsed, setCallExpiryUsed] = useState<string>('');
  const [putExpiryUsed, setPutExpiryUsed] = useState<string>('');
  const [bothCopied, setBothCopied] = useState(false);
  const [expirySearchStatus, setExpirySearchStatus] = useState<string>('');
  
  // Default to today's date
  useEffect(() => {
    setNextTradingDate(localToday());
  }, []);
  
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

    // ── Step 1: Fetch NIFTY OHLC ─────────────────────────────────────────────
    setIsFetching(true);
    const { date: effectiveDate, marketWasOpen } = getEffectiveDate(nextTradingDate);
    const data = await fetchNiftyData(effectiveDate);
    setIsFetching(false);

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
      const MAX_TRIES = 5;

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
        const entryPrice = Math.round(optDLL * (1 - ENTRY_DISCOUNT) * 100) / 100;
        const target     = Math.round(entryPrice * (1 - TARGET_PROFIT) * 100) / 100;
        const msl        = Math.round(entryPrice * (1 + MSL_INCREASE) * 100) / 100;
        const tsl        = Math.round(optDHH * (1 + TSL_INCREASE) * 100) / 100;
        const stopLoss   = Math.round(Math.min(msl, tsl) * 100) / 100;
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
                <p className="text-green-400 text-xs hidden sm:block leading-tight">NIFTY Option Selling Signals</p>
              </div>
            </div>
            {/* Right: prep date + run button */}
            <div className="flex items-center gap-2 shrink-0">
              {marketData?.preparationDate && (
                <div className="text-right hidden sm:block">
                  <p className="text-green-400 text-xs leading-tight">{marketData.preparationDay}</p>
                  <p className="text-xs font-semibold text-white leading-tight">{formatDisplayDate(marketData.preparationDate)}</p>
                </div>
              )}
              <button onClick={handleRun} disabled={isFetching || isFetchingLTPs || !nextTradingDate}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white"
                style={{background: (isFetching || isFetchingLTPs) ? '#1f2937' : 'linear-gradient(135deg,#16a34a,#15803d)', boxShadow: (isFetching || isFetchingLTPs) ? 'none' : '0 0 12px rgba(22,163,74,0.4)'}}>
                {isFetching ? <><span className="animate-spin inline-block">↻</span> Fetching</> : isFetchingLTPs ? <><span className="animate-spin inline-block">↻</span> Loading</> : <>▶ Run</>}
              </button>
            </div>
          </div>
        </div>
      </header>
      
      <main className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-5 space-y-3 sm:space-y-5">
        {/* ── Setup Card ── */}
        <Card title="⚡ Strategy Setup">
          <div className="space-y-3">

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
              return (
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl text-xs" style={{background:'#161b22', border:'1px solid #30363d'}}>
                  <span className="text-gray-600 font-semibold uppercase tracking-widest text-xs shrink-0">Setup</span>
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
                  <span className={`font-bold px-2 py-0.5 rounded-full text-xs ${isNextWk ? 'bg-amber-900/50 text-amber-300' : 'bg-purple-900/50 text-purple-300'}`}>
                    {isNextWk ? 'Next Week' : 'Current Week'}
                  </span>
                </div>
              );
            })()}

            {/* OHLC strip — shown after data loaded */}
            {marketData?.fetched && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'PDH', value: marketData.day1High, date: marketData.day1Date, color: 'text-green-400' },
                  { label: 'PDL', value: marketData.day1Low,  date: marketData.day1Date, color: 'text-red-400' },
                  { label: 'D-2 High', value: marketData.day2High, date: marketData.day2Date, color: 'text-green-500' },
                  { label: 'D-2 Low',  value: marketData.day2Low,  date: marketData.day2Date, color: 'text-red-500' },
                ].map(item => (
                  <div key={item.label} className="bg-gray-800 rounded-lg px-3 py-2 flex items-center justify-between">
                    <div>
                      <p className={`text-xs font-bold ${item.color}`}>{item.label}</p>
                      <p className="text-xs text-gray-500">{formatDisplayDate(item.date)}</p>
                    </div>
                    <p className="font-bold text-white">₹{item.value.toFixed(2)}</p>
                  </div>
                ))}
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base">🚀</span>
                    <span className="font-bold text-white text-sm sm:text-base">Trade Execution Signals</span>
                    {expiryUsed && <span className="hidden sm:inline text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded-full font-semibold">{expiryUsed}</span>}
                    {marketData?.preparationDate && (
                      <span className="hidden sm:flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-900/40 border border-green-800/50 text-green-300">
                        <span className="text-green-600">Prep</span>
                        <span className="font-semibold">{formatDisplayDate(marketData.preparationDate)}</span>
                        <span className="text-green-600">{marketData.preparationDay?.slice(0,3)}</span>
                      </span>
                    )}
                    {marketData?.day1Date && (
                      <span className="hidden sm:flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-700/50 border border-gray-700 text-gray-400">
                        <span className="text-gray-600">EOD</span>
                        <span>{formatDisplayDate(marketData.day2Date)}</span>
                        <span className="text-gray-600">&</span>
                        <span>{formatDisplayDate(marketData.day1Date)}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
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
                        const lines: string[] = [
                          `📊 NIFTY Trade Signal`,
                          `━━━━━━━━━━━━━━━━━━━━`,
                        ];
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
                        navigator.clipboard.writeText(lines.join('\n')).then(() => {
                          setBothCopied(true);
                          setTimeout(() => setBothCopied(false), 2000);
                        });
                      }}
                        className={cn(
                          "flex items-center justify-center w-8 h-8 rounded-lg transition-all",
                          bothCopied
                            ? "bg-green-700 text-white"
                            : "bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white border border-gray-600"
                        )} title="Copy CE+PE">
                        {bothCopied ? (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" strokeWidth={2}/><path strokeLinecap="round" strokeWidth={2} d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
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
                  <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-700">
                    {result.callTrade && <TradeSignalCard signal={result.callTrade} expiry={callExpiryUsed || expiryUsed} prepDate={formatDisplayDate(marketData?.preparationDate)} prepDay={marketData?.preparationDay} eodDate={formatDisplayDate(marketData?.effectiveDataDate)} />}
                    {result.putTrade && <TradeSignalCard signal={result.putTrade} expiry={putExpiryUsed || expiryUsed} prepDate={formatDisplayDate(marketData?.preparationDate)} prepDay={marketData?.preparationDay} eodDate={formatDisplayDate(marketData?.effectiveDataDate)} />}
                  </div>
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
                          const minPremium = strike * MIN_PREMIUM_FACTOR;
                          const strikeData = result.callStrikes.find(d => d.strike === strike);
                          const ceOI = strikeData?.callOI || 0;
                          const ceLTP = strikeData?.callPremium || 0;
                          const oiMet = ceOI >= MIN_OI;
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
                          const minPremium = strike * MIN_PREMIUM_FACTOR;
                          const strikeData = result.putStrikes.find(d => d.strike === strike);
                          const peOI = strikeData?.putOI || 0;
                          const peLTP = strikeData?.putPremium || 0;
                          const oiMet = peOI >= MIN_OI;
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
    </div>
  );
}
