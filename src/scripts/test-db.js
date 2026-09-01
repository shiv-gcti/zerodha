import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const dataDir = path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'app-local.db');
const db = new Database(dbPath);

db.prepare(`CREATE TABLE IF NOT EXISTS local_db_check (id INTEGER PRIMARY KEY, checked_at TEXT)`).run();
db.prepare(`INSERT INTO local_db_check (checked_at) VALUES (?)`).run(new Date().toISOString());

const rows = db.prepare('SELECT * FROM local_db_check ORDER BY id DESC LIMIT 1').all();
console.log('✅ Local SQLite database connected successfully');
console.log(rows);

db.close();