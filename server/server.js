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
import { URLSearchParams } from "url"; 
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
const MIN_TON_BET           = Number(process.env.MIN_TON_BET          || 0.1); // ≥0.1 TON для ставки

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
const FLOORS_FILE   = path.join(DATA_DIR, "thermos_floors.json");   // кеш Thermos
const MODEL_FLOORS_FILE = path.join(DATA_DIR, "thermos_model_floors.json"); // кеш моделей внутри коллекций
const GIFT_XFER_FILE= path.join(DATA_DIR, "gift_transfers.json");

/* ─── Helpers: нормализация и дедуп подарков ─── */
function normalizeGift(g = {}) {
  return {
    ...g,
    ownedId: String(g?.ownedId ?? "").trim(),
    ownerId: String(g?.ownerId ?? "").trim(),
  };
}
function dedupeAndNormalizeGifts(arr = []) {
  const seen = new Set();
  const out  = [];
  for (const raw of arr) {
    const g = normalizeGift(raw);
    if (g.ownedId && !seen.has(g.ownedId)) {
      seen.add(g.ownedId);
      out.push(g);
    }
  }
  return out;
}
   
/* === 25 Stars за вывод подарка === */
const STARS_PRICE      = 25;               // фикс цена
const BOT_TOKEN        = process.env.APP_BOT_TOKEN; 
if (!BOT_TOKEN) throw new Error("APP_BOT_TOKEN not set");
/* === Альтернатива: TON-комиссия за вывод подарка === */
const GIFT_WITHDRAW_TON_FEE = Number(process.env.GIFT_WITHDRAW_TON_FEE || 0.1);

/* для createInvoiceLink */
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const ADDR_FILE = path.join(DATA_DIR, "addresses.json");
const DEPOSIT_LIMIT = Number(process.env.DEPOSIT_LIMIT || 100);
let addrMap = {};           // { [userId]: "EQB…" }
const gifts = [];           // { gid, ownedId, name, price, img, ownerId, staked }

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
  try {
    const raw = JSON.parse(await fs.readFile(GIFTS_FILE, "utf8"));
    const norm = dedupeAndNormalizeGifts(Array.isArray(raw) ? raw : []);
    gifts.length = 0;                  // сохраняем ссылку
    gifts.push(...norm);
  } catch (e) {
    if (e.code !== "ENOENT") console.error(e);
    gifts.length = 0;        // очищаем, но не пересоздаём
  }
}
async function saveGifts() {
  const tmp = GIFTS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(gifts, null, 2));
  await fs.rename(tmp, GIFTS_FILE);
}

/* ---------- QUEUE: gift transfers (TON-paid) ---------- */
let giftTransfers = []; // [{id,userId,ownedIds,ts,status:'queued'|'working'|'done'|'fail', leaseTs?}]
async function loadGiftTransfers(){
  try { giftTransfers = JSON.parse(await fs.readFile(GIFT_XFER_FILE,'utf8')); }
  catch(e){ if(e.code!=='ENOENT') console.error(e); giftTransfers=[]; }
}
async function saveGiftTransfers(){
  const tmp = GIFT_XFER_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(giftTransfers,null,2));
  await fs.rename(tmp, GIFT_XFER_FILE);
}
function reclaimLeases(){
  const now = Date.now();
  let changed=false;
  giftTransfers.forEach(j=>{
    if (j.status==='working' && j.leaseTs && now - j.leaseTs > 3*60_000){ j.status='queued'; j.leaseTs=null; changed=true; }
  });
  if (changed) saveGiftTransfers().catch(console.error);
}
setInterval(reclaimLeases, 30_000);

const wallet = express.Router();
wallet.use(apiLimiter, userAuth);   // защита и для JWT-роутов

/* GET /wallet/balance?userId=123 */
wallet.get("/balance", (req, res) => {
  const bal = balances[req.userId] || 0;
  res.json({ balance: bal });
});

