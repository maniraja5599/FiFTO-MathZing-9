# FiFTO Trading Secret — Complete Strategy Documentation for Backtesting

> **Purpose:** This document contains the complete FiFTO Trading Secret strategy logic, formulas, rules, and examples. It is designed to be given to an AI (e.g., Claude) to build a backtesting simulation.

---

## 1. Strategy Overview

**Type:** Short options selling (Credit Spread style, without the long leg)  
**Instruments:** NIFTY Weekly options (CE = Call, PE = Put)  
**Concept:** Sell out-of-the-money (OTM) options, collect premium decay. Entry is placed at a **10% discount** below the option's **2-day lowest low (2DLL)**. Exit at **75% premium decay** (25% of entry price). Stop loss at the lower of a fixed max loss or trailing stop based on 2DHH.

### 1.1 Key Parameters (Default: NIFTY Weekly)

| Parameter | Symbol | Value | Meaning |
|-----------|--------|-------|---------|
| Lot Size | `L` | 65 | Units per lot (NIFTY) |
| Min OI (contracts) | `OIC` | 500 | Minimum open interest per strike |
| Min OI (units) | | 32,500 | `OIC × L` |
| Strike Factor | `SF` | 0.0015 (0.15%) | Buffer for strike boundary from 2DHH/2DLL |
| Min Premium Factor | `MPF` | 0.0085 (0.85%) | Min premium as % of strike price |
| Strike Interval | `SI` | 50 | Strike price spacing (NIFTY) |
| Num Strikes | `N` | 10 | Number of strikes scanned per leg |
| Max Expiries | `ME` | 5 | Max weekly expiries to search |
| Entry Discount | `ED` | 0.10 (10%) | Entry = 2DLL × (1 − 0.10) |
| Target Profit | `TP` | 0.75 (75%) | Target = Entry × (1 − 0.75) = Entry × 0.25 |
| Max SL Increase | `MSLI` | 0.75 (75%) | MSL = Entry × (1 + 0.75) = Entry × 1.75 |
| TSL Increase | `TSLI` | 0.10 (10%) | TSL = 2DHH × (1 + 0.10) = 2DHH × 1.10 |

---

## 2. Input Data Requirements

For each backtest day, you need:

### 2.1 NIFTY 50 Spot OHLC (Last 2 Trading Days)

```
Day1: { high: number, low: number, date: string }
Day2: { high: number, low: number, date: string }
```

- **Day1** = Most recent completed trading day
- **Day2** = Day before Day1
- These are used to compute:
  - `2DHH = max(Day1.high, Day2.high)` — Two-Day Highest High
  - `2DLL = min(Day1.low, Day2.low)` — Two-Day Lowest Low

**Example:**
```
Day1 (2026-05-30): high = 22650, low = 22480
Day2 (2026-05-29): high = 22700, low = 22450
2DHH = max(22650, 22700) = 22700
2DLL = min(22480, 22450) = 22450
```

### 2.2 Option Chain Data (Per Strike, Per Expiry)

For each strike in the search range, for each weekly expiry, you need:

```
Option:
  strike: number        // e.g., 22500, 22550, 22600...
  2D_High: number       // Option's highest trade price in last 2 days
  2D_Low: number        // Option's lowest trade price in last 2 days
  OpenInterest: number   // Current open interest in units
```

- `2D_Low` = min(prev_day_low, day_before_low)
- `2D_High` = max(prev_day_high, day_before_high)
- `OpenInterest` must be >= 32,500 (for NIFTY default)

### 2.3 Weekly Expiry Dates

- NIFTY weekly expiries are on **Thursdays**
- You need the list of upcoming weekly expiry dates
- Format: "DDMMMYYYY" e.g., "04JUN2026", "11JUN2026"

### 2.4 Intraday Data (for F3 Check and Gap Recalc)

For F3 check (at 09:25 IST):
```
10-min option candle (09:15 to 09:25):
  low: number    // Lowest price in this 10-min window
  high: number   // Highest price in this 10-min window
```

For Gap-Down recalc (at 09:30 IST):
```
NIFTY 15-min candle (09:15 to 09:30):
  low: number
  high: number

Option 15-min candle (09:15 to 09:30):
  low: number
  high: number
```

---

## 3. Strike Selection Algorithm

### Step 1: Compute Strike Boundaries

```
upperLevel = 2DHH × (1 + SF)    // 2DHH × 1.0015
lowerLevel = 2DLL × (1 − SF)    // 2DLL × 0.9985
```

