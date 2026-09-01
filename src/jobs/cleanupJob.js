import cron from 'node-cron';
import cleanupService from '../services/cleanupService.js';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_SCHEDULE = '10 0 * * *';

function cleanupTimezone() {
    return process.env.CLEANUP_TIMEZONE || DEFAULT_TIMEZONE;
}

function cleanupSchedule() {
    return process.env.CLEANUP_CRON || DEFAULT_SCHEDULE;
}

async function runCleanup() {
    console.log('[CLEANUP] Daily cleanup started');

    try {
        const summary = await cleanupService.runDailyCleanup();

        console.log(
            '[CLEANUP] Daily cleanup completed',
            JSON.stringify(summary)
        );
    } catch (error) {
        console.error('[CLEANUP] Daily cleanup failed', error?.message || error);
    }
}

export function startCleanupJob() {
    const schedule = cleanupSchedule();
    const timezone = cleanupTimezone();

    cron.schedule(schedule, runCleanup, {
        timezone
    });

    console.log(`[CLEANUP] Job scheduled (${schedule}, ${timezone})`);
}

export { runCleanup };
