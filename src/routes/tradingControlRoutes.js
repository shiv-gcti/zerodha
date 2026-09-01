import express from 'express';
import {
    getTradingStatus,
    setTradingEnabled
} from '../services/tradingControlService.js';

const router = express.Router();

router.get('/status', (req, res) => {
    res.json({
        success: true,
        trading: getTradingStatus()
    });
});

router.post('/status', (req, res) => {
    const enabled = Boolean(req.body?.enabled);

    res.json({
        success: true,
        trading: setTradingEnabled(enabled)
    });
});

export default router;
