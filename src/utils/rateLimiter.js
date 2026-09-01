// Simple in-process strict rate limiter for async functions.
// Enforces: at most `ratePerInterval` starts per `intervalMs` (strict spacing).

export function createRateLimiter({ ratePerInterval = 1, intervalMs = 500 } = {}) {
    const queue = [];

    // min delay between *starts*
    const minDelayMs = Math.max(0, Math.floor(intervalMs / Math.max(1, ratePerInterval)));
    let lastStart = 0;

    async function drain() {
        if (drain.running) return;
        drain.running = true;
        try {
            while (queue.length > 0) {
                const next = queue.shift();

                const now = Date.now();
                const wait = Math.max(0, (lastStart + minDelayMs) - now);
                if (wait > 0) {
                    await new Promise(r => setTimeout(r, wait));
                }
                lastStart = Date.now();

                next();
            }
        } finally {
            drain.running = false;
        }
    }

    return async function runWithLimit(fn) {
        await new Promise((resolve) => {
            queue.push(resolve);
            drain();
        });
        return await fn();
    };
}


