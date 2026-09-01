/**
 * Default TP/SL Configuration for Signal Reversal
 * These defaults are used when a signal reversal happens without explicit TP/SL
 */

// Default target and stop loss points (in rupees/paise)
const DEFAULT_TARGET_POINTS = process.env.DEFAULT_TARGET_POINTS 
    ? Number(process.env.DEFAULT_TARGET_POINTS) 
    : 50;

const DEFAULT_STOPLOSS_POINTS = process.env.DEFAULT_STOPLOSS_POINTS 
    ? Number(process.env.DEFAULT_STOPLOSS_POINTS) 
    : 30;

/**
 * Get effective TP/SL for a signal, using defaults if not specified
 * @param {Object} signal - The signal object
 * @param {boolean} useDefaults - Whether to apply defaults if TP/SL missing
 * @returns {Object} - { targetPoints, stopLossPoints, hasDefaults }
 */
export function getEffectiveTPSL(signal, useDefaults = false) {
    const tp = signal.TP ?? signal.tp ?? signal.target ?? null;
    const sl = signal.SL ?? signal.sl ?? signal.stoploss ?? signal.stop_loss ?? null;

    const hasTP = tp !== null && Number(tp) > 0;
    const hasSL = sl !== null && Number(sl) > 0;

    if (!useDefaults) {
        return {
            targetPoints: hasTP ? Number(tp) : null,
            stopLossPoints: hasSL ? Number(sl) : null,
            hasDefaults: false,
            usedDefaults: []
        };
    }

    const usedDefaults = [];
    const targetPoints = hasTP ? Number(tp) : DEFAULT_TARGET_POINTS;
    const stopLossPoints = hasSL ? Number(sl) : DEFAULT_STOPLOSS_POINTS;

    if (!hasTP) usedDefaults.push('TP');
    if (!hasSL) usedDefaults.push('SL');

    return {
        targetPoints,
        stopLossPoints,
        hasDefaults: usedDefaults.length > 0,
        usedDefaults,
        defaultTargetPoints: DEFAULT_TARGET_POINTS,
        defaultStopLossPoints: DEFAULT_STOPLOSS_POINTS
    };
}

/**
 * Inject default TP/SL into signal if not present
 * @param {Object} signal - The signal object
 * @returns {Object} - Modified signal with defaults applied
 */
export function injectDefaultTPSL(signal) {
    const tpsl = getEffectiveTPSL(signal, true);

    if (tpsl.hasDefaults) {
        console.log(`[DEFAULT TPSL] Applying defaults - TP: ${tpsl.targetPoints}, SL: ${tpsl.stopLossPoints}`);
    }

    return {
        ...signal,
        TP: tpsl.targetPoints,
        SL: tpsl.stopLossPoints,
        _tpslInfo: tpsl
    };
}

/**
 * Create a default TP/SL configuration object for order payload
 * @returns {Object}
 */
export function getDefaultTPSLConfig() {
    return {
        targetPoints: DEFAULT_TARGET_POINTS,
        stopLossPoints: DEFAULT_STOPLOSS_POINTS
    };
}

export default {
    DEFAULT_TARGET_POINTS,
    DEFAULT_STOPLOSS_POINTS,
    getEffectiveTPSL,
    injectDefaultTPSL,
    getDefaultTPSLConfig
};
