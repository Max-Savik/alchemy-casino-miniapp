// ────────────────────────────────────────────────────────────────
//  Jackpot Server with Persistent Disk on Render
//  --------------------------------------------------------------
//  • Stores history.json on Render's mounted disk (/data by default)
//  • Disk survives deploys & restarts on Starter plan
//  • CORS enabled for any front‑end host
// ────────────────────────────────────────────────────────────────

import express from "express";
import crypto from "crypto";  
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

import dotenv from 'dotenv';
dotenv.config();               // .env: ADMIN_TOKEN=super-secret-hex

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not set');

// ─────────────────── TON init ─────────────────────
import { TonClient, WalletContractV4, internal } from "@ton/ton";
import { mnemonicToWalletKey } from "@ton/crypto";
import axios from "axios";

const ton = new TonClient({ endpoint: process.env.TON_API });
const serviceKey = await mnemonicToWalletKey(process.env.SERVICE_WALLET_MNEMONIC.split(' '));
const serviceWallet = WalletContractV4.create({
  workchain: 0,
  publicKey: serviceKey.publicKey,
});


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
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));   // раздаём фронт
app.get("/history", (req, res) => res.json(history));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

/* ===== Balances (per Telegram username) ===== */
const balances = new Map();           // name → tonBalance (nanoTON)
function addBalance(name, nano){      // депозит
  balances.set(name, (balances.get(name)||0n) + nano);
}
function subBalance(name, nano){      // вывод / ставка
  const cur = balances.get(name)||0n;
  if (cur < nano) throw 'ENOUGH_FUNDS';
  balances.set(name, cur - nano);
}


// ───────────────────── Game state (1 round) ────────────────────
let game = {
  players: [],
  totalUSD: 0,
  phase: "waiting",
  endsAt: null,
  seed: null,           // крипто-сид
  commitHash: null      // sha256(seed)
};

// ───────────────────── Helper functions ────────────────────────
// Дет. выбор на основе seed
function weightedPickBySeed(seed) {
  // получаем псевдослучай [0,1) из sha256(seed + "spin")
  const hash = crypto
    .createHash("sha256")
    .update(seed + "spin")
    .digest("hex")
    .substr(0, 16);
  const rnd = parseInt(hash, 16) / 0xffffffffffffffff;
  const ticket = rnd * game.totalUSD;
  let acc = 0;
  for (const p of game.players) {
    acc += p.value;
    if (ticket <= acc) return p;
  }
  return game.players.at(-1);
}

function resetRound() {
  // 1) Новый сид для следующего раунда
  const seed = crypto.randomBytes(16).toString("hex");
  game = {
    players: [],
    totalUSD: 0,
    phase: "waiting",
    endsAt: null,
    seed,
    commitHash: crypto.createHash("sha256").update(seed).digest("hex")
  };
  io.emit("state", game);
}
// ───── utility: детерминированное float-rand из seed + salt ─────
function rand01(seed, salt){
  const h = crypto
      .createHash("sha256")
      .update(seed + salt)
      .digest("hex")
      .slice(0, 16);           // 64-бит = 16 hex
  return parseInt(h, 16) / 0xffffffffffffffff;
}

function maybeStartCountdown() {
  if (game.phase !== "waiting" || game.players.length < 2) return;
  game.phase = "countdown";
  game.endsAt = Date.now() + 45_000;
  io.emit("countdownStart", {
    endsAt: game.endsAt,
    commitHash: game.commitHash      // публикуем хэш заранее
  });

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
  const winner = weightedPickBySeed(game.seed);

  // Детерминируем число оборотов
  const spins = 6 + (parseInt(game.seed.substr(0,2), 16) % 4);

  // угловой размер сектора победителя
  const sliceDeg = (winner.value / game.totalUSD) * 360;
  const offset   = 5 + rand01(game.seed, "offset") * (sliceDeg - 10); // 5° отступ от краёв
  
  io.emit("spinStart", {
    players:    game.players,
    winner,
    spins,               
    offsetDeg:  offset,
    seed:       game.seed,     // тоже удобнее передать сразу
    commitHash: game.commitHash
  });

  setTimeout(() => {
      io.emit("spinEnd", {
      winner,
      total: game.totalUSD,
      seed: game.seed            // теперь раскрываем сид
     });

    // ───── persist round to mounted disk ─────

history.push({
  timestamp: new Date().toISOString(),
  winner:     winner.name,
  total:      game.totalUSD,

  /* === provable-fair data === */
  commitHash: game.commitHash,   // sha256(seed)
  seed:       game.seed,         // публикуем сид после спина

  participants: game.players.map(p => ({
    name: p.name,
    nfts: p.nfts
  }))
});

    saveHistory().catch(console.error);
    // ─────────────────────────────────────────

    setTimeout(resetRound, 6_000);
  }, 6_000);
}

// ─── middleware для /admin/* ──────────────
function adminAuth(req, res, next) {
  const token = req.get('X-Admin-Token');
  if (token !== ADMIN_TOKEN) return res.sendStatus(403);
  next();
}

// ─── admin-роуты ──────────────────────────
const admin = express.Router();
admin.use(adminAuth);

