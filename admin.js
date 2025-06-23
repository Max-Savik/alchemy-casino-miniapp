// admin.js
const API = 'https://alchemy-casino-miniapp.onrender.com';

(async () => {
  // ждём initData
  while (!window.Telegram?.WebApp?.initData) {
    await new Promise(r => setTimeout(r, 50));
  }
  const initDataRaw = window.Telegram.WebApp.initData;
  const headers = { 'X-Tg-Init-Data-B64': btoa(initDataRaw) };   // 👈 base64!

  const apiFetch = (path, opt = {}) =>
  fetch(`${API}${path}`, { ...opt, headers });

  const res = await fetch(`${API}/admin/history`, { headers });
  if (res.status === 401 || res.status === 403) {
    document.getElementById('notAdmin').classList.remove('hidden');
    return;
  }
  const history = await res.json();
  document.getElementById('panel').classList.remove('hidden');

  /* ---------- таблица ---------- */
  const tbody = document.getElementById('table');
  if (!history.length) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="py-8 text-center text-gray-400">История пуста</td></tr>';
  }
  history.forEach((rec, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pr-3">${new Date(rec.timestamp).toLocaleString('ru')}</td>
      <td class="pr-3 text-amber-300">${rec.winner}</td>
      <td class="pr-3">${rec.total.toFixed(2)} TON</td>
      <td><button data-idx="${i}"
                  class="del bg-red-600 hover:bg-red-500 px-2 py-0.5 rounded">🗑</button></td>`;
    tbody.appendChild(tr);
  });

  /* ---------- кнопки ---------- */
  document.getElementById('download').onclick = () => {
    const blob = new Blob([JSON.stringify(history, null, 2)],
                          { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: 'history.json'
    });
    a.click();
  };

  document.getElementById('clear').onclick = async () => {
    if (!confirm('Очистить всю историю?')) return;
    await apiFetch('/admin/history/clear', { method: 'POST' });
    location.reload();
  };

  tbody.addEventListener('click', async e => {
    if (!e.target.matches('.del')) return;
    const idx = e.target.dataset.idx;
    if (!confirm('Удалить запись?')) return;
    await apiFetch(`/admin/history/${idx}`, { method: 'DELETE' });
    location.reload();
  });
})();
