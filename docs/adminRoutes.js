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

  return router;
}
