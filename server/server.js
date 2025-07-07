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
import TonWeb from "tonweb";
import nacl from "tweetnacl";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { parse as parseCookie } from "cookie";
import {
  DATA_DIR,
  HISTORY_FILE,
  balances,
  txs,
  withdrawals,
  addrMap,
  loadHistory,
  saveHistory,
  loadBalances,
  saveBalances,
  loadTx,
  saveTx,
  loadWithdrawals,
  saveWithdrawals,
  loadAddr,
  saveAddr
} from "./storage.js";
import { wallet } from "./wallet.js";
import { apiLimiter, JWT_SECRET, JWT_LIFE, adminAuth } from "./utils.js";
dotenv.config();  

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────────────────────── Config & Disk ─────────────────────────
const PORT      = process.env.PORT || 3000;
const DEPOSIT_ADDR   = process.env.DEPOSIT_ADDR;
const TON_API        = process.env.TONCENTER_API || "https://toncenter.com/api/v2/";
const TON_API_KEY    = process.env.TONCENTER_KEY || "";
const HOT_PRIV_KEY   = process.env.HOT_PRIV_KEY;
const HOT_WALLET_TYPE= process.env.HOT_WALLET_TYPE || "v4r2";
if (!HOT_PRIV_KEY) throw new Error("HOT_PRIV_KEY not set");

const raw = TonWeb.utils.hexToBytes(
  HOT_PRIV_KEY.startsWith("0x") ? HOT_PRIV_KEY.slice(2) : HOT_PRIV_KEY
);

let keyPair;
if (raw.length === 32) {
  // Дан только seed → генерируем пару
  keyPair = nacl.sign.keyPair.fromSeed(raw);             // {publicKey, secretKey}
} else if (raw.length === 64) {
  // Дан уже secretKey (seed+pub) → вытаскиваем pub из второй половины
  keyPair = { secretKey: raw, publicKey: raw.slice(32) };
} else {
  throw new Error("HOT_PRIV_KEY должен быть 32- или 64-байтным hex");
}

const provider   = new TonWeb.HttpProvider(TON_API, {apiKey: TON_API_KEY});
const tonweb     = new TonWeb(provider);

/* выбираем класс кошелька без учёта регистра              */
const WalletClass = tonweb.wallet.all[HOT_WALLET_TYPE]   // v3R2, v4R2, …
   || tonweb.wallet.all.v4R2;               // второй элемент пары → сам класс

if (!WalletClass) {
  const supported = Object.keys(tonweb.wallet.all).join(", ");
  throw new Error(`Unsupported wallet type "${HOT_WALLET_TYPE}". Supported: ${supported}`);
}

const hotWallet  = new WalletClass(provider, { publicKey: keyPair.publicKey });

if (!DEPOSIT_ADDR) throw new Error("DEPOSIT_ADDR not set");

const palette = [
  '#fee440','#d4af37','#8ac926','#1982c4',
  '#ffca3a','#6a4c93','#d79a59','#218380'
];

