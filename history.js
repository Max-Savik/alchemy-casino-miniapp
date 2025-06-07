/* История игр – Golden Play */

const API = "https://alchemy-casino-miniapp.onrender.com";

document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('historyContainer');
  const loader    = document.getElementById('loader');
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
  loader.classList.add('hidden');       // убираем спиннер
  container.classList.remove('hidden'); // показываем основной блок

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
      'opacity-0 bg-gray-800 rounded-lg p-4 flex flex-col gap-4 translate-y-4';

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

    /* 👑 победитель с короной и свечением */
    const winnerEl = document.createElement('div');
    winnerEl.innerHTML = `
      <span class="inline-flex items-center gap-1 text-amber-300 font-bold winner-glow max-w-full break-words">
        <svg class="w-4 h-4 -mt-0.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 7l3.89 7.26L12 8l4.11 6.26L20 7l-2 12H6L4 7z"/>
        </svg>
        ${record.winner}
      </span>
      выиграл <span class="text-emerald-300 font-semibold">$${record.total.toFixed(2)}</span>
    `;
    winnerEl.className = 'text-base';

    info.append(dateEl, winnerEl);
    card.appendChild(info);

    /* ── список участников ── */
    const participantsWrapper = document.createElement('div');
    participantsWrapper.className = 'flex flex-col gap-3';

    record.participants.forEach(p => {
      const pDiv = document.createElement('div');
      pDiv.className = 'flex flex-col gap-1';

      const totalByPlayer = p.nfts.reduce((sum, x) => sum + x.price, 0);
      const pHeader = document.createElement('div');
      pHeader.innerHTML = `
        <span class="text-emerald-300 font-medium">${p.name}</span>
        поставил <span class="text-gray-100">$${totalByPlayer.toFixed(2)}</span>
      `;
      pHeader.className = 'text-sm break-words';

      const nftsWrapper = document.createElement('div');
      nftsWrapper.className = 'flex gap-2 overflow-x-auto py-1';

      p.nfts.forEach(nftObj => {
        const nftDiv = document.createElement('div');
        nftDiv.className = `
          relative w-16 h-16 rounded-md overflow-hidden
          shadow-md border border-gray-600 flex-shrink-0
        `;

        const img = document.createElement('img');
        img.src = nftObj.img;
        img.alt = nftObj.id;
        img.className = 'w-full h-full object-cover';
        nftDiv.appendChild(img);

        const priceBadge = document.createElement('div');
        priceBadge.textContent = `$${nftObj.price}`;
        priceBadge.className = `
          absolute bottom-0 left-0 w-full text-center text-xs
          bg-gray-900/80 text-amber-300 opacity-0 hover:opacity-100
          transition-opacity duration-150
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