### Step 2: Round to Valid Strike

```javascript
function roundToNearestStrike(value, roundUp) {
  const interval = 50; // strikeInterval
  const rounded = Math.round(value / interval) * interval;
  if (roundUp) {
    return rounded >= value ? rounded : rounded + interval;
  } else {
    return rounded <= value ? rounded : rounded - interval;
  }
}

callEndStrike = roundToNearestStrike(lowerLevel, false)  // Floor — round DOWN
putEndStrike  = roundToNearestStrike(upperLevel, true)   // Ceil — round UP
```

**Example:**
```
2DHH = 22700, 2DLL = 22450
upperLevel = 22700 × 1.0015 = 22734.05
lowerLevel = 22450 × 0.9985 = 22416.33

putEndStrike  = roundToNearestStrike(22734.05, true)  = 22750
callEndStrike = roundToNearestStrike(22416.33, false) = 22400
```

### Step 3: Generate Strike Range (10 Strikes per Leg)

```javascript
function generateStrikeRange(endStrike, direction) {
  const range = [];
  for (let i = 0; i < 10; i++) {
    range.push(endStrike + (direction === 'up' ? i : -i) * 50);
  }
  return range;
}

// CALL strikes: from OTM (high) to ITM (low)
callRange = generateStrikeRange(callEndStrike, 'up').reverse();
// [22400+9*50=22850, 22800, 22750, ..., 22400]

// PUT strikes: from OTM (low) to ITM (high)
putRange = [...generateStrikeRange(putEndStrike, 'down').reverse()];
// [22750-9*50=22300, 22350, 22400, ..., 22750]
```

**Key:** The range goes from **most OTM** (farthest from ATM) to **most ITM** (closest to ATM). The first qualifying strike is selected.

### Step 4: Filtering — F1 (OI) and F2 (Premium)

For each strike in the range (from OTM to ITM):

**F1 — Minimum Open Interest:**
```javascript
effectiveMinOI = minOIContracts × lotSize = 500 × 65 = 32,500
F1 passes if option.OpenInterest >= 32,500
```

**F2 — Minimum Premium:**
```javascript
minPremium = strike × minPremiumFactor = strike × 0.0085
F2 passes if option.2D_Low >= minPremium
```

### Step 5: Select First Valid Strike

Scan strikes from OTM → ITM. Pick the **first strike** where both F1 and F2 pass.

If no strike in the current expiry qualifies, try the **next weekly expiry** (up to 5 expiries = `ME`).

**Expiry start index:**
```
preparationDay = day of week of prep date
startIdx = (preparationDay === 'Monday' || preparationDay === 'Tuesday') ? 1 : 0
// Mon/Tue → start at next week expiry (skip current week)
// Wed–Fri → start at current week expiry
```

---

## 4. Trade Signal Calculation

Once a strike is selected, fetch its **option 2D OHLC** (2D_High and 2D_Low) and compute:

```javascript
function roundHalf(value) {
  return Math.round(value * 2) / 2;  // Round to nearest 0.5
}

entryPrice = roundHalf(option.2D_Low × (1 − ED))
           = roundHalf(option.2D_Low × 0.90)

target = roundHalf(entryPrice × (1 − TP))
       = roundHalf(entryPrice × 0.25)

msl = roundHalf(entryPrice × (1 + MSLI))
    = roundHalf(entryPrice × 1.75)

tsl = roundHalf(option.2D_High × (1 + TSLI))
    = roundHalf(option.2D_High × 1.10)

stopLoss = roundHalf(min(msl, tsl))
```

### 4.1 Example Calculation

```
Option Strike: 22600 CE
Option 2D_Low = 85.50
Option 2D_High = 120.00

entryPrice = roundHalf(85.50 × 0.90) = roundHalf(76.95) = 77.0
target     = roundHalf(77.0 × 0.25)   = roundHalf(19.25) = 19.5
msl        = roundHalf(77.0 × 1.75)   = roundHalf(134.75) = 134.5
tsl        = roundHalf(120.0 × 1.10)  = roundHalf(132.0) = 132.0
stopLoss   = roundHalf(min(134.5, 132.0)) = roundHalf(132.0) = 132.0
```

### 4.2 Contract Type

```javascript
const prepDay = day-of-week of preparation date
contractType = (prepDay === 'Monday' || prepDay === 'Tuesday') 
  ? 'Next Week' 
  : 'Current Week';
```

