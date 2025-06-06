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

function refreshUI(){
  list.innerHTML = '';
  players.forEach(p => {
    // Основной li
    const li = document.createElement('li');
    li.className = 'flex items-center gap-2';

    // 1️⃣ Блок с маленькими NFT-иконками (макс. 4 штуки, например)
    const iconsWrapper = document.createElement('div');
    iconsWrapper.className = 'flex gap-1';

    // p.nfts — массив объектов { id, img, price }
    // Покажем не более 4-х превью, остальные скроем (чтобы не было слишком длинно)
    const maxToShow = 4;
    p.nfts.slice(-maxToShow).forEach(nftObj => {
      const img = document.createElement('img');
      img.src = nftObj.img;
      img.alt = nftObj.id;
      img.className = 'w-6 h-6 rounded-sm border border-gray-600';
      iconsWrapper.appendChild(img);
    });
    if (p.nfts.length > maxToShow) {
      const more = document.createElement('span');
      more.textContent = `+${p.nfts.length - maxToShow}`;
      more.className = 'text-xs text-gray-400 ml-1';
      iconsWrapper.appendChild(more);
    }

    // 2️⃣ Блок с текстом «имя — сумма · процент»
    const textWrapper = document.createElement('div');
    textWrapper.innerHTML = `
      <span class="text-amber-300 font-medium">${p.name}</span>
      — $${p.value.toFixed(2)}
      <span class="text-emerald-400">· ${((p.value/totalUSD)*100).toFixed(1)}%</span>
    `;

    li.appendChild(iconsWrapper);
    li.appendChild(textWrapper);
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


