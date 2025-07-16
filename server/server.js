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
import rateLimit from "express-rate-limit";
import { parse as parseCookie } from "cookie";
import createAdminRouter from "./adminRoutes.js";
dotenv.config();  

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────────────────────── Config & Disk ─────────────────────────
const PORT      = process.env.PORT || 3000;
const DATA_DIR  = process.env.DATA_DIR || "/data";  // ← mountPath in Render disk
const DEPOSIT_ADDR   = process.env.DEPOSIT_ADDR;
const TON_API        = process.env.TONCENTER_API || "https://toncenter.com/api/v2/";
const TON_API_KEY    = process.env.TONCENTER_KEY || "";
const HOT_PRIV_KEY   = process.env.HOT_PRIV_KEY;
const HOT_WALLET_TYPE= process.env.HOT_WALLET_TYPE || "v4r2";
if (!HOT_PRIV_KEY) throw new Error("HOT_PRIV_KEY not set");

// ───── L I M I T S ─────────────────────────────────────────────
// Можно переопределить через переменные окружения
const MIN_DEPOSIT           = Number(process.env.MIN_DEPOSIT          || 0.1); // ≥0.1 TON
const MIN_WITHDRAW          = Number(process.env.MIN_WITHDRAW         || 0.5); // ≥0.5 TON
const WITHDRAW_RATE_LIMIT   = Number(process.env.WITHDRAW_RATE_LIMIT  || 2);   // ≤2 вывода/мин/UID

/* ───── COMMISSION ───────────────────────────────────────────────
   Процент сервиса, удерживаемый ТОЛЬКО с TON-ставок других игроков,
   т.е. победитель всегда получает свою собственную ставку целиком.  
   Значение читается из env-переменной COMMISSION_RATE (0…1).
   По умолчанию 5 % (0.05).                                         */
const COMMISSION_RATE = Math.min(
  Math.max(Number(process.env.COMMISSION_RATE ?? 0.05), 0),
  1
);

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

const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const BALANCES_FILE = path.join(DATA_DIR, "balances.json");
const TX_FILE       = path.join(DATA_DIR, "transactions.json");
const WD_FILE       = path.join(DATA_DIR, "withdrawals.json"); 
const GIFTS_FILE    = path.join(DATA_DIR, "gifts.json"); 

/* === 25 Stars за вывод подарка === */
const STARS_PRICE      = 25;               // фикс цена
const BOT_TOKEN        = process.env.APP_BOT_TOKEN;   // тот же, что у листенера
if (!BOT_TOKEN) throw new Error("APP_BOT_TOKEN not set");

/* для createInvoiceLink */
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const ADDR_FILE = path.join(DATA_DIR, "addresses.json");
const DEPOSIT_LIMIT = Number(process.env.DEPOSIT_LIMIT || 100);
let addrMap = {};           // { [userId]: "EQB…" }
let gifts   = [];           // { gid, ownedId, name, price, img, ownerId, staked }

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


const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not set');

/* ───── JWT ───── */
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in environment (process.env.JWT_SECRET)");
}
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_LIFE   = "30d";  // Время жизни токена

/* ───── RATE-LIMIT (от  DoS/брут/спама) ──── */
const apiLimiter = rateLimit({
  windowMs: 60_000,   // 1 минута
  max     : 60,       // ≤60 запросов/мин с одного IP
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
    const txt  = await fs.readFile(HISTORY_FILE, "utf8");
    const data = JSON.parse(txt);

    /* ✅  НЕ переопределяем переменную, а мутируем массив.
       Admin-роутер получил ссылку на history ещё до bootstrap-а,
       поэтому ссылка должна остаться той же, иначе он «не видит»
       новые данные и возвращает нули.                              */
    history.length = 0;
    history.push(...data);

    console.log(`Loaded ${history.length} history records.`);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("History read error:", e);
    history.length = 0;            // оставляем прежнюю ссылку, просто чистим
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
    const txt  = await fs.readFile(BALANCES_FILE, "utf8");
    const data = JSON.parse(txt);

    /* ⭕ Сохраняем исходную ссылку, чтобы admin-роутер,
       получивший её ДО bootstrap-а, видел актуальные данные. */
    Object.assign(balances, data);          // мутация вместо присваивания
    console.log("Loaded balances:", balances);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Balances read error:", e);
    /* чистим, но не меняем объект */
    for (const k of Object.keys(balances)) delete balances[k];
  }
}
async function saveBalances() {
  const tmp = BALANCES_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(balances, null, 2));
  await fs.rename(tmp, BALANCES_FILE);
}

