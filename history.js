/* История игр – Golden Play (обновлено) */

const API = "https://alchemy-casino-miniapp.onrender.com";

document.addEventListener('DOMContentLoaded', async () => {
  const lottieEl = document.getElementById('lottieContainer');
  lottieEl.style.display = 'block';  // сразу показываем контейнер

  try {
    const res  = await fetch('https://nft.fragment.com/gift/bondedring-403.lottie.json');
    const data = await res.json();
    data.layers = data.layers.filter(layer =>
  layer.nm !== 'Background' &&
  layer.nm !== 'Color Icon'
);


    // Запускаем анимацию
    lottie.loadAnimation({
      container:     lottieEl,
      renderer:      'svg',
      loop:          true,
      autoplay:      true,
      animationData: data
    });
  } catch (err) {
    console.error('Ошибка Lottie:', err);
  }

  const container = document.getElementById('historyContainer');
  const backBtn   = document.getElementById('backBtn');

  backBtn.addEventListener('click', () => window.location.href = 'index.html');

  let gameHistory = null;

  /* ─────────── fetch history: API → fallback file ─────────── */
  try {
    const res = await fetch(`${API}/history`);
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    gameHistory = await res.json();
  } catch (serverErr) {
    console.warn('Не удалось запросить /history:', serverErr);
    try {
      const res2 = await fetch(`${API}/history.json`);
      if (!res2.ok) throw new Error(`history.json responded ${res2.status}`);
      gameHistory = await res2.json();
    } catch (fileErr) {
      console.error('Не удалось загрузить history.json:', fileErr);
    }
  }

  /* ─────────── отображение результата ─────────── */
  // 1) Прячем Lottie
  document.getElementById('lottieContainer').style.display = 'none';
  // 2) Показываем контейнер с историей
  const historyContainer = document.getElementById('historyContainer');
  historyContainer.classList.remove('hidden');

  // 3) Плавно проявляем весь <main>
  const main = document.getElementById('mainContent');
  requestAnimationFrame(() => {
    main.classList.remove('opacity-0');
    main.classList.add('opacity-100');
  });

  if (!Array.isArray(gameHistory)) {
    container.innerHTML =
      `<p class="text-lg text-red-400 text-center py-10">Ошибка при загрузке истории.</p>`;
    return;
  }

  if (gameHistory.length === 0) {
    container.innerHTML =
      `<p class="text-lg text-gray-400 text-center py-10">История пуста — пока нет завершённых игр.</p>`;
    return;
  }

  /* ───── сортируем по времени: самые свежие сверху ───── */
  gameHistory = [...gameHistory].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );

  /* ─────────── рендер карточек ─────────── */
  gameHistory.forEach((record, idx) => {
const card = document.createElement('div');
card.className =
  'w-full opacity-0 bg-gray-800 rounded-lg p-4 flex flex-col gap-4 translate-y-4';


    /* ── верхняя строка: дата + победитель ── */
    const info = document.createElement('div');
    info.className =
      'flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2 break-words';

    const dt      = new Date(record.timestamp);
    const dateStr = dt.toLocaleString('ru-RU', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const dateEl   = document.createElement('div');
    dateEl.textContent = dateStr;
    dateEl.className   = 'text-gray-400 text-sm';

  const winnerEl = document.createElement('div');

    // найдём сумму ставок победителя
    const winnerRecord = record.participants.find(p => p.name === record.winner);
    const winnerSum = winnerRecord
      ? winnerRecord.nfts.reduce((sum, x) => sum + x.price, 0)
      : 0;
    const winPct = record.total > 0
      ? (winnerSum / record.total) * 100
      : 0;

    // форматируем общий пул и процент с разделителем тысяч
    const formattedTotal = record.total
      .toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formattedPct = winPct.toLocaleString('ru-RU', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });

    // генерируем HTML победителя
    winnerEl.innerHTML = `
      <span class="inline-flex items-center gap-1 text-amber-300 font-bold winner-glow max-w-full break-words">
        <svg class="w-4 h-4 -mt-0.5" xmlns="http://www.w3.org/2000/svg"
             viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 7l3.89 7.26L12 8l4.11 6.26L20 7l-2 12H6L4 7z"/>
        </svg>
        ${record.winner}
      </span>
      выиграл 
      <span class="text-emerald-300 font-semibold">
        ${formattedTotal} TON (${formattedPct} %)
      </span>
    `;
    winnerEl.className = 'text-base';

    info.append(dateEl, winnerEl);
    card.appendChild(info);

    /* ── список участников ── */
    const participantsWrapper = document.createElement('div');
    participantsWrapper.className = 'flex flex-col gap-3';

    record.participants.forEach(p => {
      const pDiv = document.createElement('div');
      pDiv.className = 'flex flex-col gap-1' + (p.name === record.winner ? ' winner-bet' : '');

      const totalByPlayer = p.nfts.reduce((sum, x) => sum + x.price, 0);
      const chance = record.total > 0 ? (totalByPlayer / record.total) * 100 : 0;

      const pHeader = document.createElement('div');
pHeader.innerHTML = `
  <span class="text-emerald-300 font-medium">${p.name}</span>
  поставил <span class="text-gray-100">${totalByPlayer.toFixed(2)} TON</span>
  <span class="text-gray-400">(${chance.toFixed(1)}%)</span>
`;

      pHeader.className = 'text-sm break-words';

      const nftsWrapper = document.createElement('div');
      nftsWrapper.className = 'flex gap-2 overflow-x-auto py-1';

      p.nfts.forEach(nftObj => {
const nftDiv = document.createElement('div');
nftDiv.className = `
  relative w-16 h-16 rounded-md overflow-hidden
  shadow-md border border-gray-600 flex-shrink-0 group
`;
// чтобы реагировать на tap
nftDiv.setAttribute('tabindex','0');
nftDiv.addEventListener('click', () => {
  nftDiv.classList.toggle('show-price');
});

const img = document.createElement('img');
        img.src = nftObj.img;
        img.alt = nftObj.id;
        img.className = 'w-full h-full object-cover';
 nftDiv.appendChild(img);

const priceBadge = document.createElement('div');
priceBadge.className = `
  price-badge
  absolute bottom-0 left-0
  bg-gray-900/80 text-amber-300
  pointer-events-none
  transition-opacity duration-150
`;
// рендерим число + картинку TON
priceBadge.innerHTML = `
  ${nftObj.price.toFixed(2)}
  <img src="data:image/svg+xml,%3csvg%20width='32'%20height='28'%20viewBox='0%200%2032%2028'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M31.144%205.84244L17.3468%2027.1579C17.1784%2027.4166%2016.9451%2027.6296%2016.6686%2027.7768C16.3922%2027.9241%2016.0817%2028.0009%2015.7664%2028C15.451%2027.9991%2015.141%2027.9205%2014.8655%2027.7716C14.59%2027.6227%2014.3579%2027.4084%2014.1911%2027.1487L0.664576%205.83477C0.285316%205.23695%200.0852825%204.54843%200.0869241%203.84647C0.104421%202.81116%200.544438%201.82485%201.31047%201.10385C2.0765%200.382844%203.10602%20-0.0139909%204.17322%200.000376986H27.6718C29.9143%200.000376986%2031.7391%201.71538%2031.7391%203.83879C31.7391%204.54199%2031.5333%205.23751%2031.1424%205.84244M3.98489%205.13003L14.0503%2020.1858V3.61156H5.03732C3.99597%203.61156%203.5291%204.28098%203.98647%205.13003M17.7742%2020.1858L27.8395%205.13003C28.3032%204.28098%2027.8285%203.61156%2026.7871%203.61156H17.7742V20.1858Z'%20fill='white'/%3e%3c/svg%3e"
  alt="TON" />
`;
nftDiv.appendChild(priceBadge);


        nftsWrapper.appendChild(nftDiv);
      });

      pDiv.append(pHeader, nftsWrapper);
      participantsWrapper.appendChild(pDiv);
    });

    card.appendChild(participantsWrapper);
    container.appendChild(card);

    

    /* ── анимация появления ── */
    requestAnimationFrame(() => {
      setTimeout(() => {
        card.classList.add('animate-fade-in-up');
        card.classList.remove('opacity-0', 'translate-y-4');
      }, idx * 60);
    });
  });
});
