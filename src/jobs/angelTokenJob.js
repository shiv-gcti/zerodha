import cron from "node-cron";
import angelAuthService from "../services/angelAuthService.js";

export function startAngelTokenJob() {
    console.log("🕒 Angel token job scheduled");

    cron.schedule(
        "0 6 * * 1-5",
        async () => {
            try {
                await angelAuthService.generateSession();
            } catch (err) {
                console.error(
                    "Angel token job failed:",
                    err.message
                );
            }
        },
        {
            timezone: "Asia/Kolkata"
        }
    );
}