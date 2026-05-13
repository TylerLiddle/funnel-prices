# funnel-prices

Daily-refreshed price-data mirror for The Funnel prototype's Stage 2 v6 architecture.

A scheduled GitHub Action runs `fetch.js` every weekday at **06:00 UTC**, pulls the trailing 14 months of daily closes for 29 industry ETFs plus the S&P 500 from Stooq, pulls the most-recent 10-year Treasury par yield from home.treasury.gov, normalises the result into a single bundle JSON, and commits it to `main` as `latest.json`. The Funnel prototype's Phase A retrieval reads the bundle with a single `web_fetch` against:

```
https://raw.githubusercontent.com/{handle}/funnel-prices/main/latest.json
```

## Bundle schema (version 1.0)

```json
{
  "schemaVersion": "1.0",
  "asOfTradingDate": "YYYY-MM-DD",
  "fetchedAt": "YYYY-MM-DDTHH:MM:SSZ",
  "attribution": { "priceData": "...", "treasuryData": "..." },
  "industries": [ { "name": "Healthcare", "ticker": "XLV", "prices": [["YYYY-MM-DD", 142.31], ...] }, ... ],
  "spx":         { "ticker": "^SPX", "prices": [["YYYY-MM-DD", 5612.31], ...] },
  "treasury10y": { "asOfDate": "YYYY-MM-DD", "value": 4.31 }
}
```

- `industries` is a length-29 array ordered to match `INDUSTRY_TO_ETF_TICKER` in the prototype. Each `name` matches the prototype name verbatim so Phase B can join on `name`.
- `prices` rows are `[date, close]` tuples, sorted ascending. Date strings are ISO `YYYY-MM-DD`.
- Schema version is the compatibility contract with the prototype. Any breaking change requires a coordinated prototype + mirror release.

## Triggering a manual run

GitHub → **Actions** tab → **Daily Stooq Fetch** workflow → **Run workflow** (uses `workflow_dispatch`). Use this to refresh outside the daily schedule or to bring up `latest.json` for the first time.

## Failure-mode notes

- If the scheduled run fails (Stooq blocks the runner, Treasury feed shape changes, GitHub outage), the last successful `latest.json` remains served from `raw.githubusercontent.com`. Check the **Actions** tab for the failure log and re-run manually once the issue is resolved.
- Partial industry failures (some series fetch OK, others don't) are not fatal: the bundle still commits, with empty `prices` arrays for failing series. The prototype handles missing series via `dataAvailable: false`, not crashes.
- A bundle older than ~48h triggers a stale-data warning surfaced in the prototype's methodology disclosure.

## Attribution

### Stooq (price data)

End-of-day price series for the 29 industry ETFs and the S&P 500 index are sourced from Stooq (https://stooq.com), accessed via the public CSV download endpoint at `stooq.com/q/d/l/` using a per-user API key obtained through Stooq's standard captcha-protected acquisition flow at `stooq.com/q/d/?s={ticker}&get_apikey`.

This mirror exists strictly for **non-commercial research use** in support of an academic/personal investment-research project. The bundle published here is **derived data** (per-ticker date and close arrays), not a redistribution of Stooq's raw CSV product, and is refreshed once per US trading day rather than streamed.

A reasonable good-faith search of stooq.com at the time of this mirror's setup did not surface a formal published Terms of Use document covering API-key usage or redistribution of derived data; the apikey acquisition flow itself does not require acceptance of any displayed terms. If Stooq publishes terms that this mirror's behaviour conflicts with, please contact the maintainer (see below) and the mirror will be brought into compliance or taken offline.

**Rights-holder contact:** Stooq or any other rights-holder with a concern about this mirror's content or refresh cadence may open a GitHub issue on this repository or contact the repository owner via their GitHub profile. The maintainer commits to responding within 24 hours of receipt and to taking the mirror offline within 24 hours of any credible request from Stooq or their authorised representatives.

### US Treasury (10-year yield)

The 10-year Treasury par yield is sourced from the US Department of the Treasury's daily treasury yield curve XML feed at `home.treasury.gov`. US Treasury data is a US government work and is in the **public domain** in the United States. See https://home.treasury.gov for current rate publications.

## Repository layout

```
.
├── fetch.js                          Daily fetch + bundle writer (Node 20, zero deps)
├── latest.json                       Most recent bundle (committed by the Action)
├── .github/workflows/daily-fetch.yml Schedule + manual-trigger workflow
├── .gitignore
└── README.md
```

## Operator setup

The script has zero npm dependencies; nothing to install. To run locally:

```
node fetch.js
```

This writes `latest.json` to the repo root. Exit code 0 = success (including partial fetches with warnings); exit code 1 = unrecoverable failure (zero industries fetched, Treasury feed unparseable, or schema validation fails).

Schema version: **1.0**. Bundle URL: `https://raw.githubusercontent.com/{handle}/funnel-prices/main/latest.json`.
