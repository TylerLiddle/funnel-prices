// Daily price-data fetch for The Funnel's Stage 2 v6 architecture.
// Pulls Stooq EOD CSVs for 29 industry ETFs + SPX, pulls the most-recent
// Treasury 10y from home.treasury.gov, writes a single bundle to latest.json.
// Schema: see README.md and stage2_v6_master_plan.md §2 A.5. Schema version 1.0.
// Zero external dependencies — Node 20 standard library only.

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// Canonical industry → Stooq ETF ticker mapping. Order and names MUST match
// INDUSTRY_TO_ETF_TICKER in the working HTML file verbatim — Phase A joins
// industries by `name`. 2026-05-15: three substitutions to purpose-built ETFs
// to eliminate prior intra-sector ticker duplicates (Water & Waste → PHO,
// Automotive → CARZ, Precision Medicine → IDNA). All 29 industries now have
// distinct tickers so Phase B intra-sector percentile ranking is not
// corrupted by byte-identical price series.
const INDUSTRIES = [
  // Defensive (9)
  { name: 'Healthcare',                                  ticker: 'XLV'  },
  { name: 'Utilities',                                   ticker: 'XLU'  },
  { name: 'Consumer Staples',                            ticker: 'XLP'  },
  { name: 'Insurance',                                   ticker: 'KIE'  },
  { name: 'Pharmaceuticals',                             ticker: 'IHE'  },
  { name: 'Medical Devices',                             ticker: 'IHI'  },
  { name: 'Water & Waste',                               ticker: 'PHO'  },
  { name: 'Telecoms',                                    ticker: 'XTL'  },
  { name: 'Defence & Aerospace',                         ticker: 'ITA'  },
  // Secular (10)
  { name: 'Artificial Intelligence & Semiconductors',    ticker: 'SOXX' },
  { name: 'Cybersecurity',                               ticker: 'CIBR' },
  { name: 'Cloud Infrastructure',                        ticker: 'SKYY' },
  { name: 'Renewable Energy',                            ticker: 'ICLN' },
  { name: 'Biotechnology',                               ticker: 'IBB'  },
  { name: 'Digital Payments & Fintech',                  ticker: 'IPAY' },
  { name: 'E-commerce & Logistics',                      ticker: 'IBUY' },
  { name: 'Electric Vehicles & Battery Tech',            ticker: 'IDRV' },
  { name: 'Robotics & Automation',                       ticker: 'BOTZ' },
  { name: 'Precision Medicine',                          ticker: 'IDNA' },
  // Cyclical (10)
  { name: 'Banks & Financial Services',                  ticker: 'KBE'  },
  { name: 'Energy (Oil & Gas)',                          ticker: 'XLE'  },
  { name: 'Mining & Materials',                          ticker: 'XME'  },
  { name: 'Industrials & Capital Goods',                 ticker: 'XLI'  },
  { name: 'Automotive',                                  ticker: 'CARZ' },
  { name: 'Chemicals',                                   ticker: 'XLB'  },
  { name: 'Construction & Real Estate',                  ticker: 'XLRE' },
  { name: 'Shipping & Freight',                          ticker: 'IYT'  },
  { name: 'Travel & Leisure',                            ticker: 'PEJ'  },
  { name: 'Specialty Retail',                            ticker: 'XRT'  }
];

const USER_AGENT = 'funnel-prices/1.0 (daily price mirror; non-commercial research)';
const REQUEST_TIMEOUT_MS = 30000;
const STOOQ_DELAY_MS = 100;

function pad2(n) { return String(n).padStart(2, '0'); }
function ymdCompact(d) { return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`; }
function ymdDashed(d)  { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function yyyymm(d)     { return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}`; }

// Redact apikey from any URL before logging it — keeps the key out of stderr / CI logs.
function redactUrl(url) { return String(url).replace(/(apikey=)[^&]+/gi, '$1[REDACTED]'); }

