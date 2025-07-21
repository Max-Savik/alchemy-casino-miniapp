/* === CONSTANTS === */
const API_ORIGIN = "https://alchemy-casino-miniapp.onrender.com";
let jwtToken   = localStorage.getItem("jwt") || null;
let gifts      = [];             // оригинальный список
let viewGifts  = [];             // после фильтра / сортировки
let selected   = new Set();      // ownedId
let tonBalance = 0;

/* === Shortcuts === */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* === AUTH / BALANCE === */
async function ensureJwt() {
  if (document.cookie.split("; ").some(c => c.startsWith("sid="))) return;
  if (jwtToken) return;
  const userId = window?.Telegram?.WebApp?.initDataUnsafe?.user?.id
              || "guest-" + Math.random().toString(36).slice(2);
  const r = await fetch(`${API_ORIGIN}/auth/login`, {
    method : "POST",
    credentials: "include",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ userId })
  });
  jwtToken = (await r.json()).token;
  localStorage.setItem("jwt", jwtToken);
}

async function refreshBalance() {
  const r = await fetch(`${API_ORIGIN}/wallet/balance`, {
    credentials: "include",
    headers: jwtToken ? { Authorization: "Bearer "+jwtToken } : {}
  });
  if (r.ok) {
    tonBalance = (await r.json()).balance || 0;
    $("#tonBalance").textContent = tonBalance.toFixed(2);
  }
}

/* === DATA === */
function buildImgLink(g) {
  /* ① letters‑only из названия («DeskCalendar‑190442» → deskcalendar) */
  const letters = (g.name || "")
    .toLowerCase()
    .replace(/[^a-z]+/g, "");

  /* ② цифры: сначала ищем в названии, иначе в ownedId, иначе gid */
  const num =
    (g.name.match(/\d+/)     ||   // «DeskCalendar‑190442»
     g.ownedId.match(/\d+/)   ||   // «deskcalendar-243»
     [g.gid || "0"])[0];

  return `https://nft.fragment.com/gift/${letters}-${num}.medium.jpg`;
}


async function loadGifts() {
  const r = await fetch(`${API_ORIGIN}/wallet/gifts`, {
    credentials: "include",
    headers: jwtToken ? { Authorization: "Bearer "+jwtToken } : {}
  });
  const arr = await r.json();
  gifts = arr.map(g => ({
    ...g,
    id    : g.ownedId,
    img   : buildImgLink(g)
  }));
  selected.clear(); 
  applyFilters();
}

/* === SELECT‑ALL === */
$("#checkAll").addEventListener("change", e=>{
  if (e.target.checked){
    viewGifts
      .filter(g=>g.status==='idle')  // ← только свободные
      .forEach(g=>selected.add(g.id));
  }else{
    selected.clear();
  }
  renderGrid();
});

/* === UI RENDER === */
function giftCardHTML(g) {
  const sel = selected.has(g.id);
  const pend = g.status === "pending_withdraw";
  const cls = [
    "relative rounded-xl bg-gray-800/80 border border-gray-700 shadow-lg",
    "transition-transform hover:-translate-y-1"
  ];
  if (sel) cls.push("ring-2 ring-amber-400");
  if (pend) cls.push("opacity-60 pointer-events-none");

  return `
    <div data-id="${g.id}" class="${cls.join(" ")}">
      <img src="${g.img.replace('.jpg','.webp')}"
           srcset="${g.img.replace('.jpg','.webp')} 1x, ${g.img} 2x"
           alt="${g.name}"
           class="w-full aspect-square object-cover rounded-t-xl"
           onerror="this.onerror=null;this.src='${g.img}';">
      <div class="px-2 py-1 flex justify-between items-center text-xs sm:text-sm">
 <span class="truncate drop-shadow-sm">${g.name}</span>
 <span class="font-semibold text-amber-300 drop-shadow-sm">$${g.price}</span>
      </div>

      ${pend
        ? '<div class="absolute inset-0 bg-black/50 flex items-center justify-center text-amber-300 text-xs">⏳ вывод…</div>'
        : '<button class="quickWithdraw absolute top-2 right-2 bg-amber-500/90 hover:bg-amber-500 text-gray-900 text-xs font-bold px-1.5 py-0.5 rounded shadow">⇄</button>'
      }
      <input type="checkbox"
             class="selBox absolute bottom-2 right-2 w-4 h-4 accent-amber-500"
             ${sel ? "checked" : ""}
             ${pend ? "disabled" : ""}/>
    </div>`;
}

