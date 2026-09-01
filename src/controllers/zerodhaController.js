import kite from '../config/kite.js';

export const profile = async (req, res) => {
    try {

        const data = await kite.getProfile();

        res.json({
            success: true,
            profile: data
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};

export const margins = async (req, res) => {
    try {

        const data = await kite.getMargins();

        res.json({
            success: true,
            data
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};