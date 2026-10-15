// Shah Jewellers — Live MCX Rate Feed
// Vercel Serverless Function — place at /api/feed.js
//
// Fetches MCX + Spot rates from a data provider YOU are authorised to use,
// validates them, normalises them, and auto-rolls contracts by expiry date.
//
// ── SETUP (Vercel dashboard → this project → Settings → Environment Variables)
//   MCX_PROVIDER_URL        (required) the provider's rates endpoint
//   MCX_API_KEY             (optional) your API key / token
//   MCX_API_KEY_HEADER      (optional) header name for the key, default "Authorization"
//   MCX_API_KEY_PREFIX      (optional) text before the key, default "Bearer "
// After adding or changing variables, redeploy the project.
//
// The provider must return a JSON array of items shaped like:
//   { symb, expiry, rate, buy, sell, chg, chgper, open, close, high, low }
// (expiry is "DD-MMM-YY" for futures, and "na" or "-" for spot rows).
// If your provider uses a different shape, change buildContracts() only.

export const config = { maxDuration: 10 };

const PROVIDER_URL = process.env.MCX_PROVIDER_URL || '';
const API_KEY = process.env.MCX_API_KEY || '';
const API_KEY_HEADER = process.env.MCX_API_KEY_HEADER || 'Authorization';
const API_KEY_PREFIX = process.env.MCX_API_KEY_PREFIX !== undefined ? process.env.MCX_API_KEY_PREFIX : 'Bearer ';

// Kept short so worst case (2 tries) stays well under Vercel Hobby's 10s limit.
const MAX_RETRIES = 2;
const TIMEOUT_MS = 3000;

// Warm-container memory cache: serves repeat requests within CACHE_TTL_MS
// without calling the provider again, and is the "last known good" fallback.
const CACHE_TTL_MS = 2000;
let cache = { contracts: [], lastUpdated: null, fetchedAt: 0 };

const DISPLAY_NAMES = {
  'Gold': 'MCX Gold', 'Silver': 'MCX Silver', 'Copper': 'MCX Copper',
  'Crude Oil': 'MCX Crude Oil', 'Natural Gas': 'MCX Natural Gas',
  'Lead': 'MCX Lead', 'Zinc': 'MCX Zinc', 'Nickel': 'MCX Nickel',
  'Aluminium': 'MCX Aluminium',
  'Spot Gold': 'Spot Gold', 'Spot Silver': 'Spot Silver', 'Spot USDINR': 'Spot USDINR',
};

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// ── Helpers ──────────────────────────────────────────────────────

function isSpotExpiry(expiryRaw) {
  const s = String(expiryRaw || '').trim().toLowerCase();
  // Providers mark spot rows with "na", "-", or blank. (An older version of
  // this file only checked "na" and silently dropped spot rows that use "-".)
  return s === '' || s === 'na' || s === '-';
}

function parseExpiry(expiryRaw) {
  if (isSpotExpiry(expiryRaw)) return null;
  const m = String(expiryRaw).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const d = new Date(year, month, parseInt(m[1], 10), 23, 59, 59);
  return isNaN(d.getTime()) ? null : d;
}

function toNumber(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s.toLowerCase() === 'na' || s === '-') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── Fetch with retry + timeout ──────────────────────────────────

