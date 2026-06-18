# Keystone Home Lending

A Texas home-lending **pre-qualification** platform: a marketing site, a multi-step
loan application with a **live underwriting bar** (DTI / LTV / payment / cash-to-close),
an account-gated submission, a **client portal**, and a **property dashboard** that filters
real estate to the borrower's qualified price range.

> **Read this first — what this is and isn't.** Every rate, payment, tax, mortgage-insurance,
> and qualification figure is an **estimate for educational purposes only**. It is **not** a
> Loan Estimate, an approval, or a commitment to lend, and it is not legal or compliance
> sign-off. See **Disclaimers & compliance** at the bottom.

---

## Quick start

```bash
npm install      # installs express, express-session, bcryptjs, better-sqlite3
npm start        # serves http://localhost:3000
```

Optional:

```bash
SESSION_SECRET="a-long-random-string" npm start   # set a real secret (recommended)
npm run test:calc                                   # run the underwriting-engine tests
```

### Node version & the database

The default datastore is **better-sqlite3**, a native module. It builds on first install
with Node 18–22 and a C toolchain present (it ships prebuilt binaries for common platforms).

If `better-sqlite3` can't be installed or built in your environment, the app **still runs**:
`db.js` transparently falls back to a small pure-JS, file-backed store at `data/store.json`
with the identical query interface. You'll see a one-line warning on boot. Install
`better-sqlite3` for any real deployment — the JSON fallback is for convenience/dev only.

---

## Project layout

```
homelend/
  server.js              Express API + static host + session auth
  db.js                  Persistence (better-sqlite3 → JSON fallback). Single query surface `q`.
  package.json
  test/test_calc.js      Underwriting-engine unit tests
  public/
    index.html           Marketing landing page
    contact.html         Request-a-callback page
    apply.html           Multi-step loan application + sticky underwriting bar
    dashboard.html       Property search dashboard (filters to qualified range)
    portal.html          Client portal: login + application summary + saved homes
    css/app.css          Shared design system
    js/
      calc.js            Mortgage math engine (UMD: browser + Node, unit-tested)
      tx-tax.js          Texas property-tax estimator by county/ZIP (UMD)
      market-data.js     Rate grid + listings data layer (UMD)  ← real-feed swap point
      apply.js           Wizard controller (live recompute, program rules, submit)
      dashboard.js       Dashboard controller (filters, cards, map pins, save, lightbox)
  data/                  Runtime data (JSON fallback store lives here)
```

## How the pieces connect

1. **Apply** (`apply.html` + `apply.js`) collects the borrower profile, property, program,
   income, debts/assets, and rate. The underwriting bar recomputes on every keystroke via
   `calc.js`. Texas property tax auto-fills from the ZIP via `tx-tax.js`.
2. **Submit** requires creating an account. `POST /api/register-and-submit` hashes the
   password (bcrypt, cost 12), stores the user + application, and starts a session.
3. **Dashboard** (`dashboard.html` + `dashboard.js`) reads the submitted application
   (`GET /api/application`), clamps the max price to the borrower's qualified amount, and
   lists properties from `GET /api/listings`. Hearts save via `POST/DELETE /api/saved`.
4. **Portal** (`portal.html`) logs users back in (`POST /api/login`) and shows their
   application summary, estimated numbers, and saved homes.

## API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/api/register-and-submit` | — | Create account, store application, start session |
| POST | `/api/login` | — | Sign in |
| POST | `/api/logout` | — | Destroy session |
| GET  | `/api/me` | ✓ | Current user |
| GET  | `/api/application` | ✓ | Latest submitted application |
| GET  | `/api/listings` | — | Listings (filterable: minPrice, maxPrice, beds, minSqft, types, zip) |
| GET  | `/api/saved` | ✓ | Saved properties |
| POST | `/api/saved` | ✓ | Save a property |
| DELETE | `/api/saved/:id` | ✓ | Remove a saved property |

---

## Production swap points (clearly marked in code)

- **Real listings** — `public/js/market-data.js → fetchListings()` returns sample data.
  Replace with a licensed **MLS/IDX (RESO Web API)** or aggregator (ATTOM, Bridge, RentCast).
  There is **no legal public Zillow/Redfin/Realtor API**; Zillow retired theirs and scraping
  all three violates their terms. Wire the licensed feed here and the dashboard works unchanged.
- **Live daily rates** — `market-data.js → fetchLiveRates()` is a stub returning `null`; the
  app uses a seeded rate grid. Connect a pricing engine / rate feed and have the grid read from it.
- **Full Texas ZIP→county tax** — `tx-tax.js` ships county effective rates + a representative
  ZIP map + statewide fallback. Load the complete **HUD ZIP–county crosswalk** via
  `Tax.loadCrosswalk(map)` in production. Note: Texas taxes by overlapping units
  (county + city + ISD + **MUD/PID**), so ZIP-level figures are estimates and local
  special-district levies can move the rate materially.
- **Postgres** — `db.js` isolates all SQL to the `q` object. Port to `pg` with `$1` placeholders;
  no route changes required.
- **Lead capture** — `contact.html` is a demo form; POST it to your CRM / lead inbox.
- **Map provider** — the dashboard map panel positions pins from sample coordinates. Drop in
  Mapbox / Google Maps / MapLibre with geocoded results from your live feed.

## Security practices implemented

bcrypt password hashing (cost 12); parameterized queries / no string-built SQL; `httpOnly`,
`sameSite=lax` session cookies (`secure` in production); `x-powered-by` disabled; basic
security headers; generic login errors to avoid account enumeration; an `audit_log` table
with hooks on sensitive actions. Set a strong `SESSION_SECRET` env var and serve over HTTPS.

> **"SOC 2 compliant"** is an organizational audit performed by a CPA firm against the Trust
> Services Criteria — it is **not** a property of source code. The above are supporting
> controls. Achieving SOC 2 also requires org-level policies, access controls, logging/monitoring,
> vendor management, and an audit period. This codebase does not by itself make you SOC 2 compliant.

## Disclaimers & compliance

This is a demonstration pre-qualification tool. All outputs are **estimates** and do not
constitute a Loan Estimate, an offer or commitment to lend, or credit approval. Actual terms
depend on a complete application, credit pull, property appraisal, and underwriting. Rates
change daily. Texas property-tax figures are county-level effective-rate estimates that may not
reflect local MUD/PID/special-district levies. Before any real-world use, have the flow,
disclosures, and forms reviewed by a licensed mortgage professional and counsel for compliance
with applicable federal and Texas law, including **TILA / Reg Z, RESPA / Reg X, ECOA / Reg B,
the SAFE Act, and the Texas Finance Code**. Equal Housing Lender.
