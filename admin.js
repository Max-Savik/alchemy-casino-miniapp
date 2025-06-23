(async () => {
  const initDataRaw = window.Telegram?.WebApp?.initData || '';
  if (!initDataRaw) return;

// admin.js
const API = 'https://alchemy-casino-miniapp.onrender.com';   // тот же, что в history.js

const headers = { 'X-Telegram-Init-Data': initDataRaw };

// ───── загрузка
const res = await fetch(`${API}/admin/history`, { headers });
  if (res.status === 401 || res.status === 403) {
    document.getElementById('notAdmin').classList.remove('hidden');
    return;
  }
  const history = await res.json();
  document.getElementById('panel').classList.remove('hidden');

  // заполнение таблицы
  const tbody = document.getElementById('table');
  history.forEach((rec, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pr-3">${new Date(rec.timestamp).toLocaleString('ru')}</td>
      <td class="pr-3 text-amber-300">${rec.winner}</td>
      <td class="pr-3">${rec.total.toFixed(2)} TON</td>
      <td>
        <button data-idx="${i}" class="del bg-red-600 hover:bg-red-500 px-2 py-0.5 rounded">🗑</button>
      </td>`;
    tbody.appendChild(tr);
  });

  // скачать JSON
  document.getElementById('download').onclick = () => {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'history.json';
    a.click();
  };

  // очистка истории
  document.getElementById('clear').onclick = async () => {
    if (!confirm('Очистить всю историю безвозвратно?')) return;
    await fetch(`${API}/admin/history/clear`, { method: 'POST', headers });
    location.reload();
  };

  // удаление одной записи
  tbody.addEventListener('click', async e => {
    if (e.target.matches('.del')) {
      const idx = e.target.dataset.idx;
      if (!confirm('Удалить запись?')) return;
      await fetch(`${API}/admin/history/${idx}`, { method: 'DELETE', headers });
      location.reload();
    }
  });
})();
