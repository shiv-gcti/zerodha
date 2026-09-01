CREATE TABLE IF NOT EXISTS trade_positions (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL,
    tradingsymbol TEXT NOT NULL,
    exchange TEXT NOT NULL,
    transaction_type TEXT NOT NULL,
    product TEXT NOT NULL DEFAULT 'CNC',
    quantity INTEGER NOT NULL,
    entry_order_id TEXT,
    exit_order_id TEXT,
    entry_price NUMERIC,
    exit_price NUMERIC,
    target_points NUMERIC,
    stoploss_points NUMERIC,
    status TEXT NOT NULL DEFAULT 'OPEN',
    exchange_token TEXT,
    pnl NUMERIC DEFAULT 0,
    managed BOOLEAN NOT NULL DEFAULT FALSE,
    lifecycle_status TEXT NOT NULL DEFAULT 'ENTRY_PENDING',
    target_order_id TEXT,
    stoploss_order_id TEXT,
    target_price NUMERIC,
    stoploss_price NUMERIC,
    exit_gtt_id TEXT,
    exit_gtt_type TEXT,
    closed_reason TEXT,
    last_error TEXT,
    exit_place_cooldown_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trade_lifecycle_events (
    id BIGSERIAL PRIMARY KEY,
    trade_id BIGINT REFERENCES trade_positions(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    order_id TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_logs (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'RECEIVED',
    order_id TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zerodha_tokens (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    user_id TEXT,
    access_token TEXT,
    public_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS angel_tokens (
    id INTEGER PRIMARY KEY DEFAULT 1,
    access_token TEXT,
    refresh_token TEXT,
    feed_token TEXT,
    jwt_token TEXT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zerodha_instruments (
    instrument_token BIGINT PRIMARY KEY,
    exchange_token BIGINT,
    tradingsymbol TEXT NOT NULL,
    name TEXT,
    last_price NUMERIC,
    expiry TEXT,
    strike NUMERIC,
    tick_size NUMERIC,
    lot_size INTEGER,
    instrument_type TEXT,
    segment TEXT,
    exchange TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trade_positions_account_status_idx
ON trade_positions (account_id, status);

CREATE INDEX IF NOT EXISTS trade_positions_status_created_at_idx
ON trade_positions (status, created_at);

CREATE INDEX IF NOT EXISTS trade_positions_status_closed_at_idx
ON trade_positions (status, closed_at)
WHERE closed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS trade_positions_entry_order_id_idx
ON trade_positions (entry_order_id)
WHERE entry_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trade_positions_lifecycle_status_idx
ON trade_positions (lifecycle_status);

CREATE INDEX IF NOT EXISTS trade_positions_target_order_id_idx
ON trade_positions (target_order_id)
WHERE target_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trade_positions_stoploss_order_id_idx
ON trade_positions (stoploss_order_id)
WHERE stoploss_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trade_positions_exit_gtt_id_idx
ON trade_positions (exit_gtt_id)
WHERE exit_gtt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trade_positions_exit_place_cooldown_until_idx
ON trade_positions (exit_place_cooldown_until);

CREATE INDEX IF NOT EXISTS trade_lifecycle_events_trade_id_idx
ON trade_lifecycle_events (trade_id, created_at DESC);

CREATE INDEX IF NOT EXISTS order_logs_account_status_created_at_idx
ON order_logs (account_id, status, created_at);

CREATE INDEX IF NOT EXISTS order_logs_created_at_idx
ON order_logs (created_at);

CREATE UNIQUE INDEX IF NOT EXISTS trade_lifecycle_events_order_event_uidx
ON trade_lifecycle_events (trade_id, account_id, event_type, order_id)
WHERE order_id IS NOT NULL;
