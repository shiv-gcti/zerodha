import express from 'express';
import db from '../services/dbService.js';
import { syncInstrumentsIfNeeded } from '../jobs/instrumentSyncJob.js';

const router = express.Router();


// GET /instruments/search?instrument_type=FUT&query=RELIANCE
// Returns matching symbols (tradingsymbols) from zerodha_instruments.
router.post('/sync-now', async (req, res) => {
  try {
    const result = await syncInstrumentsIfNeeded();
    return res.json({
      success: true,
      ...result,
      message: result.synced ? 'Instrument cache synced successfully.' : 'Instrument cache already had data.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || String(error)
    });
  }
});

router.get('/search', async (req, res) => {
  try {
    const instrumentType = String(req.query.instrument_type || '').trim();
    const q = String(req.query.query || '').trim();

    if (!q) {
      return res.status(400).json({ success: false, message: 'query is required' });
    }

    const params = [q + '%'];

    // Minimal filtering: if instrument_type provided, also filter by it.
    // (You can extend to segment/exchange rules later.)
const sql = `
      SELECT
        tradingsymbol,
        instrument_type,
        segment,
        exchange,
        expiry,
        strike
      FROM zerodha_instruments
      WHERE tradingsymbol ILIKE $1
      ${instrumentType ? 'AND instrument_type = $2' : ''}
      ${req.query.exchange ? 'AND exchange = $' + (instrumentType ? 3 : 2) : ''}
      ORDER BY tradingsymbol
      LIMIT 25
    `;

const exchange = String(req.query.exchange || '').trim();

const values = [];
values.push(q + '%');
if (instrumentType) values.push(instrumentType);
if (exchange) values.push(exchange);

const rows = (await db.query(sql, values)).rows;



    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || String(e) });
  }
});

export default router;

