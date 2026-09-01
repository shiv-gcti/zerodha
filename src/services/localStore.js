import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_DIR = path.join(DATA_DIR, 'local-store');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORE_DIR, { recursive: true });

function getTablePath(tableName) {
    return path.join(STORE_DIR, `${String(tableName).trim()}.json`);
}

function readTable(tableName) {
    const filePath = getTablePath(tableName);
    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function writeTable(tableName, rows) {
    const filePath = getTablePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
}

export function listRecords(tableName, filters = {}, sort = null) {
    let rows = readTable(tableName);

    for (const [field, value] of Object.entries(filters)) {
        rows = rows.filter((row) => {
            const actual = row?.[field];
            if (value === undefined || value === null) {
                return actual === value;
            }
            return actual === value;
        });
    }

    if (sort) {
        const { field, ascending = true } = sort;
        rows = [...rows].sort((a, b) => {
            const left = a?.[field];
            const right = b?.[field];
            if (left === right) return 0;
            const direction = ascending ? 1 : -1;
            return left > right ? direction : -direction;
        });
    }

    return rows;
}

export function findRecords(tableName, filters = {}) {
    return listRecords(tableName, filters);
}

export function findOneRecord(tableName, filters = {}) {
    const rows = findRecords(tableName, filters);
    return rows[0] || null;
}

export function upsertRecord(tableName, record, matchFields = ['id']) {
    const rows = readTable(tableName);
    const index = rows.findIndex((row) => {
        return matchFields.some((field) => row?.[field] !== undefined && row?.[field] === record?.[field]);
    });

    if (index >= 0) {
        const nextRow = { ...rows[index], ...record };
        rows[index] = nextRow;
        writeTable(tableName, rows);
        return nextRow;
    }

    const nextRow = { ...record };
    rows.push(nextRow);
    writeTable(tableName, rows);
    return nextRow;
}

export function insertRecords(tableName, records) {
    const rows = readTable(tableName);
    const entries = Array.isArray(records) ? records : [records];
    rows.push(...entries);
    writeTable(tableName, rows);
    return entries;
}

export function updateRecords(tableName, filters = {}, updates = {}) {
    const rows = readTable(tableName);
    let changed = 0;

    for (const row of rows) {
        let matches = true;
        for (const [field, value] of Object.entries(filters)) {
            if (row?.[field] !== value) {
                matches = false;
                break;
            }
        }

        if (matches) {
            Object.assign(row, updates);
            changed += 1;
        }
    }

    writeTable(tableName, rows);
    return { changed };
}

export function deleteRecords(tableName, filters = {}) {
    const rows = readTable(tableName);
    const nextRows = rows.filter((row) => {
        for (const [field, value] of Object.entries(filters)) {
            if (row?.[field] !== value) {
                return true;
            }
        }
        return false;
    });

    writeTable(tableName, nextRows);
    return { deleted: rows.length - nextRows.length };
}

export function clearTable(tableName) {
    writeTable(tableName, []);
}

export function tableExists(tableName) {
    return fs.existsSync(getTablePath(tableName));
}
