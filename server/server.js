// ────────────────────────────────────────────────────────────────
//  Jackpot Server – v2
//  • Один процесс (Express + Socket.IO)
//  • История хранится на диске Render (/data) и переживает деплой
//  • Админ-эндпоинты закрыты verifyAdmin (подпись Telegram + ADMIN_IDS)
//  • Фронтенд лежит в ../ (index.html, admin.html, …)
// ────────────────────────────────────────────────────────────────

import express  from "express";
import http     from "http";
import cors     from "cors";
import crypto   from "crypto";
import fs       from "fs/promises";
import path     from "path";
import { fileURLToPath } from "url";
import { Server as SocketIOServer } from "socket.io";
import { verifyAdmin } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONT_DIR = path.join(__dirname, "..");          // ./index.html, ./admin.html …

// ─────────── Config & Disk ───────────
const PORT         = process.env.PORT || 3000;
const DATA_DIR     = process.env.DATA_DIR || "/data";  // render-disk
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

// обязательно создаём /data при локальном запуске
await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});

/* ----------  JSON-history helpers  ---------- */
let history = [];
async function loadHistory() {
  try {
    const txt = await fs.readFile(HISTORY_FILE, "utf8");
    history = JSON.parse(txt);
    console.log(`Loaded ${history.length} history records`);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("History read error:", e);
    history = [];
  }
}
async function saveHistory() {
  const tmp = HISTORY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(history, null, 2));
  await fs.rename(tmp, HISTORY_FILE);
}

/* ----------  Express + Socket.IO  ---------- */
const app  = express();
const httpServer = http.createServer(app);
const io   = new SocketIOServer(httpServer, { cors: { origin: "*" } });

/* ───── 1. Закрытые админ-API (выше public/статик!) ───── */
app.get("/admin/history",        verifyAdmin, (req, res) => res.json(history));

app.post("/admin/history/clear", verifyAdmin, async (req, res) => {
  history = [];
  await saveHistory();
  res.json({ ok: true });
});

app.delete("/admin/history/:i",  verifyAdmin, async (req, res) => {
  const i = +req.params.i;
  if (i < 0 || i >= history.length) return res.status(400).end("bad index");
  history.splice(i, 1);
  await saveHistory();
  res.json({ ok: true });
});

/* ───── 2. Публичные JSON-API ───── */
app.use(cors()); // можно тонко настроить, если нужен CORS только на /history
app.get("/history", (req, res) => res.json(history));

/* ───── 3. Статические файлы ───── */
app.use(express.static(FRONT_DIR));   // index.html, admin.html, script.js …

/* ---------- Game state ---------- */
let game = {
  players:    [],
  totalTON:   0,           // всё в TON
  phase:      "waiting",
  endsAt:     null,
  seed:       null,
  commitHash: null
};
const palette = ['#fee440','#d4af37','#8ac926','#1982c4','#ffca3a','#6a4c93','#d79a59','#218380'];

/* ---------- Helpers ---------- */
function resetRound() {
  const seed = crypto.randomBytes(16).toString("hex");
  game = {
    players: [],
    totalTON: 0,
    phase: "waiting",
    endsAt: null,
    seed,
    commitHash: crypto.createHash("sha256").update(seed).digest("hex")
  };
  io.emit("state", game);
}

function rand01(seed, salt) {
  const h = crypto.createHash("sha256").update(seed + salt).digest("hex").slice(0, 16);
  return parseInt(h, 16) / 0xffffffffffffffff;
}

function weightedPickBySeed(seed) {
  const hash = crypto.createHash("sha256").update(seed + "spin").digest("hex").slice(0, 16);
  const rnd  = parseInt(hash, 16) / 0xffffffffffffffff;
  const ticket = rnd * game.totalTON;
  let acc = 0;
  for (const p of game.players) {
    acc += p.value;
    if (ticket <= acc) return p;
  }
  return game.players.at(-1);
}

function maybeStartCountdown() {
  if (game.phase !== "waiting" || game.players.length < 2) return;
  game.phase = "countdown";
  game.endsAt = Date.now() + 45_000;

  io.emit("countdownStart", { endsAt: game.endsAt, commitHash: game.commitHash });

  const timer = setInterval(() => {
    const left = game.endsAt - Date.now();
    if (left <= 0) {
      clearInterval(timer);
      startSpin();
    } else {
      io.emit("countdownTick", { remaining: left });
    }
  }, 1_000);
}

function startSpin() {
  game.phase = "spinning";
  const winner = weightedPickBySeed(game.seed);

  const spins = 6 + (parseInt(game.seed.slice(0, 2), 16) % 4);
  const sliceDeg = (winner.value / game.totalTON) * 360;
  const offset   = 5 + rand01(game.seed, "offset") * (sliceDeg - 10);

  io.emit("spinStart", {
    players: game.players,
    winner,
    spins,
    offsetDeg: offset,
    seed: game.seed,
    commitHash: game.commitHash
  });

  setTimeout(() => {
    io.emit("spinEnd", { winner, total: game.totalTON, seed: game.seed });

    /* ---- persist ---- */
    history.push({
      timestamp: new Date().toISOString(),
      winner: winner.name,
      total: game.totalTON,
      commitHash: game.commitHash,
      seed: game.seed,
      participants: game.players.map(p => ({ name: p.name, nfts: p.nfts }))
    });
    saveHistory().catch(console.error);

    setTimeout(resetRound, 6_000);
  }, 6_000);
}

/* ---------- Socket.IO ---------- */
io.on("connection", socket => {
  socket.emit("state", game);

  socket.on("placeBet", ({ name, nfts = [], tonAmount = 0 }) => {
    let player = game.players.find(p => p.name === name);
    if (!player) {
      player = { name, value: 0, color: palette[game.players.length % palette.length], nfts: [] };
      game.players.push(player);
    }
    const nftSum = nfts.reduce((s, x) => s + x.price, 0);

    player.value  += nftSum + tonAmount;
    game.totalTON += nftSum + tonAmount;
    player.nfts.push(...nfts);

    io.emit("state", game);
    maybeStartCountdown();
  });
});

/* ---------- Bootstrap ---------- */
await loadHistory();
resetRound();
httpServer.listen(PORT, () => console.log("Jackpot server on", PORT));
