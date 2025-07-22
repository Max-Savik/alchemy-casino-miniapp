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

function ensureTonIcon() {
  const pill = document.querySelector(".ton-pill");
  if (!pill) return;
  let tonIcon = pill.querySelector("img[data-ton]");
  if (!tonIcon) {
    tonIcon = document.createElement("img");
    tonIcon.dataset.ton = "1";
    pill.prepend(tonIcon);
  }
  tonIcon.src = "data:image/svg+xml,%3csvg%20width='32'%20height='28'%20viewBox='0%200%2032%2028'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M31.144%205.84244L17.3468%2027.1579C17.1784%2027.4166%2016.9451%2027.6296%2016.6686%2027.7768C16.3922%2027.9241%2016.0817%2028.0009%2015.7664%2028C15.451%2027.9991%2015.141%2027.9205%2014.8655%2027.7716C14.59%2027.6227%2014.3579%2027.4084%2014.1911%2027.1487L0.664576%205.83477C0.285316%205.23695%200.0852825%204.54843%200.0869241%203.84647C0.104421%202.81116%200.544438%201.82485%201.31047%201.10385C2.0765%200.382844%203.10602%20-0.0139909%204.17322%200.000376986H27.6718C29.9143%200.000376986%2031.7391%201.71538%2031.7391%203.83879C31.7391%204.54199%2031.5333%205.23751%2031.1424%205.84244M3.98489%205.13003L14.0503%2020.1858V3.61156H5.03732C3.99597%203.61156%203.5291%204.28098%203.98647%205.13003M17.7742%2020.1858L27.8395%205.13003C28.3032%204.28098%2027.8285%203.61156%2026.7871%203.61156H17.7742V20.1858Z'%20fill='white'/%3e%3c/svg%3e";
  tonIcon.className = "w-4 h-4";
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
      <img src="${g.img}"
           alt="${g.name}"
           class="w-full aspect-square object-cover rounded-t-xl"
           onerror="this.onerror=null;this.src='${g.img}';">
      <div class="px-2 py-1 flex justify-between items-center text-xs sm:text-sm">
 <span class="truncate drop-shadow-sm">${g.name}</span>
 <span class="font-semibold text-amber-300 drop-shadow-sm">${g.price} ${TON_LABEL}</span>
      </div>

      ${
        pend
          ? `<div class="absolute inset-0 bg-black/60 backdrop-blur-sm
                     flex flex-col items-center justify-center gap-1
                     text-amber-300 text-[11px] font-semibold uppercase tracking-wider">
                 <svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" stroke-width="2">
                   <circle cx="12" cy="12" r="10" class="opacity-25"/>
                   <path d="M12 6v6l3 3" stroke-linecap="round" stroke-linejoin="round"/>
                 </svg>
                 вывод
             </div>`
          : `<button class="quickWithdraw absolute top-2 right-2 bg-amber-500/90 hover:bg-amber-500
                            text-gray-900 px-1.5 py-0.5 rounded shadow flex items-center justify-center"
                      title="Вывести">
               <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <rect x="5" y="13" width="14" height="6" rx="2" />
                 <path d="M12 3v10" />
                 <path d="M8.5 7.5 12 4l3.5 3.5" />
               </svg>
             </button>`
      }
      <input type="checkbox"
             class="selBox absolute top-2 left-2 w-4 h-4 accent-amber-500"
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
ensureTonIcon();
