/* === CONSTANTS === */
const API_ORIGIN = "https://alchemy-casino-miniapp.onrender.com";
let jwtToken   = localStorage.getItem("jwt") || null;
const TON_LABEL = "TON";
let gifts      = [];             // оригинальный список
let viewGifts  = [];             // после фильтра / сортировки
let selected   = new Set();      // ownedId
let tonBalance = 0;
let currentSort = "priceDesc";
let modelFilter = null;          // null = все модели
let modelsMap   = new Map();     // modelName -> {count, img}

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

/* === MODEL HELPERS === */
function extractModel(name="") {
  // Берём всё до первого дефиса. Если нет дефиса, полное имя = модель
  const m = name.split("-")[0].trim();
  return m || name;
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
    img   : buildImgLink(g),
    model : extractModel(g.name)
  }));
  selected.clear(); 
  // сформируем карту моделей
  rebuildModelsMap();
  buildModelMenu();
  applyFilters();
}

function rebuildModelsMap(){
  modelsMap.clear();
  gifts.forEach(g=>{
    if(!modelsMap.has(g.model)) modelsMap.set(g.model,{count:0, imgs:[]});
    const rec = modelsMap.get(g.model);
    rec.count++;
    if(rec.imgs.length<5) rec.imgs.push(g.img); // запас для рандома
  });
}

/* === MODEL MENU (global) === */
function buildModelMenu(){
  const modelMenu = $("#modelMenu");
  if(!modelMenu) return;

  const items = [];
  // «Все модели»
  items.push(`
    <button class="model-item ${modelFilter? "":"active"}" data-model="">
      <img src="https://nft.fragment.com/gift/deskcalendar-190442.medium.jpg" alt="">
      <span>Все модели</span>
      <span class="count">${gifts.length}</span>
    </button>
  `);

  modelsMap.forEach((info,name)=>{
    const rndImg = info.imgs[Math.floor(Math.random()*info.imgs.length)];
    items.push(`
      <button class="model-item ${modelFilter===name?"active":""}" data-model="${name}">
        <img src="${rndImg}" alt="${name}">
        <span>${name}</span>
        <span class="count">${info.count}</span>
      </button>
    `);
  });
  modelMenu.innerHTML = items.join("");
}

function updateModelUI(){
  const labelEl = $("[data-current-model]");
  if (labelEl) {
    labelEl.textContent = modelFilter ? `Модель: ${modelFilter}` : "Модель: Все";
  }
  const modelMenu = $("#modelMenu");
  if(!modelMenu) return;
  modelMenu.querySelectorAll(".model-item").forEach(btn=>{
    btn.classList.toggle(
      "active",
      (btn.dataset.model||"") === (modelFilter||"")
    );
  });
}

/* === SELECT‑ALL === */
const checkAllEl = $("#checkAll");
function eligibleVisible(g){ return g.status === "idle"; }

// убрать из selected всё, чего уже нет/или не idle
function pruneSelection(){
  selected.forEach(id=>{
    const g = gifts.find(x=>x.id===id);
    if(!g || g.status!=="idle") selected.delete(id);
  });
}

// синхронизируем состояние чекбокса «выбрать все»
function syncCheckAll(){
  const total = viewGifts.filter(eligibleVisible).length;
  const sel   = viewGifts.filter(g=>eligibleVisible(g) && selected.has(g.id)).length;
  checkAllEl.checked       = total>0 && sel===total;
  checkAllEl.indeterminate = sel>0 && sel<total;
}

function toggleSelectAll(checked){
  const ids = viewGifts.filter(eligibleVisible).map(g=>g.id);
  if(checked){
    ids.forEach(id=>selected.add(id));
  }else{
    ids.forEach(id=>selected.delete(id));
  }
  renderGrid();
}


checkAllEl.addEventListener("change", e=>{
  toggleSelectAll(e.target.checked);
});

