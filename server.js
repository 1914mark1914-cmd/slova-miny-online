const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

io.on("connection", (socket) => {
    socket.on("createRoom", ({ name }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name }],
            game: null
        };
        socket.join(roomCode);
        socket.emit("roomCreated", roomCode);
        io.to(roomCode).emit("updatePlayers", { players: rooms[roomCode].players, host: rooms[roomCode].host });
    });

    socket.on("joinRoom", ({ name, room }) => {
        if (rooms[room]) {
            rooms[room].players.push({ id: socket.id, name });
            socket.join(room);
            socket.emit("joinedRoom", room);
            io.to(room).emit("updatePlayers", { players: rooms[room].players, host: rooms[room].host });
        } else {
            socket.emit("errorMsg", "Комната не найдена!");
        }
    });

    socket.on("startRound", ({ room, word, mines }) => {
        const roomData = rooms[room];
        if (!roomData || roomData.players.length < 2) return;

        const guesser = roomData.players[0].id;
        const explainer = roomData.players[1].id;

        roomData.game = { word, mines, guesser, explainer };

        io.to(room).emit("roundStarted", roomData.game);
    });

    socket.on("clickMine", ({ room, mine }) => {
        io.to(room).emit("mineExploded", { mine });
    });

    socket.on("disconnect", () => {
        for (const roomCode in rooms) {
            rooms[roomCode].players = rooms[roomCode].players.filter(p => p.id !== socket.id);
            if (rooms[roomCode].players.length === 0) {
                delete rooms[roomCode];
            } else {
                io.to(roomCode).emit("updatePlayers", { players: rooms[roomCode].players, host: rooms[roomCode].host });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
