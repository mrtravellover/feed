// Shah Jewellers — Live MCX Rate Feed
// Vercel Serverless Function — /api/feed.js
//
// Provider: MCXLive (https://mcxlive.in)
// Fetches, validates, normalises, and auto-rolls MCX + Spot contracts.
// No contract IDs or expiry dates are ever hardcoded — every refresh
// re-derives which contract is "current" from the live data itself.

// Allow more execution time on Vercel Pro/Enterprise (ignored on Hobby,
// which has a fixed 10s hard cap regardless of this setting).
export const config = { maxDuration: 20 };

const PROVIDER_URL = 'https://data.liveapi.uk/get/mcmil/index.php';
const MAX_RETRIES = 3;
const TIMEOUT_MS = 5000;

// ⚠️ HOBBY PLAN NOTE: worst case (3 attempts × 5s timeout + backoff delays)
// ≈ 15.9s, which exceeds Vercel Hobby's fixed 10s function limit — Vercel
// will kill the function mid-retry before all 3 attempts complete. This is
// fine on Pro/Enterprise (20s cap set above). On Hobby, either accept that
// worst-case failures may only get 1-2 retries in practice before Vercel
// cuts the function, or lower TIMEOUT_MS to ~2500 to fit safely under 10s.

// Module-scope cache — persists across invocations only while the same
// Lambda container stays warm; resets on cold start. Best-effort "last
// known good" fallback, not a durable store — fine for a low-traffic
// internal rate board where a cold-start empty cache just means one
// visitor sees a 502 instead of stale data, extremely rare in practice.
let cache = { contracts: [], lastUpdated: null };

const DISPLAY_NAMES = {
  'Gold':          'MCX Gold',
  'Silver':        'MCX Silver',
  'Copper':        'MCX Copper',
  'Crude Oil':     'MCX Crude Oil',
  'Natural Gas':   'MCX Natural Gas',
  'Lead':          'MCX Lead',
  'Zinc':          'MCX Zinc',
  'Nickel':        'MCX Nickel',
  'Aluminium':     'MCX Aluminium',
  'Spot Gold':     'Spot Gold',
  'Spot Silver':   'Spot Silver',
  'Spot USDINR':   'Spot USDINR',
};

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// ── Helpers ──────────────────────────────────────────────────────

function parseExpiry(expiryRaw) {
  // Expects "DD-MMM-YY" e.g. "05-Aug-26". Returns Date at end-of-day, or
  // null if unparseable / spot contract ("na").
  const s = String(expiryRaw || '').trim();
  if (!s || s.toLowerCase() === 'na') return null;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const d = new Date(year, month, parseInt(m[1], 10), 23, 59, 59);
  return isNaN(d.getTime()) ? null : d;
}

function toNumber(v) {
  if (v === undefined || v === null || v === '' || v === 'na') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function isPlaceholderResponse(json) {
  // Provider sends this exact shape when Origin/Referer auth is missing.
  return Array.isArray(json) && json.length === 1 &&
    String(json[0] && json[0].symb || '').trim().toLowerCase() === 'na' &&
    String(json[0] && json[0].rate || '').toLowerCase().includes('api access');
}

// ── Fetch with retry + timeout ──────────────────────────────────

async function fetchWithRetry() {
  let lastError;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(PROVIDER_URL, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          'Origin': 'https://mcxlive.in',
          'Referer': 'https://mcxlive.in/',
        },
        signal: controller.signal,
      });
      clearTimeout(abortTimer);

      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);

      const json = await response.json();

      if (isPlaceholderResponse(json)) {
        throw new Error('Provider returned placeholder response (Origin/Referer rejected)');
      }
      if (!Array.isArray(json)) {
        throw new Error('Provider response is not an array');
      }

      return json;
    } catch (err) {
      clearTimeout(abortTimer);
      lastError = err;
      console.error(`[feed] attempt ${i + 1}/${MAX_RETRIES} failed:`, err.name, err.message);
      if (i < MAX_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, 300 * (i + 1)));
      }
    }
  }
  throw lastError;
}

// ── Normalise + auto contract rollover ──────────────────────────

function buildContracts(rawList) {
  const mapped = rawList.map(item => {
    const symbol    = String(item.symb || '').trim();
    const expiryRaw = String(item.expiry || '').trim();
    const isSpot    = !expiryRaw || expiryRaw.toLowerCase() === 'na';
    return {
      symbol,
      displayName:   DISPLAY_NAMES[symbol] || symbol,
      expiry:        isSpot ? null : expiryRaw,
      expiryDate:    isSpot ? null : parseExpiry(expiryRaw),   // internal only, stripped before response
      ltp:           toNumber(item.rate),
      buy:           toNumber(item.buy),
      sell:          toNumber(item.sell),
      change:        toNumber(item.chg),
      changePercent: toNumber(item.chgper),
      open:          toNumber(item.open),
      close:         toNumber(item.close),
      high:          toNumber(item.high),
      low:           toNumber(item.low),
      isSpot,                                                  // internal only, stripped before response
    };
  }).filter(c => c.symbol);

  const spotContracts    = mapped.filter(c => c.isSpot);
  const futuresContracts = mapped.filter(c => !c.isSpot);

  // Group MCX futures by symbol. Drop only genuinely expired contracts —
  // everything else stays, tagged "near" (soonest expiry) or "far"
  // (next one after). Auto-rollover still needs zero code changes: the
  // moment a "near" contract's expiry passes, it drops out of `valid`
  // on the next poll and whatever was "far" automatically becomes the
  // new "near" — no dates or contract codes are ever hardcoded.
  const now = new Date();
  const bySymbol = {};
  futuresContracts.forEach(c => {
    (bySymbol[c.symbol] = bySymbol[c.symbol] || []).push(c);
  });

  const allFutures = [];
  Object.keys(bySymbol).forEach(symbol => {
    const valid = bySymbol[symbol].filter(c => c.expiryDate && c.expiryDate.getTime() >= now.getTime());
    if (!valid.length) return; // all contracts for this symbol have expired; skip until provider adds a new one
    valid.sort((a, b) => a.expiryDate - b.expiryDate);
    valid.forEach((c, i) => { c.position = i === 0 ? 'near' : 'far'; });
    allFutures.push(...valid);
  });

  const strip = c => { const { expiryDate, isSpot, ...rest } = c; return rest; };
  return [...spotContracts.map(strip), ...allFutures.map(strip)];
}

// ── Handler ──────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const raw = await fetchWithRetry();
    const contracts = buildContracts(raw);

    if (!contracts.length) {
      throw new Error('Provider data produced zero usable contracts after processing');
    }

    // Only ever overwrite the cache with genuinely valid, non-empty data —
    // a placeholder/error response or empty result never clobbers a good cache.
    cache = { contracts, lastUpdated: new Date().toISOString() };

    return res.status(200).json({
      success: true,
      provider: 'MCXLive',
      lastUpdated: cache.lastUpdated,
      contracts: cache.contracts,
    });

  } catch (error) {
    console.error('[feed] Fetch/process error:', error.message);

    if (cache.contracts.length) {
      // Serve last known good data instead of a hard failure.
      return res.status(200).json({
        success: true,
        provider: 'MCXLive',
        lastUpdated: cache.lastUpdated,
        contracts: cache.contracts,
        stale: true,
        staleReason: error.message,
      });
    }

    return res.status(502).json({
      success: false,
      provider: 'MCXLive',
      error: error.message,
    });
  }
}
