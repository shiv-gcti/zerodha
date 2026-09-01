DELETE FROM trade_lifecycle_events a
USING trade_lifecycle_events b
WHERE a.id > b.id
  AND a.trade_id IS NOT DISTINCT FROM b.trade_id
  AND a.account_id = b.account_id
  AND a.event_type = b.event_type
  AND a.order_id = b.order_id
  AND a.order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trade_lifecycle_events_order_event_uidx
ON trade_lifecycle_events (trade_id, account_id, event_type, order_id)
WHERE order_id IS NOT NULL;