function userAuth(req, res, next) {
  try {
    const token =
      req.cookies?.sid || (req.get("Authorization") || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "no token" });
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}

/* pending withdrawals  [{id,userId,amount,to,ts,status}] */
let withdrawals = [];
async function loadWithdrawals() {
  try {
    const data = JSON.parse(await fs.readFile(WD_FILE, "utf8"));
    withdrawals.length = 0;
    withdrawals.push(...data);
  } catch (e) {
    if (e.code !== "ENOENT") console.error(e);
    withdrawals.length = 0;
  }
}
async function saveWithdrawals() {
  const tmp = WD_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(withdrawals, null, 2));
  await fs.rename(tmp, WD_FILE); 
}   
// ---------- GIFTS ----------
async function loadGifts() {
  try { gifts = JSON.parse(await fs.readFile(GIFTS_FILE, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") console.error(e); gifts = []; }
}
async function saveGifts() {
  const tmp = GIFTS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(gifts, null, 2));
  await fs.rename(tmp, GIFTS_FILE);
}
const wallet = express.Router();
wallet.use(apiLimiter, userAuth);   // защита и для JWT-роутов

/* GET /wallet/balance?userId=123 */
wallet.get("/balance", (req, res) => {
  const bal = balances[req.userId] || 0;
  res.json({ balance: bal });
});

/* GET /wallet/gifts  — список НЕ поставленных подарков */
wallet.get("/gifts", (req, res) => {
  res.json(gifts.filter(g => g.ownerId === req.userId && !g.staked));
});

/* POST /wallet/withdrawGift { ownedId } ➋ */
wallet.post("/withdrawGift", async (req, res) => {
  const { ownedId } = req.body || {};
  const gift = gifts.find(
    g => g.ownedId === ownedId && g.ownerId === req.userId && !g.staked
  );
  if (!gift) return res.status(404).json({ error: "gift not found" });

  /* если уже ждём оплату — возвращаем прежний link */
  if (gift.status === "pending_withdraw" && gift.invoiceLink)
    return res.json({ link: gift.invoiceLink });

  try {
    const link = await createStarsInvoice(req.userId, ownedId);
    gift.status      = "pending_withdraw";
    gift.invoiceLink = link;
    await saveGifts();
    res.json({ link });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



/* POST /wallet/withdraw { userId, amount } */
wallet.post("/withdraw", async (req, res) => {
  const amt = Number(req.body.amount);

  /* 1️⃣ базовые проверки */
  // ➊ Минимальная сумма вывода
  if (!amt || amt < MIN_WITHDRAW)
    return res.status(400).json({ error: `min ${MIN_WITHDRAW} TON` });

  // ➋ Rate-limit: не более 2 выводов за последние 60 с
  const now = Date.now();
  const recent = withdrawals.filter(
    w => w.userId === req.userId && now - w.ts < 60_000
  );
  if (recent.length >= WITHDRAW_RATE_LIMIT)
    return res.status(429).json({ error: "rate limit: 2 withdrawals/min" });
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

  txs.push({
    userId : req.userId,
    type   : "withdraw",
    amount : amt,
    ts     : Date.now(),
    status : "pending",
    wid    : id 
  });
  await saveTx();

  res.json({ balance: balances[req.userId], wid: id });
});

/* --- helper: создаём инвойс Stars (с payload вида "withdraw:<ownedId>") --- */
async function createStarsInvoice(userId, ownedId) {
  const payload = `withdraw:${ownedId}`;
  const body = {
    title              : "Вывод подарка",
    description        : "Комиссия за вывод подарка в Telegram",
    payload,
    provider_token     : "STARS",      // спец‑токен Stars
    currency           : "STARS",
    prices             : [{ label: "Вывод", amount: STARS_PRICE * 100 }],
    need_name          : false,
    need_email         : false,
    max_tip_amount     : 0,
  };
  const r = await fetch(`${TG_API}/createInvoiceLink`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify(body),
  }).then(x => x.json());
  if (!r.ok) throw new Error(r.description || "invoice error");
  return r.result;
}

/* POST /wallet/link { userId, address }  */
wallet.post('/link', async (req,res)=>{
  const {address} = req.body || {};
  if(!address) return res.status(400).json({error:'address required'});
  /* TON-адреса бывают двух типов:
     ① base64url (48-49 симв., без «=»)
     ② raw-hex с workchain: «0:<64hex>» или «-1:<64hex>»
     Принимаем оба варианта.                                */
  if(!/^([A-Za-z0-9_\-]{48,49}|-?0:[0-9a-fA-F]{64})$/.test(address))
    return res.status(400).json({error:'bad address'});
  addrMap[req.userId] = address;
  await saveAddr();
  res.json({ ok:true, address });
});


 /* GET /wallet/history?limit=30 */
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
  try {
    const data = JSON.parse(await fs.readFile(TX_FILE, "utf8"));
    txs.length = 0;
    txs.push(...data);
  } catch(e) {
    if (e.code !== "ENOENT") console.error(e);
    txs.length = 0;
  }
}
async function saveTx(){
  const tmp = TX_FILE+'.tmp';
  await fs.writeFile(tmp, JSON.stringify(txs,null,2));
  await fs.rename(tmp, TX_FILE);
}
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
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));
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
// === INTERNAL: получить новый подарок ===
app.post("/internal/receiveGift", adminAuth, async (req, res) => {
  const { gid, ownedId, name, price, img, ownerId } = req.body || {};
  if (!gid || !ownedId || !ownerId) return res.status(400).json({ error: "bad gift" });
  if (gifts.some(g => g.ownedId === ownedId)) return res.json({ ok: true }); // дубль
  gifts.push({ gid, ownedId, name, price, img, ownerId, staked: false });
  await saveGifts();
  res.json({ ok: true });
});

/* ───────── Stars‑webhook: платеж подтверждён ───────── */
app.post("/internal/withdrawGiftPaid", adminAuth, async (req, res) => {
  const { ownedId, payerId } = req.body || {};

  /* ищем подарок владельца, который ждёт вывод */
  const gift = gifts.find(
    (g) => g.ownedId === ownedId && g.ownerId === String(payerId)
  );
  if (!gift || gift.status !== "pending_withdraw")
    return res.status(400).json({ error: "gift not pending" });

  /* помечаем как «sent» — бот уже отправил его пользователю */
  gift.status = "sent";
  await saveGifts();
  res.json({ ok: true });
});

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
        /* 1) Общий TON-банк текущего раунда */
        const potTON = game.players.reduce(
          (sum, p) =>
            sum +
            p.nfts
              .filter(n => n.id.startsWith("ton-"))
              .reduce((s, n) => s + n.price, 0),
          0
        );

        if (potTON > 0) {
          /* 2) TON, внесённый победителем лично */
          const winnerStake = winner.nfts
            .filter(n => n.id.startsWith("ton-"))
            .reduce((s, n) => s + n.price, 0);

          /* 3) TON других игроков – только с него берём комиссию */
          const othersStake = potTON - winnerStake;

          const commission = othersStake * COMMISSION_RATE;   // 0, если играл один
          const payout     = potTON - commission;            // сумма, уходящая победителю

          /* 4) Увеличиваем баланс победителя */
          balances[uid] = (balances[uid] || 0) + payout;

          /* 5) Накапливаем комиссию на спец-счёте '__service__'
                (можно выводить админ-роутом точно так же, как пользователи) */
          balances.__service__ = (balances.__service__ || 0) + commission;
          await saveBalances();

          /* записываем prize-транзакцию */
          txs.push({
            userId : uid,
            type   : "prize",
            amount : payout,
            ts     : Date.now()
          });
          /* отдельная запись о комиссии (пригодится для учёта) */
          if (commission > 0) {
            txs.push({
              userId : "__service__",
              type   : "commission",
              amount : commission,
              ts     : Date.now()
            });
          }
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
function adminAuth(req, res, next) {
  const token = req.get('X-Admin-Token');
  if (token !== ADMIN_TOKEN) return res.sendStatus(403);
  next();
}
/* ───── Admin router (вынесен) ───── */
app.use(
  "/admin",
  createAdminRouter({
    /* базовое */
    ADMIN_TOKEN,
    HISTORY_FILE,
    history,
    saveHistory,
    /* TON & балансы/транзакции */
    balances,
    saveBalances,
    txs,
    saveTx,
    withdrawals,
    saveWithdrawals,
  })
);

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
  // 1) Берём подарки из серверного хранилища ---------------------
  nfts = nfts.map(obj => {
    const g = gifts.find(x => x.ownedId === obj.id && x.ownerId === userId && !x.staked);
    if (g) { g.staked = true; }           // помечаем занятыми
    return obj;
  });
  await saveGifts();

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
  // пропускаем undefined / null – API TonCenter этого не любит
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  if (TON_API_KEY) url.searchParams.set("api_key", TON_API_KEY);
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok && j.status !== 200) throw new Error(j.error || "Toncenter error");
  return j.result ?? j;
}

