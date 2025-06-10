// ────────────────────────────────────────────────────────────────
//  Jackpot Server with Persistent Disk on Render
//  --------------------------------------------------------------
//  • Stores history.json on Render's mounted disk (/data by default)
//  • Disk survives deploys & restarts on Starter plan
//  • CORS enabled for any front‑end host
// ────────────────────────────────────────────────────────────────

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────────────────────── Config & Disk ─────────────────────────
const PORT      = process.env.PORT || 3000;
const DATA_DIR  = process.env.DATA_DIR || "/data";  // ← mountPath in Render disk
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

// ensure /data exists (Render mounts it, но локально нужно создать)
await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});

// ─────────────────── JSON‑history helpers ──────────────────────
let history = [];
const palette = [
  '#fee440','#d4af37','#8ac926','#1982c4',
  '#ffca3a','#6a4c93','#d79a59','#218380'
];
async function loadHistory() {
  try {
    const txt = await fs.readFile(HISTORY_FILE, "utf8");
    history = JSON.parse(txt);
    console.log(`Loaded ${history.length} history records.`);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("History read error:", e);
    history = []; // файл ещё не создан – начинаем с пустого массива
  }
}

async function saveHistory() {
  const tmp = HISTORY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(history, null, 2));
  await fs.rename(tmp, HISTORY_FILE);
}

// ─────────────────── Express / Socket.IO ───────────────────────
const app = express();
app.use(cors());
app.use(express.static(__dirname));   // раздаём фронт
app.get("/history", (req, res) => res.json(history));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ───────────────────── Game state (1 round) ────────────────────
let game = { players: [], totalUSD: 0, phase: "waiting", endsAt: null };

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
  game = { players: [], totalUSD: 0, phase: "waiting", endsAt: null };
  io.emit("state", game);
}

function maybeStartCountdown() {
  if (game.phase !== "waiting" || game.players.length < 2) return;
  game.phase = "countdown";
  game.endsAt = Date.now() + 45_000;
  io.emit("countdownStart", { endsAt: game.endsAt });

  const t = setInterval(() => {
    const left = game.endsAt - Date.now();
    if (left <= 0) {
      clearInterval(t);
      startSpin();
    } else {
      io.emit("countdownTick", { remaining: left });
    }
  }, 1_000);
}

function startSpin() {
  game.phase = "spinning";
  const winner = weightedPick();
  io.emit("spinStart", { players: game.players, winner });

  setTimeout(() => {
    io.emit("spinEnd", { winner, total: game.totalUSD });

    // ───── persist round to mounted disk ─────
    history.push({
      timestamp: new Date().toISOString(),
      winner: winner.name,
      total: game.totalUSD,
      participants: game.players.map(p => ({ name: p.name, nfts: p.nfts }))
    });
    saveHistory().catch(console.error);
    // ─────────────────────────────────────────

    setTimeout(resetRound, 6_000);
  }, 6_000);
}

// ───────────────────── Socket handlers ─────────────────────────
io.on("connection", socket => {
  socket.emit("state", game);

socket.on("placeBet", ({ name, nfts = [], tonAmount = 0 }) => {
  let player = game.players.find(p => p.name === name);
  if (!player) {
    player = {
      name,
      value: 0,
      color: palette[game.players.length % palette.length],
      nfts: []
    };
    game.players.push(player);
  }
  // сумма NFT + TON
  const nftSum = nfts.reduce((s, x) => s + x.price, 0);

  player.value     += nftSum + tonAmount;
  game.totalUSD    += nftSum + tonAmount;
  nfts.forEach(x => player.nfts.push(x));

  io.emit("state", game);
  maybeStartCountdown();
});

});

// ──────────────────────── Bootstrap ───────────────────────────
(async () => {
  await loadHistory();
  httpServer.listen(PORT, () => console.log("Jackpot server on", PORT));
})();
