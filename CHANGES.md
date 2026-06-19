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
