// ============================ script.js ============================

/* === TonConnect === */
const tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
  manifestUrl: "https://max-savik.github.io/alchemy-casino-miniapp/tonconnect-manifest.json",
  buttonRootId: "tonConnectBtn"
});

let tonAddress = null;

tonConnectUI.onStatusChange(async walletInfo => {
  if (!walletInfo) {
    tonAddress = null;
    return;
  }
  tonAddress = walletInfo.account.address;

  // сообщаем серверу, если ещё не привязан
  await postJSON(`${API_ORIGIN}/wallet/link`, {
    userId: myId,
    address: tonAddress
  }).catch(()=>{});

  refreshBalance();
});



async function postJSON(url, data){
  const res = await fetch(url, {
    method: 'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(data)
  });
  if(!res.ok) throw new Error(await res.text());
  return res.json();
}


// накопленный общий угол (в градусах)
var cumulativeRotation = 0;

// ───── Preloader + Lottie ─────
(async function showPreloader() {
  const overlay   = document.getElementById('lottieOverlay');
  const lottieEl  = document.getElementById('lottieContainer');
  // 1) Показываем оверлей
  overlay.style.display = 'flex';

  try {
    // 2) Загружаем JSON-анимацию
    const res  = await fetch('https://nft.fragment.com/gift/bondedring-403.lottie.json');
    const data = await res.json();
    // 3) Убираем фон (если нужно)
    data.layers = data.layers.filter(layer =>
  layer.nm !== 'Background' &&
  layer.nm !== 'Color Icon'
);
    // 4) Запускаем Lottie
    lottie.loadAnimation({
      container:     lottieEl,
      renderer:      'svg',
      loop:          true,
      autoplay:      true,
      animationData: data
    });
  } catch (e) {
    console.error('Ошибка Lottie:', e);
  }
})();

// 1. Подключаемся к бекенду
const API_ORIGIN = "https://alchemy-casino-miniapp.onrender.com";
const socket = io(API_ORIGIN);

/* если env.js не успел загрузиться — fallback */
window.CASINO_WALLET = window.CASINO_WALLET || "";

// 2. Локальное состояние
const inventory = [
  { id:'orb001',          name:'Loot Bag',      price:160, img:'https://nft.fragment.com/gift/lootbag-10075.medium.jpg',   staked:false },
  { id:'pearl42',         name:'Loot Bag',      price:160, img:'https://nft.fragment.com/gift/lootbag-9355.medium.jpg',    staked:false },
  { id:'egg007',          name:'Loot Bag',      price:175, img:'https://nft.fragment.com/gift/lootbag-767.medium.jpg',     staked:false },
  { id:'elixir1',         name:'Vintage Cigar', price:55, img:'https://nft.fragment.com/gift/vintagecigar-19295.medium.jpg', staked:false },
  { id:'cryst66',         name:'Vintage Cigar', price:55, img:'https://nft.fragment.com/gift/vintagecigar-6050.medium.jpg',    staked:false },
  { id:'diamondring-4526',name:'Diamond Ring',  price:26, img:'https://nft.fragment.com/gift/diamondring-4526.medium.jpg',  staked:false },
  { id:'eternalrose-9785',name:'Eternal Rose',  price:25, img:'https://nft.fragment.com/gift/eternalrose-9785.medium.jpg',  staked:false },
  { id:'lovecandle-14932',name:'Love Candle',   price:15,  img:'https://nft.fragment.com/gift/lovecandle-14932.medium.jpg',   staked:false },
  { id:'lovepotion-11784',name:'Love Potion',   price:19,  img:'https://nft.fragment.com/gift/lovepotion-11784.medium.jpg',  staked:false },
  { id:'lovecandle-7853', name:'Love Candle',   price:16,  img:'https://nft.fragment.com/gift/lovecandle-7853.medium.jpg',   staked:false },
];
// Состояние фильтров
let filterName   = "";
let filterMaxPr  =  Infinity;

// Селекторы для элементов управления
const nftSearch     = document.getElementById('nftSearch');
const priceRange    = document.getElementById('priceRange');
const priceValue    = document.getElementById('priceValue');
const selectCount   = document.getElementById('selectCount');
const countValue    = document.getElementById('countValue');
const clearFiltersBtn = document.getElementById('clearFilters');

const selected = new Set();            // NFT, выбранные перед ставкой
const palette  = ['#fee440','#d4af37','#8ac926','#1982c4','#ffca3a','#6a4c93','#d79a59','#218380'];

let players   = [];
let totalUSD  = 0;
let phase     = "waiting";              // waiting | countdown | spinning

// Храним развернутых игроков (по имени) для истории NFT 
const expandedPlayers = new Set();

/* ================= TON BALANCE ================= */
let tonBalance = 0;
async function refreshBalance(){
  try{
    const res = await fetch(`${API_ORIGIN}/wallet/balance?userId=${myId}`);
    const {balance} = await res.json();
    tonBalance = balance;
    document.getElementById('tonBalance').textContent = tonBalance.toFixed(2);
  }catch(e){ console.warn('Balance fetch error',e); }
}

