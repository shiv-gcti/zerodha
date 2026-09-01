const logger = {
    info: (msg, data = null) => {
        console.log(`[INFO] ${msg}`, data || '');
    },

    error: (msg, err = null) => {
        console.error(`[ERROR] ${msg}`, err || '');
    },

    warn: (msg, data = null) => {
        console.warn(`[WARN] ${msg}`, data || '');
    }
};

export default logger;