ALTER TABLE trade_positions
ADD COLUMN IF NOT EXISTS managed BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'CNC',
ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'ENTRY_PENDING',
ADD COLUMN IF NOT EXISTS target_order_id TEXT,
ADD COLUMN IF NOT EXISTS stoploss_order_id TEXT,
ADD COLUMN IF NOT EXISTS target_price NUMERIC,
ADD COLUMN IF NOT EXISTS stoploss_price NUMERIC,
ADD COLUMN IF NOT EXISTS closed_reason TEXT,
ADD COLUMN IF NOT EXISTS last_error TEXT,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

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

CREATE TABLE IF NOT EXISTS trade_lifecycle_events (
    id BIGSERIAL PRIMARY KEY,
    trade_id BIGINT REFERENCES trade_positions(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    order_id TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trade_lifecycle_events_trade_id_idx
ON trade_lifecycle_events (trade_id, created_at DESC);
