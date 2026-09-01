ALTER TABLE trade_positions
ADD COLUMN IF NOT EXISTS exit_place_cooldown_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS trade_positions_exit_place_cooldown_until_idx
ON trade_positions (exit_place_cooldown_until);