// =========================== Элементы страницы ===========================
const svg         = document.getElementById('wheelSvg');
const list        = document.getElementById('players');
const pot         = document.getElementById('pot');
const picker      = document.getElementById('nftPicker');
const grid        = document.getElementById('profileGrid');
const statusEl    = document.getElementById('countdown');

const depositNFTBtn  = document.getElementById('depositNFT');
const pickerOverlay  = document.getElementById('nftPickerOverlay');
const closePickerBtn = document.getElementById('closePicker');
const placeBetBtn    = document.getElementById('placeBet');
const nftPicker      = document.getElementById('nftPicker');
const historyBtn     = document.getElementById('historyBtn');

const gameSection    = document.getElementById('gameSection');
const marketSection  = document.getElementById('marketSection');
const profileSection = document.getElementById('profileSection');
const earnSection    = document.getElementById('earnSection');
const navGame        = document.getElementById('navGame');
const navMarket      = document.getElementById('navMarket');
const navProfile     = document.getElementById('navProfile');
const navEarn        = document.getElementById('navEarn');
const tonPickerOverlay = document.getElementById('tonPickerOverlay');
const closeTonPickerBtn = document.getElementById('closeTonPicker');
const tonAmountInput = document.getElementById('tonAmount');
const placeTonBetBtn = document.getElementById('placeTonBet');
const depositTONBtn = document.getElementById('depositTON');

/* === Fair Play UI === */
const fairBtn      = document.getElementById('fairBtn');
const fairPanel    = document.getElementById('fairPanel');
const commitFull   = document.getElementById('commitFull');

