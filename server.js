/* server.js — Keystone Home Lending API + static host.
   Security posture (the practices SOC 2 audits look for; the certification
   itself is an organizational process, not something code can grant):
     • bcrypt password hashing (cost 12)         • parameterized SQL only
     • httpOnly + sameSite session cookies        • secret from env, not source
     • generic auth errors (no user enumeration)  • audit log of auth events
   Production hardening still required: HTTPS/HSTS, rate limiting, CSRF tokens
   on state-changing routes, a real session store, secrets manager, backups,
   access reviews, and a SOC 2 control program with your auditor. */
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { q } = require('./db');
const Market = require('./public/js/market-data.js');

/* ---- Minimal .env loader (no dependency) ----
   Put secrets in a file named ".env" in the project root, one KEY=VALUE per
   line, e.g.:
       SESSION_SECRET=some-long-random-string
       RENTCAST_API_KEY=your_rentcast_key_here
   Lines starting with # are ignored. Real environment variables win over .env. */
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) return;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, '');
      if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
    });
  } catch (e) { /* ignore */ }
})();

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY || '';
const RENTCAST_BASE = 'https://api.rentcast.io/v1';
const LISTINGS_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h — protects the free tier
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn('\n[WARN] SESSION_SECRET not set — using a dev fallback. Set it in the environment before any real use.\n');
}

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { // minimal security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(session({
  name: 'ks.sid',
  secret: SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 },
}));

const ip = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
const audit = (uid, action, req) => { try { q.audit.run(uid || null, action, ip(req)); } catch (e) {} };
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in.' });
  next();
}
// async route wrapper so a thrown/rejected handler returns JSON, never an HTML 500
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const VALID_PURPOSES = ['purchase', 'refinance', 'investment', 'second_home'];
function purposeOf(application) {
  var p = application && application.loanPurpose;
  return VALID_PURPOSES.indexOf(p) !== -1 ? p : 'purchase';
}
// Upsert: one application per (user, purpose). Updates in place if it exists.
function upsertApplication(userId, application) {
  const purpose = purposeOf(application);
  const json = JSON.stringify(application);
  const existing = q.appByPurpose.get(userId, purpose);
  if (existing) { q.updateApplicationById.run(json, existing.id); return { purpose: purpose, updated: true }; }
  q.insertApplication.run(userId, purpose, json);
  return { purpose: purpose, updated: false };
}
function appSummary(row) {
  let a = {};
  try { a = JSON.parse(row.data_json); } catch (e) {}
  const loan = a.loan || {}, res = a.result || {}, prof = a.profile || {};
  return {
    purpose: row.purpose || 'purchase',
    status: row.status || 'submitted',
    createdAt: row.created_at, updatedAt: row.updated_at || row.created_at,
    program: a.program || loan.program || null,
    occupancy: a.occupancy || null,
    applicant: ((prof.firstName || '') + ' ' + (prof.lastName || '')).trim(),
    purchasePrice: loan.purchasePrice != null ? loan.purchasePrice : (res.price || null),
    totalMonthly: (a.context && a.context.numbers && a.context.numbers.totalMonthly) || res.totalMonthly || null,
    maxQualifiedPrice: a.maxQualifiedPrice || null,
  };
}

/* ---- Auth ---- */
app.post('/api/register-and-submit', wrap((req, res) => {
  const { email, password, application } = req.body || {};
  if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Valid email and 8+ char password required.' });
  if (q.userByEmail.get(email.toLowerCase())) return res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
  const hash = bcrypt.hashSync(password, 12);
  const prof = (application && application.profile) || {};
  const info = q.createUser.run({ email: email.toLowerCase(), hash, first: prof.firstName || null, last: prof.lastName || null, phone: prof.phone || null });
  const userId = info.lastInsertRowid;
  if (application) upsertApplication(userId, application);
  req.session.userId = userId;
  audit(userId, 'register+submit', req);
  res.json({ ok: true, userId });
}));

