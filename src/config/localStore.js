import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'local-store');
fs.mkdirSync(DATA_DIR, { recursive: true });

export function getLocalStorePath(name) {
    return path.join(DATA_DIR, `${String(name).trim()}.json`);
}

export function readTable(tableName) {
    const filePath = getLocalStorePath(tableName);
    if (!fs.existsSync(filePath)) return [];

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function writeTable(tableName, rows) {
    const filePath = getLocalStorePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
}
