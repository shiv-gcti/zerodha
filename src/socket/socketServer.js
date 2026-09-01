import { Server } from "socket.io";

let io;

export function initSocket(server) {
    io = new Server(server, {
        cors: {
            origin: "*"
        }
    });

    io.on("connection", (socket) => {
        console.log("⚡ Client connected:", socket.id);
    });

    return io;
}

export function getIO() {
    if (!io) throw new Error("Socket not initialized");
    return io;
}