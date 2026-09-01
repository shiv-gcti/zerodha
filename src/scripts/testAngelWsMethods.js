import { WebSocketV2 } from "smartapi-javascript";

const ws = new WebSocketV2({
    jwttoken: "dummy",
    apikey: "dummy",
    clientcode: "dummy",
    feedtype: "dummy"
});

console.log("=== INSTANCE ===");
console.log(ws);

console.log("\n=== KEYS ===");
console.log(Object.keys(ws));

console.log("\n=== ENTRIES ===");
console.log(
    Object.entries(ws)
        .filter(([_, value]) => typeof value === "function")
        .map(([key]) => key)
);