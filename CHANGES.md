# Keystone — dashboard & application update

Changes made in this round, all built on the existing underwriting engine
(`calc.js` + `tx-tax.js`) so the dashboard and the application stay in sync.

## Find-a-Home dashboard (`dashboard.html` / `dashboard.js`)
- **Per-home estimated payment.** Every listing card now shows an estimated
  monthly payment computed from *your* application (program, down %, rate, term,
  credit, income, debts) applied to that home's price and HOA.
- **Live "Your numbers" bar.** A bar above the results shows your estimated
  payment, front/back DTI (color-graded against your program's limit), and cash
  to close — and it stays visible after the application is done.
- **Select a home → numbers update.** Tap "Use these numbers" (or the card body)
  and the bar recomputes DTI, payment, and cash to close for that home. "Clear
  selection" returns to your application's target price.
- **ZIP changes everything in real time.** Changing the ZIP (or picking a spot on
  the map) reloads listings + map pins, recomputes the property-tax rate for that
  county, and re-runs your numbers — then writes the new ZIP + tax rate back onto
  your application.
- **Expandable, draggable map.** The map (⤢) icon opens a larger Texas map you can
  drag and zoom. Click *anywhere* — you don't need to click a home — to look in
  that area; it resolves to the nearest metro ZIP, updates the tax rate, and
  reloads the dashboard.
- **Filter dropdowns no longer get cut off.** Menus that would spill off the right
  edge now flip to stay on-screen, and go full-width on small screens.

## Application (`apply.html` / `apply.js`)
- **"My Application" reopens what you submitted.** When you're signed in, the
  application page loads your saved answers and jumps to the review screen; you
  can edit and **Save changes** without creating a new account.
- Carries your "where you're looking" ZIP through submission.
- Fixed a pre-existing syntax error (an unescaped apostrophe) that broke the page.

## Portal (`portal.html`)
- Shows **where you're looking** and the current property-tax rate.
- Estimated numbers reflect the **home you selected** on the dashboard when one is
  set (with a note), otherwise your application's target price.
- Added a **View / edit** button that opens your submitted application.

## Server / data (`server.js` / `db.js`)
- `POST /api/application` — save a new version of the application for a logged-in
  user (used by "Save changes").
- `PATCH /api/application/context` — merge live shopping context (ZIP, tax rate,
  selected home + its recomputed numbers) onto the latest application without
  discarding the original submission.
- Added the `updateLatestApplication` query to both the SQLite and the pure-JS
  fallback stores.

---

# Round 2 — live listings (RentCast) + persistent numbers bar

## Live for-sale listings via RentCast
- `/api/listings` now pulls **live active for-sale listings from RentCast** when a
  ZIP is searched and an API key is set. Results are **cached in the DB for 12
  hours per ZIP**, so the free tier's 50-calls/month budget isn't spent on filter
  or sort changes — one call per ZIP per 12h.
- Graceful fallbacks: no key, or an all-Texas browse with no ZIP, shows the sample
  inventory; a quota error (429) or network failure serves stale cache if present,
  otherwise the sample set — the app never breaks.
- The RentCast call happens **server-side only**, so your API key is never exposed
  to the browser.
- New `listings_cache` table added to both the SQLite and pure-JS stores.

### Where to put your API key
1. Get a free key at https://www.rentcast.io/api (Dashboard → API Keys).
2. In the project root, copy `.env.example` to `.env`.
3. Put your key in it: `RENTCAST_API_KEY=your_key_here` (and set `SESSION_SECRET`).
4. Restart the server. `.env` is gitignored so the key won't be committed.
   (You can also set it as a real environment variable instead of using `.env`.)

## Persistent "your numbers" bar
- A sticky bar under the nav now shows **estimated payment, front/back DTI (color-
  graded), LTV, cash to close, and your qualified ceiling** at all times when
  logged in — on the client portal and the find-a-home dashboard.
- On the dashboard it updates live as you select a home or change ZIP; on the
  portal it reflects the home you last selected (or your application's target).
- Implemented as a shared component (`public/js/numberbar.js`) so both pages stay
  consistent.

---

# Round 3 — auth, session, SSN, and navigation fixes

## Single source of truth for "logged in" = the server session
The app previously trusted three different signals (server session, browser
`sessionStorage`, and hardcoded nav links), which contradicted each other and
caused the broken behavior where "Find a Home" showed someone's numbers without
a real login. Fixed:
- Removed ALL `sessionStorage` ("ks_app_preview") use. Application data now comes
  only from the server, only when authenticated.
- The Find-a-Home dashboard is now gated: it checks `/api/me` first and redirects
  to the portal login if there's no session. Nothing renders and no numbers
  appear for a logged-out visitor.
- New shared `public/js/nav.js` makes every page's nav auth-aware: items marked
  `data-auth="in"` show only when logged in, `data-auth="out"` only when logged
  out. "Find a Home" and "My Application" are logged-in-only and start hidden, so
  they never flash for logged-out visitors.
- After completing an application + creating an account, the user lands on the
  client portal (server session established). On a server error the account is
  reported as NOT created instead of faking a logged-in dashboard.

## Account creation / login verified
Registration saves the user (bcrypt hash) and the application; logout clears the
session; logging back in with the same credentials restores everything. Verified
end-to-end against a fresh database. (Ship with an empty store; it seeds itself.)

## SSN input no longer scrambles digits
The old formatter restored the caret to its pre-format position, so when a dash
was auto-inserted the caret landed before the digit you just typed — reversing
input. Rewrote it with digit-count-aware caret positioning so digits stay in the
order typed (and mid-string edits behave).

## Exit confirmation in the application
Pressing "Home" (or the logo) inside the application now opens a confirmation:
the application isn't saved and leaving deletes the entered information. "Keep
editing" stays; "Leave & delete" exits to the home page.

---

# Round 4 — network-error fix, multi-application, REO/rental, decision modal, points

## The "network error" is fixed (root cause found)
The applications table had a `UNIQUE(user_id, purpose)` constraint but the insert
didn't set a purpose, so a SECOND application collided on the unique key, threw,
and the unhandled error became a 500 that the browser reported as a network
error. Fixed by:
- A real multi-application data model: one application per loan purpose, with an
  upsert (update-in-place) instead of blind insert. (db.js + server.js)
- A global JSON error handler + async route wrapper so ANY server error returns
  a real JSON message — a server error can never again look like a network error.
- Verified live end-to-end: register → second application (different product) →
  re-submit same product (upsert) → logout → login, with zero server errors.

## Multiple applications per account (one per product)
purchase / refinance / investment / second_home. You can have one of each, edit
any of them, and delete one to free up that product. New endpoints:
GET /api/applications, GET/POST/DELETE /api/application?purpose=…, GET /api/profile.
The portal now lists all your applications with Open/Edit and Delete, plus
"Start another application."

## No second account prompt
When you're logged in, the application never shows the "create an account" card
again — it saves straight to your account. Starting another application offers to
reuse your contact + income info (SSN is never stored and must be re-entered), and
products you already have are locked so you can't duplicate them.

## Submit → processing → decision
Submitting now shows a "submitting… running an automated pre-qualification, this
will take a few moments" screen, then an Approved result (or a "needs a closer
look" with the specific items) before sending you to your portal.

## Rate buydown in cash to close
Discount points now flow into cash-to-close: +1 point adds 1% of the loan, a
lender credit subtracts it. (calc.js + the rate scenario you pick.)

## Real-world program/occupancy rules
- Page-1 question "owned or sold a home in the last 3 years?" drives first-time-
  buyer status (the real 3-year test). If yes, first-time-buyer programs and
  down-payment assistance disappear.
- Loan purpose + occupancy gate programs: FHA/VA/USDA are primary-only;
  Conventional 97 and DPA require a primary residence AND a first-time buyer;
  investment and second homes are Conventional/Jumbo with higher minimum down
  (15% investment, 10% second home).

## Properties you own (REO) + rental income
In Debts & Assets you can add any number of homes you own (value, balance, rate,
taxes, insurance, PMI/MIP) and we estimate each one's payment. A home you keep
counts as a monthly debt; a home you rent out applies 75% of the gross rent net
of its payment (positive → income, negative → debt), per the agency rental rule.
This feeds your DTI so you can qualify for the next purchase or investment.

### Honest scope notes (v1)
- Refinance is selectable and stored as its own product, but the property step is
  still purchase-oriented (price/down) rather than a full current-value/payoff/
  cash-out LTV flow. That's the next thing to build out.
- Program rules cover the common cases accurately; they are not a full agency
  rule engine (e.g., USDA/EA income limits, FHA county loan limits, MI tiers by
  score band are simplified).

---

# Round 5 — full refinance flow + sign-in verified

## Refinance is now a real flow (not purchase-style)
Choosing "Refinance" on page 1 swaps the property step for a refinance-specific
one:
- Current home value + current mortgage payoff → equity and current LTV.
- Rate & term vs Cash-out. Cash-out shows a live "max cash at XX% LTV" figure and
  warns when the new loan exceeds the program's LTV cap.
- "Roll closing costs into the loan" option.
- New loan = payoff + cash-out (+ financed costs); LTV = new loan ÷ home value.
- The bar's "Cash to Close" becomes "Cash to you" for a cash-out refi and shows
  the net proceeds; rate & term shows cash to close.
- Real LTV caps by program/occupancy/type (e.g., conventional cash-out 80%
  primary / 75% non-owner; FHA cash-out 80%; VA cash-out ~90%; rate & term up to
  95% primary). Refinance offers Conventional/FHA/VA/Jumbo only (no USDA-rural,
  first-time-buyer, DPA, or land). The engine has a dedicated calculateRefi path
  so the purchase math (and its 21 tests) is untouched.
- The review screen and stored application carry the refinance details, and they
  reload correctly when you edit a saved refinance from the portal.

## Sign-in after creating an account — verified end to end
Tested live: create an account through the application → sign out → sign back in
(including different email casing) → session restored → add a second product
(refinance) on the same account. Also unit-tested the portal's login form itself
(fills credentials, posts to /api/login, transitions to the portal view). No
server errors at any step.

### Still simplified (honest notes)
LTV caps, MI factors, and funding/guarantee fees use representative values, not a
full per-investor/agency matrix; VA IRRRL vs VA cash-out fee nuances and FHA
streamline (no-appraisal) specifics are approximated.

---

# Round 6 — centralized, configurable rule table

All program guidelines now live in ONE place: `MortgageCalc.RULES` in calc.js.
The engine reads every limit/factor/fee from this table instead of hardcoded
values scattered through the code, so a lender can plug in their own rate card
with `MortgageCalc.configure({ ... })` (deep-merge, no code edits).

What's in the table: conforming/FHA limits, homeowners-insurance & closing-cost
rates, program labels, minimum down payment by program × occupancy (with the FHA
<580-credit 10% rule), minimum credit by program, max back-end DTI by program,
refinance max-LTV by program × type × occupancy, the conventional PMI grid, FHA
UFMIP/MIP, USDA fees, and VA funding fees split into purchase (by use × down) vs
IRRRL (streamline) vs cash-out.

The application UI now derives its DTI ceilings and minimum-down checks from this
same table (no more duplicate copies in apply.js), so the form and the engine can
never drift apart. Verified: occupancy-aware min down (conv 5% primary / 15%
investment), FHA low-credit 10% down, VA fee 1.5%/0.5%/2.15% for purchase/IRRRL/
cash-out, refi caps pulled from the table, and a configure() override visibly
changing the cap and DTI. All 21 calc tests still pass.

---

# Round 7 — login fixed for real (cookie + honest errors)

ROOT CAUSE of "Network error / it doesn't save my login": the session cookie was
marked Secure whenever NODE_ENV=production. Over plain http that makes the browser
silently discard the cookie, so login returned 200 but the next request was
logged out — and the portal then read an undefined user and threw, which the old
code mislabeled as "Network error."

Fixes:
- Cookie is Secure ONLY when you opt in with COOKIE_SECURE=1 (for real HTTPS).
  Default is http-friendly, so the session persists. Verified login persists even
  with NODE_ENV=production now.
- /api/login and /api/register-and-submit save the session explicitly and return
  the user, so the client doesn't depend on a fragile second request.
- Recreated the portal login: true network failures say "can't reach the server,"
  wrong passwords show the real reason, and a rendering error can never masquerade
  as a network error. Opening the page as a file:// now shows clear instructions
  to start the server instead of failing silently.

---

# Round 8 — works on Render/HTTPS, cookie-proof login

Deploying behind a proxy (Render) exposed the last cookie pitfall. Fixed two ways
so login works no matter the environment:

1. Proxy-aware cookies: `app.set('trust proxy', 1)` + `cookie.secure:'auto'`, so the
   cookie is correctly marked Secure over HTTPS (Render) and plain over local http
   — the same build works in both places, no env tweaking.
2. Token fallback (belt-and-suspenders): /api/login and /api/register-and-submit
   return a signed HMAC token. A new /js/auth.js (loaded first on every page)
   stores it and sends it as `Authorization: Bearer …` on every API call, and
   requireAuth accepts it. So even if the browser/host drops cookies entirely,
   auth still works. The token is verified by HMAC(SESSION_SECRET); forged tokens
   are rejected.

Note on Render: the free tier's filesystem is ephemeral, so the bundled SQLite/
JSON store resets when the service restarts or redeploys (accounts created before
a restart won't be there after). For durable accounts, attach a Render Disk or use
a managed Postgres and point the data store at it. Also set SESSION_SECRET in the
Render dashboard so tokens/sessions survive restarts.

Verified: token-only auth (no cookies) — register/login return a token, /api/me &
protected routes accept it (200), missing/forged tokens rejected (401); cookie
auth still 200; client auth.js captures/attaches/clears the token. 21 calc tests
pass.

---

# Round 9 — Postgres for durable accounts on Render

The data layer now supports Postgres so accounts/applications survive restarts and
redeploys on Render (the free tier's local disk is wiped on restart, which is why
file-based storage "forgot" accounts).

How it works:
- Set DATABASE_URL → the app uses Postgres (node-postgres). No DATABASE_URL → it
  falls back to better-sqlite3, or a pure-JS file store, for local dev. Same code.
- The entire query layer (`q`) is now async; every route awaits it. initDb()
  creates the Postgres tables on boot, then the server starts listening.
- SSL is enabled automatically for non-local Postgres (Render requires it).

Verified: 14 Postgres SQL checks via an in-memory Postgres engine (SERIAL +
RETURNING, UNIQUE(user_id,purpose) enforcement, ON CONFLICT upserts for saved
properties and the listings cache, rowCount→changes, now()); a full end-to-end
server run on Postgres (register → token auth → second product → returning login →
data still present); and the local JSON path still passes the whole flow. 21 calc
tests pass.

## Render setup (one time)
1. Render dashboard → New → PostgreSQL. Create it (free tier is fine).
2. Open the new database → copy the "Internal Database URL".
3. Your web service → Environment → add:
     DATABASE_URL = <the Internal Database URL>
     SESSION_SECRET = <any long random string>
4. Deploy. On boot you'll see "Keystone running (postgres)" and accounts persist.
