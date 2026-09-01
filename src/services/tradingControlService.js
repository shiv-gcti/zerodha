const truthyValues = new Set(['true', '1', 'yes', 'on']);

let tradingEnabled = truthyValues.has(String(process.env.TRADING_ENABLED || '').toLowerCase());

export function isTradingEnabled() {
    if (String(process.env.DRY_RUN || '').toLowerCase() === 'true') {
        return false;
    }

    return tradingEnabled;
}

export function setTradingEnabled(enabled) {
    tradingEnabled = Boolean(enabled);
    return getTradingStatus();
}

export function getTradingStatus() {
    const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

    return {
        enabled: !dryRun && tradingEnabled,
        requestedEnabled: tradingEnabled,
        dryRun,
        mode: dryRun ? 'DRY_RUN' : (tradingEnabled ? 'LIVE' : 'OFF')
    };
}
