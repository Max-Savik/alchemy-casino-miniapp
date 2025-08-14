// market.js — Themis · Маркет (v2)
// • GSAP-анимация "Скоро"
// • Роутинг нижней навигации
// • Баланс TON в хедере (идентично профилю): #tonBalance внутри #balanceBox
// • Мягкий fade-in страницы

document.addEventListener("DOMContentLoaded", () => {
  /* ──────────────────────────────────
   * 1) Плавная анимация заголовка
   * ────────────────────────────────── */
  try {
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.fromTo(
      "#comingSoonHeadline",
      { y: 20, opacity: 0 },
      { y: 0, opacity: 1, duration: 1 }
    );
    tl.to(
      "#comingSoonHeadline",
      { repeat: -1, yoyo: true, duration: 2, opacity: 0.7, ease: "sine.inOut" },
      "+=0.5"
    );
  } catch (_) {
    // GSAP может отсутствовать локально — просто пропустим анимацию
  }

  /* ──────────────────────────────────
   * 2) Роутинг нижней навигации
   * ────────────────────────────────── */
  const nav = {
    navGame: "index.html#game",
    navMarket: "market.html", // остаёмся здесь
    navProfile: "profile.html",
    navEarn: "index.html#earn",
  };
  Object.entries(nav).forEach(([btnId, url]) => {
    const el = document.getElementById(btnId);
    if (!el) return;
    el.addEventListener("click", () => (location.href = url));
  });

  /* ──────────────────────────────────
   * 3) Мягкий fade-in тела страницы
   * ────────────────────────────────── */
  requestAnimationFrame(() => document.body.classList.remove("opacity-0"));

  /* ──────────────────────────────────
   * 4) Баланс TON в шапке (как в профиле)
   *    – берём API_ORIGIN из глобала, иначе дефолт
   *    – используем JWT из localStorage, иначе логинимся по Telegram initData
   * ────────────────────────────────── */
  (function tonBalanceModule() {
    const balanceEl = document.getElementById("tonBalance");
    if (!balanceEl) return; // если на странице нет плашки баланса — тихо выходим

    const API_ORIGIN =
      (typeof window.API_ORIGIN === "string" && window.API_ORIGIN) ||
      "https://alchemy-casino-miniapp.onrender.com";

    let jwtToken = localStorage.getItem("jwt") || null;

    function hasSidCookie() {
      return document.cookie.split("; ").some((c) => c.startsWith("sid="));
    }

    async function ensureJwt(force = false) {
      // если уже есть sid-кука и не форсим — считаем, что бэку достаточно
      if (hasSidCookie() && !force) return;
      if (!force && jwtToken) return;

      const initDataRaw = window?.Telegram?.WebApp?.initData;
      if (!initDataRaw) {
        // вне Telegram WebApp — не авторизуемся, просто не покажем реальный баланс
        return;
      }

      const r = await fetch(`${API_ORIGIN}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: initDataRaw }),
      });

      const j = await r.json().catch(() => ({}));
      if (j && j.token) {
        jwtToken = j.token;
        localStorage.setItem("jwt", jwtToken);
      }
    }

    async function fetchJSON(url, opts = {}, { _retry } = {}) {
      const res = await fetch(url, {
        credentials: "include",
        headers: {
          ...(opts.headers || {}),
          ...(jwtToken ? { Authorization: "Bearer " + jwtToken } : {}),
        },
      });
      if (res.status === 401 && !_retry) {
        await ensureJwt(true);
        return fetchJSON(url, opts, { _retry: true });
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => String(res.status));
        throw new Error(txt || `HTTP ${res.status}`);
      }
      return res.json();
    }

    async function refreshBalance() {
      try {
        const j = await fetchJSON(`${API_ORIGIN}/wallet/balance`);
        const n = Number(j?.balance || 0);
        balanceEl.textContent = n.toFixed(2);
      } catch (_) {
        // оставляем дефолт 0.00
      }
    }

    // Инициализация
    (async () => {
      try {
        await ensureJwt();
      } finally {
        // всегда хотя бы один запрос баланса попробуем
        await refreshBalance();
      }
    })();

    // Опционально: фоновые обновления, если страница открыта долго
    let refreshTimer = null;
    function scheduleRefresh() {
      clearInterval(refreshTimer);
      // обновляем раз в 30 сек, но только когда вкладка активна
      refreshTimer = setInterval(() => {
        if (document.visibilityState === "visible") refreshBalance();
      }, 30_000);
    }
    scheduleRefresh();

    // Когда возвращаемся на вкладку — сразу обновим
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshBalance();
    });

    // При смене темы в Telegram (необязательно, но безвредно)
    try {
      window.Telegram?.WebApp?.onEvent?.("themeChanged", refreshBalance);
    } catch (_) {}
  })();
});