---

## 5. Trade Execution Rules

### 5.1 Order Placement

A SELL limit order is placed at `entryPrice`.  
The order fills when option LTP **drops to or below** `entryPrice`.

```
if (LTP <= entryPrice) → Order fills → status = 'TRIGGERED'
```

### 5.2 Target Exit

```
if (LTP <= target) → Exit at profit → status = 'TARGET_HIT'
P&L = (entryPrice − target) × lotSize  (always positive for short sell)
```

### 5.3 Stop Loss Exit

```
if (LTP >= stopLoss) → Exit at loss → status = 'SL_HIT'
P&L = (entryPrice − stopLoss) × lotSize  (negative)
```

### 5.4 Running P&L (for open positions)

```
runningPnl = (entryPrice − currentLTP) × lotSize
```

### 5.5 0DTE Expiry Close (15:00 IST)

For trades with **today's expiry** that are still TRIGGERED at 15:00:
```
// Use LTP if available, else fallback:
exitPrice = currentLTP > 0 ? currentLTP : entryPrice × 0.10
P&L = (entryPrice − exitPrice) × lotSize
status = 'TARGET_HIT' (or 'SL_HIT' if P&L negative)
exitReason = 'EXPIRY'
```

### 5.6 End of Day (15:30 IST)

- **PENDING** orders → status = `'EXPIRED'`
- **TRIGGERED** orders → `carryToNextDay = true` (resume next day)

---

## 6. Morning Check (F3) — 09:25 IST

For each leg (CE and PE) with a valid trade signal:

```
1. Fetch 10-min option candle from 09:15 to 09:25
2. F3 passes if candle.low >= entryPrice
3. F3 fails if candle.low < entryPrice
```

**If F3 passes:** Place the order using EOD signal as-is.  
**If F3 fails:** The option has gapped below entry. Trigger gap-down recalculation at 09:30.

---

## 7. Gap-Down Recalculation — 09:30 IST

For each leg where F3 failed:

### Step 1: Fetch NIFTY 15-min Candle (09:15–09:30)

```javascript
candle15 = { low: <lowest NIFTY price in window>, high: <highest price> }
```

### Step 2: Compute New Strike Boundaries
```javascript
GAP_BUF = 0.00125  // 0.125%

newCallEnd = roundToNearestStrike(candle15.low × (1 − GAP_BUF), false)
            = roundToNearestStrike(candle15.low × 0.99875, false)  // Floor
newPutEnd  = roundToNearestStrike(candle15.high × (1 + GAP_BUF), true)
            = roundToNearestStrike(candle15.high × 1.00125, true)  // Ceil
```

### Step 3: Generate New 10-Strike Range (same as EOD)
```
callRange = [newCallEnd + 9×50, ..., newCallEnd]   // OTM to ITM
putRange  = [newPutEnd − 9×50, ..., newPutEnd]      // OTM to ITM
```

### Step 4: Re-scan with F1 + F2 + F3'

F3' (new): For each option, fetch its 15-min candle (09:15–09:30):
```
F3' passes if option_15min_candle.low >= entryPrice
entryPrice = option.2D_Low × 0.90  (same formula)
```

