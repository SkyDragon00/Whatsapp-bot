const Database = require('better-sqlite3');
const db = new Database('citas.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    patient_name TEXT NOT NULL,
    service TEXT NOT NULL,
    date_text TEXT NOT NULL,
    date_iso TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

module.exports = db;
