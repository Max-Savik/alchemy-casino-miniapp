/* === CONSTANTS === */
const API_ORIGIN = "https://alchemy-casino-miniapp.onrender.com";
let jwtToken   = localStorage.getItem("jwt") || null;
const TON_LABEL = "TON";
let gifts      = [];             // оригинальный список
let viewGifts  = [];             // после фильтра / сортировки
let selected   = new Set();      // ownedId
let tonBalance = 0;
let currentSort = "priceDesc";

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
  const priceStr = (parseFloat(g.price) || 0).toFixed(2);
  const cls = ["nft-card shadow-lg"];
  if (sel) cls.push("selected");
  if (pend) cls.push("opacity-60 pointer-events-none");

  return `
    <div data-id="${g.id}" class="${cls.join(" ")}">
      <img src="${g.img}" alt="${g.name}" class="nft-img"
           onerror="this.onerror=null;this.src='${g.img}';">

      <span class="price-badge">
        ${priceStr}&nbsp;${TON_LABEL}
      </span>

      <div class="title-badge absolute left-0 right-0 bottom-0 px-2 py-1 text-[11px] sm:text-xs truncate text-gray-100 text-center w-full">
        ${g.name}
      </div>

      <input type="checkbox"
             class="selBox absolute top-1.5 left-1.5 z-30 w-4 h-4 accent-amber-500"
             ${sel ? "checked" : ""} ${pend ? "disabled" : ""}/>
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
  const val = totalValue(viewGifts).toFixed(2);
  $("#counter").textContent = `${sel} / ${all} (${val} ${TON_LABEL})`;

  const btn = $("#withdrawSelected");
  // не показываем «0», просто «Вывести»
  btn.querySelector("[data-caption]").textContent =
      sel ? `Вывести ${sel}` : "Вывести";
  btn.disabled = sel === 0;
}

/* === FILTER / SORT === */
function applyFilters() {
  const q = $("#searchInput").value.trim().toLowerCase();

  viewGifts = gifts.filter(g =>
       g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q));

  viewGifts.sort((a,b)=>{
    if (currentSort==="priceAsc")  return a.price - b.price;
    if (currentSort==="priceDesc") return b.price - a.price;
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
  toast("Операции идут по очереди, комиссия 25 ⭐ за каждый NFT");
  for (const id of ids) {
    await doWithdraw(id);
    await new Promise(r => setTimeout(r, 800));
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
  card.classList.toggle("selected", selected.has(id));
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
  const socket = io(API_ORIGIN, { auth: { token: jwtToken } });

socket.on("giftUpdate", ({ ownedId, status }) => {
  const g = gifts.find(x => x.id === ownedId);
  if (g) {
    g.status = status;
    applyFilters();           // перерисовать сетку
  }
});

/* === SORT DROPDOWN === */
const sortBtn  = $("#sortBtn");
const sortMenu = $("#sortMenu");
const dropdown = $("#sortDropdown");

function updateSortUI() {
  const labelMap = {
    priceDesc: "Сортировка: Цена ↓",
    priceAsc : "Сортировка: Цена ↑",
    name     : "Сортировка: Название A‑Z"
  };
  $("[data-current-sort]").textContent = labelMap[currentSort];
  // подсветка активного
  sortMenu.querySelectorAll("[data-sort]").forEach(btn=>{
    const active = btn.dataset.sort === currentSort;
    btn.classList.toggle("bg-amber-500/15", active);
    btn.classList.toggle("text-amber-300", active);
    btn.querySelector(".icon").classList.toggle("opacity-0", !active);
  });
}
updateSortUI();

sortBtn.addEventListener("click", e=>{
  e.stopPropagation();
  sortMenu.classList.toggle("hidden");
  sortBtn.querySelector("svg").classList.toggle("rotate-180");
});

sortMenu.addEventListener("click", e=>{
  const item = e.target.closest("[data-sort]");
  if (!item) return;
  currentSort = item.dataset.sort;
  updateSortUI();
  sortMenu.classList.add("hidden");
  sortBtn.querySelector("svg").classList.remove("rotate-180");
  applyFilters();
});

document.addEventListener("click", e=>{
  if (!e.target.closest("#sortDropdown")) {
    sortMenu.classList.add("hidden");
    sortBtn.querySelector("svg").classList.remove("rotate-180");
  }
});
})();