function fetchUrl(url, redirectDepth) {
  redirectDepth = redirectDepth || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectDepth < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchUrl(next, redirectDepth + 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status} for ${redactUrl(url)}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms for ${redactUrl(url)}`));
    });
    req.on('error', reject);
  });
}

function parseStooqCsv(csv) {
  if (!csv) return [];
  const trimmed = csv.trim();
  if (trimmed.length === 0) return [];
  // Stooq returns the string "No data" (sometimes with extra commentary) for
  // unknown tickers or empty date ranges. Treat anything not starting with a
  // recognisable header as empty.
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headerCols = lines[0].toLowerCase().split(',').map((s) => s.trim());
  if (headerCols[0] !== 'date') return [];
  const closeIdx = headerCols.indexOf('close');
  if (closeIdx < 0) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length <= closeIdx) continue;
    const date = parts[0].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const close = parseFloat(parts[closeIdx]);
    if (!Number.isFinite(close)) continue;
    rows.push([date, close]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

async function fetchStooqSeries(ticker, isSpx, fromYmd, toYmd, apikey) {
  const s = isSpx ? '^spx' : ticker.toLowerCase() + '.us';
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d&d1=${fromYmd}&d2=${toYmd}&apikey=${encodeURIComponent(apikey)}`;
  const csv = await fetchUrl(url);
  return parseStooqCsv(csv);
}

