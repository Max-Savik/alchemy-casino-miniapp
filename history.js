// File: history.js
document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('historyContainer');
  const backBtn   = document.getElementById('backBtn');

  backBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  let gameHistory = null;

  // 1) Пытаемся получить историю с сервера
  try {
    const API = 'https://alchemy-casino-miniapp.onrender.com';
    const res = await fetch(`${API}/history`);
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    gameHistory = await res.json();
  } catch (serverErr) {
    console.warn('Не удалось запросить /history:', serverErr);

    // 2) Фоллбэк — пробуем загрузить статичный файл history.json
    try {
      const res2 = await fetch(`${API}/history.json`);
      if (!res2.ok) throw new Error(`history.json responded ${res2.status}`);
      gameHistory = await res2.json();
    } catch (fileErr) {
      console.error('Не удалось загрузить history.json:', fileErr);
    }
  }

  // Если ничего не подгрузилось — показываем ошибку
  if (!Array.isArray(gameHistory)) {
    const msg = document.createElement('p');
    msg.textContent = "Ошибка при загрузке истории.";
    msg.className = 'text-lg text-red-400 text-center py-10';
    container.appendChild(msg);
    return;
  }

  // Если нет записей — пустая история
  if (gameHistory.length === 0) {
    const msg = document.createElement('p');
    msg.textContent = "История пуста — пока нет завершённых игр.";
    msg.className = 'text-lg text-gray-400 text-center py-10';
    container.appendChild(msg);
    return;
  }

  // Рендерим каждую запись
  gameHistory.forEach(record => {
    // record = { timestamp, winner, total, participants: [ {name, nfts:[…]} ] }
    const card = document.createElement('div');
    card.className = 'bg-gray-800 rounded-lg p-4 flex flex-col gap-4';

    // ── Шапка: дата + победитель
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
    dateEl.className = 'text-gray-400 text-sm';

    const winnerEl = document.createElement('div');
    winnerEl.innerHTML = `
      <span class="text-amber-300 font-semibold">${record.winner}</span>
      выиграл <span class="text-gray-100 font-medium">$${record.total.toFixed(2)}</span>
    `;
    winnerEl.className = 'text-gray-200 text-base';

    info.appendChild(dateEl);
    info.appendChild(winnerEl);
    card.appendChild(info);

    // ── Участники и их NFT
    const participantsWrapper = document.createElement('div');
    participantsWrapper.className = 'flex flex-col gap-3';

    record.participants.forEach(p => {
      const pDiv = document.createElement('div');
      pDiv.className = 'flex flex-col gap-1';

      const totalByPlayer = p.nfts.reduce((sum,x) => sum + x.price, 0);
      const pHeader = document.createElement('div');
      pHeader.innerHTML = `
        <span class="text-emerald-300 font-medium">${p.name}</span>
        поставил <span class="text-gray-100">$${totalByPlayer.toFixed(2)}</span>
      `;
      pHeader.className = 'text-gray-200 text-sm';

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
