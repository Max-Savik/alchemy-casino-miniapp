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
import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────────────────────── Config & Disk ─────────────────────────
const PORT      = process.env.PORT || 3000;
const DATA_DIR  = process.env.DATA_DIR || "/data";  // ← mountPath in Render disk
const DEPOSIT_ADDR   = process.env.DEPOSIT_ADDR;
const TON_API        = process.env.TONCENTER_API || "https://toncenter.com/api/v2/";
const TON_API_KEY    = process.env.TONCENTER_KEY || "";
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const BALANCES_FILE = path.join(DATA_DIR, "balances.json");
const TX_FILE       = path.join(DATA_DIR, "transactions.json");
const WD_FILE       = path.join(DATA_DIR, "withdrawals.json"); 
const ADDR_FILE = path.join(DATA_DIR, "addresses.json");
let addrMap = {};           // { [userId]: "EQB…" }

if (!DEPOSIT_ADDR) throw new Error("DEPOSIT_ADDR not set");

async function loadAddr(){
  try{ addrMap = JSON.parse(await fs.readFile(ADDR_FILE,'utf8')); }
  catch(e){ if(e.code!=="ENOENT") console.error(e); addrMap={}; }
}
async function saveAddr(){
  const tmp=ADDR_FILE+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(addrMap,null,2));
  await fs.rename(tmp,ADDR_FILE);
}

import dotenv from 'dotenv';
dotenv.config();               // .env: ADMIN_TOKEN=super-secret-hex

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not set');


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

// ─────────────── BALANCES helpers ─────────────── ➋
let balances = {};          // { [userId]: number }
async function loadBalances() {
  try {
    const txt = await fs.readFile(BALANCES_FILE, "utf8");
    balances = JSON.parse(txt);
    console.log("Loaded balances:", balances);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Balances read error:", e);
    balances = {};
  }
}
async function saveBalances() {
  const tmp = BALANCES_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(balances, null, 2));
  await fs.rename(tmp, BALANCES_FILE);
}

