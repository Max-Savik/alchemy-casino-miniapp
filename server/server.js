// server.js
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(__dirname));   // 📂 отдавать все файлы этой папки
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });   // * dev-режим

// 1️⃣ Храним состояние одного раунда (start → countdown → spin → reset)
let game = {
  players: [],        // [{name,value,color}]
  totalUSD: 0,
  phase: 'waiting',   // waiting → countdown → spinning
  endsAt: null        // timestamp конца обратного отсчёта
};

// 2️⃣ Вспомогательные функции
function weightedPick() {
  const ticket = Math.random() * game.totalUSD;
  let acc = 0;
  for (const p of game.players) { acc += p.value; if (ticket <= acc) return p; }
  return game.players.at(-1);
}
function resetRound() {
  game = { players: [], totalUSD: 0, phase: 'waiting', endsAt: null };
  io.emit('state', game);
}

// 3️⃣ Запуск таймера (60 с) при ≥ 2 игроках
function maybeStartCountdown() {
  if (game.phase !== 'waiting' || game.players.length < 2) return;
  game.phase  = 'countdown';
  game.endsAt = Date.now() + 60_000;
  io.emit('countdownStart', { endsAt: game.endsAt });

  const timer = setInterval(() => {
    const rest = game.endsAt - Date.now();
    if (rest <= 0) { clearInterval(timer); startSpin(); }
    else           { io.emit('countdownTick', { remaining: rest }); }
  }, 1000);
}

// 4️⃣ Крутилка
function startSpin() {
  game.phase = 'spinning';
  const winner = weightedPick();
  io.emit('spinStart', { players: game.players, winner });

  setTimeout(() => {
    io.emit('spinEnd', { winner, total: game.totalUSD });
    resetRound();
  }, 6000);                   // столько же, сколько анимация GSAP на фронте
}

// 5️⃣ Сердце: приём ставок
io.on('connection', socket => {
  socket.emit('state', game);               // отправляем новый вкладке текущее

  socket.on('placeBet', ({ name, nfts }) => {
    // nfts: [{id,price}] – минимальная проверка
    let player = game.players.find(p => p.name === name);
    if (!player) {
      const palette = ['#fee440','#d4af37','#8ac926','#1982c4','#ffca3a','#6a4c93','#d79a59','#218380'];
      player = { name, value: 0, color: palette[game.players.length % palette.length] };
      game.players.push(player);
    }
    const added = nfts.reduce((s,x) => s + x.price, 0);
    player.value += added;
    game.totalUSD += added;

    io.emit('state', game);                 // рассылаем обновление
    maybeStartCountdown();                  // запускаем таймер, если пора
  });
});

httpServer.listen(PORT, () => console.log('Jackpot server on', PORT));
