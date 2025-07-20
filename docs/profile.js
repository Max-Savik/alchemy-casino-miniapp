// profile.js
const API_ORIGIN = "https://alchemy-casino-miniapp.onrender.com";
let jwtToken = localStorage.getItem("jwt") || null;
let inventory = [];
let tonBalance = 0;

/* ===== Telegram user ===== */
const tgUser = window?.Telegram?.WebApp?.initDataUnsafe?.user || {};
const myId = tgUser.id || tgUser.user_id || 'guest-' + Math.random().toString(36).slice(2);

/* ===== Utils ===== */
async function postJSON(url, data){
  const res = await fetch(url, {
    method: 'POST',
    headers:{
      'Content-Type':'application/json',
      ...(jwtToken && { 'Authorization': 'Bearer '+jwtToken })
    },
    body: JSON.stringify(data),
    credentials: "include"
  });
  if(!res.ok) throw new Error(await res.text());
  return res.json();
}

async function ensureJwt(){
  if (document.cookie.split("; ").some(c => c.startsWith("sid="))) return;
  if (jwtToken) return;
  const r = await fetch(`${API_ORIGIN}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ userId: myId })
  });
  const j = await r.json();
  jwtToken = j.token;
  localStorage.setItem("jwt", jwtToken);
}

async function refreshBalance(){
  try{
    const res = await fetch(`${API_ORIGIN}/wallet/balance`, {
      credentials: "include",
      headers: jwtToken ? { 'Authorization': 'Bearer '+jwtToken } : {}
    });
    if(res.ok){
      const { balance=0 } = await res.json();
      tonBalance = balance;
      document.getElementById('tonBalance').textContent = tonBalance.toFixed(2);
    }
  }catch(e){ console.warn('balance error', e); }
}

function cardHTML(nft){
  const withdrawing = nft.status === 'pending_withdraw';
  return `
    <div class="nft-card relative ${nft.staked ? 'staked' : ''} ${withdrawing ? 'opacity-60 pointer-events-none' : ''}"
         data-id="${nft.id}">
      <img src="${nft.img}" alt="${nft.name}" class="rounded-md w-full object-cover" />
      <div class="mt-1 flex items-center justify-between text-sm">
        <span>${nft.name}</span>
        <span class="text-amber-300 font-semibold">$${nft.price}</span>
      </div>
      ${
        !nft.staked && !withdrawing
          ? `<button class="withdraw-btn mt-2 w-full inline-flex justify-center items-center gap-1
                     py-1.5 rounded-md bg-amber-500/90 hover:bg-amber-500 active:bg-amber-600
                     text-[13px] font-semibold text-gray-900 transition">
               ⇄ Вывести <span class="text-[15px]">⭐25</span>
             </button>`
          : (withdrawing
              ? `<div class="mt-2 w-full text-center text-[11px] text-amber-300 font-semibold select-none">
                   ⏳ вывод...
                 </div>`
              : "")
      }
    </div>
  `;
}

function renderProfile(){
  const grid = document.getElementById('profileGrid');
  grid.innerHTML = '';
  inventory.forEach(n => {
    grid.insertAdjacentHTML('beforeend', cardHTML(n));
  });

  grid.onclick = async e => {
    const btn = e.target.closest('.withdraw-btn');
    if (!btn) return;
    const card = btn.closest('.nft-card');
    const id = card.dataset.id;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const { link } = await postJSON(`${API_ORIGIN}/wallet/withdrawGift`, {
        ownedId: id
      });
      const nft = inventory.find(x => x.id === id);
      if (nft){
        nft.status = 'pending_withdraw';
        nft.staked = true;
      }
      renderProfile();
      if (window.Telegram?.WebApp?.openInvoice) {
        Telegram.WebApp.openInvoice(link);
      } else {
        window.open(link, '_blank');
      }
    } catch(err){
      alert('Ошибка: '+err.message);
    }
  };
}

async function loadGifts(){
  try{
    const res = await fetch(`${API_ORIGIN}/wallet/gifts`, {
      credentials: "include",
      headers: jwtToken ? { 'Authorization':'Bearer '+jwtToken } : {}
    });
    const arr = await res.json();
    // чистим и заполняем заново (можно умнее — diff)
    inventory = arr.map(g => ({
      id: g.ownedId,
      name: g.name,
      price: g.price,
      img: g.img,
      staked: false,
      status: g.status || 'idle'
    }));
    renderProfile();
  }catch(e){
    console.warn('gift fetch error', e);
  }
}

/* ===== INIT ===== */
(async () => {
  await ensureJwt();
  await refreshBalance();
  await loadGifts();
})();

document.getElementById('refreshGifts')
  .addEventListener('click', loadGifts);

/* ===== (Опционально) реалтайм обновления подарков =====
   Можно подключить socket.io, если нужно:
   const token = (document.cookie.split("; ").find(c=>c.startsWith("sid="))||"").split("=")[1] || jwtToken;
   const socket = io(API_ORIGIN, { auth:{ token }, withCredentials:true });
   socket.on('giftUpdate', ({ ownedId, status }) => { ... обновить inventory ... });
*/