/* GET /wallet/gifts  — список НЕ поставленных подарков (цены в TON) */
wallet.get("/gifts", async (req, res) => {
  try {
    /* ① Коллекционные floor-цены */
    const floors = await ensureFloorsFresh();
    const map = floors?.collections || {};

    /* ② Готовим список коллекций пользователя, чтобы сразу
          подтянуть floor-цены **по моделям**                */
    const wantNames  = new Set();
    const keyToName  = {};
    gifts.forEach(g => {
      const k   = normalizeKey(g.name || "");
      const rec = map[k];
      if (rec?.name) {
        keyToName[k] = rec.name;      // cache key → «Human Name»
        wantNames.add(rec.name);
      }
    });
    await ensureModelFloorsForCollections([...wantNames]);

    // показываем все НЕ отправленные и не staked подарки, включая pending_withdraw
    const out = gifts
      .filter(g =>
        g.ownerId === req.userId &&
        !g.staked &&
        g.status !== "sent"
      )
      .map(g => {
        const key       = normalizeKey(g.name || "");
        const colName   = keyToName[key];            // «DeskCalendar», «Plush Pepe» …
        const modelKey  = normalizeKey(modelLabelFromGiftObj(g));

        /* ── приоритет: floor по модели → floor по коллекции ── */
        let modelFloorTon = 0;
        if (colName) {
          const models   = thermosModelFloors.byCollection[colName]?.models || {};
          modelFloorTon  = Number(models[modelKey]?.floorTon || 0);
        }
        const collFloorTon = Number(map[key]?.floorTon || 0);
        const floorTon     = modelFloorTon > 0 ? modelFloorTon : collFloorTon;

        const priceTon = floorTon > 0 ? floorTon : 0;
        return {
          gid     : g.gid,
          ownedId : g.ownedId,
          name    : g.name,
          price   : priceTon,   // ← всегда TON
          img     : g.img,
          status  : g.status || "idle"
        };
      });
    res.json(out);
  } catch (e) {
    console.error("/wallet/gifts:", e);
    res.status(500).json({ error: "gifts fetch failed" });
  }
});

/* POST /wallet/withdrawGift { ownedId } ➋ */
wallet.post("/withdrawGift", async (req, res) => {
  const { ownedIds, ownedId, method } = req.body || {};
  const raw    = ownedIds ?? (ownedId ? [ownedId] : []);
  const ids    = Array.isArray(raw) ? raw : [raw];
  if (!ids.length) return res.status(400).json({ error: "no gifts" });

  /* валидация всех подарков */
  const batch = ids.map(id =>
    gifts.find(g => g.ownedId === id && g.ownerId === req.userId && !g.staked)
  );
  if (batch.some(g => !g))
    return res.status(404).json({ error: "some gifts not found" });
  // ── Новый метод: списание TON с внутреннего баланса ──────────
  if ((method || "stars") === "ton") {
    try{
      const count = ids.length;
      const charge = GIFT_WITHDRAW_TON_FEE * count;
      const bal = Number(balances[req.userId] || 0);
      if (bal < charge) return res.status(400).json({ error: "insufficient balance" });

      // списываем с пользователя и начисляем «сервису»
      balances[req.userId] = bal - charge;
      balances.__service__ = (balances.__service__ || 0) + charge;
      await saveBalances();

      // транзакции учёта
      txs.push({
        userId : req.userId,
        type   : "gift_withdraw_fee",
        amount : charge,
        ts     : Date.now(),
        meta   : { count }
      });
      txs.push({
        userId : "__service__",
        type   : "gift_withdraw_income",
        amount : charge,
        ts     : Date.now(),
        meta   : { payer: String(req.userId), count }
      });
      await saveTx();

      // помечаем как ожидающие отправки складом
      const now = Date.now();
      batch.forEach(g => { g.status = "queued_transfer"; g.ts = now; delete g.invoiceLink; });
      await saveGifts();
      // создаём/добавляем задание на отправку
      const jobId = crypto.randomUUID();
      giftTransfers.push({ id: jobId, userId: String(req.userId), ownedIds: ids, ts: now, status: 'queued' });
      await saveGiftTransfers();

      ids.forEach(ownedId => io.to("u:" + req.userId).emit("giftUpdate", { ownedId, status: "queued_transfer" }));
      return res.json({ ok:true, balance: balances[req.userId], jobId });
    }catch(e){
      return res.status(500).json({ error: String(e) });
    }
  }


  try {
    const link = await createStarsInvoice(req.userId, ids);

    batch.forEach(g => {
      g.status      = "pending_withdraw";
      g.ts          = Date.now();
      g.invoiceLink = link;
    });
    await saveGifts();

    ids.forEach(ownedId =>
      io.to("u:" + req.userId).emit("giftUpdate", {
        ownedId,
        status: "pending_withdraw"
      })
    );

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

/* --- helper: создаём инвойс Stars (одним чеком на все выбранные подарки) --- */
async function createStarsInvoice(userId, ownedIds) {
  const ids   = Array.isArray(ownedIds) ? ownedIds : [ownedIds];
  const count = ids.length;
  const total = STARS_PRICE * count;          // общая сумма XTR (целые звёзды)

  // Бэкенд бота ожидает список id именно в payload → передаём все через запятую.
  const payload = `withdraw:${ids.join(",")}`;

  // Метаданные — необязательно, но удобно (бот может использовать при логировании).
  const providerData = JSON.stringify({
    kind: "withdraw",
    user: String(userId),
    count,
    total,
    ids
  });

  const body = {
    title          : "Вывод подарков",
    description    : `Комиссия за вывод ${count} NFT-подарк${count === 1 ? "а" : count < 5 ? "а" : "ов"}`,
    payload,
    provider_token : "STARS",
    currency       : "XTR",
    prices         : [{ label: `Вывод ×${count}`, amount: total }],
    provider_data  : providerData,
    need_name      : false,
    need_email     : false,
    max_tip_amount : 0
  };

  const r = await fetch(`${TG_API}/createInvoiceLink`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify(body)
  }).then(res => res.json());

  if (!r.ok) throw new Error(r.description || "invoice error");
  return r.result; // invoiceLink
}

/* ─── AUTO‑RESET for stale pending_withdraw ─────────────────── */
function cleanupPendingGifts() {
  const now   = Date.now();
  const limit = 10 * 60_000;                // 10 минут
  let changed = false;

  gifts.forEach(g => {
    if (g.status === "pending_withdraw" && now - (g.ts || 0) > limit) {
      g.status = "idle";
      delete g.invoiceLink;
      changed = true;
      /* уведомляем владельца в реальном времени */
      io.to("u:" + g.ownerId).emit("giftUpdate", {
        ownedId: g.ownedId,
        status : "idle"
      });
    }
  });

  if (changed) saveGifts().catch(console.error);
}
setInterval(cleanupPendingGifts, 60_000);    // проверяем раз в минуту


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
// ---------- CORS (должен быть ПЕРВЫМ) ----------
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s=>s.trim()).filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);              // curl / Postman
    if (allowed.includes(origin)) return cb(null, true);
    cb(new Error("CORS: origin blocked"));
  },
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));           // ①
app.options("*", cors(corsOptions));  // ②  отвечаем на pre‑flight БЕЗ auth

