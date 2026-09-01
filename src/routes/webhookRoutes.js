import express from 'express';
import { receiveSignal } from '../controllers/webhookController.js';

const router = express.Router();

router.post('/', receiveSignal);

export default router;