const socket = io("https://alchemy-casino-miniapp.onrender.com");

/* Временный мок баланса TON */
function setBalance(amount){
  document.getElementById("tonBalance").textContent =
        parseFloat(amount).toFixed(2);
}

/* Имя текущего пользователя из Telegram */
const tgUser = window?.Telegram?.WebApp?.initDataUnsafe?.user || {};
const myName =
      tgUser.username
   || [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ")
   || "Гость";

/* SAMPLE INVENTORY */
const inventory = [
  { id:'orb001',  name:'Loot Bag',         price:40, img:'https://nft.fragment.com/gift/lootbag-10075.medium.jpg', staked:false },
  { id:'pearl42', name:'Loot Bag',         price:40, img:'https://nft.fragment.com/gift/lootbag-9355.medium.jpg',  staked:false },
  { id:'egg007',  name:'Loot Bag',         price:45, img:'https://nft.fragment.com/gift/lootbag-767.medium.jpg',   staked:false },
  { id:'elixir1', name:'Vintage Cigar',    price:25, img:'https://nft.fragment.com/gift/vintagecigar-19295.medium.jpg', staked:false },
  { id:'cryst66', name:'Vintage Cigar',    price:25, img:'https://nft.fragment.com/gift/vintagecigar-6050.medium.jpg',  staked:false },
  { id:'diamondring-4526',  name:'Diamond Ring',         price:11, img:'https://nft.fragment.com/gift/diamondring-4526.medium.jpg', staked:false },
  { id:'eternalrose-9785', name:'Eternal Rose',         price:10, img:'https://nft.fragment.com/gift/eternalrose-9785.medium.jpg',  staked:false },
  { id:'lovecandle-14932',  name:'Love Candle',         price:7, img:'https://nft.fragment.com/gift/lovecandle-14932.medium.jpg',   staked:false },
  { id:'lovepotion-11784', name:'Love Potion',    price:6, img:'https://nft.fragment.com/gift/lovepotion-11784.medium.jpg', staked:false },
  { id:'lovecandle-7853', name:'Love Candle',    price:5, img:'https://nft.fragment.com/gift/lovecandle-7853.medium.jpg',  staked:false },
];

/* SVG-helpers */
function polar(cx,cy,r,deg){
  const rad = (deg - 90)*Math.PI/180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function arc(cx,cy,r,start,end,color){
  const s = polar(cx,cy,r,end),
        e = polar(cx,cy,r,start),
        large = end - start <= 180 ? 0 : 1;
  return `<path d="M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y} Z" fill="${color}"/>`;
}

/* STATE */
const palette = ['#fee440','#d4af37','#8ac926','#1982c4','#ffca3a','#6a4c93','#d79a59','#218380'];
let players   = [];
let totalUSD  = 0;
let phase     = "waiting";        // waiting | countdown | spinning
const selected = new Set();       // выбраны NFT для ставки
// Храним тех, чьи NFT развернуты (показываем все), по имени игрока
const expandedPlayers = new Set();


/* ELEMENTS */
const svg            = document.getElementById('wheelSvg');
const list           = document.getElementById('players');
const pot            = document.getElementById('pot');
const pickerOverlay  = document.getElementById('nftPickerOverlay');
const nftPicker      = document.getElementById('nftPicker');
const placeBetBtn    = document.getElementById('placeBet');
const closePickerBtn = document.getElementById('closePicker');
const depositNFTBtn  = document.getElementById('depositNFT');
const grid           = document.getElementById('profileGrid');
const statusEl       = document.getElementById('countdown');

/* Навигация (по существующему коду) */
const gameSection    = document.getElementById('gameSection');
const marketSection  = document.getElementById('marketSection');
const profileSection = document.getElementById('profileSection');
const earnSection    = document.getElementById('earnSection');
const navGame        = document.getElementById('navGame');
const navMarket      = document.getElementById('navMarket');
const navProfile     = document.getElementById('navProfile');
const navEarn        = document.getElementById('navEarn');

document.addEventListener('DOMContentLoaded', () => {
  const tg = window.Telegram.WebApp;
  tg.ready();
  tg.expand();
});

/* ==== RENDER HELPERS ==== */
function cardHTML(nft, extra=''){
  return `
    <div class="nft-card ${extra}" data-id="${nft.id}">
      <img src="${nft.img}" alt="${nft.name}" />
      <div class="mt-2 text-sm text-gray-200">${nft.name}</div>
      <div class="font-semibold text-amber-300">$${nft.price}</div>
    </div>`;
}

function renderPicker(){
  nftPicker.innerHTML = '';
  inventory
    .filter(n => !n.staked)
    .forEach(n => {
      nftPicker.insertAdjacentHTML('beforeend',
        cardHTML(n, selected.has(n.id) ? 'selected' : '')
      );
    });
}

function renderProfile(){
  grid.innerHTML = '';
  inventory.forEach(n => {
    const extra = n.staked ? 'staked' : '';
    grid.insertAdjacentHTML('beforeend', cardHTML(n, extra));
  });
}

function drawWheel(){
  svg.innerHTML = '';
  if (!totalUSD) return;
  let start = -90;
  players.forEach(p => {
    const sweep = (p.value / totalUSD) * 360;
    const end   = start + sweep;
    if (players.length > 1) {
      svg.insertAdjacentHTML('beforeend',
        arc(200,200,190,start,end,p.color)
          .replace('<path ','<path data-player="'+p.name+'" ')
      );
    } else {
      svg.insertAdjacentHTML('beforeend',
        `<circle cx="200" cy="200" r="190" fill="${p.color}" data-player="${p.name}"></circle>`
      );
    }
    const mid = start + sweep/2;
    const pos = polar(200,200,120,mid);
    const angle = mid + 90;
    svg.insertAdjacentHTML('beforeend',`
      <text x="${pos.x}" y="${pos.y}"
            transform="rotate(${angle} ${pos.x} ${pos.y})"
            font-size="15" fill="#000" text-anchor="middle">
        ${(p.name || "?").length > 14 ? p.name.slice(0,12) + "…" : p.name}
      </text>`);
    start = end;
  });
}

function refreshUI() {
  list.innerHTML = '';

  players.forEach(p => {
    const li = document.createElement('li');
    li.className = 'flex flex-col gap-1 py-2';

    // ── Блок с ником и суммой (+ процент)
    const headerDiv = document.createElement('div');
    headerDiv.className = 'flex items-baseline gap-2';

    const nameEl = document.createElement('span');
    nameEl.textContent = p.name;
    nameEl.className = 'text-amber-300 font-semibold';

    const valueEl = document.createElement('span');
    valueEl.textContent = `$${p.value.toFixed(2)}`;
    valueEl.className = 'text-gray-100 text-sm';

    const percEl = document.createElement('span');
    percEl.textContent = `· ${((p.value/totalUSD)*100).toFixed(1)}%`;
    percEl.className = 'text-emerald-400 text-xs';

    headerDiv.appendChild(nameEl);
    headerDiv.appendChild(valueEl);
    headerDiv.appendChild(percEl);

    // ── Блок с иконками NFT (отсортированы по цене, от дорогих к дешевым)
    const iconsWrapper = document.createElement('div');
    // flex-wrap, gap, выравнивание; чтобы иконки красиво переходили на новую строку
    iconsWrapper.className = 'flex flex-wrap items-center gap-2 mt-1';

    const sortedNFTs = [...p.nfts].sort((a,b) => b.price - a.price);
    const isExpanded  = expandedPlayers.has(p.name);
    const maxToShow   = 24;

    // Функция-утилита для создания «нарядной» иконки NFT
    function makeNFTIcon(nftObj) {
      const wrapper = document.createElement('div');
      wrapper.className = `
        relative 
        w-8 h-8 
        rounded-md 
        overflow-hidden 
        shadow-lg 
        border border-gray-600 
        hover:scale-110 
        transition-transform duration-150 ease-in-out
      `;

      const img = document.createElement('img');
      img.src = nftObj.img;
      img.alt = nftObj.id;
      img.className = 'w-full h-full object-cover';
      wrapper.appendChild(img);

      // При наведении показываем подпись с ценой
      const priceBadge = document.createElement('div');
      priceBadge.textContent = `$${nftObj.price}`;
      priceBadge.className = `
        absolute 
        bottom-0 
        left-0 
        w-full 
        bg-gray-900/80 
        text-xs 
        text-amber-300 
        text-center 
        py-0.5 
        opacity-0 
        hover:opacity-100 
        transition-opacity duration-150
      `;
      wrapper.appendChild(priceBadge);

      return wrapper;
    }

    if (sortedNFTs.length <= maxToShow || isExpanded) {
      // Показываем все NFT
      sortedNFTs.forEach(nftObj => {
        iconsWrapper.appendChild(makeNFTIcon(nftObj));
      });

      // Если было развёрнуто, добавим кнопку «Скрыть»
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
      // Показываем только первые 8
      sortedNFTs.slice(0, maxToShow).forEach(nftObj => {
        iconsWrapper.appendChild(makeNFTIcon(nftObj));
      });

      // Добавляем кнопку «Показать все»
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

    // ── Собираем <li>
    li.appendChild(headerDiv);
    li.appendChild(iconsWrapper);
    list.appendChild(li);
  });

  pot.textContent = '$' + totalUSD.toFixed(2);
  drawWheel();
  renderPicker();
  renderProfile();
}
/* ==== SOCKET EVENTS ==== */
socket.on("state", s => {
  players  = s.players;
  totalUSD = s.totalUSD;
  phase    = s.phase;

  if (players.length === 0) {
    inventory.forEach(n => n.staked = false);
    gsap.set('#wheelSvg', { rotation: 0 });
    document.getElementById('result').textContent = '';
    lockBets(false);
    updateStatus();
  }

  refreshUI();

  if (s.phase === "countdown") {
    updateStatus(Math.ceil((s.endsAt - Date.now()) / 1000));
  } else {
    updateStatus();
  }
});

socket.on("countdownStart", ({ endsAt }) => {
  phase = "countdown";
  updateStatus(Math.ceil((endsAt - Date.now()) / 1000));
});
socket.on("countdownTick", ({ remaining }) => {
  phase = "countdown";
  updateStatus(Math.ceil(remaining / 1000));
});
socket.on("spinStart", ({ players: list, winner }) => {
  players  = list;
  totalUSD = list.reduce((a,b)=>a+b.value,0);
  phase    = "spinning";
  lockBets(true);
  updateStatus();
  runSpinAnimation(winner);
});
socket.on("spinEnd", ({ winner, total }) => {
  showResult(winner, total);
  lockBets(false);
  phase = "waiting";
  updateStatus();
});

/* ==== ANIMATION & UTILS ==== */
function highlightWinner(winner){
  const slice = svg.querySelectorAll(`[data-player="${winner.name}"]`);
  slice.forEach(el => {
    gsap.fromTo(el,
      { filter: 'brightness(1)' },
      { filter: 'brightness(2.2)', duration: .4, yoyo:true, repeat:5 }
    );
  });
}

function runSpinAnimation(winner){
  const idx = players.indexOf(winner);
  let start = -90, mid = 0;
  players.forEach((p,i) => {
    const sweep = (p.value / totalUSD) * 360;
    if (i === idx) mid = start + sweep/2;
    start += sweep;
  });
  const spins = 6 + Math.floor(Math.random() * 4);
  const target = 360 * spins + (360 - mid);
  gsap.to('#wheelSvg',{
    duration: 6,
    rotation: target,
    ease: 'power4.out',
    onComplete: () => highlightWinner(winner)
  });
}

function showResult(winner,total){
  document.getElementById('result').textContent =
      `${winner.name} выигрывает $${total.toFixed(2)}!`;
}

function lockBets(lock){
  document.getElementById("placeBet").disabled = lock;
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

/* ==== PICKER LOGIC ==== */
// Открытие модального выбора NFT
depositNFTBtn.addEventListener('click', () => {
  renderPicker();
  selected.clear();
  renderPicker();
  placeBetBtn.disabled = true;
  pickerOverlay.classList.remove('hidden');
});

// Закрытие окна без ставки
closePickerBtn.addEventListener('click', () => {
  pickerOverlay.classList.add('hidden');
  selected.clear();
  renderPicker();
});

// Клик по карточке NFT внутри picker
nftPicker.addEventListener('click', e => {
  const card = e.target.closest('.nft-card');
  if (!card) return;

  const id = card.dataset.id;
  if (selected.has(id)) {
    selected.delete(id);
  } else {
    selected.add(id);
  }
  renderPicker();
  placeBetBtn.disabled = selected.size === 0;
});

// Нажатие «Поставить выбранные»
placeBetBtn.addEventListener('click', () => {
  if (selected.size === 0) {
    alert("Выберите хотя бы один NFT");
    return;
  }

  const name = myName;
  const nfts = Array.from(selected).map(id => {
  const n = inventory.find(x => x.id === id);
  return { id: n.id, price: n.price, img: n.img };
});

  // Локально помечаем NFT стейкнутыми
  nfts.forEach(({ id }) => {
    const item = inventory.find(x => x.id === id);
    if (item) item.staked = true;
  });

  selected.clear();
  renderProfile();
  renderPicker();
  pickerOverlay.classList.add('hidden');

  socket.emit("placeBet", { name: myName, nfts });
});

/* ==== НАВИГАЦИЯ ==== */
document.getElementById('navGame')   .addEventListener('click', ()=>show('game'));
document.getElementById('navMarket') .addEventListener('click', ()=>show('market'));
document.getElementById('navProfile').addEventListener('click', ()=>show('profile'));
document.getElementById('navEarn')   .addEventListener('click', ()=>show('earn'));
function show(view){
  gameSection   .classList.toggle('hidden', view!=='game');
  profileSection.classList.toggle('hidden', view!=='profile');
  marketSection .classList.toggle('hidden', view!=='market');
  earnSection   .classList.toggle('hidden', view!=='earn');

  navGame   .classList.toggle('active', view==='game');
  navMarket .classList.toggle('active', view==='market');
  navProfile.classList.toggle('active', view==='profile');
  navEarn   .classList.toggle('active', view==='earn');
}

/* ==== BUBBLES / STEAM (без изменений) ==== */
const cauldron = document.getElementById('cauldron');
function spawnBubble(){
  const b = document.createElement('span');
  b.className = 'bubble';
  b.style.left = Math.random()*80 + 10 + '%';
  const s = 10 + Math.random()*16;
  b.style.width = b.style.height = s + 'px';
  b.style.animation = `rise ${4 + Math.random()*3}s ease-in forwards`;
  cauldron.appendChild(b);
  setTimeout(() => b.remove(), 7000);
}
setInterval(spawnBubble, 1000);
gsap.fromTo('#steam',{scale:.6,opacity:0},{scale:1.4,opacity:.55,y:-90,duration:5,repeat:-1,ease:'power1.out',repeatDelay:1.2});

/* ==== INIT ==== */
show('game');
refreshUI();