// ──────────────── Body-parsers ────────────────
// Если фронт вдруг шлёт запрос без `Content-Type: application/json`,
// Express не разбирает тело и `req.body` остаётся пустым.
// Добавляем поддерж­ку form-urlencoded и raw-text *до* json-парсера,
// чтобы /auth/login корректно обрабатывал любые варианты.
app.use(express.urlencoded({ extended: false }));
app.use(express.text());

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cookieParser());
app.use(express.json());
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));
app.use(apiLimiter);  

// ─────────── Thermos floors proxy (cache) ───────────
const THERMOS_PROXY = "https://proxy.thermos.gifts/api/v1";
const FLOORS_TTL_MS = 5 * 60_000; // 5 минут
const MODEL_FLOORS_TTL_MS = 5 * 60_000; // 5 минут для моделей

function normalizeKey(s=""){
  return String(s).toLowerCase().replace(/[^a-z]+/g,"");
}

// Извлекаем «человеческое» имя модели из g.gid или, если его нет, из g.name
function modelLabelFromGiftObj(g = {}) {
  const raw = String(g?.gid || "");
  const m = raw.match(/name=['"]([^'"]+)['"]/i);
  if (m) return m[1];
  if (raw) return raw;                                    // ← главный фикс
  return (String(g?.name || "").split("-")[0] || "").trim();
}

let thermosFloorsCache = { fetchedAt: 0, collections: {} }; // { key: { name, floorTon } }
let thermosModelFloors = { byCollection: {} };

async function loadFloorsCacheFromDisk(){
  try{
    const j = JSON.parse(await fs.readFile(FLOORS_FILE,'utf8'));
    if (j && j.collections) thermosFloorsCache = j;
  }catch(e){ if (e.code!=="ENOENT") console.error("FLOORS read:", e.message); }
}
async function saveFloorsCacheToDisk(){
  const tmp = FLOORS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(thermosFloorsCache,null,2));
  await fs.rename(tmp, FLOORS_FILE);
}

async function loadModelFloorsCacheFromDisk(){
  try{
    const j = JSON.parse(await fs.readFile(MODEL_FLOORS_FILE,'utf8'));
    if (j && j.byCollection) thermosModelFloors = j;
  }catch(e){ if (e.code!=="ENOENT") console.error("MODEL_FLOORS read:", e.message); }
}
async function saveModelFloorsCacheToDisk(){
  const tmp = MODEL_FLOORS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(thermosModelFloors,null,2));
  await fs.rename(tmp, MODEL_FLOORS_FILE);
}