// 1) Скачать history.json
admin.get('/history/download', async (req, res) => {
  await saveHistory();                       // убедимся, что последнее состояние записано
  res.download(HISTORY_FILE, 'history.json');
});

// 2) Очистить историю (с резервной копией)
admin.post('/history/clear', async (req, res) => {
  const backup = HISTORY_FILE + '.' + Date.now() + '.bak';
  await fs.copyFile(HISTORY_FILE, backup).catch(() => {});  // silently skip if нет файла
  history = [];
  await saveHistory();
  res.json({ ok: true, backup });
});

// 3) Краткая статистика (топ победителей)
admin.get('/history/top', (req, res) => {
  const topN = Number(req.query.n || 10);
  const map = new Map();
  for (const rec of history) {
    map.set(rec.winner, (map.get(rec.winner) || 0) + rec.total);
  }
  const top = [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name, sum]) => ({ name, sum }));
  res.json(top);
});

/* 4) Игровая статистика конкретного игрока
   GET /admin/history/player?name=Alice */
admin.get('/history/player', (req, res) => {
  const qName = (req.query.name || '').trim();
  if (!qName) return res.status(400).json({ error: 'name empty' });

  let games = 0, wins = 0;
  for (const rec of history) {
    if (rec.participants.some(p => p.name === qName)) games++;
    if (rec.winner === qName) wins++;
  }
  const winPct = games ? (wins / games) * 100 : 0;
  res.json({ name: qName, games, wins, winPct });
});

/* 5) Сделать «голый» backup history.json */
admin.post('/history/backup', async (_req, res) => {
  const backup = HISTORY_FILE + '.' + Date.now() + '.bak';
  await fs.copyFile(HISTORY_FILE, backup);
  res.json({ backup: path.basename(backup) });
});

/* 6) Prune — удалить записи старше N дней (с бэкапом)           
   POST /admin/history/prune?days=30 */
admin.post('/history/prune', async (req, res) => {
  const days = Number(req.query.days);
  if (!days || days <= 0) return res.status(400).json({ error: 'days required' });

  // 1) backup
  const backup = HISTORY_FILE + '.' + Date.now() + '.bak';
  await fs.copyFile(HISTORY_FILE, backup).catch(() => {});
  
  // 2) prune
  const cutoff = Date.now() - days * 86_400_000;
  const before = history.length;
  history = history.filter(r => new Date(r.timestamp).getTime() >= cutoff);
  await saveHistory();

  res.json({
    removed: before - history.length,
    left: history.length,
    backup: path.basename(backup)
  });
});

/* 7) Restore бэкапа
   POST /admin/history/restore?id=history.json.1719226800000.bak */
admin.post('/history/restore', async (req, res) => {
  const id = (req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });

  const file = path.join(DATA_DIR, id);
  try {
    const txt = await fs.readFile(file, 'utf8');
    history = JSON.parse(txt);
    await saveHistory();      // перезаписываем актуальный history.json
    res.json({ ok: true, restored: id, count: history.length });
  } catch (e) {
    res.status(404).json({ error: 'backup not found' });
  }
});

/* 8) Скачать любой backup по id
   GET /admin/history/download?id=history.json.1719226800000.bak      */
admin.get('/history/download', async (req, res) => {
  const id = (req.query.id || '').trim() || 'history.json';
  const file = path.join(DATA_DIR, id);
  res.download(file).catch(() => res.sendStatus(404));
});

app.use('/admin', admin);

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

socket.on('depositTonHash', async ({name, hash, amount})=>{
  try{
    await waitTxConfirm(hash);              // см. ниже
    addBalance(name, BigInt(amount));       // nanoTON
    socket.emit('balance', balances.get(name));
  }catch(e){
    socket.emit('txError', {error:e});
  }
});

  
});

async function waitTxConfirm(hash){
  let attempts = 12;
  while(attempts--){
    const r = await axios.get(
      `${process.env.TON_API}/blockchain/messages/${hash}/transaction`,
      { headers:{'X-API-Key':process.env.TON_API_KEY}}
    ).catch(()=>null);
    if(r?.data?.transaction) return true;
    await new Promise(r=>setTimeout(r, 5000));
  }
  throw 'TX_NOT_FOUND';
}

app.post('/withdraw', async (req,res)=>{
  try{
    const {name, amount, toAddr} = req.body;          // nanoTON
    subBalance(name, BigInt(amount));

    // 1 TON ≈ 0.05 TON комиссия → добавьте safety-margin
    const fee = 50_000_000n;                             // 0.05 TON
    const value = BigInt(amount) - BigInt(fee);

    const seqno = await ton.runMethod(serviceWallet.address, 'seqno')
                           .then(r=>r.stack.readNumber());
    const transfer = serviceWallet.createTransfer({
      secretKey: serviceKey.secretKey,
      seqno,
      messages:[
        internal({
          to: toAddr,
          value,
          bounce:false
        })
      ]
    });
    await ton.sendExternalMessage(serviceWallet, transfer);

    res.json({ok:true, txHash: transfer.hash().toString('hex')});
  }catch(e){
    res.status(400).json({error:String(e)});
  }
});


// ──────────────────────── Bootstrap ───────────────────────────
(async () => {
  await loadHistory();
  resetRound();      
  httpServer.listen(PORT, () => console.log("Jackpot server on", PORT));
})();
