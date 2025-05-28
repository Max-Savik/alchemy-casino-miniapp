let countdownStarted = false;
let countdownInterval = null;

/* ================= SAMPLE INVENTORY ================= */
const inventory = [
  { id:'orb001',  name:'🔥 Огненный Орб #001', price:10, img:'https://picsum.photos/seed/orb/200', staked:false },
  { id:'pearl42', name:'💧 Жемчужина Вод #042',price:25, img:'https://picsum.photos/seed/pearl/200',staked:false },
  { id:'egg007',  name:'🐲 Яйцо Дракона #007', price:60, img:'https://picsum.photos/seed/egg/200',  staked:false },
  { id:'elixir1', name:'🧪 Эликсир Манны #155',price:5,  img:'https://picsum.photos/seed/elixir/200',staked:false },
  { id:'cryst66', name:'🌑 Тёмный Кристалл #666',price:45,img:'https://picsum.photos/seed/cryst/200', staked:false },
];

/* ================= SVG helpers (как раньше) ================= */
function polar(cx,cy,r,deg){const rad=(deg-90)*Math.PI/180;return{x:cx+r*Math.cos(rad),y:cy+r*Math.sin(rad)}}
function arc(cx,cy,r,start,end,color){const s=polar(cx,cy,r,end),e=polar(cx,cy,r,start),large=end-start<=180?0:1;
  return`<path d="M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y} Z" fill="${color}"/>`}

/* ================= STATE ================= */
const palette=['#fee440','#d4af37','#8ac926','#1982c4','#ffca3a','#6a4c93','#d79a59','#218380'];
let players=[], totalUSD=0, selected=new Set();

/* ================= ELEMENTS ================= */
const svg=document.getElementById('wheelSvg');
const list=document.getElementById('players');
const pot=document.getElementById('pot');
const picker=document.getElementById('nftPicker');
const grid=document.getElementById('profileGrid');

/* ================= RENDER HELPERS ================= */
function cardHTML(nft,extra=''){return`
  <div class="nft-card ${extra}" data-id="${nft.id}">
    <img src="${nft.img}" alt="">
    <div class="text-sm">${nft.name}</div>
    <div class="text-amber-300 font-semibold">$${nft.price}</div>
  </div>`}

function renderPicker(){
  picker.innerHTML='';
  inventory.filter(n=>!n.staked).forEach(n=>{
    picker.insertAdjacentHTML('beforeend', cardHTML(n, selected.has(n.id)?'selected':''));
  });
}
function renderProfile(){
  grid.innerHTML='';
  inventory.forEach(n=>{
    const extra=n.staked?'staked':''; grid.insertAdjacentHTML('beforeend',cardHTML(n,extra));
  });
}
function drawWheel(){
  svg.innerHTML=''; if(!totalUSD)return;
  let start=-90;
  players.forEach(p=>{
    const sweep=(p.value/totalUSD)*360, end=start+sweep;
    svg.insertAdjacentHTML('beforeend', arc(200,200,190,start,end,p.color));
    start=end;
  });
}
function refreshUI(){
  list.innerHTML='';
  players.forEach(p=>{
    const li=document.createElement('li');
    li.innerHTML=`<span class="text-amber-300">${p.name}</span> — $${p.value.toFixed(2)}
      · <span class="text-emerald-400">${((p.value/totalUSD)*100).toFixed(1)}%</span>`;
    list.appendChild(li);
  });
  pot.textContent='$'+totalUSD.toFixed(2);
  drawWheel(); renderPicker(); renderProfile();
    // Запускаем таймер при достижении 2+ игроков
  if (players.length >= 2 && !countdownStarted) {
    startCountdown();
  }
}