// Treasury XML feed: monthly daily-yield-curve data. Stable endpoint dating
// back to the original treasury.gov XML services. Each <entry> has a child
// <m:properties> with <d:NEW_DATE> and <d:BC_10YEAR> tags.
function parseTreasuryXml(xml) {
  if (!xml) return null;
  const entries = xml.split(/<entry[\s>]/i).slice(1);
  let best = null;
  for (const raw of entries) {
    const dateMatch = raw.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/i);
    const valMatch  = raw.match(/<d:BC_10YEAR[^>]*>([^<]+)<\/d:BC_10YEAR>/i);
    if (!dateMatch || !valMatch) continue;
    const dateStr = dateMatch[1].substring(0, 10);
    const value = parseFloat(valMatch[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
    if (!Number.isFinite(value)) continue;
    if (!best || dateStr > best.asOfDate) best = { asOfDate: dateStr, value };
  }
  return best;
}

async function fetchTreasury10y(today) {
  // Try current month, then previous month (covers month-rollover edge cases
  // and the case where today is very early in the month with no entries yet).
  const months = [
    today,
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 15))
  ];
  let lastErr;
  for (const m of months) {
    const ym = yyyymm(m);
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`;
    try {
      const xml = await fetchUrl(url);
      const parsed = parseTreasuryXml(xml);
      if (parsed) return parsed;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`home.treasury.gov 10y fetch failed: ${lastErr ? lastErr.message : 'no data parsed from any month feed'}`);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const apikey = process.env.STOOQ_APIKEY;
  if (!apikey) {
    console.error('FATAL STOOQ_APIKEY env var not set.');
    console.error('      Stooq requires a per-user API key for CSV downloads. Acquire one by visiting');
    console.error('      https://stooq.com/q/d/?s=xlv.us in a browser, downloading any CSV, and copying the');
    console.error('      apikey value from the download URL (Ctrl+J → right-click → Copy link address).');
    console.error('      Then set it as STOOQ_APIKEY in your shell, or as a GitHub Actions repo secret.');
    process.exit(1);
  }

  const today = new Date();
  const fromDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 14, today.getUTCDate()));
  const fromYmd = ymdCompact(fromDate);
  const toYmd = ymdCompact(today);

  console.log(`funnel-prices fetch — window ${fromYmd}..${toYmd} (UTC)`);

  const industries = [];
  for (const ind of INDUSTRIES) {
    let prices = [];
    try {
      prices = await fetchStooqSeries(ind.ticker, false, fromYmd, toYmd, apikey);
    } catch (e) {
      console.warn(`WARN  ${ind.name} (${ind.ticker}) fetch error: ${e.message}`);
    }
    if (prices.length === 0) {
      console.warn(`WARN  ${ind.name} (${ind.ticker}) returned 0 rows`);
    } else if (prices.length < 250) {
      console.warn(`WARN  ${ind.name} (${ind.ticker}) returned ${prices.length} rows (<250)`);
    }
    industries.push({ name: ind.name, ticker: ind.ticker, prices });
    await sleep(STOOQ_DELAY_MS);
  }

  let spxPrices = [];
  try {
    spxPrices = await fetchStooqSeries('^SPX', true, fromYmd, toYmd, apikey);
    if (spxPrices.length < 250) console.warn(`WARN  SPX returned ${spxPrices.length} rows (<250)`);
  } catch (e) {
    console.error(`ERROR SPX fetch failed: ${e.message}`);
  }

  let treasury10y;
  try {
    treasury10y = await fetchTreasury10y(today);
  } catch (e) {
    console.error(`FATAL ${e.message}`);
    process.exit(1);
  }

  // Determine asOfTradingDate from the most-recent date across populated series.
  const lastDates = [];
  for (const ind of industries) {
    if (ind.prices.length) lastDates.push(ind.prices[ind.prices.length - 1][0]);
  }
  if (spxPrices.length) lastDates.push(spxPrices[spxPrices.length - 1][0]);
  if (lastDates.length === 0) {
    console.error('FATAL no price data fetched from any source — aborting');
    process.exit(1);
  }
  const counts = {};
  for (const d of lastDates) counts[d] = (counts[d] || 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
  const asOfTradingDate = ranked[0][0];
  if (ranked.length > 1) {
    console.warn(`WARN  last-trading-date disagreement across series; picked ${asOfTradingDate} from ${JSON.stringify(counts)}`);
  }

  const bundle = {
    schemaVersion: '1.0',
    asOfTradingDate,
    fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    attribution: {
      priceData: 'Data from stooq.com — non-commercial research use; see README.md',
      treasuryData: 'Data from home.treasury.gov (public domain)'
    },
    industries,
    spx: { ticker: '^SPX', prices: spxPrices },
    treasury10y
  };

  const outPath = path.join(__dirname, 'latest.json');
  fs.writeFileSync(outPath, JSON.stringify(bundle));

  const fileSizeBytes = fs.statSync(outPath).size;
  const fileSizeKb = fileSizeBytes / 1024;
  const fetchedOk = industries.filter((i) => i.prices.length > 0).length;
  const longEnough = industries.filter((i) => i.prices.length >= 250).length;
  const shortInds = industries.filter((i) => i.prices.length < 250);

  // Hard validation gates. Failures here = exit 1.
  let exitCode = 0;
  if (industries.length !== 29) {
    console.error(`FATAL industries.length === ${industries.length}, expected 29`);
    exitCode = 1;
  }
  if (bundle.schemaVersion !== '1.0') {
    console.error(`FATAL schemaVersion === ${bundle.schemaVersion}, expected "1.0"`);
    exitCode = 1;
  }
  if (!(typeof treasury10y.value === 'number' && treasury10y.value > 0 && treasury10y.value < 20)) {
    console.error(`FATAL treasury10y.value (${treasury10y.value}) out of (0, 20)`);
    exitCode = 1;
  }
  const asOfMs = Date.parse(asOfTradingDate + 'T00:00:00Z');
  const ageDays = (Date.now() - asOfMs) / 86400000;
  if (!Number.isFinite(asOfMs) || ageDays < 0 || ageDays > 7) {
    console.error(`FATAL asOfTradingDate ${asOfTradingDate} is ${ageDays.toFixed(1)} days old`);
    exitCode = 1;
  }
  if (fileSizeKb >= 500) {
    console.error(`FATAL latest.json is ${fileSizeKb.toFixed(0)} KB (>= 500 KB ceiling)`);
    exitCode = 1;
  }

  console.log('');
  console.log('fetch.js complete:');
  console.log(`  industries fetched: ${fetchedOk}/29`);
  console.log(`  industries with >=250 rows: ${longEnough}`);
  if (shortInds.length > 0) {
    const desc = shortInds.map((i) => `${i.name} — ${i.ticker}, ${i.prices.length} rows`).join('; ');
    console.log(`  industries with <250 rows: ${shortInds.length} (${desc})`);
  } else {
    console.log(`  industries with <250 rows: 0`);
  }
  console.log(`  spx rows: ${spxPrices.length}`);
  console.log(`  treasury10y: ${treasury10y.value}% as of ${treasury10y.asOfDate}`);
  console.log(`  asOfTradingDate: ${asOfTradingDate}`);
  console.log(`  file size: ${fileSizeKb.toFixed(0)} KB`);
  console.log(`  exit code: ${exitCode}`);

  process.exit(exitCode);
}

main().catch((e) => {
  console.error(`FATAL unhandled: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
