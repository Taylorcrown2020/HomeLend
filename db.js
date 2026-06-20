/* db.js — persistence layer with an ASYNC query surface (`q`) and three backends:

   1) POSTGRES (production / Render): used when DATABASE_URL is set. Durable.
   2) better-sqlite3 (local production-ish): used if installed and it loads.
   3) pure-JS JSON file store (sandbox/dev fallback): always works.

   server.js awaits every q.* call, so all three back the same interface. Tables
   are created by initDb() (await it before listening).

   On Render: add a PostgreSQL instance, copy its Internal Database URL into a
   DATABASE_URL env var on the web service, and accounts persist across restarts. */
const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL || '';
let q, backend, initDb, db = null;

/* Wrap a synchronous prepared-statement method as async (preserves `this` so
   better-sqlite3 statements keep working; turns thrown errors into rejections). */
function aw(stmt, method) {
  return function () {
    try { return Promise.resolve(stmt[method].apply(stmt, arguments)); }
    catch (e) { return Promise.reject(e); }
  };
}

if (DATABASE_URL) {
  /* =====================  POSTGRES  ===================== */
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)/.test(DATABASE_URL);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false }, // Render/managed PG need SSL
    max: 5,
  });
  const run1 = (text, params) => pool.query(text, params);
  const get1 = (text, params) => pool.query(text, params).then(r => r.rows[0]);
  const all1 = (text, params) => pool.query(text, params).then(r => r.rows);

  q = {
    createUser: { run: (p) => run1(
      `INSERT INTO users (email,password_hash,first_name,last_name,phone)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [p.email, p.hash, p.first, p.last, p.phone]).then(r => ({ lastInsertRowid: r.rows[0].id })) },
    userByEmail: { get: (email) => get1(`SELECT * FROM users WHERE email = $1`, [email]) },
    userById: { get: (id) => get1(`SELECT id,email,first_name,last_name,phone,created_at FROM users WHERE id = $1`, [id]) },
    insertApplication: { run: (userId, purpose, dataJson) => run1(
      `INSERT INTO applications (user_id,purpose,data_json) VALUES ($1,$2,$3) RETURNING id`,
      [userId, purpose || 'purchase', dataJson]).then(r => ({ lastInsertRowid: r.rows[0].id })) },
    appByPurpose: { get: (userId, purpose) => get1(`SELECT * FROM applications WHERE user_id = $1 AND purpose = $2`, [userId, purpose]) },
    updateApplicationById: { run: (dataJson, id) => run1(
      `UPDATE applications SET data_json = $1, status = 'submitted', updated_at = now() WHERE id = $2`,
      [dataJson, id]).then(r => ({ changes: r.rowCount })) },
    listApplications: { all: (userId) => all1(`SELECT * FROM applications WHERE user_id = $1 ORDER BY updated_at DESC, id DESC`, [userId]) },
    deleteByPurpose: { run: (userId, purpose) => run1(`DELETE FROM applications WHERE user_id = $1 AND purpose = $2`, [userId, purpose]).then(r => ({ changes: r.rowCount })) },
    latestApplication: { get: (userId) => get1(`SELECT * FROM applications WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 1`, [userId]) },
    saveProperty: { run: (userId, listingId, dataJson) => run1(
      `INSERT INTO saved_properties (user_id,listing_id,data_json) VALUES ($1,$2,$3)
       ON CONFLICT (user_id,listing_id) DO UPDATE SET data_json = EXCLUDED.data_json, created_at = now()`,
      [userId, listingId, dataJson]) },
    listSaved: { all: (userId) => all1(`SELECT listing_id,data_json,created_at FROM saved_properties WHERE user_id = $1 ORDER BY id DESC`, [userId]) },
    removeSaved: { run: (userId, listingId) => run1(`DELETE FROM saved_properties WHERE user_id = $1 AND listing_id = $2`, [userId, listingId]) },
    audit: { run: (userId, action, ip) => run1(`INSERT INTO audit_log (user_id,action,ip) VALUES ($1,$2,$3)`, [userId, action, ip]) },
    getCache: { get: (key) => get1(`SELECT data_json, fetched_at FROM listings_cache WHERE cache_key = $1`, [key]) },
    setCache: { run: (key, dataJson) => run1(
      `INSERT INTO listings_cache (cache_key,data_json,fetched_at) VALUES ($1,$2,now())
       ON CONFLICT (cache_key) DO UPDATE SET data_json = EXCLUDED.data_json, fetched_at = now()`,
      [key, dataJson]) },
  };
  initDb = async function () {
    await run1(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      first_name TEXT, last_name TEXT, phone TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
    await run1(`CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL DEFAULT 'purchase', data_json TEXT NOT NULL, status TEXT DEFAULT 'submitted',
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id,purpose))`);
    await run1(`CREATE TABLE IF NOT EXISTS saved_properties (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(user_id,listing_id))`);
    await run1(`CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, ip TEXT, at TIMESTAMPTZ DEFAULT now())`);
    await run1(`CREATE TABLE IF NOT EXISTS listings_cache (
      cache_key TEXT PRIMARY KEY, data_json TEXT NOT NULL, fetched_at TIMESTAMPTZ DEFAULT now())`);
    console.log('[db] Postgres ready');
  };
  backend = 'postgres';
} else {
  /* ============  SYNC backend (better-sqlite3 or JSON), wrapped async  ============ */
  let sync;
  try {
    const Database = require('better-sqlite3');
    db = new Database(path.join(__dirname, 'keystone.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        first_name TEXT, last_name TEXT, phone TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL DEFAULT 'purchase', data_json TEXT NOT NULL, status TEXT DEFAULT 'submitted',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, purpose));
      CREATE TABLE IF NOT EXISTS saved_properties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, listing_id));
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL, ip TEXT, at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS listings_cache (
        cache_key TEXT PRIMARY KEY, data_json TEXT NOT NULL, fetched_at TEXT DEFAULT (datetime('now')));
    `);
    sync = {
      createUser: db.prepare(`INSERT INTO users (email,password_hash,first_name,last_name,phone) VALUES (@email,@hash,@first,@last,@phone)`),
      userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
      userById: db.prepare(`SELECT id,email,first_name,last_name,phone,created_at FROM users WHERE id = ?`),
      insertApplication: db.prepare(`INSERT INTO applications (user_id,purpose,data_json) VALUES (?,?,?)`),
      appByPurpose: db.prepare(`SELECT * FROM applications WHERE user_id = ? AND purpose = ?`),
      updateApplicationById: db.prepare(`UPDATE applications SET data_json = ?, status = 'submitted', updated_at = datetime('now') WHERE id = ?`),
      listApplications: db.prepare(`SELECT * FROM applications WHERE user_id = ? ORDER BY updated_at DESC, id DESC`),
      deleteByPurpose: db.prepare(`DELETE FROM applications WHERE user_id = ? AND purpose = ?`),
      latestApplication: db.prepare(`SELECT * FROM applications WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`),
      saveProperty: db.prepare(`INSERT OR REPLACE INTO saved_properties (user_id,listing_id,data_json) VALUES (?,?,?)`),
      listSaved: db.prepare(`SELECT listing_id,data_json,created_at FROM saved_properties WHERE user_id = ? ORDER BY id DESC`),
      removeSaved: db.prepare(`DELETE FROM saved_properties WHERE user_id = ? AND listing_id = ?`),
      audit: db.prepare(`INSERT INTO audit_log (user_id,action,ip) VALUES (?,?,?)`),
      getCache: db.prepare(`SELECT data_json, fetched_at FROM listings_cache WHERE cache_key = ?`),
      setCache: db.prepare(`INSERT OR REPLACE INTO listings_cache (cache_key,data_json,fetched_at) VALUES (?, ?, datetime('now'))`),
    };
    backend = 'better-sqlite3';
    q = {
      createUser: { run: aw(sync.createUser, 'run') },
      userByEmail: { get: aw(sync.userByEmail, 'get') },
      userById: { get: aw(sync.userById, 'get') },
      insertApplication: { run: aw(sync.insertApplication, 'run') },
      appByPurpose: { get: aw(sync.appByPurpose, 'get') },
      updateApplicationById: { run: aw(sync.updateApplicationById, 'run') },
      listApplications: { all: aw(sync.listApplications, 'all') },
      deleteByPurpose: { run: aw(sync.deleteByPurpose, 'run') },
      latestApplication: { get: aw(sync.latestApplication, 'get') },
      saveProperty: { run: aw(sync.saveProperty, 'run') },
      listSaved: { all: aw(sync.listSaved, 'all') },
      removeSaved: { run: aw(sync.removeSaved, 'run') },
      audit: { run: aw(sync.audit, 'run') },
      getCache: { get: aw(sync.getCache, 'get') },
      setCache: { run: aw(sync.setCache, 'run') },
    };
  } catch (err) {
    /* ---- pure-JS file store ---- */
    const FILE = path.join(__dirname, 'data', 'store.json');
    const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
    const seed = { users: [], applications: [], saved: [], audit: [], cache: {}, seq: { users: 0, applications: 0, saved: 0, audit: 0 } };
    let mem;
    try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { mem = JSON.parse(JSON.stringify(seed)); }
    if (!mem.cache) mem.cache = {};
    const persist = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(mem, null, 0)); } catch (e) {} };
    const P = (v) => Promise.resolve(v);
    q = {
      createUser: { run: (p) => {
        if (mem.users.some(u => u.email === p.email)) { const e = new Error('UNIQUE'); e.code = 'SQLITE_CONSTRAINT'; return Promise.reject(e); }
        const id = ++mem.seq.users;
        mem.users.push({ id, email: p.email, password_hash: p.hash, first_name: p.first, last_name: p.last, phone: p.phone, created_at: now() });
        persist(); return P({ lastInsertRowid: id });
      } },
      userByEmail: { get: (email) => P(mem.users.find(u => u.email === email)) },
      userById: { get: (id) => { const u = mem.users.find(x => x.id === id); return P(u && { id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, phone: u.phone, created_at: u.created_at }); } },
      insertApplication: { run: (userId, purpose, dataJson) => {
        const id = ++mem.seq.applications;
        mem.applications.push({ id, user_id: userId, purpose: purpose || 'purchase', data_json: dataJson, status: 'submitted', created_at: now(), updated_at: now() });
        persist(); return P({ lastInsertRowid: id });
      } },
      appByPurpose: { get: (userId, purpose) => P(mem.applications.find(a => a.user_id === userId && (a.purpose || 'purchase') === purpose)) },
      updateApplicationById: { run: (dataJson, id) => {
        const row = mem.applications.find(a => a.id === id);
        if (row) { row.data_json = dataJson; row.status = 'submitted'; row.updated_at = now(); persist(); }
        return P({ changes: row ? 1 : 0 });
      } },
      listApplications: { all: (userId) => P(mem.applications.filter(a => a.user_id === userId).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || b.id - a.id)) },
      deleteByPurpose: { run: (userId, purpose) => {
        const before = mem.applications.length;
        mem.applications = mem.applications.filter(a => !(a.user_id === userId && (a.purpose || 'purchase') === purpose));
        persist(); return P({ changes: before - mem.applications.length });
      } },
      latestApplication: { get: (userId) => P(mem.applications.filter(a => a.user_id === userId).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || b.id - a.id)[0]) },
      saveProperty: { run: (userId, listingId, dataJson) => {
        const ex = mem.saved.find(s => s.user_id === userId && s.listing_id === listingId);
        if (ex) { ex.data_json = dataJson; ex.created_at = now(); }
        else { mem.saved.push({ id: ++mem.seq.saved, user_id: userId, listing_id: listingId, data_json: dataJson, created_at: now() }); }
        persist(); return P();
      } },
      listSaved: { all: (userId) => P(mem.saved.filter(s => s.user_id === userId).sort((a, b) => b.id - a.id).map(s => ({ listing_id: s.listing_id, data_json: s.data_json, created_at: s.created_at }))) },
      removeSaved: { run: (userId, listingId) => { mem.saved = mem.saved.filter(s => !(s.user_id === userId && s.listing_id === listingId)); persist(); return P(); } },
      audit: { run: (userId, action, ip) => { mem.audit.push({ id: ++mem.seq.audit, user_id: userId, action, ip, at: now() }); persist(); return P(); } },
      getCache: { get: (key) => P(mem.cache[key] || undefined) },
      setCache: { run: (key, dataJson) => { mem.cache[key] = { data_json: dataJson, fetched_at: now() }; persist(); return P(); } },
    };
    backend = 'json-fallback';
    console.warn('[db] better-sqlite3 unavailable (' + ((err && err.code) || (err && err.message)) +
      ') — using pure-JS file store at data/store.json. Set DATABASE_URL for Postgres in production.');
  }
  initDb = async function () { /* tables already created synchronously above */ };
}

module.exports = { db, q, backend, initDb };
