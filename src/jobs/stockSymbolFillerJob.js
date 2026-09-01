import stockSymbolFillerService
    from '../services/stockSymbolFillerService.js';

let interval;

export async function startStockSymbolFillerJob() {

    await stockSymbolFillerService.init();

    console.log(
        '📅 Stock Symbol Filler scheduled (every 1 minute)'
    );

    // Run immediately on startup
    await stockSymbolFillerService.process();

    interval = setInterval(async () => {

        try {

            await stockSymbolFillerService.process();

        } catch (err) {

            console.error(
                '❌ Stock Symbol Filler Job failed:',
                err.message
            );
        }

    }, 60 * 1000);
}

export async function stopStockSymbolFillerJob() {

    clearInterval(interval);

    await stockSymbolFillerService.stop();
}