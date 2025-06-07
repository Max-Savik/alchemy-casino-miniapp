const API = "https://alchemy-casino-miniapp.onrender.com";

document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('historyContainer');
  const backBtn   = document.getElementById('backBtn');

  backBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  let gameHistory = null;

  // 1) Try to load full history from server
  try {
    const res = await fetch(`${API}/history`);
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    gameHistory = await res.json();
  } catch (serverErr) {
    console.warn('Не удалось запросить /history:', serverErr);

    // 2) Fallback — static JSON file
    try {
      const res2 = await fetch(`${API}/history.json`);
      if (!res2.ok) throw new Error(`history.json responded ${res2.status}`);
      gameHistory = await res2.json();
    } catch (fileErr) {
      console.error('Не удалось загрузить history.json:', fileErr);
    }
  }

  // no data → error
  if (!Array.isArray(gameHistory)) {
    container.innerHTML =
      '<p class="text-lg text-red-400 text-center py-10">Ошибка при загрузке истории.</p>';
    return;
  }

  // empty history
  if (gameHistory.length === 0) {
    container.innerHTML =
      '<p class="text-lg text-gray-400 text-center py-10">История пуста — пока нет завершённых игр.</p>';
    return;
  }

  // Render each record
  gameHistory.forEach(record => {
    // record = { timestamp, winner, total, participants: [ {name, nfts:[…]} ] }
    const card = document.createElement('div');
    card.className =
      'timeline-item glass rounded-xl p-6 flex flex-col gap-5 shadow-lg transition transform fade-in hover:-translate-y-0.5 hover:shadow-amber-500/40';

    // ── Header: date + winner
    const info = document.createElement('div');
    info.className = 'flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2';

    const dt = new Date(record.timestamp);
    const dateStr = dt.toLocaleString('ru-RU', {
      year:   'numeric',
      month:  '2-digit',
      day:    '2-digit',
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const dateEl = document.createElement('div');
    dateEl.textContent = dateStr;
    dateEl.className = 'text-gray-400 text-xs sm:text-sm';

    const winnerEl = document.createElement('div');
    winnerEl.innerHTML = `
      <span class="text-amber-300 font-semibold">${record.winner}</span>
      выиграл
      <span class="text-gray-100 font-semibold">$${record.total.toFixed(2)}</span>
      <span class="inline-block ml-1 text-amber-400">🏆</span>
    `;
    winnerEl.className = 'text-gray-200 text-sm sm:text-base';

    info.appendChild(dateEl);
    info.appendChild(winnerEl);
    card.appendChild(info);

    // ── Participants & NFTs
    const participantsWrapper = document.createElement('div');
    participantsWrapper.className = 'flex flex-col gap-4';

    record.participants.forEach(p => {
      const pDiv = document.createElement('div');
      pDiv.className = 'flex flex-col gap-1';

      const totalByPlayer = p.nfts.reduce((sum, x) => sum + x.price, 0);
      const pHeader = document.createElement('div');
      pHeader.innerHTML = `
        <span class="text-emerald-300 font-medium">${p.name}</span>
        поставил
        <span class="text-gray-100">$${totalByPlayer.toFixed(2)}</span>
      `;
      pHeader.className = 'text-gray-200 text-xs sm:text-sm';

      const nftsWrapper = document.createElement('div');
      nftsWrapper.className = 'flex gap-2 overflow-x-auto py-1';

      p.nfts.forEach(nftObj => {
        const nftDiv = document.createElement('div');
        nftDiv.className = `
          relative w-16 h-16 rounded-md overflow-hidden flex-shrink-0
          border border-gray-600 shadow transition transform
          hover:scale-105 hover:shadow-amber-400/30
        `;
        const img = document.createElement('img');
        img.src = nftObj.img;
        img.alt = nftObj.id;
        img.className = 'w-full h-full object-cover';
        nftDiv.appendChild(img);

        const priceBadge = document.createElement('div');
        priceBadge.textContent = `$${nftObj.price}`;
        priceBadge.className = `
          absolute bottom-0 left-0 w-full text-xs text-amber-300
          bg-black/60 text-center py-0.5 backdrop-blur-sm
          opacity-0 group-hover:opacity-100 transition-opacity duration-150
        `;
        nftDiv.appendChild(priceBadge);

        nftsWrapper.appendChild(nftDiv);
      });

      pDiv.appendChild(pHeader);
      pDiv.appendChild(nftsWrapper);
      participantsWrapper.appendChild(pDiv);
    });

    card.appendChild(participantsWrapper);
    container.appendChild(card);
  });
});