let lastLt = 0n;                         // сдвигаемся только вперёд

async function pollDeposits() {
  try {
    let ltCursor;                       // постранично вперёд
    while (true) {
      const page = await tonApi("getTransactions", ltCursor
        ? { address: DEPOSIT_ADDR, limit: DEPOSIT_LIMIT, lt: ltCursor }
        : { address: DEPOSIT_ADDR, limit: DEPOSIT_LIMIT }
      );

      for (const tx of page) {
        const lt = BigInt(tx.transaction_id.lt);
        if (lt <= lastLt) { ltCursor = null; break; }   // дошли до старых

        const valueTon = Number(tx.in_msg.value) / 1e9;
        // ⛔ Отбрасываем всё, что меньше минимального депозита
        if (valueTon < MIN_DEPOSIT) continue;
        const bodyText = tx.in_msg.message || tx.in_msg.msg_data?.text || "";

        if (bodyText.startsWith("uid:") && valueTon > 0) {
          const userId = bodyText.slice(4).trim();

          // дубликаты по hash
          if (txs.some(t => t.hash === tx.transaction_id.hash)) continue;

          console.log(`➕ Deposit ${valueTon} TON from ${userId}`);
          balances[userId] = (balances[userId] || 0) + valueTon;
          await saveBalances();

          txs.push({
            userId,
            type  : "deposit",
            amount: valueTon,
            ts    : tx.utime * 1000,
            hash  : tx.transaction_id.hash
          });
          await saveTx();
        }

        lastLt = lt;
      }

      if (ltCursor === null || page.length < DEPOSIT_LIMIT) break;
      ltCursor = page.at(-1).transaction_id.lt;         // следующая страница
    }
  } catch (e) {
    console.error("pollDeposits:", e.message);
  } finally {
    setTimeout(pollDeposits, 15_000);   // каждые 15 с
  }
}

