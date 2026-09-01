const VALID_BROKER_PRODUCTS = new Set(['MIS', 'CNC', 'NRML']);

export function normalizeBrokerProduct(product, fallback = 'NRML') {
    const normalizedValue = String(product ?? '').trim().toUpperCase();

    if (VALID_BROKER_PRODUCTS.has(normalizedValue)) {
        return normalizedValue;
    }

    return fallback;
}

export function resolveBrokerTradingsymbol(requestedSymbol, instrument = null) {
    const requested = String(requestedSymbol ?? '').trim();
    if (requested) {
        return requested;
    }

    return String(instrument?.tradingSymbol || instrument?.tradingsymbol || instrument?.symbol || '').trim();
}
