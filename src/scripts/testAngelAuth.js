import dotenv from "dotenv";
dotenv.config();

import angelAuthService from "../services/angelAuthService.js";

async function run() {
    try {
        const result = await angelAuthService.generateSession();

        console.log("✅ TOKEN GENERATED SUCCESSFULLY");
        console.log(result);
    } catch (err) {
        console.error("❌ FAILED:", err.message);
    }
}

run();