// ─────────────── globals ────────────────
// Локальный счётчик последовательности. Берём стартовое значение из сети,
// а дальше доверяем самому себе — так мы не зависим от «запаздывающего»
// ответа Toncenter и не посылаем два сообщения с одним seqno.
let nextSeqno = Number(await hotWallet.methods.seqno().call());
let sending   = false;                                          // «замок»

// каждые 5 с проверяем очередь
setInterval(processWithdrawals, 5_000);

// ─────────────────────────────────────────
//  processWithdrawals — единственная точка,
//  где мы реально шлём деньги из hot-кошелька
// ─────────────────────────────────────────
async function waitSeqnoChange(oldSeqno, timeout = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = Number(await hotWallet.methods.seqno().call());
    if (s > oldSeqno) return s;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`seqno ${oldSeqno} not confirmed in ${timeout} ms`);
}

async function processWithdrawals() {
  if (sending) return;                  // защита от параллельных запусков
  sending = true;
  let w, txRec;                         // нужны и в catch
  try {
    w = withdrawals.find(x => x.status === 'pending');
    if (!w) return;
    txRec = txs.find(t => t.wid === w.id);

    /* 1️⃣  синхронизируемся, если кто-то тратил кошелёк вручную */
    const chainSeqno = Number(await hotWallet.methods.seqno().call());
    if (chainSeqno > nextSeqno) nextSeqno = chainSeqno;

    /* 2️⃣  резервируем локальный seqno именно для ЭТОЙ выплаты */
    const mySeq = nextSeqno;

    /* 3️⃣  формируем транзакцию */
    const transfer = hotWallet.methods.transfer({
      secretKey : keyPair.secretKey,
      toAddress : w.to,
      amount    : TonWeb.utils.toNano(String(w.amount)),
      seqno     : mySeq,
      sendMode  : 3
    });
    const cell = await transfer.getQuery();
    const boc  = TonWeb.utils.bytesToBase64(await cell.toBoc(false));

    /* 4️⃣  отправляем BOC */
    await tonApi('sendBoc', { boc });
    console.log(`✅ ${w.id}: seqno ${mySeq} → ${w.to} (${w.amount} TON)`);

    /* 5️⃣  ждём, пока seqno увеличится в сети → транзакция принята */
    await waitSeqnoChange(mySeq);
    nextSeqno = mySeq + 1;              // бронируем следующий

    /* 6️⃣  помечаем вывод успешным */
    w.txHash = boc.slice(0, 16);
    w.status = 'sent';
    w.seqno  = mySeq;
    await saveWithdrawals();

    if (txRec) {
      txRec.status = 'sent';
      txRec.hash   = w.txHash;
      await saveTx();
    }

  } catch (err) {
    const txt = String(err);

    /* exit code 33 / duplicate — seqno уже использован.
       Сдвигаемся вперёд и оставляем вывод pending. */
    if (txt.includes('exit code 33') || txt.includes('duplicate')) {
      console.log('ℹ️  seqno duplicate, увеличиваем nextSeqno и повторим позже');
      nextSeqno += 1;
    } else {
      console.error('processWithdrawals:', err);
      if (w) {
        /* возвращаем деньги пользователю */
        balances[w.userId] = (balances[w.userId] || 0) + w.amount;
        await saveBalances();

        w.status = 'fail';
        w.error  = txt.slice(0, 150);
        w.seqno  = nextSeqno;
        await saveWithdrawals();

        if (txRec) {
          txRec.status = 'fail';
          txRec.error  = w.error;
          await saveTx();
        }
      }
    }
  } finally {
    sending = false;
  }
}

// ──────────────────────── Bootstrap ───────────────────────────
(async () => {
  await loadHistory();
  await loadBalances();
  await loadTx();
  await loadAddr();
  await loadWithdrawals();
  await loadGifts(); 
  resetRound();      
  pollDeposits().catch(console.error);
  httpServer.listen(PORT, () => console.log("Jackpot server on", PORT));
})();
