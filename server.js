
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();

function makeCode() {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase();
  while (rooms.has(code));
  return code;
}
function cleanName(name) {
  return String(name || "Игрок").trim().slice(0, 24) || "Игрок";
}
function roomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    target: room.target,
    message: room.message,
    timer: room.timer,
    winner: room.winner,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, role: p.role
    })),
    mines: room.mines.map(m => ({ id: m.id, word: m.word, active: m.active }))
  };
}
function broadcast(room) {
  io.to(room.code).emit("state", roomState(room));
}
function resetRoles(room) {
  room.players.forEach(p => p.role = "player");
}
function startTimer(room) {
  clearInterval(room.timerHandle);
  room.timer = 60;
  room.timerHandle = setInterval(() => {
    room.timer--;
    io.to(room.code).emit("timer", room.timer);
    if (room.timer <= 0) {
      clearInterval(room.timerHandle);
      room.phase = "result";
      room.winner = "time";
      room.message = "⏱️ Время вышло!";
      broadcast(room);
    }
  }, 1000);
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}) => {
    const room = {
      code: makeCode(),
      players: new Map(),
      phase: "lobby",
      target: "",
      mines: [],
      message: "Ожидаем игроков…",
      timer: 60,
      timerHandle: null,
      winner: null
    };
    room.players.set(socket.id, {
      id: socket.id, name: cleanName(name), role: "host"
    });
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.room = room.code;
    socket.emit("joined", {code: room.code});
    broadcast(room);
  });

  socket.on("joinRoom", ({code, name}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return socket.emit("errorMsg", "Такой комнаты нет.");
    if (room.phase !== "lobby") return socket.emit("errorMsg", "Раунд уже идёт.");
    if (room.players.size >= 20) return socket.emit("errorMsg", "Комната заполнена.");
    room.players.set(socket.id, {
      id: socket.id, name: cleanName(name), role: "player"
    });
    socket.join(room.code);
    socket.room = room.code;
    socket.emit("joined", {code: room.code});
    broadcast(room);
  });

  socket.on("startRound", ({target, guesserId, setterId, mines}) => {
    const room = rooms.get(socket.room);
    if (!room) return;
    const host = room.players.get(socket.id);
    if (!host || host.role !== "host")
      return socket.emit("errorMsg", "Только создатель комнаты может начать раунд.");

    if (room.players.size < 3)
      return socket.emit("errorMsg", "Нужно минимум 3 игрока.");
    if (!target?.trim())
      return socket.emit("errorMsg", "Введите слово.");
    if (!room.players.has(guesserId) || !room.players.has(setterId))
      return socket.emit("errorMsg", "Выберите роли.");
    if (guesserId === setterId)
      return socket.emit("errorMsg", "Загадывающий и отгадывающий должны быть разными.");

    const words = (Array.isArray(mines) ? mines : [])
      .map(x => String(x).trim())
      .filter(Boolean)
      .slice(0, 30);

    if (!words.length)
      return socket.emit("errorMsg", "Добавьте хотя бы одну мину.");

    resetRoles(room);
    room.players.get(setterId).role = "setter";
    room.players.get(guesserId).role = "guesser";
    host.role = "host";

    room.target = String(target).trim().slice(0, 50);
    room.mines = words.map((word, i) => ({
      id: i + 1, word: word.slice(0, 50), active: true
    }));
    room.phase = "round";
    room.winner = null;
    room.message = "Отгадывающий пытается угадать слово.";
    startTimer(room);
    broadcast(room);
  });

  socket.on("explodeMine", ({mineId}) => {
    const room = rooms.get(socket.room);
    if (!room || room.phase !== "round") return;
    const p = room.players.get(socket.id);
    if (!p || p.role !== "spectator" && p.role !== "host") return;

    const mine = room.mines.find(m => m.id === mineId && m.active);
    if (!mine) return;

    mine.active = false;
    clearInterval(room.timerHandle);
    room.phase = "result";
    room.winner = "mine";
    room.message = `💥 Мина «${mine.word}» взорвалась!`;
    broadcast(room);
  });

  socket.on("finishGuess", ({answer}) => {
    const room = rooms.get(socket.room);
    if (!room || room.phase !== "round") return;
    const p = room.players.get(socket.id);
    if (!p || p.role !== "guesser") return;

    const correct =
      String(answer || "").trim().toLocaleLowerCase("ru-RU") ===
      room.target.toLocaleLowerCase("ru-RU");

    clearInterval(room.timerHandle);
    room.phase = "result";
    room.winner = correct ? "guesser" : "wrong";
    room.message = correct
      ? `🎉 ${p.name} отгадал слово!`
      : `❌ Ответ «${String(answer || "").trim()}» неверный.`;
    broadcast(room);
  });

  socket.on("newRound", () => {
    const room = rooms.get(socket.room);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || (p.role !== "host" && p.role !== "setter")) return;

    clearInterval(room.timerHandle);
    room.phase = "lobby";
    room.target = "";
    room.mines = [];
    room.winner = null;
    room.timer = 60;
    room.message = "Готовы к новому раунду.";
    resetRoles(room);
    const first = [...room.players.values()][0];
    if (first) first.role = "host";
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.room);
    if (!room) return;
    room.players.delete(socket.id);
    if (!room.players.size) {
      clearInterval(room.timerHandle);
      rooms.delete(room.code);
    } else {
      broadcast(room);
    }
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("Слова-мины запущены");
});
