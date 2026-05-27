'use strict';
require('dotenv').config();
const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.resolve(process.env.DB_PATH || './coffeemoon.db');
let _db;

// Hər yazma əməliyyatından sonra diske saxla
function save() {
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// better-sqlite3-ə uyğun Statement wrapper
function makeStmt(sql) {
  return {
    run(...args) {
      const flat = args.flatMap(a => Array.isArray(a) ? a : [a]);
      _db.run(sql, flat.length ? flat : null);
      save();
      return { changes: _db.getRowsModified() };
    },
    get(...args) {
      const flat = args.flatMap(a => Array.isArray(a) ? a : [a]);
      const stmt = _db.prepare(sql);
      if (flat.length) stmt.bind(flat);
      const row = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free();
      return row;
    },
    all(...args) {
      const flat = args.flatMap(a => Array.isArray(a) ? a : [a]);
      const stmt = _db.prepare(sql);
      const rows = [];
      if (flat.length) stmt.bind(flat);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  };
}

// Əsas DB interfeysi (better-sqlite3 API-si ilə uyğun)
const db = {
  pragma() {},   // sql.js-də WAL lazım deyil
  exec(sql) { _db.exec(sql); save(); },
  run(sql, params) { _db.run(sql, params || null); save(); return { changes: _db.getRowsModified() }; },
  prepare: (sql) => makeStmt(sql),
  transaction(fn) {
    return (...outerArgs) => {
      _db.run('BEGIN TRANSACTION');
      try { fn(...outerArgs); _db.run('COMMIT'); }
      catch (e) { _db.run('ROLLBACK'); throw e; }
      save();
    };
  },
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dept TEXT DEFAULT '',
    secret TEXT UNIQUE, deviceId TEXT DEFAULT '', message TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS attendance (
    rowId INTEGER PRIMARY KEY AUTOINCREMENT, empId TEXT NOT NULL,
    empName TEXT, dept TEXT, timestamp TEXT NOT NULL,
    type TEXT, overtime TEXT DEFAULT '', shiftType TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS nahar (
    naharId TEXT PRIMARY KEY, empId TEXT NOT NULL, empName TEXT,
    dept TEXT, timestamp TEXT NOT NULL, type TEXT
  );
  CREATE TABLE IF NOT EXISTS scanDevices (
    deviceId TEXT PRIMARY KEY, branch TEXT DEFAULT '',
    status TEXT DEFAULT 'pending', createdAt TEXT DEFAULT (datetime('now','localtime')),
    label TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS cedvel (
    cedvelId TEXT PRIMARY KEY, empId TEXT NOT NULL, empName TEXT,
    dept TEXT, dateStr TEXT NOT NULL, shiftType TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS izin (
    izinId TEXT PRIMARY KEY, empId TEXT, empName TEXT, dept TEXT,
    startDate TEXT, endDate TEXT, type TEXT DEFAULT 'İzin',
    note TEXT DEFAULT '', status TEXT DEFAULT 'pending',
    createdAt TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS checklistItems (
    itemId TEXT PRIMARY KEY, text TEXT, category TEXT,
    sortOrder INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS checklistLogs (
    logId TEXT PRIMARY KEY, date TEXT, dept TEXT, itemId TEXT,
    itemText TEXT, checked INTEGER DEFAULT 0,
    checkedAt TEXT DEFAULT '', mgrNote TEXT DEFAULT '', adminNote TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS mgrAcks (
    ackId TEXT PRIMARY KEY, date TEXT, dept TEXT,
    globalAcked INTEGER DEFAULT 0, globalAckedAt TEXT DEFAULT '',
    branchAcked INTEGER DEFAULT 0, branchAckedAt TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS products (
    productId TEXT PRIMARY KEY, name TEXT, unit TEXT DEFAULT 'ədəd',
    active INTEGER DEFAULT 1, createdAt TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS productLogs (
    logId TEXT PRIMARY KEY, dateStr TEXT, dept TEXT, productId TEXT,
    productName TEXT, incoming REAL DEFAULT 0, wasted REAL DEFAULT 0,
    savedAt TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS mgrSchedule (
    schedId TEXT PRIMARY KEY, dept TEXT, dateStr TEXT, shiftType TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS latePerms (
    permId TEXT PRIMARY KEY, empId TEXT, empName TEXT, dept TEXT,
    dateStr TEXT, requestedTime TEXT, status TEXT DEFAULT 'pending',
    createdAt TEXT DEFAULT (datetime('now','localtime')), approvedAt TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, type TEXT DEFAULT 'info',
    pinned INTEGER DEFAULT 0, date TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT DEFAULT ''
  );
`;

const DEFAULT_ITEMS = [
  ['CI-001','Açılış hazırlığı (stol, stul, avadanlıq)',    'Açılış',   1],
  ['CI-002','Kassa balansının yoxlanması',                  'Açılış',   2],
  ['CI-003','Temperatur jurnalının doldurulması',           'Gigiyena', 3],
  ['CI-004','Soyuducu / vitrin yoxlaması',                  'Gigiyena', 4],
  ['CI-005','Stok sayımı və çatışmazlıq qeydi',             'Stok',     5],
  ['CI-006','Personalın geyim / görünüş yoxlaması',         'Personal', 6],
  ['CI-007','Müştəri şikayətlərinin nəzərdən keçirilməsi',  'Xidmət',   7],
  ['CI-008','Günün hesabatının hazırlanması',               'Bağlanış', 8],
  ['CI-009','Bağlanış yoxlaması (qapı, işıq, avadanlıq)',   'Bağlanış', 9],
];

async function initialize() {
  const SQL  = await initSqlJs();
  const data = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  _db = data ? new SQL.Database(data) : new SQL.Database();

  // Schema yarat
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    _db.run(stmt);
  }

  // Default çeklist elementlərini yalnız boş cədvəl üçün əlavə et
  const count = _db.exec('SELECT COUNT(*) as c FROM checklistItems')[0]?.values[0][0] || 0;
  if (count === 0) {
    for (const [id, text, cat, ord] of DEFAULT_ITEMS) {
      _db.run('INSERT OR IGNORE INTO checklistItems (itemId,text,category,sortOrder,active) VALUES (?,?,?,?,1)',
        [id, text, cat, ord]);
    }
  }
  save();
  return db;
}

module.exports = { initialize, db };