/* === UI RENDER === */
function giftCardHTML(g) {
  const sel  = selected.has(g.id);
  const pend = g.status === "pending_withdraw";
  const priceStr = (parseFloat(g.price) || 0).toFixed(2);

  return `
    <div data-id="${g.id}" class="nft-card ${sel?'selected':''} ${pend?'opacity-60 pointer-events-none':''}">
      <img src="${g.img}" alt="${g.name}" class="nft-img"
           onerror="this.onerror=null;this.src='${g.img}';">

      <div class="price-chip">${priceStr}&nbsp;${TON_LABEL}</div>

      <div class="title-badge" title="${g.name}">${g.name}</div>

      <input type="checkbox" class="selBox" ${sel?"checked":""} ${pend?"disabled":""}/>
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

  // различать: вообще нет подарков vs по фильтру/поиску ничего не нашлось
  const emptyState = $("#emptyState");
  if (viewGifts.length === 0) {
    if (gifts.length === 0) {
      // стандартное сообщение (у вас пока нет подарков)
      emptyState.innerHTML = `
       <div class="mb-2">У вас пока нет подарков.</div>
       <div class="text-sm">
          Чтобы передать подарки, отправьте их аккаунту 
          <a href="https://t.me/themis_transfer" target="_blank" 
             class="text-amber-300 underline font-semibold hover:text-amber-400">
            @themis_transfer
          </a>.
        </div>`;
    } else {
      // по фильтру / поиску ничего не найдено
      emptyState.innerHTML = `
        <div class="mb-2">По вашему запросу подарков не найдено.</div>
        <div class="text-sm">
          Попробуйте изменить фильтр или поиск.
        </div>`;
    }
    emptyState.classList.remove("hidden");
  } else {
    emptyState.classList.add("hidden");
  }

  pruneSelection();
  syncCheckAll();
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
  btn.querySelector("[data-caption]").textContent = "Вывести";
  btn.disabled = sel === 0;
}

/* === FILTER / SORT === */
function applyFilters() {
  const q = $("#searchInput").value.trim().toLowerCase();

  viewGifts = gifts.filter(g =>
       (g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q)) &&
       (!modelFilter || g.model === modelFilter)
  );

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
  try {
    /* один чек на все выбранные подарки */
    const { link } = await postJSON("/wallet/withdrawGift", { ownedIds: ids });

    /* локально помечаем подарки как pending */
    ids.forEach(id => {
      const g = gifts.find(x => x.id === id);
      if (g) g.status = "pending_withdraw";
    });
    applyFilters();

    /* открываем инвойс */
    if (window.Telegram?.WebApp?.openInvoice) {
      Telegram.WebApp.openInvoice(link);
    } else {
      window.open(link, "_blank");
    }
  } catch (e) {
    alert("Ошибка: " + e.message);
  } finally {
    selected.clear();
  }
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
  if (!labelMap[currentSort]) currentSort = "priceDesc";
  $("[data-current-sort]").textContent = labelMap[currentSort];
  // подсветка активного
  sortMenu.querySelectorAll("[data-sort]").forEach(btn=>{
    const active = btn.dataset.sort === currentSort;
    btn.classList.toggle("bg-amber-500/15", active);
    btn.classList.toggle("text-amber-300", active);
    btn.querySelector(".icon").classList.toggle("opacity-0", !active);
  });
  updateModelUI();
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
/* ========= MODEL DROPDOWN ========= */
const modelBtn   = $("#modelBtn");
const modelMenu  = $("#modelMenu");
const modelDrop  = $("#modelDropdown");


modelBtn?.addEventListener("click", e=>{
  e.stopPropagation();
  modelMenu.classList.toggle("hidden");
  modelBtn.querySelector("svg").classList.toggle("rotate-180");
});

modelMenu?.addEventListener("click", e=>{
  const item = e.target.closest(".model-item");
  if(!item) return;
  modelFilter = item.dataset.model || null;
  updateModelUI();
  modelMenu.classList.add("hidden");
  modelBtn.querySelector("svg").classList.remove("rotate-180");
  applyFilters();
});

document.addEventListener("click", e=>{
  if (!e.target.closest("#modelDropdown")) {
    modelMenu.classList.add("hidden");
    modelBtn?.querySelector("svg")?.classList.remove("rotate-180");
  }
});
})();
