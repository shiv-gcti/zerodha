import db from './dbService.js';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

function cleanupTimezone() {
    return process.env.CLEANUP_TIMEZONE || DEFAULT_TIMEZONE;
}

function getLocalDateWindow() {
    const now = new Date();
    const offsetMinutes = now.getTimezoneOffset();
    const localNow = new Date(now.getTime() - offsetMinutes * 60 * 1000);

    const start = new Date(localNow);
    start.setHours(0, 0, 0, 0);

    const yesterdayStart = new Date(start);
    yesterdayStart.setDate(start.getDate() - 1);

    const tomorrowStart = new Date(start);
    tomorrowStart.setDate(start.getDate() + 1);

    return {
        yesterdayStart: yesterdayStart.toISOString(),
        todayStart: start.toISOString(),
        tomorrowStart: tomorrowStart.toISOString(),
    };
}

class CleanupService {
    async runDailyCleanup() {
        const timezone = cleanupTimezone();
        const bounds = getLocalDateWindow();

        const orderLogsResult = await db.query(
            `
            DELETE FROM order_logs
            WHERE created_at IS NULL
               OR created_at < ?
               OR created_at >= ?
            `,
            [bounds.yesterdayStart, bounds.tomorrowStart]
        );

        const relevantTradeIds = await db.query(
            `
            SELECT id
            FROM trade_positions
            WHERE UPPER(COALESCE(status, '')) IN ('OPEN', 'ACTIVE')
               OR (
                    UPPER(COALESCE(status, '')) = 'CLOSED'
                    AND COALESCE(closed_at, created_at) >= ?
                    AND COALESCE(closed_at, created_at) < ?
               )
            `,
            [bounds.todayStart, bounds.tomorrowStart]
        );

        const tradeIds = (relevantTradeIds.rows || []).map((row) => row.id);
        const tradeLifecycleDelete = await db.query(
            `
            DELETE FROM trade_lifecycle_events
            WHERE trade_id IS NOT NULL
              AND trade_id NOT IN (
                SELECT id FROM trade_positions
                WHERE UPPER(COALESCE(status, '')) IN ('OPEN', 'ACTIVE')
                   OR (
                        UPPER(COALESCE(status, '')) = 'CLOSED'
                        AND COALESCE(closed_at, created_at) >= ?
                        AND COALESCE(closed_at, created_at) < ?
                   )
              )
            `,
            [bounds.todayStart, bounds.tomorrowStart]
        );

        const tradePositionsDelete = await db.query(
            `
            DELETE FROM trade_positions
            WHERE NOT (
                UPPER(COALESCE(status, '')) IN ('OPEN', 'ACTIVE')
                OR (
                    UPPER(COALESCE(status, '')) = 'CLOSED'
                    AND COALESCE(closed_at, created_at) >= ?
                    AND COALESCE(closed_at, created_at) < ?
                )
            )
            `,
            [bounds.todayStart, bounds.tomorrowStart]
        );

        return {
            timezone,
            orderLogsDeleted: Number(orderLogsResult.rowCount || 0),
            tradeLifecycleEventsDeleted: Number(tradeLifecycleDelete.rowCount || 0),
            tradePositionsDeleted: Number(tradePositionsDelete.rowCount || 0)
        };
    }
}

export default new CleanupService();