function userAuth(req, res, next) {
  const userId =
    (req.body && req.body.userId) ||
    (req.query && req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId required" });
  req.userId = String(userId);
  next();
}

/* pending withdrawals  [{id,userId,amount,to,ts,status}] */
let withdrawals = [];
async function loadWithdrawals() {
  try {
    withdrawals = JSON.parse(await fs.readFile(WD_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.error(e);
    withdrawals = [];
  }
}
async function saveWithdrawals() {
  const tmp = WD_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(withdrawals, null, 2));
  await fs

const wallet = express.Router();
wallet.use(userAuth);

/* GET /wallet/balance?userId=123 */
wallet.get("/balance", (req, res) => {
  const bal = balances[req.userId] || 0;
  res.json({ balance: bal });
});

/* POST /wallet/deposit { userId, amount } */
wallet.post("/deposit", async (req, res) => {
  const amt = Number(req.body.amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "amount>0" });
  balances[req.userId] = (balances[req.userId] || 0) + amt;
  await saveBalances();
  res.json({ balance: balances[req.userId] });
  txs.push({ userId: req.userId, type:'deposit', amount:amt, ts:Date.now() });
  await saveTx();
});

/* POST /wallet/withdraw { userId, amount } */
wallet.post("/withdraw", async (req, res) => {
  const amt = Number(req.body.amount);

  /* 1️⃣ базовые проверки */
  if (!amt || amt <= 0)  return res.status(400).json({ error: "amount>0" });
  const bal = balances[req.userId] || 0;
  if (bal < amt)         return res.status(400).json({ error: "insufficient" });

  /* 2️⃣ нужен привязанный адрес */
  const toAddr = addrMap[req.userId];
  if (!toAddr)           return res.status(400).json({ error: "no linked address" });

  /* 3️⃣ резервируем средства и пишем pending */
  balances[req.userId] = bal - amt;
  await saveBalances();

  const id = crypto.randomUUID();
  withdrawals.push({
    id, userId: req.userId, amount: amt, to: toAddr,
    ts: Date.now(), status: "pending"           // позже будет «sent» / «fail»
  });
  await saveWithdrawals();

  /* 4️⃣ финансовая история для пользователя */
  txs.push({ userId:req.userId, type:"withdraw", amount:amt, ts:Date.now() });
  await saveTx();

  res.json({ balance: balances[req.userId], wid: id });
});

/* POST /wallet/link { userId, address }  */
wallet.post('/link', async (req,res)=>{
  const {address} = req.body || {};
  if(!address) return res.status(400).json({error:'address required'});
  addrMap[req.userId] = address;
  await saveAddr();
  res.json({ ok:true, address });
});


 /* GET /wallet/history?userId=123&limit=30 */
wallet.get('/history', (req,res)=>{
  const lim = Math.min( Number(req.query.limit||50), 200);
  const list = txs
      .filter(t=>t.userId===req.userId)
      .slice(-lim)          // последние N
      .reverse();          // от нового к старому
  res.json(list);
});       

/* -------- WALLET TX helpers -------- */
let txs = [];   // [{userId,type,amount,ts,hash?}]
async function loadTx() {
  try{
    txs = JSON.parse(await fs.readFile(TX_FILE,'utf8'));
  }catch(e){ if (e.code!=="ENOENT") console.error(e); txs=[]; }
}
async function saveTx(){
  const tmp = TX_FILE+'.tmp';
  await fs.writeFile(tmp, JSON.stringify(txs,null,2));
  await fs.rename(tmp, TX_FILE);
}
// ─────────────────── Express / Socket.IO ───────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));   // раздаём фронт
app.get("/history", (req, res) => res.json(history));
app.use("/wallet", wallet);
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

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

  setTimeout(async () => {
      io.emit("spinEnd", {
      winner,
      total: game.totalUSD,
      seed: game.seed            // теперь раскрываем сид
     });

      /* ───────── начисляем приз (только TON) ───────── */
      const uid = String(winner.userId);
      if (uid) {
        /* считаем общий TON-банк: суммируем NFT-токены, id которых
           мы создавали вида  "ton-<ts>"  */
        const potTON = game.players.reduce((sum, p) =>
          sum +
          p.nfts
           .filter(n => n.id.startsWith("ton-"))
           .reduce((s, n) => s + n.price, 0)
        , 0);

        if (potTON > 0) {
          balances[uid] = (balances[uid] || 0) + potTON;
          await saveBalances();

          /* записываем prize-транзакцию */
          txs.push({
            userId : uid,
            type   : "prize",
            amount : potTON,
            ts     : Date.now()
          });
          await saveTx();
        }
      }
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

    await saveHistory();

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

socket.on("placeBet", ({ userId, name, nfts = [], tonAmount = 0 }) => {
  let player = game.players.find(p => p.userId === userId);
  if (!player) {
    player = {
      userId,
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

// ─────────── DEPOSIT WATCHER (Toncenter) ───────────
async function tonApi(method, params = {}) {
  const url = new URL(method, TON_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (TON_API_KEY) url.searchParams.set("api_key", TON_API_KEY);
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok && j.status !== 200) throw new Error(j.error || "Toncenter error");
  return j.result ?? j;
}

let lastLt = 0n;                         // сдвигаемся только вперёд

async function pollDeposits() {
  try {
    const txsList = await tonApi("getTransactions", {
      address: DEPOSIT_ADDR,
      limit: 20
    });

    for (const tx of txsList) {
      const lt   = BigInt(tx.transaction_id.lt);
      if (lt <= lastLt) break;          // всё старое уже учли

      const valueTon = Number(tx.in_msg.value) / 1e9;
      /* --- достаём текст комментария, как делает Toncenter --- */
      const bodyText =
        tx.in_msg.message                         // старые кошельки
        || tx.in_msg.msg_data?.text               // msg.dataText
        || ""; 

      if (bodyText.startsWith("uid:") && valueTon > 0) {

        const userId = bodyText.slice(4).trim();

        /* пропускаем, если уже записали этот hash */
        if (txs.some(t => t.hash === tx.transaction_id.hash)) continue;

        console.log(`➕ Deposit ${valueTon} TON from ${userId}`);
        balances[userId] = (balances[userId] || 0) + valueTon;
        await saveBalances();

        txs.push({
          userId,
          type:   "deposit",
          amount: valueTon,
          ts:     tx.utime * 1000,
          hash:   tx.transaction_id.hash
        });
        await saveTx();
      }

      lastLt = lt;
    }
  } catch (e) {
    console.error("pollDeposits:", e.message);
  } finally {
    setTimeout(pollDeposits, 15_000);   // каждые 15 с
  }
}


// ──────────────────────── Bootstrap ───────────────────────────
(async () => {
  await loadHistory();
  await loadBalances();
  await loadTx();
  await loadAddr();
  await loadWithdrawals();
  resetRound();      
  pollDeposits().catch(console.error);
  httpServer.listen(PORT, () => console.log("Jackpot server on", PORT));
})();