async function fetchThermosCollections(){
  const r = await fetch(`${THERMOS_PROXY}/collections`, { timeout: 10_000 });
  if(!r.ok) throw new Error("thermos collections http "+r.status);
  const arr = await r.json(); // [{ name, image_url, stats:{count, floor:"nanoton"} }, ...]
  const map = {};
  for(const col of arr || []){
    const key = normalizeKey(col.name);
    const floorNano = BigInt(col?.stats?.floor ?? "0");
    const floorTon  = Number(floorNano) / 1e9;
    map[key] = { name: col.name, floorTon };
  }
  thermosFloorsCache = { fetchedAt: Date.now(), collections: map };
  await saveFloorsCacheToDisk();
  return thermosFloorsCache;
}

async function ensureFloorsFresh(){
  const now = Date.now();
  if (now - (thermosFloorsCache.fetchedAt||0) < FLOORS_TTL_MS &&
      Object.keys(thermosFloorsCache.collections||{}).length) {
    return thermosFloorsCache;
  }
  try{
    return await fetchThermosCollections();
  }catch(e){
    console.error("Thermos floors fetch failed:", e.message);
    // вернём то, что есть в кеше, даже если устарело
    return thermosFloorsCache;
  }
}

// GET /market/floors  → { fetchedAt, ttlMs, collections:{ key:{name,floorTon} } }
app.get("/market/floors", async (_req,res)=>{
  const data = await ensureFloorsFresh();
  res.json({ fetchedAt: data.fetchedAt, ttlMs: FLOORS_TTL_MS, collections: data.collections });
});

// helper: подтянуть/обновить floors по моделям для заданных ИМЁН коллекций
async function ensureModelFloorsForCollections(collectionNames=[]){
  const need = [];
  const now = Date.now();
  for (const name of collectionNames) {
    const rec = thermosModelFloors.byCollection[name];
    if (!rec || (now - (rec.fetchedAt||0)) > MODEL_FLOORS_TTL_MS) need.push(name);
  }
  if (!need.length) return;
  const r = await fetch(`${THERMOS_PROXY}/attributes`, {
    method:"POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ collections: need })
  });
  if(!r.ok) throw new Error("thermos attributes http "+r.status);
  const j = await r.json(); // { "Collection Name": { models:[{name, stats:{floor}}], ... } }
  for (const [colName, val] of Object.entries(j||{})) {
    const models = {};
    for (const m of (val?.models || [])) {
      const floorTon = Number(BigInt(m?.stats?.floor ?? "0")) / 1e9;
      models[ normalizeKey(m.name) ] = { name: m.name, floorTon };
    }
    thermosModelFloors.byCollection[colName] = { fetchedAt: Date.now(), models };
  }
  await saveModelFloorsCacheToDisk();
}

// GET /market/model-floors?keys=deskcalendar,plushpepe
// → { keys:{ [colKey]: { models:{ [modelKey]:{name,floorTon} } } }, ttlMs:... }
app.get("/market/model-floors", async (req,res)=>{
  try{
    const keys = String(req.query.keys||"").split(",").map(s=>s.trim()).filter(Boolean);
    if (!keys.length) return res.json({ keys:{}, ttlMs: MODEL_FLOORS_TTL_MS });
    // гарантируем наличие коллекций (имён) в кеше
    const floors = await ensureFloorsFresh();
    const wantNames = [];
    const keyToName = {};
    for (const k of keys) {
      const col = floors.collections[k];
      if (col?.name) {
        keyToName[k] = col.name;
        wantNames.push(col.name);
      }
    }
    await ensureModelFloorsForCollections(wantNames);
    const out = {};
    for (const k of keys) {
      const name = keyToName[k];
      const rec = name ? thermosModelFloors.byCollection[name] : null;
      out[k] = { models: rec?.models || {} };
    }
    res.json({ keys: out, ttlMs: MODEL_FLOORS_TTL_MS });
  }catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});
// === LOGIN ===  (вызывается телеграм-клиентом один раз)
/* helper: вытаскиваем user.id из initData                                 *
 * initData — это query-string вида                                       *
 *   "query_id=...&user=%7B%22id%22%3A123%2C...%7D&hash=..."              */
function userIdFromInitData(str = "") {
  try {
    const params = new URLSearchParams(str);
    const userJson = params.get("user");
    if (!userJson) return "";
    const userObj = JSON.parse(userJson);
    return userObj?.id ? String(userObj.id) : "";
  } catch {
    return "";
  }
}

