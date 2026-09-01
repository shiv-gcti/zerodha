ALTER TABLE trade_positions
ADD COLUMN IF NOT EXISTS exit_gtt_id TEXT,
ADD COLUMN IF NOT EXISTS exit_gtt_type TEXT;

CREATE INDEX IF NOT EXISTS trade_positions_exit_gtt_id_idx
ON trade_positions (exit_gtt_id)
WHERE exit_gtt_id IS NOT NULL;
