/* =================  CONSTANTS  ================= */
const API_ORIGIN = "https://alchemy-casino-miniapp.onrender.com";
let jwtToken  = localStorage.getItem("jwt") || null;
let inventory = [];
let tonBalance = 0;

/* ============  HELPERS  ============ */
const $ = sel => document.querySelector(sel);

async function postJSON(url, data = {}) {
  const res = await fetch(url, {
    method : "POST",
    credentials: "include",
    headers : {
      "Content-Type": "application/json",
      ...(jwtToken && { Authorization: "Bearer "+jwtToken })
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function ensureJwt() {
  if (document.cookie.split("; ").some(c => c.startsWith("sid="))) return;
  if (jwtToken) return;
  const r = await fetch(`${API_ORIGIN}/auth/login`, {
    method : "POST",
    credentials: "include",
    headers : {"Content-Type":"application/json"},
    body: JSON.stringify({ userId: getUid() })
  });
  const { token } = await r.json();
  jwtToken = token;
  localStorage.setItem("jwt", token);
}

function getUid() {
  const tgUser = window?.Telegram?.WebApp?.initDataUnsafe?.user || {};
  return tgUser.id || tgUser.user_id || "guest-"+Math.random().toString(36).slice(2);
}

async function refreshBalance() {
  try {
    const r = await fetch(`${API_ORIGIN}/wallet/balance`, {
      credentials: "include",
      headers: jwtToken ? { Authorization: "Bearer "+jwtToken } : {}
    });
    if (r.ok) {
      const { balance = 0 } = await r.json();
      tonBalance = balance;
      $("#tonBalance").textContent = tonBalance.toFixed(2);
    }
  } catch (e) {
    console.warn("balance:", e.message);
  }
}

/* ============  NFT GRID  ============ */
function nftCardHTML(n) {
  const withdrawing = n.status === "pending_withdraw";
  const waitingCss  = withdrawing ? "opacity-60 pointer-events-none" : "";
  return `
    <div data-id="${n.id}"
         class="nft-card relative overflow-hidden rounded-xl bg-gray-800/80 backdrop-blur-md
                border border-gray-700 shadow-lg hover:ring-2 hover:ring-amber-400
                transition-transform hover:-translate-y-1 ${waitingCss}">
      <img src="${n.img}" alt="${n.name}" class="w-full aspect-square object-cover">
      <div class="p-2 flex items-center justify-between text-sm">
        <span>${n.name}</span>
        <span class="font-semibold text-amber-300">$${n.price}</span>
      </div>
      ${
        !withdrawing
          ? `<button class="withdraw-btn absolute top-2 right-2 bg-amber-500/90 hover:bg-amber-500
                         text-gray-900 text-xs font-bold px-1.5 py-0.5 rounded-md shadow">
               ⇄
             </button>`
          : `<span class="absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px]
                         text-amber-300 font-semibold select-none">⏳ вывод…</span>`
      }
    </div>`;
}

function renderGrid() {
  const grid = $("#profileGrid");
  grid.innerHTML = "";
  inventory.forEach(n => grid.insertAdjacentHTML("beforeend", nftCardHTML(n)));

  $("#emptyState").classList.toggle("hidden", inventory.length !== 0);

  grid.onclick = async e => {
    const btn  = e.target.closest(".withdraw-btn");
    if (!btn) return;
    const card = btn.closest(".nft-card");
    const id   = card.dataset.id;

    btn.disabled = true;
    btn.textContent = "…";

    try {
      const { link } = await postJSON(`${API_ORIGIN}/wallet/withdrawGift`, { ownedId: id });

      // помечаем локально
      const nft = inventory.find(x => x.id === id);
      if (nft) nft.status = "pending_withdraw";
      renderGrid();

      // открываем инвойс на оплату комиссии
      if (window.Telegram?.WebApp?.openInvoice) {
        Telegram.WebApp.openInvoice(link);
      } else {
        window.open(link, "_blank");
      }
    } catch (err) {
      alert("Ошибка: "+err.message);
    }
  };
}

/* ============  DATA  ============ */
async function loadGifts() {
  try {
    const r = await fetch(`${API_ORIGIN}/wallet/gifts`, {
      credentials: "include",
      headers: jwtToken ? { Authorization: "Bearer "+jwtToken } : {}
    });
    const arr = await r.json();
    inventory = arr.map(g => ({
      id   : g.ownedId,
      name : g.name,
      price: g.price,
      img  : g.img,
      status: g.status || "idle"
    }));
    renderGrid();
  } catch (e) {
    console.warn("gifts:", e.message);
  }
}

/* =====  INIT  ===== */
(async () => {
  await ensureJwt();
  await Promise.all([ refreshBalance(), loadGifts() ]);
})();

$("#refreshGifts").addEventListener("click", loadGifts);
