import db from './dbService.js';

class OrderLogService {

    async create(accountId, payload) {

        const result = await db.query(
            `
            INSERT INTO order_logs
            (
                account_id,
                payload,
                status
            )
            VALUES
            (
                $1,
                $2,
                'RECEIVED'
            )
            RETURNING id
            `,
            [
                accountId,
                JSON.stringify(payload)
            ]
        );

        return result.rows[0].id;
    }

    async updateSuccess(logId, orderId) {

        await db.query(
            `
            UPDATE order_logs
            SET
                status = 'PLACED',
                order_id = $1
            WHERE id = $2
            `,
            [
                orderId,
                logId
            ]
        );
    }

    async updateFailed(logId, errorMessage) {

        await db.query(
            `
            UPDATE order_logs
            SET
                status = 'FAILED',
                error_message = $1
            WHERE id = $2
            `,
            [
                errorMessage,
                logId
            ]
        );
    }

    async updateBlocked(logId, reason) {

        await db.query(
            `
            UPDATE order_logs
            SET
                status = 'BLOCKED',
                error_message = $1
            WHERE id = $2
            `,
            [
                reason,
                logId
            ]
        );
    }

}

export default new OrderLogService();
