
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const fs      = require('fs').promises;
const path    = require('path');
const cors   = require('cors');

// ────────────────────────── Config ─────────────────────────────
const PORT         = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'history.json');

// ─────────────────── JSON‑history helpers ──────────────────────
let history = [];

async function loadHistory() {
  try {
    const txt = await fs.readFile(HISTORY_FILE, 'utf8');
    history   = JSON.parse(txt);
    console.log(`Loaded ${history.length} history records.`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('History read error → starting empty:', e);
    } else {
      console.log('No existing history.json, starting fresh.');
    }
    history = [];
  }
}

async function saveHistory() {
  const tmp = HISTORY_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(history, null, 2));
  await fs.rename(tmp, HISTORY_FILE);
}

// ─────────────────── Express / Socket.IO ───────────────────────
const app = express();
app.use(cors({ origin: 'https://max-savik.github.io' }));
app.use(express.static(__dirname));          // serve front‑end files

app.get('/history', (req, res) => res.json(history));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });   // * dev CORS

// ───────────────────── Game state (1 round) ────────────────────
let game = {
  players: [],        // [{ name, value, color, nfts:[{id,img,price}] }]
  totalUSD: 0,
  phase: 'waiting',   // waiting → countdown → spinning
  endsAt: null
};

// ───────────────────── Helper functions ────────────────────────
function weightedPick() {
  const ticket = Math.random() * game.totalUSD;
  let acc = 0;
  for (const p of game.players) {
    acc += p.value;
    if (ticket <= acc) return p;
  }
  return game.players.at(-1);
}

function resetRound() {
  game = { players: [], totalUSD: 0, phase: 'waiting', endsAt: null };
  io.emit('state', game);
}

function maybeStartCountdown() {
  if (game.phase !== 'waiting' || game.players.length < 2) return;
  game.phase  = 'countdown';
  game.endsAt = Date.now() + 45_000; // 45 s
  io.emit('countdownStart', { endsAt: game.endsAt });

  const timer = setInterval(() => {
    const rest = game.endsAt - Date.now();
    if (rest <= 0) {
      clearInterval(timer);
      startSpin();
    } else {
      io.emit('countdownTick', { remaining: rest });
    }
  }, 1000);
}

function startSpin() {
  game.phase = 'spinning';
  const winner = weightedPick();
  io.emit('spinStart', { players: game.players, winner });

  // after GSAP animation (6 s) → spinEnd
  setTimeout(() => {
    io.emit('spinEnd', { winner, total: game.totalUSD });

    // ─────────────── Persist round in history ────────────────
    history.push({
      timestamp: new Date().toISOString(),
      winner:    winner.name,
      total:     game.totalUSD,
      participants: game.players.map(p => ({
        name: p.name,
        nfts: p.nfts
      }))
    });
    saveHistory().catch(console.error);
    // ──────────────────────────────────────────────────────────

    setTimeout(resetRound, 6000); // small pause before next round
  }, 6000);
}

// ───────────────────── Socket handlers ─────────────────────────
io.on('connection', socket => {
  socket.emit('state', game);   // send current state

  socket.on('placeBet', ({ name, nfts }) => {
    let player = game.players.find(p => p.name === name);
    if (!player) {
      const palette = ['#fee440','#d4af37','#8ac926','#1982c4','#ffca3a','#6a4c93','#d79a59','#218380'];
      player = { name, value: 0, color: palette[game.players.length % palette.length], nfts: [] };
      game.players.push(player);
    }

    const added = nfts.reduce((s, x) => s + x.price, 0);
    player.value += added;
    game.totalUSD += added;
    nfts.forEach(x => player.nfts.push({ id: x.id, img: x.img, price: x.price }));

    io.emit('state', game);
    maybeStartCountdown();
  });
});

// ──────────────────────── Bootstrap ───────────────────────────
loadHistory()
  .then(() => httpServer.listen(PORT, () => console.log('Jackpot server on', PORT)))
  .catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
