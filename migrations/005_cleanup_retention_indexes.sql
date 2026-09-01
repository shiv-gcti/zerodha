CREATE INDEX IF NOT EXISTS order_logs_created_at_idx
ON public.order_logs (created_at);

CREATE INDEX IF NOT EXISTS trade_positions_status_created_at_idx
ON public.trade_positions (status, created_at);

CREATE INDEX IF NOT EXISTS trade_positions_status_closed_at_idx
ON public.trade_positions (status, closed_at)
WHERE closed_at IS NOT NULL;
