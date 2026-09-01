import test from 'node:test';
import assert from 'node:assert/strict';
import tradeLifecycleService from '../src/services/tradeLifecycleService.js';
import cleanupService from '../src/services/cleanupService.js';

test('trade lifecycle schema initialization is SQLite-compatible', async () => {
    await assert.doesNotReject(() => tradeLifecycleService.ensureSchema());
    assert.equal(tradeLifecycleService.schemaReady, true);
});

test('daily cleanup works with SQLite-compatible queries', async () => {
    const summary = await cleanupService.runDailyCleanup();
    assert.ok(summary && typeof summary === 'object');
    assert.ok(Number.isFinite(summary.orderLogsDeleted));
    assert.ok(Number.isFinite(summary.tradeLifecycleEventsDeleted));
    assert.ok(Number.isFinite(summary.tradePositionsDeleted));
});
