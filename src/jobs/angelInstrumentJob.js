import cron from 'node-cron';
import angelInstrumentService from '../services/angelInstrumentService.js';

export function startAngelInstrumentJob() {

    cron.schedule(
        '5 6 * * 0',
        async () => {

            try {

                console.log(
                    '⏰ Sunday 6:05 AM IST - Angel Instrument Sync Triggered'
                );

                await angelInstrumentService.runSync();

            } catch (err) {

                console.error(
                    '❌ Angel Instrument Sync Failed:',
                    err.message
                );
            }

        },
        {
            timezone: 'Asia/Kolkata'
        }
    );

    console.log(
        '📅 Angel Instrument Sync Cron Scheduled (weekly on Sunday 6:05 AM IST)'
    );
}