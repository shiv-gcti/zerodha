import dotenv from "dotenv";
dotenv.config();

import angelInstrumentService from "../services/angelInstrumentService.js";

async function run() {
    try {
        console.log("🚀 Starting Angel Instrument Test...");

        await angelInstrumentService.runSync();

        console.log("🎉 INSTRUMENT SYNC COMPLETE");
    } catch (err) {
        console.error("❌ FAILED:", err.message);
    }
}

run();