app.post("/auth/login", (req, res) => {
  /*  Принимаем userId в ПЯТИ возможных вариантах:
        ① JSON            → { "userId": 123 }
        ② form-urlencoded → userId=123
        ③ text/plain      → "123"
        ④ initData (JSON) → { "initData": "query_id=...&user=%7B...%7D&..." }
        ⑤ initData (text) → "query_id=...&user=%7B...%7D&..."               */

  let uid = "";

  // raw-text body
  if (typeof req.body === "string") {
    uid = /^\d+$/.test(req.body.trim())
      ? req.body.trim()               // вариант ③
      : userIdFromInitData(req.body); // вариант ⑤
  }

  // JSON / form body
  if (!uid && req.body) {
    if (req.body.userId !== undefined) {
      uid = String(req.body.userId).trim();           // вариант ① / ②
    } else if (req.body.initData) {
      uid = userIdFromInitData(String(req.body.initData)); // вариант ④
    }
  }

  // fallback: ?userId=123 в query-string
  if (!uid && req.query.userId) uid = String(req.query.userId).trim();

  if (!/^\d+$/.test(uid)) return res.status(400).json({ error: "bad userId" });

  const token = jwt.sign({ uid }, JWT_SECRET, {
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
  if (!gid || ownedId === undefined || ownerId === undefined)
    return res.status(400).json({ error: "bad gift" });

  // 🔒 Приводим идентификаторы к строке и проверяем дубль по строковому ID
  const normOwnedId = String(ownedId).trim();
  const normOwnerId = String(ownerId).trim();
  if (!normOwnedId || !normOwnerId) return res.status(400).json({ error: "bad gift" });
  if (gifts.some(g => String(g.ownedId) === normOwnedId)) return res.json({ ok: true }); // дубль
  const autoImg = img || (()=>{
      const core = name.toLowerCase().replace(/[^a-z0-9]+/g,"");
      const num  = (String(normOwnedId).match(/\d+/)||[gid])[0];
      return `https://nft.fragment.com/gift/${core}-${num}.medium.jpg`;
  })();

  gifts.push({ gid, ownedId: normOwnedId, name, price, img: autoImg, ownerId: normOwnerId,
               staked: false, status: "idle" });
  await saveGifts();
  res.json({ ok: true });
});

/* ======== INTERNAL: queue API for gifts_listener (TON-paid) ======== */
// GET /internal/transfer/next?limit=10 → {jobs:[{id,userId,ownedIds,ts}]}
app.get("/internal/transfer/next", adminAuth, (req,res)=>{
  const lim = Math.min( Number(req.query.limit||10), 50);
  const now = Date.now();
  const jobs = [];
  for (const j of giftTransfers) {
    if (jobs.length>=lim) break;
    if (j.status==='queued') {
      j.status = 'working';
      j.leaseTs = now;
      jobs.push({ id:j.id, userId:j.userId, ownedIds:j.ownedIds, ts:j.ts });
    }
  }
  saveGiftTransfers().catch(console.error);
  res.json({ jobs });
});

// POST /internal/transfer/complete { jobId, ok, sent:[], failed:[] }
app.post("/internal/transfer/complete", adminAuth, async (req,res)=>{
  const { jobId, ok, sent=[], failed=[] } = req.body || {};
  const job = giftTransfers.find(j=>j.id===jobId);
  if (!job) return res.status(404).json({ error:"job not found" });

  const uid = String(job.userId);
  let changedGifts = false;
  // помечаем подарки
  for (const id of sent) {
    const g = gifts.find(x=>x.ownedId===id && x.ownerId===uid);
    if (g){ g.status='sent'; changedGifts=true; io.to("u:"+uid).emit("giftUpdate", { ownedId:id, status:"sent" }); }
  }
  for (const id of failed) {
    const g = gifts.find(x=>x.ownedId===id && x.ownerId===uid);
    if (g){ g.status='idle'; changedGifts=true; io.to("u:"+uid).emit("giftUpdate", { ownedId:id, status:"idle" }); }
  }
  if (changedGifts) await saveGifts();

  // частичный/полный рефанд TON-комиссии
  const total = (job.ownedIds||[]).length;
  const failCnt = failed.length;
  if (failCnt>0) {
    // Вернуть комиссию за неотправленные подарки
    const feePerGift = Number(GIFT_WITHDRAW_TON_FEE) || 0;
    const refund = +(feePerGift * failCnt).toFixed(9);
    if (refund > 0) {
      // игроку +TON, сервису −TON
      balances[uid]        = (balances[uid]||0) + refund;
      balances.__service__ = (balances.__service__||0) - refund;
      await saveBalances();
      txs.push({ userId: uid,          type:"gift_withdraw_refund",      amount: refund, ts: Date.now(), meta:{ jobId, failed: failCnt }});
      txs.push({ userId: "__service__", type:"gift_withdraw_refund_out", amount: refund, ts: Date.now(), meta:{ jobId, to: uid, failed: failCnt }});
      await saveTx();
    }
  }

  job.status = ok && failed.length===0 ? 'done' : (failed.length===total ? 'fail' : 'partial');
  delete job.leaseTs;
  await saveGiftTransfers();
  res.json({ ok:true, status:job.status });
});
/* ───────── Stars-webhook: платеж подтверждён ───────── */
app.post("/internal/withdrawGiftPaid", adminAuth, async (req, res) => {
  const { ownedIds, ownedId, payerId } = req.body || {};

  // Нормализация входных id: поддерживаем массив, строку списком и одиночный id
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
    if (v !== undefined && v !== null) return [String(v)];
    return [];
  };

  // Приоритет: если пришёл ownedIds — берём его; иначе разбираем ownedId (в т.ч. "a,b,c")
  const ids = norm(ownedIds).length ? norm(ownedIds) : norm(ownedId);
  if (!ids.length) return res.status(400).json({ error: "no gifts" });

  const owner = String(payerId);

  // Ищем ЛЮБОЙ из переданных подарков у плательщика, который ждёт выдачу
  const probe = gifts.find(
    g =>
      g.ownerId === owner &&
      g.status === "pending_withdraw" &&
      ids.includes(g.ownedId)
  );
  if (!probe) return res.status(400).json({ error: "gift not pending" });

  // Все подарки, оплаченные одним и тем же invoiceLink — считаем этой же пачкой
  const link = probe.invoiceLink;
  let touched = false;

  gifts.forEach(g => {
    if (
      g.ownerId === owner &&
      g.status === "pending_withdraw" &&
      g.invoiceLink === link
    ) {
      g.status = "sent";
      touched = true;
      io.to("u:" + owner).emit("giftUpdate", { ownedId: g.ownedId, status: "sent" });
    }
  });

  if (touched) {
    await saveGifts();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: "gifts not pending" });
});