// ─────────────────── Express / Socket.IO ───────────────────────
const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cookieParser());
// ---------- безопасный CORS ----------
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // запросы без Origin (curl, Postman) можно пускать
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      cb(new Error("CORS: origin blocked"));
    },
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());
app.use(express.static(__dirname));   // раздаём фронт
app.use(apiLimiter);  
// === LOGIN ===  (вызывается телеграм-клиентом один раз)
app.post("/auth/login", (req, res) => {
  /* Telegram должен подписывать userId — здесь минимальная проверка на число */
  const { userId } = req.body || {};
  if (!/^\d+$/.test(userId)) return res.status(400).json({ error: "bad userId" });

  const token = jwt.sign({ uid: String(userId) }, JWT_SECRET, {
    expiresIn: JWT_LIFE,
  });

  res
    .cookie("sid", token, {
      httpOnly : true,
      sameSite : "None",          // ← разрешаем отправлять с другого домена
      secure   : true,            // must-have для SameSite=None
      maxAge   : 1000*60*60*24*30
    })
    .json({ ok: true, token });
});
app.get("/history", (req, res) => res.json(history));
app.use("/wallet", wallet);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowed,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ───────────────────── Game state (1 round) ────────────────────
let game = {
  players: [],
  totalTON: 0,
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
  const ticket = rnd * game.totalTON;
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
    totalTON: 0,
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
  const sliceDeg = (winner.value / game.totalTON) * 360;
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
      total: game.totalTON,
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
  total:      game.totalTON,

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
// ─── admin-роуты ──────────────────────────
const admin = express.Router();
admin.use(adminAuth);

/* 1) Скачать history.json или конкретный backup
   GET /admin/history/download            – актуальный файл
   GET /admin/history/download?id=…bak    – бэкап по id           */
admin.get('/history/download', async (req, res) => {
  const id   = (req.query.id || '').trim();      // пусто ⇒ основной файл
  const file = path.join(DATA_DIR, id || 'history.json');

  try {
    await fs.access(file);        // убедимся, что файл существует
    res.download(file);
  } catch {
    res.sendStatus(404);
  }
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

app.use('/admin', admin);

// ───────────────────── Socket handlers ─────────────────────────
io.use((socket, next) => {
  try {
    const cookies = parseCookie(socket.handshake.headers.cookie || "");
    const token = cookies.sid || socket.handshake.auth?.token;
    if (!token) return next(new Error("auth"));
    const { uid } = jwt.verify(token, JWT_SECRET);
    socket.userId = uid;
    next();
  } catch {
    next(new Error("auth"));
  }
});

io.on("connection", socket => {
  socket.emit("state", game);

socket.on("placeBet", async ({ name, nfts = [], tonAmount = 0 }) => {
  const userId = socket.userId;
  // 0) базовая валидация
  tonAmount = Number(tonAmount) || 0;
  if (tonAmount < 0) tonAmount = 0;          // защита от отрицательных

  /* 1) проверяем и списываем TON-баланс */
  if (tonAmount > 0) {
    const bal = balances[userId] || 0;
    if (bal < tonAmount) {
      socket.emit("err", "insufficient");
      return;
    }
    balances[userId] = bal - tonAmount;
    await saveBalances();

    txs.push({
      userId,
      type:   "bet",
      amount: tonAmount,
      ts:     Date.now()
    });
    await saveTx();

    // оформляем TON как «виртуальный NFT-токен», чтобы логика колеса не менялась
    nfts.push({
      id:   `ton-${Date.now()}`,
      img:  "https://pbs.twimg.com/profile_images/1602985148219260928/VC-Mraev_400x400.jpg",
      price: tonAmount
    });
  }
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
  // итоговая стоимость ставки (NFT-ы уже содержат TON-токен, если он был)
  const betValue = nfts.reduce((s, x) => s + x.price, 0);

  player.value  += betValue;
  game.totalTON += betValue;
  nfts.forEach(x => player.nfts.push(x));

  io.emit("state", game);
  maybeStartCountdown();
});

});

// ─────────── DEPOSIT WATCHER (Toncenter) ───────────
async function tonApi(method, params = {}) {
  /* === sendBoc должен идти POST-ом в тело! === */
  if (method === 'sendBoc') {
    const r = await fetch(TON_API + 'sendBoc', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        boc     : params.boc,
        api_key : TON_API_KEY || undefined
      })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'TonCenter error');
    return j.result ?? j;
  }

  /* остальные методы – как и раньше, GET */
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

// ─────────────── globals ────────────────
let nextSeqno = Number(await hotWallet.methods.seqno().call()); // актуальный на старте
let sending   = false;                                          // «замок»

// каждые 5 с проверяем очередь
setInterval(processWithdrawals, 5_000);

// ─────────────────────────────────────────
//  processWithdrawals — единственная точка,
//  где мы реально шлём деньги из hot-кошелька
// ─────────────────────────────────────────
async function processWithdrawals() {
  if (sending) return;
  sending = true;

  try {
    while (true) {                       // обработаем сразу все ожидания
      const w = withdrawals.find(x => x.status === 'pending');
      if (!w) break;                     // очередь пуста

      // 1. seqno
      const chainSeqno = Number(await hotWallet.methods.seqno().call());
      if (chainSeqno > nextSeqno) nextSeqno = chainSeqno;

      // 2. формируем перевод
      const transfer = hotWallet.methods.transfer({
        secretKey : keyPair.secretKey,
        toAddress : w.to,
        amount    : TonWeb.utils.toNano(String(w.amount)),
        seqno     : nextSeqno,
        sendMode  : 3
      });

     const cell   = await transfer.getQuery();
     const boc    = TonWeb.utils.bytesToBase64(await cell.toBoc(false));

      // 3. отправляем
      await tonApi('sendBoc', { boc });
      console.log(`✅ ${w.id}: seqno ${nextSeqno} → ${w.to} (${w.amount} TON)`);

      // 4. отмечаем
      w.txHash = boc.slice(0, 16);
      w.status = 'sent';
      w.seqno  = nextSeqno;
      nextSeqno += 1;
      await saveWithdrawals();
    }

  } catch (err) {
    const txt = String(err);
    if (txt.includes('exit code 33') || txt.includes('duplicate')) {
      console.log('ℹ️ дубликат seqno — увеличиваем счётчик');
      nextSeqno += 1;
    } else {
      console.error('processWithdrawals:', err);
      const wpend = withdrawals.find(x => x.status === 'pending');
      if (wpend) {
        wpend.status = 'fail';
        wpend.error  = txt.slice(0, 150);
        wpend.seqno  = nextSeqno;
        await saveWithdrawals();
      }
    }
  } finally {
    sending = false;               // обязательно снимаем «замок»
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
