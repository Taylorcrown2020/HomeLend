/* db.js — persistence layer.
   PRIMARY: better-sqlite3 (parameterized prepared statements → no SQL injection,
   WAL journaling, foreign keys). This is what runs in production.

   FALLBACK: if better-sqlite3 isn't installed or can't load its native binary
   (e.g. a sandbox without a compiler / blocked headers download), we transparently
   drop to a tiny pure-JS, file-backed store that implements the SAME statement
   surface (.run / .get / .all). server.js never has to know which one is active.

   PORTING TO POSTGRES: the query surface is intentionally tiny and isolated to the
   `q` object below. Swap to `pg` with $1 placeholders — mechanical, no route changes. */
const path = require('path');
const fs = require('fs');

let q, db, backend;

try {
  /* ---------------- PRIMARY: better-sqlite3 ---------------- */
  const Database = require('better-sqlite3');
  db = new Database(path.join(__dirname, 'keystone.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      first_name TEXT, last_name TEXT, phone TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data_json TEXT NOT NULL, status TEXT DEFAULT 'submitted',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS saved_properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL, data_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, listing_id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
      action TEXT NOT NULL, ip TEXT, at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS listings_cache (
      cache_key TEXT PRIMARY KEY, data_json TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    );
  `);
  q = {
    createUser: db.prepare(`INSERT INTO users (email,password_hash,first_name,last_name,phone)
                            VALUES (@email,@hash,@first,@last,@phone)`),
    userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
    userById: db.prepare(`SELECT id,email,first_name,last_name,phone,created_at FROM users WHERE id = ?`),
    addApplication: db.prepare(`INSERT INTO applications (user_id,data_json) VALUES (?,?)`),
    latestApplication: db.prepare(`SELECT * FROM applications WHERE user_id = ? ORDER BY id DESC LIMIT 1`),
    updateLatestApplication: db.prepare(`UPDATE applications SET data_json = ?
      WHERE id = (SELECT id FROM applications WHERE user_id = ? ORDER BY id DESC LIMIT 1)`),
    saveProperty: db.prepare(`INSERT OR REPLACE INTO saved_properties (user_id,listing_id,data_json) VALUES (?,?,?)`),
    listSaved: db.prepare(`SELECT listing_id,data_json,created_at FROM saved_properties WHERE user_id = ? ORDER BY id DESC`),
    removeSaved: db.prepare(`DELETE FROM saved_properties WHERE user_id = ? AND listing_id = ?`),
    audit: db.prepare(`INSERT INTO audit_log (user_id,action,ip) VALUES (?,?,?)`),
    getCache: db.prepare(`SELECT data_json, fetched_at FROM listings_cache WHERE cache_key = ?`),
    setCache: db.prepare(`INSERT OR REPLACE INTO listings_cache (cache_key,data_json,fetched_at)
                          VALUES (?, ?, datetime('now'))`),
  };
  backend = 'better-sqlite3';
} catch (err) {
  /* ---------------- FALLBACK: pure-JS file store ---------------- */
  const FILE = path.join(__dirname, 'data', 'store.json');
  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const seed = { users: [], applications: [], saved: [], audit: [], cache: {}, seq: { users: 0, applications: 0, saved: 0, audit: 0 } };
  let mem;
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { mem = JSON.parse(JSON.stringify(seed)); }
  if (!mem.cache) mem.cache = {};
  const persist = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(mem, null, 0)); } catch (e) {} };

  q = {
    createUser: { run(p) {
      if (mem.users.some(u => u.email === p.email)) { const e = new Error('UNIQUE'); e.code = 'SQLITE_CONSTRAINT'; throw e; }
      const id = ++mem.seq.users;
      mem.users.push({ id, email: p.email, password_hash: p.hash, first_name: p.first, last_name: p.last, phone: p.phone, created_at: now() });
      persist(); return { lastInsertRowid: id };
    } },
    userByEmail: { get(email) { return mem.users.find(u => u.email === email); } },
    userById: { get(id) { const u = mem.users.find(x => x.id === id); return u && { id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, phone: u.phone, created_at: u.created_at }; } },
    addApplication: { run(userId, dataJson) {
      const id = ++mem.seq.applications;
      mem.applications.push({ id, user_id: userId, data_json: dataJson, status: 'submitted', created_at: now() });
      persist(); return { lastInsertRowid: id };
    } },
    latestApplication: { get(userId) {
      const rows = mem.applications.filter(a => a.user_id === userId).sort((a, b) => b.id - a.id);
      return rows[0];
    } },
    updateLatestApplication: { run(dataJson, userId) {
      const rows = mem.applications.filter(a => a.user_id === userId).sort((a, b) => b.id - a.id);
      if (rows[0]) { rows[0].data_json = dataJson; persist(); }
      return { changes: rows[0] ? 1 : 0 };
    } },
    saveProperty: { run(userId, listingId, dataJson) {
      const existing = mem.saved.find(s => s.user_id === userId && s.listing_id === listingId);
      if (existing) { existing.data_json = dataJson; existing.created_at = now(); }
      else { mem.saved.push({ id: ++mem.seq.saved, user_id: userId, listing_id: listingId, data_json: dataJson, created_at: now() }); }
      persist();
    } },
    listSaved: { all(userId) {
      return mem.saved.filter(s => s.user_id === userId).sort((a, b) => b.id - a.id)
        .map(s => ({ listing_id: s.listing_id, data_json: s.data_json, created_at: s.created_at }));
    } },
    removeSaved: { run(userId, listingId) {
      mem.saved = mem.saved.filter(s => !(s.user_id === userId && s.listing_id === listingId)); persist();
    } },
    audit: { run(userId, action, ip) { mem.audit.push({ id: ++mem.seq.audit, user_id: userId, action, ip, at: now() }); persist(); } },
    getCache: { get(key) { return mem.cache[key] || undefined; } },
    setCache: { run(key, dataJson) { mem.cache[key] = { data_json: dataJson, fetched_at: now() }; persist(); } },
  };
  db = null;
  backend = 'json-fallback';
  console.warn('[db] better-sqlite3 unavailable (' + (err && err.code || err && err.message) +
    ') — using pure-JS file store at data/store.json. Install better-sqlite3 for production.');
}

module.exports = { db, q, backend };