app.post('/api/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const user = email ? q.userByEmail.get(String(email).toLowerCase()) : null;
  const ok = user && bcrypt.compareSync(password || '', user.password_hash);
  if (!ok) { audit(user ? user.id : null, 'login-fail', req); return res.status(401).json({ error: 'Incorrect email or password.' }); }
  req.session.userId = user.id;
  audit(user.id, 'login', req);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  const uid = req.session.userId; audit(uid, 'logout', req);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = q.userById.get(req.session.userId);
  if (!u) return res.status(401).json({ error: 'Session expired.' });
  res.json({ user: { id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name } });
});

/* ---- Applications (one per loan purpose) ---- */
// List all of the user's applications (summaries).
app.get('/api/applications', requireAuth, wrap((req, res) => {
  const rows = q.listApplications.all(req.session.userId) || [];
  res.json({ applications: rows.map(appSummary) });
}));

// Get one application. ?purpose=… returns that product; otherwise the most recent.
app.get('/api/application', requireAuth, wrap((req, res) => {
  const purpose = req.query.purpose;
  const row = (purpose && VALID_PURPOSES.indexOf(purpose) !== -1)
    ? q.appByPurpose.get(req.session.userId, purpose)
    : q.latestApplication.get(req.session.userId);
  if (!row) return res.json({ application: null });
  res.json({ application: JSON.parse(row.data_json), purpose: row.purpose || 'purchase', status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
}));

// Create OR update the application for its loan purpose (no duplicates).
app.post('/api/application', requireAuth, wrap((req, res) => {
  const { application } = req.body || {};
  if (!application || typeof application !== 'object') return res.status(400).json({ error: 'application required' });
  const r = upsertApplication(req.session.userId, application);
  audit(req.session.userId, 'application-save:' + r.purpose, req);
  res.json({ ok: true, purpose: r.purpose, updated: r.updated });
}));

// Delete the application for a given purpose (lets the user free up that slot).
app.delete('/api/application', requireAuth, wrap((req, res) => {
  const purpose = req.query.purpose;
  if (!purpose || VALID_PURPOSES.indexOf(purpose) === -1) return res.status(400).json({ error: 'valid purpose required' });
  const r = q.deleteByPurpose.run(req.session.userId, purpose);
  audit(req.session.userId, 'application-delete:' + purpose, req);
  res.json({ ok: true, deleted: (r && r.changes) || 0 });
}));

// Personal info that can be reused across applications (NO SSN — never stored).
app.get('/api/profile', requireAuth, wrap((req, res) => {
  const row = q.latestApplication.get(req.session.userId);
  const u = q.userById.get(req.session.userId);
  let prof = {}, loan = {};
  if (row) { try { const a = JSON.parse(row.data_json); prof = a.profile || {}; loan = a.loan || {}; } catch (e) {} }
  res.json({ profile: {
    firstName: prof.firstName || (u && u.first_name) || '',
    lastName: prof.lastName || (u && u.last_name) || '',
    email: prof.email || (u && u.email) || '',
    phone: prof.phone || (u && u.phone) || '',
    dob: prof.dob || '',
    currentAddress: prof.currentAddress || '',
    grossMonthlyIncome: loan.grossMonthlyIncome || '',
    creditScore: loan.creditScore || '',
  } });
}));

/* Merge live shopping context into a specific application (by purpose, else latest). */
app.patch('/api/application/context', requireAuth, wrap((req, res) => {
  const purpose = req.query.purpose;
  const row = (purpose && VALID_PURPOSES.indexOf(purpose) !== -1)
    ? q.appByPurpose.get(req.session.userId, purpose)
    : q.latestApplication.get(req.session.userId);
  if (!row) return res.status(404).json({ error: 'No application on file yet.' });
  let app;
  try { app = JSON.parse(row.data_json); } catch (e) { return res.status(500).json({ error: 'Stored application is unreadable.' }); }
  const c = req.body && req.body.context;
  if (!c || typeof c !== 'object') return res.status(400).json({ error: 'context required' });
  app.context = Object.assign({}, app.context, c);
  app.profile = app.profile || {};
  if (c.lookingZip != null) app.profile.lookingZip = c.lookingZip;
  if (c.taxCounty != null) app.taxCounty = c.taxCounty;
  if (c.taxRatePct != null && app.loan) app.loan.taxRatePct = c.taxRatePct;
  q.updateApplicationById.run(JSON.stringify(app), row.id);
  audit(req.session.userId, 'application-context', req);
  res.json({ ok: true });
}));

/* ---- Listings ----
   Live for-sale listings come from RentCast when RENTCAST_API_KEY is set and the
   request includes a ZIP (RentCast searches need a location). Results are cached
   in the DB for 12h so the free tier's 50-calls/month budget isn't burned on
   filter changes. Without a key (or for an all-Texas browse with no ZIP) we fall
   back to the bundled sample inventory. To use a different provider, swap
   fetchRentcastByZip() — the listing shape it returns is the contract.          */
function mapRentcastType(t) {
  t = String(t || '').toLowerCase();
  if (t.indexOf('condo') !== -1 || t.indexOf('town') !== -1) return 'condo';
  if (t.indexOf('multi') !== -1 || t.indexOf('apartment') !== -1 || t.indexOf('duplex') !== -1) return 'multi_family';
  if (t.indexOf('land') !== -1 || t.indexOf('lot') !== -1) return 'land';
  return 'single_family';
}
function mapRentcastListing(x, zip) {
  return {
    id: String(x.id || x.formattedAddress || (x.addressLine1 + (x.zipCode || ''))),
    title: x.addressLine1 || x.formattedAddress || 'Listing',
    address: x.addressLine1 || x.formattedAddress || '',
    city: x.city || '', zip: String(x.zipCode || zip || ''),
    price: +x.price || 0, beds: +x.bedrooms || 0, baths: +x.bathrooms || 0,
    sqft: +x.squareFootage || 0, type: mapRentcastType(x.propertyType),
    lot: x.lotSize ? Math.round((x.lotSize / 43560) * 100) / 100 : 0,
    year: +x.yearBuilt || 0, rating: 0,
    hoa: (x.hoa && x.hoa.fee) ? (+x.hoa.fee || 0) : 0,
    lat: typeof x.latitude === 'number' ? x.latitude : null,
    lng: typeof x.longitude === 'number' ? x.longitude : null,
    photos: Array.isArray(x.photos) ? x.photos.slice(0, 5) : [],
    daysOnMarket: x.daysOnMarket != null ? x.daysOnMarket : null,
  };
}
function readCache(key) {
  try {
    const row = q.getCache.get(key);
    if (!row) return null;
    const ageMs = Date.now() - new Date((row.fetched_at || '').replace(' ', 'T') + 'Z').getTime();
    return { listings: JSON.parse(row.data_json), fresh: ageMs < LISTINGS_CACHE_TTL_MS };
  } catch (e) { return null; }
}
async function fetchRentcastByZip(zip) {
  const key = 'sale:' + zip;
  const cached = readCache(key);
  if (cached && cached.fresh) return { listings: cached.listings, source: 'rentcast-cache' };

  const url = RENTCAST_BASE + '/listings/sale?zipCode=' + encodeURIComponent(zip) + '&status=Active&limit=50';
  let resp;
  try {
    resp = await fetch(url, { headers: { 'X-Api-Key': RENTCAST_API_KEY, 'Accept': 'application/json' } });
  } catch (e) {
    if (cached) return { listings: cached.listings, source: 'rentcast-cache-stale' }; // network error → serve stale
    throw e;
  }
  if (!resp.ok) {
    // 429 = monthly quota hit; serve stale cache if we have it, else fall through to sample
    if (cached) return { listings: cached.listings, source: 'rentcast-cache-stale' };
    const err = new Error('RentCast ' + resp.status); err.status = resp.status; throw err;
  }
  const body = await resp.json();
  const rows = Array.isArray(body) ? body : (body.listings || body.data || []);
  const mapped = rows.map(function (x) { return mapRentcastListing(x, zip); });
  try { q.setCache.run(key, JSON.stringify(mapped)); } catch (e) {}
  return { listings: mapped, source: 'rentcast' };
}
function applyListingFilters(arr, f) {
  return arr.filter(function (p) {
    if (f.maxPrice != null && p.price > f.maxPrice) return false;
    if (f.minPrice != null && p.price < f.minPrice) return false;
    if (f.beds != null && f.beds > 0 && p.beds < f.beds) return false;
    if (f.minSqft != null && f.minSqft > 0 && p.sqft < f.minSqft) return false;
    if (f.types && f.types.length && f.types.indexOf(p.type) === -1) return false;
    return true;
  });
}

app.get('/api/listings', async (req, res) => {
  const f = req.query;
  const types = f.types ? String(f.types).split(',').filter(Boolean) : [];
  const filters = {
    minPrice: f.minPrice ? +f.minPrice : null,
    maxPrice: f.maxPrice ? +f.maxPrice : null,
    beds: f.beds ? +f.beds : null,
    minSqft: f.minSqft ? +f.minSqft : null,
    types: types,
  };
  const zip = f.zip && /^\d{5}$/.test(String(f.zip)) ? String(f.zip) : null;

  // Live data path: RentCast (cached), only when we have a key AND a ZIP.
  if (RENTCAST_API_KEY && zip) {
    try {
      const out = await fetchRentcastByZip(zip);
      const listings = applyListingFilters(out.listings, filters);
      return res.json({ listings, source: out.source, note: 'Live for-sale listings via RentCast (cached up to 12h).' });
    } catch (e) {
      const listings = Market.fetchListings(Object.assign({}, filters, { zip: zip }));
      return res.json({ listings, source: 'sample-fallback', note: 'RentCast unavailable (' + (e.status || e.message) + ') — showing sample inventory.' });
    }
  }

  // Sample path (no key, or all-Texas browse with no ZIP).
  const listings = Market.fetchListings(Object.assign({}, filters, { zip: zip }));
  res.json({
    listings,
    source: 'sample',
    note: RENTCAST_API_KEY
      ? 'Enter a ZIP to load live RentCast listings for that area.'
      : 'Sample inventory. Set RENTCAST_API_KEY in .env to load live for-sale listings.'
  });
});

/* ---- Saved properties ---- */
app.get('/api/saved', requireAuth, (req, res) => {
  const rows = q.listSaved.all(req.session.userId);
  res.json({ saved: rows.map(r => ({ listingId: r.listing_id, data: JSON.parse(r.data_json), savedAt: r.created_at })) });
});
app.post('/api/saved', requireAuth, (req, res) => {
  const { listing } = req.body || {};
  if (!listing || !listing.id) return res.status(400).json({ error: 'listing required' });
  q.saveProperty.run(req.session.userId, String(listing.id), JSON.stringify(listing));
  audit(req.session.userId, 'save-property:' + listing.id, req);
  res.json({ ok: true });
});
app.delete('/api/saved/:id', requireAuth, (req, res) => {
  q.removeSaved.run(req.session.userId, String(req.params.id));
  res.json({ ok: true });
});

/* ---- Client config (safe-to-expose, browser-side settings) ----
   The Google Maps JS API key is used in the browser by design; restrict it by
   HTTP referrer in the Google Cloud Console so it can't be used elsewhere. */
app.get('/api/config', (req, res) => {
  res.json({ googleMapsKey: GOOGLE_MAPS_API_KEY, rentcast: !!RENTCAST_API_KEY });
});

/* ---- Static site ---- */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Unknown API routes → JSON 404 (not an HTML page the client would misread).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler: ANY thrown/rejected handler returns JSON, so the client
// always gets a real error message instead of an HTML 500 that looks like a
// "network error."
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.url, '-', (err && err.message) || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error — please try again.' });
});

app.listen(PORT, () => console.log(`Keystone running → http://localhost:${PORT}`));