// Функция старта 60-секундного таймера
function startCountdown(){
  countdownStarted = true;
  let timeLeft = 60;
  const countdownEl = document.getElementById('countdown');
  countdownEl.textContent = `Таймер: ${timeLeft} сек`;

  // Запретить добавлять повторно запуск
  countdownInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft > 0) {
      countdownEl.textContent = `Таймер: ${timeLeft} сек`;
    } else {
      clearInterval(countdownInterval);
      countdownEl.textContent = 'Раунд начинается!';
      // Запускаем автоматическое вращение
      autoSpin();
    }
  }, 1000);
}

// Автоматический спин
function autoSpin() {
  // Запретить новые ставки
  document.getElementById('placeBet').disabled = true;

  const winner = weightedPick();
  // ту же логику вычисления target
  let start = -90, mid = 0;
  players.forEach(p => {
    const sweep = (p.value/totalUSD)*360;
    if (p === winner) mid = start + sweep/2;
    start += sweep;
  });
  const spins = 6 + Math.floor(Math.random()*4);
  const target = 360*spins + (360 - mid);

  gsap.to('#wheelSvg', {
    duration: 6,
    rotation: target,
    ease: 'power4.out',
    onComplete: () => {
      document.getElementById('result').textContent = 
        `${winner.name} получает котёл на $${totalUSD.toFixed(2)}!`;
      setTimeout(resetRound, 11000);
    }
  });
}

// Сброс после раунда
function resetRound(){
  players = [];
  totalUSD = 0;
  inventory.forEach(n=>n.staked = false);
  document.getElementById('result').textContent = '';
  document.getElementById('countdown').textContent = 'Ожидание игроков...';
  document.getElementById('placeBet').disabled = false;
  gsap.set('#wheelSvg', {rotation:0});
  countdownStarted = false;
  refreshUI();
}

/* ================= PICKER EVENTS ================= */
picker.addEventListener('click',e=>{
  const card=e.target.closest('.nft-card'); if(!card)return;
  const id=card.dataset.id;
  if(selected.has(id)) selected.delete(id); else selected.add(id);
  renderPicker();
});

/* ================= PLACE BET ================= */
document.getElementById('placeBet').addEventListener('click',()=>{
  if(!selected.size){alert('Выберите хотя бы один NFT'); return;}
  const name=document.getElementById('playerName').value.trim()||'Безымянный';
  let p=players.find(x=>x.name===name);
  if(!p){p={name,value:0,color:palette[players.length%palette.length]}; players.push(p);}
  let added=0;
  selected.forEach(id=>{
    const nft=inventory.find(n=>n.id===id);
    if(!nft||nft.staked) return;
    nft.staked=true; added+=nft.price;
  });
  p.value+=added; totalUSD+=added;
  selected.clear(); refreshUI();
});

/* ================= SPIN ================= */
function weightedPick(){
  let ticket=Math.random()*totalUSD, acc=0;
  for(const p of players){acc+=p.value;if(ticket<=acc)return p;}
  return players[players.length-1];
}


/* ================= SIMPLE NAV ================= */
document.getElementById('navGame').addEventListener('click',()=>show('game'));
document.getElementById('navProfile').addEventListener('click',()=>show('profile'));
function show(view){
  document.getElementById('gameSection').classList.toggle('hidden',view!=='game');
  document.getElementById('profileSection').classList.toggle('hidden',view!=='profile');
}

/* ================= BUBBLES / STEAM (оставлено) ================= */
const cauldron=document.getElementById('cauldron');
function spawnBubble(){const b=document.createElement('span');b.className='bubble';
  b.style.left=Math.random()*80+10+'%';const s=10+Math.random()*16;b.style.width=b.style.height=s+'px';
  b.style.animation=`rise ${4+Math.random()*3}s ease-in forwards`; cauldron.appendChild(b);
  setTimeout(()=>b.remove(),7000);} setInterval(spawnBubble,1000);
gsap.fromTo('#steam',{scale:.6,opacity:0},{scale:1.4,opacity:.55,y:-90,duration:5,repeat:-1,ease:'power1.out',repeatDelay:1.2});

/* ================= INIT ================= */
show('game'); refreshUI();
