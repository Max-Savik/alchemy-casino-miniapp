// earn.js
const API_ORIGIN = "https://alchemy-casino-miniapp.onrender.com";

/* === Telegram guard (как у тебя) === */
function isTelegramWebApp(){
  return !!(window?.Telegram?.WebApp?.initData && window?.Telegram?.WebApp?.initDataUnsafe?.user?.id);
}
if (!isTelegramWebApp()) {
  document.documentElement.innerHTML = `
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;display:flex;height:100vh;align-items:center;justify-content:center;background:#0b0f16;color:#fff;font-family:system-ui,Segoe UI,Roboto,Arial">
      <div style="text-align:center">
        <div style="font-size:20px;margin-bottom:8px">Откройте мини-приложение в Telegram</div>
        <div style="opacity:.8;font-size:14px">Страница дохода работает только внутри Telegram WebApp</div>
      </div>
    </body>`;
  throw new Error("Blocked: not in Telegram WebApp");
}

/* === JWT/auth как в главной странице (лайт-версия) === */
let jwtToken = localStorage.getItem("jwt") || null;
async function ensureJwt(force=false){
  const hasSid = document.cookie.split("; ").some(c => c.startsWith("sid="));
  if (hasSid && !force) return;
  if (!force && jwtToken) return;

  const initDataRaw = window?.Telegram?.WebApp?.initData;
  if (!initDataRaw) throw new Error("No Telegram initData");

  const r = await fetch(`${API_ORIGIN}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: initDataRaw })
  });
  const j = await r.json();
  jwtToken = j.token || null;
  if (jwtToken) localStorage.setItem("jwt", jwtToken);
}
async function fetchJSON(url, opts={}, { _retry } = {}) {
  const res = await fetch(url, {
    credentials: "include",
    headers: { ...(opts.headers||{}), ...(jwtToken ? { 'Authorization': 'Bearer '+jwtToken } : {}) }
  });
  if (res.status === 401 && !_retry) { await ensureJwt(true); return fetchJSON(url, opts, { _retry: true }); }
  if (!res.ok) throw new Error(await res.text().catch(()=>String(res.status)));
  return res.json();
}
async function postJSON(url, data, { _retry } = {}) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type":"application/json", ...(jwtToken ? { 'Authorization':'Bearer '+jwtToken } : {}) },
    body: JSON.stringify(data)
  });
  if (res.status === 401 && !_retry) { await ensureJwt(true); return postJSON(url, data, { _retry: true }); }
  if (!res.ok) throw new Error(await res.text().catch(()=>String(res.status)));
  return res.json();
}

/* === UI els === */
const tonBalanceEl = document.getElementById("tonBalance");
const earnedTonEl  = document.getElementById("earnedTon");
const refreshBtn   = document.getElementById("refreshEarn");

const promoInput   = document.getElementById("promoInput");
const promoMsg     = document.getElementById("promoMsg");
const activateBtn  = document.getElementById("activatePromo");

const myCodeEl     = document.getElementById("myCode");
const genCodeBtn   = document.getElementById("genCode");
const refLinkInp   = document.getElementById("refLink");
const copyRefBtn   = document.getElementById("copyRef");

const invitedEl    = document.getElementById("invitedCount");
const activeEl     = document.getElementById("activeCount");
const lastPayoutEl = document.getElementById("lastPayout");

/* === helpers === */
function tgUser(){
  return window?.Telegram?.WebApp?.initDataUnsafe?.user || {};
}
function fmtTon(n){ return (Number(n || 0)).toFixed(2); }
function fmtDate(ts){
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return "—"; }
}

/* === balance === */
async function refreshBalance(){
  try{
    const { balance=0 } = await fetchJSON(`${API_ORIGIN}/wallet/balance`);
    tonBalanceEl.textContent = fmtTon(balance);
  }catch(_){ /* no-op */ }
}

/* === earned from referrals (из истории кошелька) === */
async function refreshEarned(){
  try{
    const arr = await fetchJSON(`${API_ORIGIN}/wallet/history?limit=500`);
    const types = new Set(["ref_income","referral_income","ref_bonus","referral_bonus"]);
    const sum = arr.reduce((s,t)=> s + (types.has(t.type) ? Math.abs(Number(t.amount)||0) : 0), 0);
    earnedTonEl.textContent = fmtTon(sum);
  }catch(_){
    earnedTonEl.textContent = "0.00";
  }
}

/* === referral summary (опциональный бек) ===
   ожидаемый ответ:
   { myCode, link, invitedCount, activeCount, lastPayoutTs } */
async function loadRefSummary(){
  let uid = tgUser().id ? String(tgUser().id) : "";
  // дефолтная ссылка на бота (если на бэке ещё нет эндпойнта):
  const fallbackLink = `https://t.me/themis_gifts_bot?start=ref_${encodeURIComponent(uid)}`;

  try{
    const data = await fetchJSON(`${API_ORIGIN}/ref/summary`);
    const myCode = (data.myCode || "").toString().trim();
    myCodeEl.textContent = myCode || "—";
    refLinkInp.value = (data.link || fallbackLink);

    invitedEl.textContent = data.invitedCount ?? "—";
    activeEl.textContent  = data.activeCount ?? "—";
    lastPayoutEl.textContent = data.lastPayoutTs ? fmtDate(data.lastPayoutTs) : "—";

    // если код уже есть — кнопку создания убираем
    if (myCode) genCodeBtn.classList.add("hidden");
  }catch(_){
    // бэка нет — показываем дефолт
    myCodeEl.textContent = "—";
    refLinkInp.value = fallbackLink;
    invitedEl.textContent = "—";
    activeEl.textContent  = "—";
    lastPayoutEl.textContent = "—";
  }
}

/* === promo: activate === */
activateBtn.addEventListener("click", async () => {
  const code = (promoInput.value || "").trim().toUpperCase();
  promoMsg.textContent = "";
  if (!/^[A-Z0-9]{3,20}$/.test(code)) {
    promoMsg.textContent = "Неверный формат кода";
    return;
  }
  activateBtn.disabled = true;
  try{
    await postJSON(`${API_ORIGIN}/ref/activate`, { code });
    promoMsg.textContent = "Промокод успешно активирован!";
    promoMsg.classList.remove("text-gray-400"); promoMsg.classList.add("text-emerald-400");
    promoInput.disabled = true;
  }catch(e){
    const txt = String(e.message || e);
    promoMsg.textContent = /already/i.test(txt) ? "Промокод уже активирован" : "Не удалось активировать";
    promoMsg.classList.remove("text-emerald-400"); promoMsg.classList.add("text-rose-400");
  }finally{
    activateBtn.disabled = false;
  }
});

/* === generate my code === */
genCodeBtn.addEventListener("click", async () => {
  genCodeBtn.disabled = true;
  try{
    const r = await postJSON(`${API_ORIGIN}/ref/generate`, {});
    const code = (r.myCode || "").toString().trim();
    if (code) {
      myCodeEl.textContent = code;
      genCodeBtn.classList.add("hidden");
      // если бэк вернул ссылку — подставим; иначе оставим fallback
      if (r.link) refLinkInp.value = r.link;
    }
  }catch(_){
    alert("Не удалось создать код");
  }finally{
    genCodeBtn.disabled = false;
  }
});

/* === copy ref link === */
copyRefBtn.addEventListener("click", async () => {
  try{
    await navigator.clipboard.writeText(refLinkInp.value || "");
    copyRefBtn.textContent = "Скопировано";
    setTimeout(()=> copyRefBtn.textContent="Копировать", 1200);
  }catch(_){ /* no-op */ }
});

/* === refresh btn === */
refreshBtn.addEventListener("click", () => { refreshEarned(); });

/* === bootstrap === */
(async () => {
  await ensureJwt();
  await Promise.all([refreshBalance(), refreshEarned(), loadRefSummary()]);
})();
