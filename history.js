// ======================== history.js ========================

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('historyContainer');
  const backBtn   = document.getElementById('backBtn');

  backBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // Загружаем историю из localStorage
  let gameHistory = [];
  try {
    const raw = localStorage.getItem('gameHistory');
    if (raw) {
      gameHistory = JSON.parse(raw);
    }
  } catch (e) {
    console.warn("Не удалось загрузить историю:", e);
  }

  if (!gameHistory || gameHistory.length === 0) {
    const msg = document.createElement('p');
    msg.textContent = "История пуста — пока нет завершённых игр.";
    msg.className = 'text-lg text-gray-400 text-center py-10';
    container.appendChild(msg);
    return;
  }

  // Перебираем каждую запись и рисуем карточку
  gameHistory.forEach(record => {
    // record = { timestamp, winner, total, participants: [ {name, nfts:[…]} ] }
    const card = document.createElement('div');
    card.className = 'bg-gray-800 rounded-lg p-4 flex flex-col gap-4';

    // ── Блок с основной информацией
    const info = document.createElement('div');
    info.className = 'flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2';

    // Форматируем дату-время
    const dt = new Date(record.timestamp);
    const dateStr = dt.toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const dateEl = document.createElement('div');
    dateEl.textContent = dateStr;
    dateEl.className = 'text-gray-400 text-sm';

    const winnerEl = document.createElement('div');
    winnerEl.innerHTML = `<span class="text-amber-300 font-semibold">${record.winner}</span> 
                          выиграл <span class="text-gray-100 font-medium">$${record.total.toFixed(2)}</span>`;
    winnerEl.className = 'text-gray-200 text-base';

    info.appendChild(dateEl);
    info.appendChild(winnerEl);
    card.appendChild(info);

    // ── Блок: Участники + их NFT
    const participantsWrapper = document.createElement('div');
    participantsWrapper.className = 'flex flex-col gap-3';

    record.participants.forEach(p => {
      // p = { name, nfts: [ {id, img, price}, … ] }
      const pDiv = document.createElement('div');
      pDiv.className = 'flex flex-col gap-1';

      // Имя участника и сумма его ставок (суммируем цены NFT)
      const totalByPlayer = p.nfts.reduce((s, x) => s + x.price, 0);
      const pHeader = document.createElement('div');
      pHeader.innerHTML = `
        <span class="text-emerald-300 font-medium">${p.name}</span> 
        поставил <span class="text-gray-100">$${totalByPlayer.toFixed(2)}</span>
      `;
      pHeader.className = 'text-gray-200 text-sm';

      // Блок с NFT иконками — горизонтальная прокрутка на узких
      const nftsWrapper = document.createElement('div');
      nftsWrapper.className = 'flex gap-2 overflow-x-auto py-1';

      p.nfts.forEach(nftObj => {
        const nftDiv = document.createElement('div');
        nftDiv.className = `
          relative 
          w-16 h-16 
          rounded-md 
          overflow-hidden 
          shadow-md 
          border border-gray-600 
          flex-shrink-0
        `;
        const img = document.createElement('img');
        img.src = nftObj.img;
        img.alt = nftObj.id;
        img.className = 'w-full h-full object-cover';
        nftDiv.appendChild(img);

        // Цена поверх при наведении (hover) — аналогично основному UI
        const priceBadge = document.createElement('div');
        priceBadge.textContent = `$${nftObj.price}`;
        priceBadge.className = `
          absolute bottom-0 left-0 
          w-full 
          bg-gray-900/80 
          text-xs text-amber-300 
          text-center py-0.5 
          opacity-0 hover:opacity-100 
          transition-opacity duration-150
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
