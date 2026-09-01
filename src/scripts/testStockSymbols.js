/**
 * Local SQLite validation script for the stock_symbols table and sync flow.
 */
import dbService from '../services/dbService.js';
import instrumentSyncService from '../services/instrumentSyncService.js';

async function testDatabaseSetup() {
    console.log('🧪 Testing local stock_symbols table setup...\n');

    try {
        console.log('1️⃣  Checking if stock_symbols table exists...');
        const tableCheck = await dbService.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stock_symbols'`
        );

        if (tableCheck.rows.length > 0) {
            console.log('✓ stock_symbols table exists\n');
        } else {
            console.log('❌ stock_symbols table does not exist\n');
            return;
        }

        console.log('2️⃣  Checking table columns...');
        const columnCheck = await dbService.query(
            `PRAGMA table_info(stock_symbols)`
        );

        console.log('✓ Table columns:');
        columnCheck.rows.forEach(col => {
            console.log(`   - ${col.name} (${col.type || 'TEXT'})`);
        });
        console.log();

        console.log('3️⃣  Checking existing records...');
        const countCheck = await dbService.query(
            `SELECT COUNT(*) as count FROM stock_symbols`
        );

        const recordCount = countCheck.rows[0].count;
        console.log(`✓ Total records in stock_symbols: ${recordCount}\n`);

        console.log('4️⃣  Testing instrumentSyncService methods...');
        const sampleSymbols = ['RELIANCE', 'TCS', 'INFY'];
        const tokens = await instrumentSyncService.getTokensForSymbols(sampleSymbols);

        if (tokens.size > 0) {
            console.log(`✓ Found tokens for ${tokens.size} sample symbols:`);
            tokens.forEach((info, symbol) => {
                console.log(`   - ${symbol}: token=${info.token}, exchange=${info.exchange}`);
            });
        } else {
            console.log('⚠️  No tokens found for sample symbols (table may be empty)');
        }
        console.log();

        console.log('5️⃣  Checking local indexes...');
        const indexCheck = await dbService.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stock_symbols' ORDER BY name`
        );

        console.log(`✓ Indexes (${indexCheck.rows.length}):`);
        indexCheck.rows.forEach(idx => {
            console.log(`   - ${idx.name}`);
        });
        console.log();

        console.log('✅ Local database setup tests completed successfully!\n');
    } catch (error) {
        console.error('❌ Test failed:', error?.message || error);
    }
}

await testDatabaseSetup();
process.exit(0);