const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowed,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

/* стартуем периодическую очистку pending‑withdraw */
setInterval(cleanupPendingGifts, 60_000);

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

      /* ───────── начисляем приз и комиссию (TON + NFT) ───────── */
      const winUid = String(winner.userId);
      // summary нужен и в блоке переноса подарков ниже — объявляем заранее
      let summary = null;
      if (winUid) {
        // Собираем сводку для модалки победителя
        summary = {
          potTon: 0,
          winnerStakeTon: 0,
          netTonWin: 0,
          payoutTon: 0,
          tonCommission: 0,
          commissionNftSum: 0,
          commissionNftCount: 0,
          refundTon: 0,
          gained: [],            // [{ownedId,name,price,img}]
          commitHash: game.commitHash,
          seed: game.seed
        };
        // 1) Общий TON-банк раунда
        const potTON = game.players.reduce(
          (sum, p) => sum + p.nfts.filter(n => n.id.startsWith("ton-")).reduce((s, n) => s + n.price, 0),
          0
        );
        // 2) Личный TON победителя
        const winnerStakeTON = winner.nfts
          .filter(n => n.id.startsWith("ton-"))
          .reduce((s, n) => s + n.price, 0);
        // 3) Чужой TON, выигранный победителем (net-win по тону)
        const netTonWin = Math.max(0, potTON - winnerStakeTON);
        summary.potTon        = potTON;
        summary.winnerStakeTon= winnerStakeTON;
        summary.netTonWin     = netTonWin;

        // 4) NFT, которые переходят победителю (кандидаты: НЕ ton-токены, не от победителя)
        const prizeNFTCandidates = [];
        for (const p of game.players) {
          if (String(p.userId) === winUid) continue;
          for (const n of (p.nfts || [])) {
            if (String(n.id).startsWith("ton-")) continue;
            const g = gifts.find(x => x.ownedId === n.id && String(x.ownerId) === String(p.userId));
            if (g) prizeNFTCandidates.push({ gift: g, price: Number(n.price || g.price || 0) });
          }
        }
        const totalPrizeNFTValue = prizeNFTCandidates.reduce((s, it) => s + (Number(it.price) || 0), 0);

        // 5) Если приз состоит только из TON → старая логика (5% от net-TON, без учёта своих TON)
        if (totalPrizeNFTValue <= 0) {
          if (potTON > 0) {
            const commissionTon = netTonWin * COMMISSION_RATE;
            const payoutTon     = potTON - commissionTon; // = свои TON + (net-TON − комиссия)

            balances[winUid] = (balances[winUid] || 0) + payoutTon;
            balances.__service__ = (balances.__service__ || 0) + commissionTon;
            await saveBalances();

            txs.push({ userId: winUid, type: "prize", amount: payoutTon, ts: Date.now() });
            if (commissionTon > 0) {
              txs.push({ userId: "__service__", type: "commission", amount: commissionTon, ts: Date.now() });
            }
            await saveTx();
            summary.payoutTon    = payoutTon;
            summary.tonCommission= commissionTon;
            summary.refundTon    = 0;
          }
        } else {
          // 6) Смешанный приз (TON + NFT): комиссия = 5% от (net-TON + NFT-стоимость)
          const totalCommission = (netTonWin + totalPrizeNFTValue) * COMMISSION_RATE;
          // 6a) Сначала удерживаем из net-TON (не трогаем свои TON)
          const tonTaken = Math.min(totalCommission, netTonWin);
          const tonRemainder = Math.max(0, totalCommission - tonTaken); // ещё надо покрыть NFT-ами

          const payoutTon = winnerStakeTON + (netTonWin - tonTaken); // свои TON + остаток net-TON
          balances[winUid] = (balances[winUid] || 0) + payoutTon;
          if (tonTaken > 0) {
            balances.__service__ = (balances.__service__ || 0) + tonTaken;
          }

          // 6b) Если нужно — удерживаем NFT на сумму не меньше остатка комиссии (лучшая подгонка)
          let withheld = [];
          let withheldSum = 0;
          let refund = 0;
          if (tonRemainder > 0.0000001 && prizeNFTCandidates.length) {
            // попытка точного/почти точного покрытия: одиночка → пары → жадно по возрастанию
            const items = [...prizeNFTCandidates];
            // одиночка
            let best = null;
            for (const it of items) {
              if (it.price >= tonRemainder && (!best || it.price < best.price)) best = it;
            }
            if (best && Math.abs(best.price - tonRemainder) < 1e-9) {
              withheld = [best];
            } else {
              // пары (если массив не слишком большой)
              if (!best && items.length <= 50) {
                let over = Infinity, pair = null;
                for (let i = 0; i < items.length; i++) {
                  for (let j = i + 1; j < items.length; j++) {
                    const s = items[i].price + items[j].price;
                    if (s >= tonRemainder && s < over) { over = s; pair = [items[i], items[j]]; }
                  }
                }
                if (pair) withheld = pair;
              }
              // жадно снизу, если ещё не подобрали
              if (!withheld.length) {
                items.sort((a, b) => a.price - b.price);
                let sum = 0, pick = [];
                for (const it of items) { pick.push(it); sum += it.price; if (sum >= tonRemainder) break; }
                withheld = pick;
              }
            }
            withheldSum = withheld.reduce((s, it) => s + (Number(it.price) || 0), 0);
            // если перебрали — вернём разницу в TON на баланс победителя
           // кламп с эпсилон, чтобы не уйти в отрицательное из-за флоатов
            const EPS = 1e-9;
            let refundCalc = withheldSum - tonRemainder;
            if (refundCalc < EPS) refundCalc = 0;
            refund = +refundCalc.toFixed(9);
            if (refund > 0) {
              // победителю +TON, сервису −TON
              balances[winUid]      = (balances[winUid] || 0) + refund;
              balances.__service__  = (balances.__service__ || 0) - refund;
              await saveBalances();
              txs.push({ userId: winUid,         type: "commission_refund",      amount: refund, ts: Date.now() });
              txs.push({ userId: "__service__",  type: "commission_refund_out",  amount: refund, ts: Date.now(), meta:{ to: winUid } });

            }
          }
          await saveBalances();

          // учёт транзакций TON (не пишем «Выигрыш» с нулём)
          if (payoutTon > 1e-9) {
            txs.push({ userId: winUid, type: "prize", amount: payoutTon, ts: Date.now() });
          }
          if (tonTaken > 0) {
            txs.push({ userId: "__service__", type: "commission", amount: tonTaken, ts: Date.now() });
          }
          if (withheldSum > 0) {
            txs.push({ userId: "__service__", type: "commission_nft", amount: withheldSum, ts: Date.now(),
                       meta: { count: withheld.length } });
          }
          await saveTx();

          // передадим список удержанных NFT дальше (в блок переноса подарков)
          winner.__withheldIds = new Set(withheld.map(it => it.gift.ownedId));
          // Сводка для модалки
          summary.payoutTon        = payoutTon;
          summary.tonCommission    = tonTaken;
          summary.commissionNftSum = withheldSum;
          summary.commissionNftCount = withheld.length;
          summary.refundTon        = refund;
        }
      }
  /* ──────────────────────────────────────────────────────────
     ПЕРЕНОС ПОДАРКОВ: все NFT, поставленные в этом раунде,
     переходят победителю. TON-«токены» (id: "ton-…") не трогаем.
     • Проигравшим шлём giftUpdate{status:'sent'} → клиент удалит.
     • Победителю шлём giftGain{…} → клиент добавит в инвентарь.
     • Свои собственные поставленные NFT у победителя просто
       снимаем со стейка (владельцем уже является победитель).
  ─────────────────────────────────────────────────────────── */
  try {
    let touched = false;

    for (const p of game.players) {
      const uid = String(p.userId);
      for (const n of (p.nfts || [])) {
        // пропускаем TON-ставки
        if (String(n.id).startsWith('ton-')) continue;
        // ищем реальную запись подарка у исходного владельца
        const g = gifts.find(x => x.ownedId === n.id && String(x.ownerId) === uid);
        if (!g) continue;

        if (uid === winUid) {
          // подарок уже у победителя → просто снимаем «staked»
          if (g.staked) { g.staked = false; touched = true; }
          // можно уведомить клиента позже общим state-reset
          continue;
        }

        // если этот подарок удержан как комиссия — уходит сервису
        const isWithheld = winner.__withheldIds && winner.__withheldIds.has(g.ownedId);
        if (isWithheld) {
          g.ownerId = "__service__";
          g.staked  = false;
          g.status  = "idle";
          touched   = true;
          // проигравшему сообщаем, что подарок ушёл
          io.to("u:" + uid).emit("giftUpdate", { ownedId: g.ownedId, status: "sent" });
          // победителю НИЧЕГО не шлём по этому подарку
          continue;
        }

        // обычный перенос победителю
        g.ownerId = winUid;
        g.staked  = false;
        g.status  = "idle";
        touched   = true;
        io.to("u:" + uid).emit("giftUpdate", { ownedId: g.ownedId, status: "sent" });
        io.to("u:" + winUid).emit("giftGain", {
          gid: g.gid, ownedId: g.ownedId, name: g.name,
          price: g.price, img: g.img, status: "idle"
        });
        // добавим в список полученных для сводки
        if (summary) summary.gained.push({ ownedId: g.ownedId, name: g.name, price: Number(g.price||0), img: g.img });
      }
    }
    if (touched) await saveGifts();
    // 🔔 Отправляем персональную сводку победителю
    if (summary && winUid) {
      io.to("u:" + winUid).emit("winSummary", summary);
    }
  } catch (e) {
    console.error("Gift transfer error:", e);
  }


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
    gifts,
    saveGifts,
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
  // индивидуальная комната для точечных пушей
  if (socket.userId) {
    socket.join("u:" + socket.userId);
  }