Select first strike passing all three filters (F1 ∧ F2 ∧ F3').

---

## 8. Carried Trades — Next Day SL Management

Trades carried from previous day (`carryToNextDay = true`):

### 8.1 SL Check at 09:25

```
Fetch 10-min option candle (09:15–09:25)
if candle.high >= stopLoss → slNeedsRecalc = true
if candle.high < stopLoss  → slNeedsRecalc = false (SL maintained)
```

### 8.2 SL Recalculation at 09:30:01

```
Fetch 15-min option candle (09:15–09:30)
newStopLoss = roundHalf(candle15.high × 1.10)
// Replace the old stopLoss with this new value
// Clear carryToNextDay flag
```

### 8.3 Check Timing for Carried Trades

- `canTarget`: Only after 09:15 IST
- `canSL`: Only after 09:25 IST

For same-day trades, `canTarget` and `canSL` are always true.

---

## 9. No-Trade Conditions

Return "No Trade" when ANY of these are true:

1. **No valid strike** after scanning all 10 strikes × 5 expiries (F1 or F2 fail for all)
2. **Option data unavailable** (2D OHLC fetch failed)
3. **NIFTY OHLC data unavailable** (both Angel One and NSE sources failed)
4. **Both legs already have open trades** (no new trades placed)
5. **Weekend** (Saturday or Sunday)
6. **Market holiday**
7. **F3 fails AND no valid recalc strike found** (gap-down recalc also fails)

---

## 10. Complete Backtest Flow

```
FOR EACH DAY in backtest period:
  1. Skip if weekend or holiday
  2. Compute preparation date = previous trading day (or day before if before 15:30)
  3. Fetch NIFTY 2-day OHLC → 2DHH, 2DLL
  4. Compute strike boundaries → callEndStrike, putEndStrike
  5. Generate strike ranges (10 per leg)
  6. FOR expiryIndex = startIdx to startIdx + 4:
     a. Get weekly expiry date
     b. Fetch option chain for all strikes in ranges
     c. Check F1 (OI) and F2 (Premium) per strike
     d. Select first valid strike per leg
     e. If both legs have valid strikes → BREAK
  7. If no valid strikes → No Trade → CONTINUE to next day
  8. Fetch option 2D OHLC for selected strikes
  9. Compute: entryPrice, target, stopLoss
  10. IF morning check simulation desired:
      a. Fetch 10-min candle (09:15-09:25)
      b. F3 check → skip leg or recalc
      c. If recalc needed: fetch 15-min candle, new strikes, re-check F3'
  11. Place sell limit order at entryPrice
  12. SIMULATE intraday price movement (15-min or 5-min candles):
      a. if LTP <= entry AND status = PENDING → TRIGGERED (record entry fill)
      b. if LTP <= target AND status = TRIGGERED → TARGET_HIT (record exit)
      c. if LTP >= stopLoss AND status = TRIGGERED → SL_HIT (record exit)
  13. At 15:00: if expiry = today AND status = TRIGGERED → force close
  14. At 15:30: if status = TRIGGERED → carryToNextDay = true
  15. If carryToNextDay: next day simulate 09:25 SL check + 09:30 recalc
  
OUTPUT per trade:
  date, leg (CE/PE), strike, expiry, contractType,
  entryPrice, target, stopLoss,
  fillTime, fillPrice, exitTime, exitPrice,
  status (TARGET_HIT/SL_HIT/EXPIRED/EXPIRY),
  P&L, return%, carryToNextDay
```

---

## 11. Full Code Examples

### 11.1 Strike Selection

```javascript
// Configuration
const CFG = {
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
};

function roundHalf(v) { return Math.round(v * 2) / 2; }

function roundToNearestStrike(value, roundUp) {
  const interval = CFG.strikeInterval;
  const rounded = Math.round(value / interval) * interval;
  return roundUp
    ? (rounded >= value ? rounded : rounded + interval)
    : (rounded <= value ? rounded : rounded - interval);
}

function selectStrike(nifty2DHH, nifty2DLL, optionChainByExpiry, prepDay) {
  const upperLevel = nifty2DHH * (1 + CFG.strikeFactor);
  const lowerLevel = nifty2DLL * (1 - CFG.strikeFactor);
  
  const putEndStrike = roundToNearestStrike(upperLevel, true);
  const callEndStrike = roundToNearestStrike(lowerLevel, false);
  
  // Generate strike ranges
  const callRange = [];
  const putRange = [];
  for (let i = 0; i < CFG.numStrikes; i++) {
    callRange.push(callEndStrike + (CFG.numStrikes - 1 - i) * CFG.strikeInterval);
    putRange.push(putEndStrike - i * CFG.strikeInterval);
  }
  // callRange: [22850, 22800, ..., 22400] (OTM→ITM)
  // putRange: [22300, 22350, ..., 22750] (OTM→ITM)
  
  const startIdx = (prepDay === 'Monday' || prepDay === 'Tuesday') ? 1 : 0;
  const effectiveMinOI = CFG.minOIContracts * CFG.lotSize;
  
  for (let expiryIdx = startIdx; expiryIdx < startIdx + CFG.maxTries; expiryIdx++) {
    const expiry = getExpiryByIndex(expiryIdx);
    const chain = optionChainByExpiry[expiry];
    if (!chain) continue;
    
    let ceStrike = null, peStrike = null;
    
    for (const strike of callRange) {
      const opt = chain[strike]?.CE;
      if (opt && opt.openInterest >= effectiveMinOI && opt.twoDLL >= strike * CFG.minPremiumFactor) {
        ceStrike = strike;
        break;
      }
    }
    
    for (const strike of putRange) {
      const opt = chain[strike]?.PE;
      if (opt && opt.openInterest >= effectiveMinOI && opt.twoDLL >= strike * CFG.minPremiumFactor) {
        peStrike = strike;
        break;
      }
    }
    
    if (ceStrike && peStrike) return { ceStrike, peStrike, expiry };
  }
  
  return null; // No trade
}
```

### 11.2 Trade Signal Calculation

```javascript
function calculateTradeSignal(strike, option2DOHLC, expiry, prepDay) {
  const twoDLL = option2DOHLC.twoDLL;
  const twoDHH = option2DOHLC.twoDHH;
  
  const entryPrice = roundHalf(twoDLL * (1 - CFG.entryDiscount));
  const target = roundHalf(entryPrice * (1 - CFG.targetProfit));
  const msl = roundHalf(entryPrice * (1 + CFG.mslIncrease));
  const tsl = roundHalf(twoDHH * (1 + CFG.tslIncrease));
  const stopLoss = roundHalf(Math.min(msl, tsl));
  
  const contractType = (prepDay === 'Monday' || prepDay === 'Tuesday')
    ? 'Next Week' : 'Current Week';
  
  return {
    strike,
    expiry,
    contractType,
    entryPrice,   // SELL limit order price
    target,       // Buy to cover at this price (75% decay)
    stopLoss,     // Buy to cover at this price (max loss)
    msl,          // Max stop loss (reference)
    tsl,          // Trailing stop loss (reference)
    twoDLL,
    twoDHH,
  };
}
```

### 11.3 Full Backtest Example

```javascript
async function backtestFiFTO(dailyData) {
  const results = [];
  
  for (const day of dailyData) {
    // day = { date, nifty2DHH, nifty2DLL, optionChain, prepDay, intradayCandles }
    
    if (isWeekend(day.date) || isHoliday(day.date)) continue;
    
    // Step 1-3: Strike selection
    const selected = selectStrike(
      day.nifty2DHH, day.nifty2DLL, 
      day.optionChain, day.prepDay
    );
    
    if (!selected) {
      results.push({ date: day.date, trade: null, reason: 'No valid strike' });
      continue;
    }
    
    // Step 4-9: Signal calculation for CE and PE
    const ceSignal = calculateTradeSignal(
      selected.ceStrike,
      day.optionChain[selected.expiry][selected.ceStrike].CE.ohlc2d,
      selected.expiry, day.prepDay
    );
    
    const peSignal = calculateTradeSignal(
      selected.peStrike,
      day.optionChain[selected.expiry][selected.peStrike].PE.ohlc2d,
      selected.expiry, day.prepDay
    );
    
    // Step 10-12: Simulate the day
    const ceResult = simulateTrade(ceSignal, day.intradayCandles.CE, CFG.lotSize);
    const peResult = simulateTrade(peSignal, day.intradayCandles.PE, CFG.lotSize);
    
    results.push({
      date: day.date,
      expiry: selected.expiry,
      ce: ceResult,
      pe: peResult,
      combinedPnl: ceResult.pnl + peResult.pnl,
    });
  }
  
  return results;
}

function simulateTrade(signal, candles, lotSize) {
  let status = 'PENDING';
  let entryFillTime = null;
  let exitTime = null;
  let exitPrice = null;
  let carryNextDay = false;
  
  for (const candle of candles) {
    // candle = { time, open, high, low, close }
    
    if (status === 'PENDING' && candle.low <= signal.entryPrice) {
      status = 'TRIGGERED';
      entryFillTime = candle.time;
      // Entry fills at entryPrice (our limit order)
    }
    
    if (status === 'TRIGGERED') {
      if (candle.low <= signal.target) {
        // Target hit
        status = 'TARGET_HIT';
        exitTime = candle.time;
        exitPrice = signal.target;
        break;
      }
      if (candle.high >= signal.stopLoss) {
        // SL hit
        status = 'SL_HIT';
        exitTime = candle.time;
        exitPrice = signal.stopLoss;
        break;
      }
    }
  }
  
  // 15:00 expiry close
  if (status === 'TRIGGERED' && isExpiryToday(signal.expiry)) {
    const lastCandle = candles[candles.length - 1];
    exitPrice = lastCandle.close > 0 ? lastCandle.close : signal.entryPrice * 0.10;
    status = 'TARGET_HIT'; // Assuming profit at expiry decay
    exitTime = '15:00';
  }
  
  // 15:30 carry forward
  if (status === 'TRIGGERED') {
    carryNextDay = true;
  }
  
  const pnl = status === 'TARGET_HIT'
    ? (signal.entryPrice - exitPrice) * lotSize
    : status === 'SL_HIT'
      ? (signal.entryPrice - exitPrice) * lotSize
      : 0;
  
  return {
    strike: signal.strike,
    expiry: signal.expiry,
    entryPrice: signal.entryPrice,
    target: signal.target,
    stopLoss: signal.stopLoss,
    status,
    entryFillTime,
    exitTime,
    exitPrice,
    pnl,
    carryNextDay,
  };
}
```

---

## 12. P&L Calculation Summary

| Scenario | P&L Formula | Typical P&L |
|----------|------------|-------------|
| Target Hit (full profit) | `(entry - target) × lotSize` | Positive (75% of entry premium) |
| SL Hit (full loss) | `(entry - stopLoss) × lotSize` | Negative (up to −75% of entry) |
| Expiry Close (0DTE) | `(entry - exitPrice) × lotSize` | Positive (usually ~90% profit) |
| Expired (PENDING) | `0` | No trade executed |
| Carried → Next Day Target | Same as target hit | Positive |
| Carried → Next Day SL | Same as SL hit | Negative |

---

## 13. Data Structures Reference

```typescript
// Trade signal for one leg
interface TradeSignal {
  type: 'CALL' | 'PUT';
  strike: number;
  entryPrice: number;      // roundHalf(2DLL × 0.90)
  target: number;          // roundHalf(entryPrice × 0.25)
  stopLoss: number;        // roundHalf(min(msl, tsl))
  msl: number;             // roundHalf(entryPrice × 1.75)
  tsl: number;             // roundHalf(option2DHH × 1.10)
  contractType: 'Current Week' | 'Next Week';
  reason: string;
  isValid: boolean;
  optionOHLC: {
    day1High: number;
    day1Low: number;
    day2High: number;
    day2Low: number;
    twoDHH: number;        // max(day1High, day2High)
    twoDLL: number;        // min(day1Low, day2Low)
  } | null;
  strikeRange: number[];    // The 10 strikes scanned
}

// Paper trade (executed/executing trade)
interface PaperTrade {
  id: string;
  date: string;            // YYYY-MM-DD
  type: 'CALL' | 'PUT';
  optType: 'CE' | 'PE';
  strike: number;
  expiry: string;          // e.g., "04JUN2026"
  strategyName: string;
  lotSize: number;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  status: 'PENDING' | 'TRIGGERED' | 'TARGET_HIT' | 'SL_HIT' | 'EXPIRED' | 'CANCELLED';
  placedAt: string;        // ISO timestamp
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
  signalSource?: 'EOD' | 'GAP_RECALC' | 'MANUAL';
  recalcScenario?: 'GAP_DOWN' | 'GAP_UP' | null;
}

// Backtest output
interface BacktestResult {
  date: string;
  expiry: string;
  ce: {
    strike: number;
    entryPrice: number;
    target: number;
    stopLoss: number;
    status: string;
    entryFillTime: string | null;
    exitTime: string | null;
    exitPrice: number | null;
    pnl: number;
    carryNextDay: boolean;
  };
  pe: {
    strike: number;
    entryPrice: number;
    target: number;
    stopLoss: number;
    status: string;
    entryFillTime: string | null;
    exitTime: string | null;
    exitPrice: number | null;
    pnl: number;
    carryNextDay: boolean;
  };
  combinedPnl: number;
}
```

---

## 14. Notes for Backtesting

1. **Round to nearest 0.5:** All prices (entry, target, SL) must be rounded using `Math.round(value × 2) / 2`.

2. **Short selling P&L:** For a short sell, P&L = (entry − exit) × lotSize. Profit when exit < entry.

3. **Expiry handling:** Use weekly Thursday expiries. Skip current week on Monday/Tuesday.

4. **Carried trades:** A trade hitting target/SL on a subsequent day should be accounted for on that day, not the entry day.

5. **F3/gap recalc:** For realistic backtesting, simulate the morning check. Without intraday data, you can approximate: if next-day open is significantly different from entry, assume F3 fail → recalc.

6. **Entry fill assumption:** In liquid options (OI >= 32,500), the entry limit order at 2DLL × 0.90 is assumed to fill if LTP reaches that level during the day.

7. **Data source:** 2D Low and 2D High for each option come from the last 2 completed daily candles of that option contract.

---

*Generated from FiFTO Trading Secret codebase — June 2026*