// Имя пользователя из Telegram
const tgUser = window?.Telegram?.WebApp?.initDataUnsafe?.user || {};
const myName =
  tgUser.username
    || [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ")
    || "Гость";

const myId = tgUser.id || tgUser.user_id || 'guest-' + Math.random().toString(36).slice(2);
// ====================== Локальное Хранилище Истории ======================
// Загружаем историю из localStorage или создаём пустую
let gameHistory = [];
try {
  const saved = localStorage.getItem('gameHistory');
  if (saved) gameHistory = JSON.parse(saved);
} catch (e) {
  console.warn("Не удалось прочитать gameHistory:", e);
}
function formatNumber(num) {
  return num
    .toFixed(2)
    // перед каждой группой из трёх цифр (слева от раздела) вставляем пробел
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
// Добавляем запись и сохраняем
function addToHistory(record) {
  gameHistory.push(record);
  try {
    localStorage.setItem('gameHistory', JSON.stringify(gameHistory));
  } catch (e) {
    console.warn("Не удалось сохранить историю:", e);
  }
}

// ========================== SVG-хелперы ==========================
function polar(cx,cy,r,deg){
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function arc(cx,cy,r,start,end,color){
  const s = polar(cx,cy,r,end),
        e = polar(cx,cy,r,start),
        large = (end - start) <= 180 ? 0 : 1;
  return `<path d="M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y} Z" fill="${color}"/>`;
}

// ========================== РЕНДЕР-ХЕЛПЕРЫ ==========================
// 0. Новая переменная для порядка сортировки
let sortAsc = true;


function cardHTML(nft, extra='') {
  return `
    <div class="nft-card ${extra}" data-id="${nft.id}">
      <img src="${nft.img}" alt="${nft.name}" class="rounded-sm" />
      <div class="text-sm mt-1">${nft.name}</div>
      <div class="text-amber-300 font-semibold">$${nft.price}</div>
    </div>
  `;
}
// Устанавливаем max для слайдера количества
selectCount.max = inventory.length;

function applyFilters(nft) {
  const nameMatch  = nft.name.toLowerCase().includes(filterName);
  const priceMatch = nft.price <= filterMaxPr;
  const notStaked  = !nft.staked;
  return nameMatch && priceMatch && notStaked;
}

function renderPicker() {
  // 2.1 фильтруем
  const filtered = inventory.filter(n => applyFilters(n));

  // 2.2 обновляем max у ползунка количества
  selectCount.max = filtered.length;
  if (+selectCount.value > filtered.length) {
    selectCount.value = 0;
    selected.clear();
    countValue.textContent = '0';
  }

  // 2.3 сортируем по текущему порядку
  const sorted = filtered.sort((a, b) =>
    sortAsc ? a.price - b.price : b.price - a.price
  );

  // 2.4 отрисовываем карточки
  picker.innerHTML = '';
  sorted.forEach(nft => {
    picker.insertAdjacentHTML(
      'beforeend',
      cardHTML(nft, selected.has(nft.id) ? 'selected' : '')
    );
  });

  // 2.5 кнопка «Поставить»
  placeBetBtn.disabled = selected.size === 0;
}

// 3. Обработчик «Количество»
selectCount.addEventListener('input', () => {
  const N = +selectCount.value;
  countValue.textContent = N;
  selected.clear();

  // снова фильтруем + сортируем
  const sorted = inventory
    .filter(n => applyFilters(n))
    .sort((a, b) => sortAsc ? a.price - b.price : b.price - a.price);

  // отмечаем первые N
  sorted.slice(0, N).forEach(n => selected.add(n.id));
  renderPicker();
});


function renderProfile() {
  grid.innerHTML = '';
  inventory.forEach(n => {
    const extra = n.staked ? 'staked' : '';
    grid.insertAdjacentHTML('beforeend', cardHTML(n, extra));
  });
}

function drawWheel() {
  svg.innerHTML = '';
  if (!totalUSD) return;

  let start = -90;
  players.forEach(p => {
    // размер сектора
    const sweep = (p.value / totalUSD) * 360;
    const end = start + sweep;

    // рисуем сектор
    if (players.length > 1) {
      svg.insertAdjacentHTML(
        'beforeend',
        arc(200, 200, 190, start, end, p.color)
          .replace('<path ', '<path data-player="' + p.name + '" ')
      );
    } else {
      svg.insertAdjacentHTML(
        'beforeend',
        `<circle cx="200" cy="200" r="190" fill="${p.color}" data-player="${p.name}"></circle>`
      );
    }

    // позиция и ориентация текста
    const mid = start + sweep / 2;
    const pos = polar(200, 200, 120, mid);
    let angle = mid + 90;
    // если текст окажется "вниз головой", переворачиваем на 180°
    if (angle > 90 && angle < 270) {
      angle += 180;
    }

    // добавляем подпись
    svg.insertAdjacentHTML('beforeend', `
      <text x="${pos.x}" y="${pos.y}"
            transform="rotate(${angle} ${pos.x} ${pos.y})"
            font-size="15"
            fill="#000"
            text-anchor="middle"
            dominant-baseline="middle">
        ${(p.name || "?").length > 14 ? p.name.slice(0, 12) + "…" : p.name}
      </text>
    `);

    start = end;
  });
}

// переключаем панель
fairBtn.onclick = () => {
  fairPanel.classList.toggle('hidden');
  fairBtn.classList.toggle('open');
};

// вывод commit-hash (короткий в кнопке, полный внутри)
function setCommit(hash) {
  if (!hash) return;
  commitFull.textContent  = hash;
}


// Обновляем UI: участников, колесо, picker, профиль
function refreshUI() {
  list.innerHTML = '';

  players.forEach(p => {
    const li = document.createElement('li');
    li.className = 'flex flex-col gap-1 py-2';

    /// ── Ник + ставка в TON + процент
 const headerDiv = document.createElement('div');
 headerDiv.className = 'flex items-center gap-2';

// Имя
const nameEl = document.createElement('span');
nameEl.textContent = p.name;
nameEl.className = 'text-amber-300 font-semibold';

// Сумма в TON с иконкой
const tonWrapper = document.createElement('div');
tonWrapper.className = 'flex items-center gap-1';

const tonIcon = document.createElement('img');
tonIcon.src = "data:image/svg+xml,%3csvg%20width='32'%20height='28'%20viewBox='0%200%2032%2028'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M31.144%205.84244L17.3468%2027.1579C17.1784%2027.4166%2016.9451%2027.6296%2016.6686%2027.7768C16.3922%2027.9241%2016.0817%2028.0009%2015.7664%2028C15.451%2027.9991%2015.141%2027.9205%2014.8655%2027.7716C14.59%2027.6227%2014.3579%2027.4084%2014.1911%2027.1487L0.664576%205.83477C0.285316%205.23695%200.0852825%204.54843%200.0869241%203.84647C0.104421%202.81116%200.544438%201.82485%201.31047%201.10385C2.0765%200.382844%203.10602%20-0.0139909%204.17322%200.000376986H27.6718C29.9143%200.000376986%2031.7391%201.71538%2031.7391%203.83879C31.7391%204.54199%2031.5333%205.23751%2031.1424%205.84244M3.98489%205.13003L14.0503%2020.1858V3.61156H5.03732C3.99597%203.61156%203.5291%204.28098%203.98647%205.13003M17.7742%2020.1858L27.8395%205.13003C28.3032%204.28098%2027.8285%203.61156%2026.7871%203.61156H17.7742V20.1858Z'%20fill='white'/%3e%3c/svg%3e";
tonIcon.alt = 'TON';
tonIcon.width = 16;
tonIcon.height = 16;

const valueEl = document.createElement('span');
valueEl.textContent = formatNumber(p.value);
valueEl.className = 'text-gray-100 text-sm';

tonWrapper.appendChild(tonIcon);
tonWrapper.appendChild(valueEl);

// Процент доли банка
const percEl = document.createElement('span');
percEl.textContent = `· ${((p.value/totalUSD) * 100).toFixed(1)}%`;
percEl.className = 'text-emerald-400 text-xs';

// Собираем
headerDiv.appendChild(nameEl);
headerDiv.appendChild(tonWrapper);
headerDiv.appendChild(percEl);


    // ── Иконки NFT (отсортированы по цене, максимум 24, с развёрткой/сокрытием)
    const iconsWrapper = document.createElement('div');
    iconsWrapper.className = 'flex flex-wrap items-center gap-2 mt-1';

    const sortedNFTs = [...p.nfts].sort((a,b) => b.price - a.price);
    const isExpanded = expandedPlayers.has(p.name);
    const maxToShow  = 24;

    // Утилита: создаёт «нарядную» NFT-иконку с hover-ценой
function makeNFTIcon(nftObj) {
  const wrapper = document.createElement('div');
  wrapper.className = [
    'nft-icon',
    'relative w-8 h-8 rounded-md overflow-hidden',
    'shadow-lg border border-gray-600'
  ].join(' ');
  wrapper.style.cursor = 'pointer';

  const img = document.createElement('img');
  img.src = nftObj.img;
  img.alt = nftObj.id;
  img.className = 'w-full h-full object-cover';
  wrapper.appendChild(img);

  const priceBadge = document.createElement('div');
  priceBadge.className = 'price-badge absolute bottom-0 left-0 inline-flex items-center justify-center bg-gray-900/80 text-xs text-amber-300 px-1';
  priceBadge.innerHTML = `
    ${nftObj.price.toFixed(2)}
    <img src="data:image/svg+xml,…" alt="TON" class="inline-block ml-0.25" />
  `;
  wrapper.appendChild(priceBadge);

wrapper.addEventListener('click', () => {
    // 1) Скрыть все другие
    document.querySelectorAll('.nft-icon.expanded').forEach(el => {
      if (el !== wrapper) {
        el.classList.remove('expanded');
        const badge = el.querySelector('.price-badge');
        badge && badge.classList.remove('show');
      }
    });

    // 2) Переключить текущее
    const willExpand = !wrapper.classList.contains('expanded');
    wrapper.classList.toggle('expanded', willExpand);
    priceBadge.classList.toggle('show', willExpand);
  });



  return wrapper;
}




    if (sortedNFTs.length <= maxToShow || isExpanded) {
      // Показываем все NFT
      sortedNFTs.forEach(nftObj => {
        iconsWrapper.appendChild(makeNFTIcon(nftObj));
      });
      if (sortedNFTs.length > maxToShow) {
        const hideBtn = document.createElement('button');
        hideBtn.textContent = 'Скрыть';
        hideBtn.className = `
          ml-1 
          text-xs 
          text-red-400 
          hover:text-red-600 
          hover:underline
        `;
        hideBtn.addEventListener('click', () => {
          expandedPlayers.delete(p.name);
          refreshUI();
        });
        iconsWrapper.appendChild(hideBtn);
      }
    } else {
      // Показываем только первые 24
      sortedNFTs.slice(0, maxToShow).forEach(nftObj => {
        iconsWrapper.appendChild(makeNFTIcon(nftObj));
      });
      const showAllBtn = document.createElement('button');
      showAllBtn.textContent = 'Показать все';
      showAllBtn.className = `
        ml-1 
        text-xs 
        text-blue-400 
        hover:text-blue-600 
        hover:underline
      `;
      showAllBtn.addEventListener('click', () => {
        expandedPlayers.add(p.name);
        refreshUI();
      });
      iconsWrapper.appendChild(showAllBtn);
    }

    // Собираем li
    li.appendChild(headerDiv);
    li.appendChild(iconsWrapper);
    list.appendChild(li);
  });

  pot.textContent = `${formatNumber(totalUSD)} TON`;
  drawWheel();
  renderPicker();
  renderProfile();
}
// Поиск по имени
nftSearch.addEventListener('input', () => {
  filterName = nftSearch.value.trim().toLowerCase();
  renderPicker();
});

// Ограничение по цене
priceRange.addEventListener('input', () => {
  const v = +priceRange.value;
  filterMaxPr = v;
  priceValue.textContent = v;
  renderPicker();
});

// Сброс всех фильтров и перерисовка
clearFiltersBtn.addEventListener('click', () => {
  // 1) Очистить текст поиска
  filterName = "";
  nftSearch.value = "";

  // 2) вернуть цену на максимум
  filterMaxPr = Infinity;
  priceRange.value = priceRange.max;
  priceValue.textContent = priceRange.value;

  // 3) обнулить селектор количества
  selectCount.value = 0;
  countValue.textContent = '0';

  // 4) Сбросить порядок сортировки (если нужно)
  sortAsc = true;
  document.getElementById('toggleSort')
          .querySelector('svg')
          .classList.remove('rotate-180');

  // 5) Очистить выбранные NFT
  selected.clear();

  // 6) Перерисовать окно выбора
  renderPicker();
});

// ========================= SOCKET EVENTS =========================
// При подключении сразу слать текущее состояние
socket.on("state", s => {
  players  = s.players;
  totalUSD = s.totalUSD;
  phase    = s.phase;

  window.players  = s.players;
  window.totalUSD = s.totalUSD;

  if (players.length === 0) {
    // Новый раунд: сбрасываем UI
    inventory.forEach(n => n.staked = false);
    lockBets(false);
    updateStatus();
  }
  if (s.commitHash) setCommit(s.commitHash);
  refreshUI();
  // убираем оверлей и показываем страницу
  const overlay = document.getElementById('lottieOverlay');
  if (overlay) overlay.remove();
  const main = document.getElementById('mainContent');
// немного даём браузеру применить начальное состояние
requestAnimationFrame(() => {
  main.classList.remove('opacity-0');
  main.classList.add('opacity-100');
});

  if (s.phase === "countdown") {
    updateStatus(Math.ceil((s.endsAt - Date.now()) / 1000));
  } else {
    updateStatus();
  }
});

socket.on("countdownStart", ({ endsAt, commitHash  }) => {
    if (commitHash) setCommit(commitHash);
  phase = "countdown";
  updateStatus(Math.ceil((endsAt - Date.now()) / 1000));
});
socket.on("countdownTick", ({ remaining }) => {
  phase = "countdown";
  updateStatus(Math.ceil(remaining / 1000));
});

let lastSpin = { players: [], seed: null };

socket.on("spinStart", ({ players: list, winner, spins, seed, offsetDeg, commitHash }) => {
    lastSpin.players = list.map(p => ({ name: p.name, value: p.value }));
  lastSpin.seed    = seed;
  lastSpin.serverWinner = winner.name; 
  players  = list;
  totalUSD = list.reduce((a,b) => a + b.value, 0);
  phase    = "spinning";
  lockBets(true);
  updateStatus();

  
  // Запускаем анимацию, передав spins
  runSpinAnimation(winner, spins, offsetDeg);
});

socket.on("spinEnd", ({ winner, total, seed  }) => {
  lockBets(false);
  phase = "waiting";
  updateStatus();

  // Собираем полную информацию о раунде:
  const record = {
    timestamp: new Date().toISOString(),
    winner:    winner.name,
    total:     total,
    participants: players.map(p => ({
      name: p.name,
      nfts: p.nfts  // массив {id, img, price}
    }))
  };
  addToHistory(record);

  /* если это мы – подтянуть новый баланс (приз уже начислен на сервере) */
   if (winner.userId === myId) {
     refreshBalance();

    /* вкладка «История» уже открыта? – сразу обновим список */
    if (typeof loadTxHistory === 'function' &&
        !panelTx.classList.contains('hidden')) {
      loadTxHistory();
    }
   }
});

socket.on('balanceUpdate', ({userId,balance})=>{
  if(userId===myId){
    tonBalance = balance;
    document.getElementById('tonBalance').textContent = tonBalance.toFixed(2);
  }
});

      
function makeDepositPayload(uid){
  const bytes = new TextEncoder().encode(`deposit:${uid}`);
  return btoa(String.fromCharCode(...bytes));   // => base64 string
}

    
// ───── byte-array → hex string helper ─────
function bufToHex(buf) {
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Тот же самый rnd, что на сервере:
 *   rnd = int( first16hex( sha256(seed + "spin") ) ) / 0xffffffffffffffff
 */
async function rndFromSeed(seed) {
  const data = new TextEncoder().encode(seed + "spin");
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hex     = bufToHex(hashBuf).slice(0, 16); // первые 64 бита
  return parseInt(hex, 16) / 0xffffffffffffffff;
}

/*  пересчитываем победителя 1-в-1 с сервером  */
async function weightedPick(seed, players) {
  const rnd   = await rndFromSeed(seed);
  const total = players.reduce((s, p) => s + p.value, 0);
  const ticket = rnd * total;

  let acc = 0;
  for (const p of players) {
    acc += p.value;
    if (ticket <= acc) return p;
  }
  return players.at(-1);
}



// ==================== АНИМАЦИИ & УТИЛИТЫ ====================
function highlightWinner(winner){
  const slice = svg.querySelectorAll(`[data-player="${winner.name}"]`);
  slice.forEach(el => {
    gsap.fromTo(el,
      { filter: 'brightness(1)' },
      { filter: 'brightness(2.2)', duration: .4, yoyo:true, repeat:5 }
    );
  });
}

function runSpinAnimation(winner, spins, offsetDeg) {
  /* 1. Угол, с которого начинается сектор победителя
        (счёт идёт от −90°, потому что первый сектор рисуется вверх). */
  let startAngle = -90;
  for (const p of players) {
    const sweep = (p.value / totalUSD) * 360;
    if (p.name === winner.name) break;
    startAngle += sweep;
  }

  /* 2. Точка в секторе, куда «должна попасть» стрелка */
  const targetSectorAngle = startAngle + offsetDeg;   // градусы колеса ДО поворота

  /* 3. Колесо уже могло быть повернуто с прошлых раундов */
  const currentWheelDeg = ((cumulativeRotation % 360) + 360) % 360; // 0‥359

  /* 4. Стрелка смотрит вверх: в нашей системе это 0°                  */
  const arrowAngle = 0;

  /* 5. Сколько ещё докрутить, чтобы target оказался под стрелкой      */
  let correction = (arrowAngle - targetSectorAngle - currentWheelDeg) % 360;
  if (correction < 0) correction += 360;   // делаем неотрицательной

  /* 6. Финальный приращение = полные обороты + корректура             */
  const delta = spins * 360 + correction;

  /* 7. Копим общий угол, анимируем GSAP-ом и подсвечиваем победителя   */
  cumulativeRotation += delta;

  gsap.to('#wheelSvg', {
    rotation: cumulativeRotation,
    duration: 6,
    ease: 'power4.out',
    transformOrigin: '50% 50%',
    onComplete: () => highlightWinner(winner)
  });
}




function lockBets(lock){
  placeBetBtn.disabled = lock;
}

function updateStatus(sec = null){
  if (phase === "waiting"){
    statusEl.textContent = "Ожидание игроков...";
  } else if (phase === "countdown"){
    statusEl.textContent = sec && sec > 0
      ? `Таймер: ${sec} сек`
      : "Раунд начинается!";
  } else if (phase === "spinning"){
    statusEl.textContent = "Игра началась!";
  }
}

// =================== PICKER & BET ===================
// Открываем модальное окно выбора NFT
depositNFTBtn.addEventListener('click', () => {
  renderPicker();
  selected.clear();
  renderPicker();
  placeBetBtn.disabled = true;
  pickerOverlay.classList.remove('hidden');
});

// Закрываем окно без ставки
closePickerBtn.addEventListener('click', () => {
  pickerOverlay.classList.add('hidden');
  selected.clear();
  renderPicker();
});

// Клик по NFT-карточке
nftPicker.addEventListener('click', e => {
  const card = e.target.closest('.nft-card');
  if (!card) return;
  const id = card.dataset.id;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderPicker();
  placeBetBtn.disabled = selected.size === 0;
});

// Нажата кнопка «Поставить выбранные»
placeBetBtn.addEventListener('click', () => {
  if (selected.size === 0) {
    alert("Выберите хотя бы один NFT");
    return;
  }
  const nfts = Array.from(selected).map(id => {
    const n = inventory.find(x => x.id === id);
    return { id: n.id, price: n.price, img: n.img };
  });

  nfts.forEach(x => {
    const item = inventory.find(y => y.id === x.id);
    if (item) item.staked = true;
  });

  selected.clear();
  renderProfile();
  renderPicker();
  pickerOverlay.classList.add('hidden');
  socket.emit("placeBet", { userId: myId, name: myName, nfts });
});
/* ======== Открываем TON-пикер ======== */
depositTONBtn.addEventListener('click', () => {
  tonPickerOverlay.classList.add('show');
  tonAmountInput.value = '';
  placeTonBetBtn.disabled = true;
});

/* ======== Закрываем TON-пикер без ставки ======== */
closeTonPickerBtn.addEventListener('click', () => {
  tonPickerOverlay.classList.remove('show');
  tonAmountInput.value = '';
});

/* ======== Проверяем ввод суммы TON ======== */
tonAmountInput.addEventListener('input', () => {
  const val = parseFloat(tonAmountInput.value);
  placeTonBetBtn.disabled = !(val > 0);
});

placeTonBetBtn.addEventListener('click', async () => {
  const amount = parseFloat(tonAmountInput.value);
  if (!(amount>0)) return;

  // 1) Проверяем баланс
  if (tonBalance < amount){
    alert('Недостаточно TON на балансе!');
    return;
  }

  // 3) Отправляем ставку в Socket.IO
  const tonToken = {
    id: `ton-${Date.now()}`,
    img:"https://pbs.twimg.com/profile_images/1602985148219260928/VC-Mraev_400x400.jpg",
    price: amount
  };

  tonPickerOverlay.classList.remove('show');
  tonAmountInput.value = '';

  const {balance} = await postJSON(`${API_ORIGIN}/wallet/withdraw`,
               {userId: myId, amount, purpose:'bet'});
  tonBalance = balance;
  document.getElementById('tonBalance').textContent = tonBalance.toFixed(2);

socket.emit('placeBet', { userId: myId, name: myName, nfts:[tonToken] });                        
});


const toggleBtn = document.getElementById('toggleSort');
const svgIcon   = toggleBtn.querySelector('svg');

toggleBtn.addEventListener('click', () => {
  sortAsc = !sortAsc;
  // поворачиваем SVG на 180° или сбрасываем
  svgIcon.classList.toggle('rotate-180', !sortAsc);
  renderPicker();
});

// =================== SIMPLE NAV ===================
navGame.addEventListener('click',   () => show('game'));
navMarket.addEventListener('click', () => show('market'));
navProfile.addEventListener('click',() => show('profile'));
navEarn.addEventListener('click',   () => show('earn'));
function show(view){
  gameSection   .classList.toggle('hidden', view !== 'game');
  profileSection.classList.toggle('hidden', view !== 'profile');
  marketSection .classList.toggle('hidden', view !== 'market');
  earnSection   .classList.toggle('hidden', view !== 'earn');

  navGame   .classList.toggle('active', view === 'game');
  navMarket .classList.toggle('active', view === 'market');
  navProfile.classList.toggle('active', view === 'profile');
  navEarn   .classList.toggle('active', view === 'earn');
}

/* ========== WALLET DEPOSIT ========== */
const walletOverlay   = document.getElementById('walletOverlay');
const walletCloseBtn  = document.getElementById('walletClose');
const walletAmountInp = document.getElementById('walletAmount');
const walletDepositBtn= document.getElementById('walletDepositBtn');
const walletBtn       = document.getElementById('openWalletWindow');   
const withdrawInp   = document.getElementById('withdrawAmount');
const walletWithdrawBtn = document.getElementById('walletWithdrawBtn');
const tabTx       = document.getElementById('tabTx');
const panelTx     = document.getElementById('panelTx');

walletBtn.addEventListener('click', () => {
  walletAmountInp.value = '';
  walletDepositBtn.disabled = true;
  walletOverlay.classList.remove('hidden');
});

walletCloseBtn.addEventListener('click', () => {
  walletOverlay.classList.add('hidden');
});

walletAmountInp.addEventListener('input', () => {
  const v = parseFloat(walletAmountInp.value);
  walletDepositBtn.disabled = !(v>0);
});

walletDepositBtn.addEventListener('click', async () => {
  const amt = parseFloat(walletAmountInp.value);
  if(!(amt>0)) return;

  try{
    await tonConnectUI.sendTransaction({
      validUntil: Math.floor(Date.now()/1e3)+300,
      messages:[{
        address : window.CASINO_WALLET,      // из /env.js
        amount  : (amt*1e9).toString(),      // в нано-ton
        payload : makeDepositPayload(myId)   // “deposit:<telegramId>”
      }]
    });

    // показываем «Ждём подтверждения…» – баланс придёт с сервера
    walletAmountInp.value = '';
    walletDepositBtn.disabled = true;
    alert('Транзакция отправлена!\nБаланс обновится после подтверждения сети.');
  }catch(e){
    alert('Платёж отклонён: '+e.message);
  }
});


walletWithdrawBtn.addEventListener('click', async () => {
  const amt = parseFloat(withdrawInp.value);
  if(!(amt>0)) return;
  try{
    const {balance} = await postJSON(`${API_ORIGIN}/wallet/withdraw`,
                                     {userId:myId, amount:amt});
    tonBalance = balance;
    document.getElementById('tonBalance').textContent = tonBalance.toFixed(2);
    walletOverlay.classList.add('hidden');
  }catch(e){ alert('Withdraw error: '+e.message); }
});


/* ===== Переключение вкладок ===== */
const tabDeposit   = document.getElementById('tabDeposit');
const tabWithdraw  = document.getElementById('tabWithdraw');
const panelDeposit = document.getElementById('panelDeposit');
const panelWithdraw= document.getElementById('panelWithdraw');

function setTab(which){               // 'dep' | 'wd'
  const dep = which==='dep', wd = which==='wd', tx = which==='tx';

  /* Deposit кнопка */
 tabDeposit.classList.toggle('bg-amber-500/90',  dep);
 tabDeposit.classList.toggle('text-gray-900',    dep);
 tabDeposit.classList.toggle('font-semibold',    dep);
 tabDeposit.classList.toggle('bg-gray-700/60',  !dep);
 tabDeposit.classList.toggle('text-gray-300',   !dep);

  /* Withdraw кнопка */
 tabWithdraw.classList.toggle('bg-amber-500/90', wd);
 tabWithdraw.classList.toggle('text-gray-900',   wd);
 tabWithdraw.classList.toggle('font-semibold',   wd);
 tabWithdraw.classList.toggle('bg-gray-700/60', !wd);
 tabWithdraw.classList.toggle('text-gray-300',  !wd);

  tabTx      .classList.toggle('bg-amber-500/90', tx);
  tabTx      .classList.toggle('text-gray-900',   tx);
  tabTx      .classList.toggle('font-semibold',   tx);
  tabTx      .classList.toggle('bg-gray-700/60', !tx);
  tabTx      .classList.toggle('text-gray-300', !tx);

  panelDeposit .classList.toggle('hidden', !dep);
  panelWithdraw.classList.toggle('hidden', !wd);
  panelTx      .classList.toggle('hidden', !tx);

  if (tx) loadTxHistory();        // подгружаем при открытии
}

tabDeposit .addEventListener('click', () => setTab('dep'));
tabWithdraw.addEventListener('click', () => setTab('wd'));
tabTx.addEventListener('click', ()=>setTab('tx'));
// при загрузке — depósito активен
setTab('dep');


withdrawInp.addEventListener('input', () => {
  const v = parseFloat(withdrawInp.value);
  walletWithdrawBtn.disabled = !(v>0);
});

async function loadTxHistory(){
  panelTx.innerHTML = '<div class="py-2 text-center text-gray-400">Загрузка…</div>';
  try{
    const res = await fetch(`${API_ORIGIN}/wallet/history?userId=${myId}&limit=50`);
    const arr = await res.json();
    if(arr.length===0){
      panelTx.innerHTML = '<div class="py-4 text-center text-gray-400">Пока пусто</div>';
      return;
    }
    panelTx.innerHTML = '';
    arr.forEach(t=>{
      const dt    = new Date(t.ts).toLocaleString();
      const label = ({
        deposit : 'Пополнение',
        withdraw: 'Вывод',
        bet     : 'Ставка',
        prize   : 'Выигрыш'
      })[t.type] || t.type;

      const plusTypes = ['deposit','prize'];
      const sign = plusTypes.includes(t.type) ? '+' : '−';
      const clr  = plusTypes.includes(t.type) ? 'text-emerald-400'
                                              : 'text-rose-400';
     panelTx.insertAdjacentHTML('beforeend', `
   <div class="flex justify-between items-center py-2 px-1">
     <div class="flex items-center gap-1 ${clr}">
       <img src="data:image/svg+xml,%3csvg%20width='32'%20height='28'%20viewBox='0%200%2032%2028'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M31.144%205.84244L17.3468%2027.1579C17.1784%2027.4166%2016.9451%2027.6296%2016.6686%2027.7768C16.3922%2027.9241%2016.0817%2028.0009%2015.7664%2028C15.451%2027.9991%2015.141%2027.9205%2014.8655%2027.7716C14.59%2027.6227%2014.3579%2027.4084%2014.1911%2027.1487L0.664576%205.83477C0.285316%205.23695%200.0852825%204.54843%200.0869241%203.84647C0.104421%202.81116%200.544438%201.82485%201.31047%201.10385C2.0765%200.382844%203.10602%20-0.0139909%204.17322%200.000376986H27.6718C29.9143%200.000376986%2031.7391%201.71538%2031.7391%203.83879C31.7391%204.54199%2031.5333%205.23751%2031.1424%205.84244M3.98489%205.13003L14.0503%2020.1858V3.61156H5.03732C3.99597%203.61156%203.5291%204.28098%203.98647%205.13003M17.7742%2020.1858L27.8395%205.13003C28.3032%204.28098%2027.8285%203.61156%2026.7871%203.61156H17.7742V20.1858Z'%20fill='white'/%3e%3c/svg%3e"
            alt="TON" class="w-4 h-4">
       <span>${sign}${t.amount}</span>
     </div>
        <div class="text-right">
     <div class="text-gray-400 text-xs">${dt}</div>
     <div class="text-gray-500 text-[10px]">${label}</div>
   </div>
   </div>`);
    });
  }catch(e){
    panelTx.innerHTML = '<div class="py-2 text-center text-rose-400">Ошибка загрузки</div>';
  }
}

// =================== HISTORY BUTTON ===================
historyBtn.addEventListener('click', () => {
  window.location.href = 'history.html';
});

// ======================= BUBBLES/STEAM =======================
const cauldron = document.getElementById('cauldron');
function spawnBubble(){
  const b = document.createElement('span');
  b.className = 'bubble';
  b.style.left = Math.random() * 80 + 10 + '%';
  const s = 10 + Math.random() * 16;
  b.style.width = b.style.height = s + 'px';
  b.style.animation = `rise ${4 + Math.random() * 3}s ease-in forwards`;
  cauldron.appendChild(b);
  setTimeout(() => b.remove(), 7000);
}
setInterval(spawnBubble, 1000);
gsap.fromTo('#steam', { scale: .6, opacity: 0 }, {
  scale: 1.4,
  opacity: .55,
  y: -90,
  duration: 5,
  repeat: -1,
  ease: 'power1.out',
  repeatDelay: 1.2
});

// ======================= INIT =======================
show('game');
refreshUI();
refreshBalance();  

// Навешиваем один раз
const copyBtn = document.getElementById('copyCommit');
if (copyBtn) {
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(commitFull.textContent)
      .then(() => {
        copyBtn.classList.add('text-emerald-400');
        setTimeout(() => copyBtn.classList.remove('text-emerald-400'), 700);
      })
      .catch(() => alert('Не удалось скопировать'));
  });
}