async function fetchFromProvider() {
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'ShahJewellers-RateBoard/1.0',
  };
  if (API_KEY) headers[API_KEY_HEADER] = API_KEY_PREFIX + API_KEY;

  let lastError;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(PROVIDER_URL, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(abortTimer);

      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);

      // Read as text first so an empty or non-JSON reply gives a clear error
      // instead of "Unexpected end of JSON input".
      const bodyText = await response.text();
      if (!bodyText.trim()) {
        throw new Error(`Provider returned an empty response (HTTP ${response.status}, 0 bytes)`);
      }
      let json;
      try { json = JSON.parse(bodyText); }
      catch (e) { throw new Error(`Provider returned non-JSON (starts with: ${bodyText.slice(0, 60)})`); }

      const list = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : null);
      if (!list) throw new Error('Provider response is not a list of rates');
      if (list.length === 0) throw new Error('Provider returned an empty rate list');
      return list;
    } catch (err) {
      clearTimeout(abortTimer);
      lastError = err;
      console.error(`[feed] attempt ${i + 1}/${MAX_RETRIES} failed:`, err.name, err.message);
      if (i < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastError;
}

// ── Normalise + auto contract rollover ──────────────────────────

function buildContracts(rawList) {
  const mapped = rawList.map(item => {
    const symbol = String(item.symb || '').trim();
    const expiryRaw = String(item.expiry || '').trim();
    const isSpot = isSpotExpiry(expiryRaw);
    return {
      symbol,
      displayName: DISPLAY_NAMES[symbol] || symbol,
      expiry: isSpot ? null : expiryRaw,
      expiryDate: isSpot ? null : parseExpiry(expiryRaw),   // internal only
      ltp: toNumber(item.rate),
      buy: toNumber(item.buy),
      sell: toNumber(item.sell),
      change: toNumber(item.chg),
      changePercent: toNumber(item.chgper),
      open: toNumber(item.open),
      close: toNumber(item.close),
      high: toNumber(item.high),
      low: toNumber(item.low),
      isSpot,                                                // internal only
    };
  }).filter(c => c.symbol);

  const spotContracts = mapped.filter(c => c.isSpot);
  const futuresContracts = mapped.filter(c => !c.isSpot);

  // Drop only genuinely expired contracts; tag the soonest "near" and the
  // rest "far". When a near contract expires it drops out on the next poll
  // and the next one becomes "near" — no dates are ever hardcoded.
  const now = new Date();
  const bySymbol = {};
  futuresContracts.forEach(c => { (bySymbol[c.symbol] = bySymbol[c.symbol] || []).push(c); });

  const allFutures = [];
  Object.keys(bySymbol).forEach(symbol => {
    const valid = bySymbol[symbol].filter(c => c.expiryDate && c.expiryDate.getTime() >= now.getTime());
    if (!valid.length) return;
    valid.sort((a, b) => a.expiryDate - b.expiryDate);
    valid.forEach((c, i) => { c.position = i === 0 ? 'near' : 'far'; });
    allFutures.push(...valid);
  });

  const strip = c => { const { expiryDate, isSpot, ...rest } = c; return rest; };
  return [...spotContracts.map(strip), ...allFutures.map(strip)];
}

// ── Handler ──────────────────────────────────────────────────────

function sendStaleOrError(res, error) {
  if (cache.contracts.length) {
    // Serve last known good data; the app shows its "stale" banner.
    res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=10');
    return res.status(200).json({
      success: true,
      provider: 'configured-provider',
      lastUpdated: cache.lastUpdated,
      contracts: cache.contracts,
      stale: true,
      staleReason: error,
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(502).json({ success: false, provider: 'configured-provider', error });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=10');

  if (!PROVIDER_URL) {
    return sendStaleOrError(res, 'Market data source not configured: set MCX_PROVIDER_URL in the Vercel project settings');
  }

  // Serve straight from memory if we fetched very recently.
  if (cache.contracts.length && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return res.status(200).json({
      success: true,
      provider: 'configured-provider',
      lastUpdated: cache.lastUpdated,
      contracts: cache.contracts,
    });
  }

  try {
    const raw = await fetchFromProvider();
    const contracts = buildContracts(raw);
    if (!contracts.length) throw new Error('Provider data produced zero usable contracts after processing');

    // Only ever overwrite the cache with valid, non-empty data.
    cache = { contracts, lastUpdated: new Date().toISOString(), fetchedAt: Date.now() };

    return res.status(200).json({
      success: true,
      provider: 'configured-provider',
      lastUpdated: cache.lastUpdated,
      contracts: cache.contracts,
    });
  } catch (error) {
    console.error('[feed] Fetch/process error:', error.message);
    return sendStaleOrError(res, error.message);
  }
}
