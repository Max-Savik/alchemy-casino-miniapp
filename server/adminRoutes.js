// adminRoutes.js
// ──────────────────────────────────────────────────────────────────
//  Admin router for Jackpot Server
//  ---------------------------------------------------------------

import express from "express";
import fs from "fs/promises";
import path from "path";

export default function createAdminRouter(opts) {
  const {
    ADMIN_TOKEN,
    HISTORY_FILE,
    history,
    saveHistory,
    balances,
    saveBalances,
    txs,
    saveTx,
    withdrawals,
    saveWithdrawals,
  } = opts;

  if (!ADMIN_TOKEN) throw new Error("ADMIN_TOKEN not set");

  /* ─── middleware auth ─── */
  const adminAuth = (req, res, next) => {
    const token = req.get("X-Admin-Token");
    return token !== ADMIN_TOKEN ? res.sendStatus(403) : next();
  };

  const router = express.Router();
  router.use(adminAuth);

  /* 1) Скачать history.json или конкретный backup */
  router.get("/history/download", async (req, res) => {
    const id   = (req.query.id || "").trim();      // пусто ⇒ основной файл
    const file = path.join(path.dirname(HISTORY_FILE), id || "history.json");
    try { await fs.access(file); res.download(file); }
    catch { res.sendStatus(404); }
  });

  /* 2) Очистить историю (резервная копия) */
  router.post("/history/clear", async (_req, res) => {
    const backup = `${HISTORY_FILE}.${Date.now()}.bak`;
    await fs.copyFile(HISTORY_FILE, backup).catch(() => {});
    history.length = 0;
    await saveHistory();
    res.json({ ok: true, backup: path.basename(backup) });
  });

  /* 3) Топ победителей */
  router.get("/history/top", (req, res) => {
    const topN = Number(req.query.n || 10);
    const map  = new Map();
    for (const rec of history)
      map.set(rec.winner, (map.get(rec.winner) || 0) + rec.total);

    const top = [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([name, sum]) => ({ name, sum }));

    res.json(top);
  });

  /* 4) Игровая статистика игрока */
  router.get("/history/player", (req, res) => {
    const qName = (req.query.name || "").trim();
    if (!qName) return res.status(400).json({ error: "name empty" });

    let games = 0, wins = 0;
    for (const rec of history) {
      if (rec.participants.some(p => p.name === qName)) games++;
      if (rec.winner === qName) wins++;
    }
    res.json({ name: qName, games, wins, winPct: games ? (wins / games) * 100 : 0 });
  });

  /* 5) «Голый» backup */
  router.post("/history/backup", async (_req, res) => {
    const backup = `${HISTORY_FILE}.${Date.now()}.bak`;
    await fs.copyFile(HISTORY_FILE, backup);
    res.json({ backup: path.basename(backup) });
  });

  /* 6) Prune — удалить записи старше N дней */
  router.post("/history/prune", async (req, res) => {
    const days = Number(req.query.days);
    if (!days || days <= 0) return res.status(400).json({ error: "days required" });

    const backup = `${HISTORY_FILE}.${Date.now()}.bak`;
    await fs.copyFile(HISTORY_FILE, backup).catch(() => {});

    const cutoff = Date.now() - days * 86_400_000;
    const before = history.length;
    const kept   = history.filter(r => new Date(r.timestamp).getTime() >= cutoff);

    history.length = 0;
    history.push(...kept);
    await saveHistory();

    res.json({ removed: before - kept.length, left: kept.length, backup: path.basename(backup) });
  });

  /* 7) Restore backup */
  router.post("/history/restore", async (req, res) => {
    const id = (req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });

    const file = path.join(path.dirname(HISTORY_FILE), id);
    try {
      const txt = await fs.readFile(file, "utf8");
      history.length = 0;
      history.push(...JSON.parse(txt));
      await saveHistory();
      res.json({ ok: true, restored: id, count: history.length });
    } catch {
      res.status(404).json({ error: "backup not found" });
    }
  });


  /* ────────────────────────────────────────────────────────────
     B A L A N C E   &   T R A N S A C T I O N S
  ──────────────────────────────────────────────────────────── */

  /* 8) GET /admin/balance?uid=123 */
  router.get("/balance", (req, res) => {
    const uid = (req.query.uid || "").trim();
    if (!uid) return res.status(400).json({ error: "uid required" });
    return res.json({ uid, balance: balances[uid] || 0 });
  });

  /* 9) POST /admin/balance/adjust  { uid, delta } */
  router.post("/balance/adjust", express.json(), async (req, res) => {
    const { uid, delta } = req.body || {};
    const d = Number(delta);
    if (!uid || !Number.isFinite(d)) return res.status(400).json({ error: "uid & delta" });

    balances[uid] = (balances[uid] || 0) + d;
    await saveBalances();

    txs.push({
      userId : uid,
      type   : d > 0 ? "admin_add" : "admin_sub",
      amount : Math.abs(d),
      ts     : Date.now(),
    });
    await saveTx();

    res.json({ uid, balance: balances[uid] });
  });

  /* 10) GET /admin/tx/list?limit=100 */
  router.get("/tx/list", (req, res) => {
    const lim = Math.min(Number(req.query.limit || 100), 500);
    res.json(txs.slice(-lim).reverse());
  });

  /* 11) GET /admin/tx/user?uid=123&limit=50 */
  router.get("/tx/user", (req, res) => {
    const uid = (req.query.uid || "").trim();
    if (!uid) return res.status(400).json({ error: "uid required" });
    const lim = Math.min(Number(req.query.limit || 100), 500);
    res.json(txs.filter(t => t.userId === uid).slice(-lim).reverse());
  });

  /* 12) GET /admin/withdrawals?status=pending|sent|fail */
  router.get("/withdrawals", (req, res) => {
    const st = (req.query.status || "").trim();
    const list = st ? withdrawals.filter(w => w.status === st) : withdrawals;
    res.json(list.slice(-200).reverse());
  });

  return router;
 }