socket.on("placeBet", async ({ name, nfts = [], tonAmount = 0 }) => {
  const userId = socket.userId;
  // 0) базовая валидация
  tonAmount = Number(tonAmount) || 0;
  if (tonAmount < 0) tonAmount = 0;          // защита от отрицательных
  // минималка для TON-ставки
  if (tonAmount > 0 && tonAmount < MIN_TON_BET) {
    socket.emit("err", `min ton bet ${MIN_TON_BET}`);
    return;
  }

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
    // курсор пагинации Toncenter должен включать И lt, И hash
    let cursor = null;                  // { lt, hash }
    while (true) {
      const page = await tonApi("getTransactions", cursor
        ? { address: DEPOSIT_ADDR, limit: DEPOSIT_LIMIT, lt: cursor.lt, hash: cursor.hash }
        : { address: DEPOSIT_ADDR, limit: DEPOSIT_LIMIT }
      );

      for (const tx of page) {
        const lt = BigInt(tx.transaction_id.lt);
        if (lt <= lastLt) { cursor = null; break; }   // дошли до старых

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

      if (cursor === null || page.length < DEPOSIT_LIMIT) break;
      const tail = page.at(-1)?.transaction_id;
      if (!tail) break;
      cursor = { lt: tail.lt, hash: tail.hash };        // следующая страница
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("LITE_SERVER_UNKNOWN")) {
      // Некорректный курсор в ноде → сбрасываемся на «последние» в следующий цикл
      console.warn("pollDeposits: cursor invalid, will reset to latest on next poll");
    } else {
      console.error("pollDeposits:", msg);
    }
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
  await loadGiftTransfers();
  await loadFloorsCacheFromDisk();
  await loadModelFloorsCacheFromDisk();
  resetRound();      
  pollDeposits().catch(console.error);
  httpServer.listen(PORT, () => console.log("Jackpot server on", PORT));
})()


