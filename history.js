// ======================== history.js ========================

// Ждём, пока DOM загрузится:
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('historyContainer');
  const backBtn   = document.getElementById('backBtn');

  // Клик по кнопке «Назад» → возвращаемся на index.html
  backBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // Пробуем получить историю из localStorage
  let gameHistory = [];
  try {
    const raw = localStorage.getItem('gameHistory');
    if (raw) {
      gameHistory = JSON.parse(raw);
    }
  } catch (e) {
    console.warn("Не удалось загрузить историю из localStorage:", e);
  }

  // Если нет ни одной записи, показываем заглушку
  if (!gameHistory || gameHistory.length === 0) {
    const msg = document.createElement('p');
    msg.textContent = "История пуста — пока нет завершённых игр.";
    msg.className = 'text-lg text-gray-400 text-center py-10';
    container.appendChild(msg);
    return;
  }

  // Иначе рисуем таблицу
  const table = document.createElement('table');
  table.className = 'min-w-full bg-gray-800 rounded-lg overflow-hidden shadow-lg';

  // Заголовок таблицы
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr class="bg-gray-700 text-gray-200 text-left">
      <th class="px-4 py-2">Дата и время</th>
      <th class="px-4 py-2">Победитель</th>
      <th class="px-4 py-2">Призовой фонд</th>
      <th class="px-4 py-2">Участники</th>
    </tr>
  `;
  table.appendChild(thead);

  // Тело таблицы
  const tbody = document.createElement('tbody');
  gameHistory.forEach(record => {
    // record = { timestamp, winner, total, participants }
    const tr = document.createElement('tr');
    tr.className = 'border-b border-gray-700 hover:bg-gray-700';

    // Колонка: Дата и время (читаемо)
    const dt = new Date(record.timestamp);
    const dateStr = dt.toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    tr.innerHTML = `
      <td class="px-4 py-2 text-gray-200">${dateStr}</td>
      <td class="px-4 py-2 text-amber-300 font-medium">${record.winner}</td>
      <td class="px-4 py-2 text-gray-100">$${record.total.toFixed(2)}</td>
      <td class="px-4 py-2 text-gray-200">${record.participants}</td>
    `;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
});
