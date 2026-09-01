# TODO

- [x] Fix POST /webhook HTTP 500 by importing getIO in src/controllers/webhookController.js

- [x] Remove TP/SL automation from the webhook order path

- [x] Restart server and re-test POST /webhook

- [x] Add GLOBAL order placement rate limiter / queue for Kite order requests

- [ ] Add diagnostics: log queue delay + active placement count per account

- [ ] Re-run npm start and validate TradingView webhook places a single Zerodha entry order