/* === Toast helper === */
function toast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.className = "fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-800 px-4 py-2" +
                " rounded-xl shadow-lg text-sm text-gray-100 opacity-0 transition";
  document.body.appendChild(t);
  requestAnimationFrame(()=>t.classList.add("opacity-90"));
  setTimeout(()=>{ t.classList.remove("opacity-90"); setTimeout(()=>t.remove(),300); }, 2500);
}

function renderGrid() {
  const grid = $("#profileGrid");
  grid.innerHTML = viewGifts.map(giftCardHTML).join("");

  $("#emptyState").classList.toggle("hidden", viewGifts.length !== 0);
  $("#checkAll").checked = selected.size &&
                           selected.size === viewGifts.filter(g=>g.status==='idle').length;
  updateCounter();
}

/* === COUNTER & BUTTONS === */
function totalValue(list) {
  return list.reduce((s,g)=>s+g.price,0);
}

function updateCounter() {
  const all = viewGifts.length;
  const sel = selected.size;
  const val = totalValue(viewGifts).toFixed(0);
  $("#counter").textContent = `${sel} / ${all} ($${val})`;

  const btn = $("#withdrawSelected");
  btn.textContent = sel ? `Вывести ${sel}` : "Вывести 0";
  btn.disabled = sel === 0;
}

/* === FILTER / SORT === */
function applyFilters() {
  const q = $("#searchInput").value.trim().toLowerCase();

  viewGifts = gifts.filter(g =>
       g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q));

  const sort = $("#sortSelect").value;
  viewGifts.sort((a,b)=>{
    if (sort==="priceAsc")  return a.price - b.price;
    if (sort==="priceDesc") return b.price - a.price;
    return a.name.localeCompare(b.name,"ru");
  });

  renderGrid();
}

/* === WITHDRAW === */
async function doWithdraw(id) {
  try {
    const { link } = await postJSON("/wallet/withdrawGift", { ownedId:id });
    const g = gifts.find(x=>x.id===id);
    if (g) g.status = "pending_withdraw";
    applyFilters();

    window.Telegram?.WebApp?.openInvoice
      ? Telegram.WebApp.openInvoice(link)
      : window.open(link,"_blank");
  } catch(e) {
    alert("Ошибка: "+e.message);
  }
}

async function withdrawSelected() {
  const ids = Array.from(selected);
  if (!ids.length) return;

  toast("Операции идут по очереди, комиссия 25 ⭐ за каждый NFT");

  for (const id of ids) {
    await doWithdraw(id);            // создаём и открываем счёт
    await new Promise(r => setTimeout(r, 800)); // пауза, чтобы не «заставить» TG
  }
  selected.clear();
}

const now = Date.now();
gifts.forEach(g=>{
  if (g.status==="pending_withdraw" && now - (g.ts||0) > 60_000) {
    g.status="idle";
  }
});      

/* === EVENTS === */
$("#searchInput").addEventListener("input", applyFilters);
$("#sortSelect").addEventListener("change", applyFilters);

$("#withdrawSelected").addEventListener("click", withdrawSelected);

$("#profileGrid").addEventListener("click", e => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  const id = card.dataset.id;

  if (e.target.classList.contains("quickWithdraw")) {
    doWithdraw(id);
    return;
  }

  /* чек‑бокс или клик по карте → toggle select */
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  // instant UI feedback
  card.classList.toggle("ring-amber-400");
  card.classList.toggle("ring-2");
  card.querySelector(".selBox").checked = selected.has(id);
  updateCounter();
});

/* helper – postJSON with auth */
function postJSON(path, data) {
  return fetch(API_ORIGIN + path, {
    method : "POST",
    credentials:"include",
    headers: {
      "Content-Type":"application/json",
      ...(jwtToken && { Authorization:"Bearer "+jwtToken })
    },
    body: JSON.stringify(data)
  }).then(r => r.ok ? r.json() : r.text().then(msg=>Promise.reject(new Error(msg))));
}

/* === INIT === */
(async ()=> {
  await ensureJwt();
  await Promise.all([refreshBalance(), loadGifts()]);
})();
