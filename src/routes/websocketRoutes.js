import express from 'express';
import angelWebSocketService from '../services/angelWebSocketService.js';

const router = express.Router();

router.post('/restart', async (req, res) => {
    try {

        await angelWebSocketService.restart();

        res.json({
            success: true,
            message: 'Angel WebSocket restarted successfully'
        });

    } catch (err) {

        console.error('Restart failed:', err);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

export default router;