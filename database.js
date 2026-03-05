const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = path.join(__dirname, "salon.db");
const db = new sqlite3.Database(dbPath);

// Включаем foreign keys (очень важно)
db.run("PRAGMA foreign_keys = ON");

db.serialize(() => {
  // ---------- SERVICES ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      price TEXT NOT NULL
    )
  `);

  // ---------- CLIENTS ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    )
  `);

  // ---------- APPOINTMENTS ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL,
      client_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT DEFAULT 'confirmed',

      FOREIGN KEY (service_id) REFERENCES services(id),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `);

  // ---------- ADMINS ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    )
  `);
});

module.exports = db;
