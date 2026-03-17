chrome.storage.local.get('lastSync', (data) => {
  const statusEl = document.getElementById('status');
  if (data.lastSync) {
    statusEl.textContent = '● 연결됨';
    statusEl.className = 'status ok';
    const t = new Date(data.lastSync.time);
    document.getElementById('last-sync').textContent = 
      t.toLocaleDateString('ko-KR') + ' ' + t.toLocaleTimeString('ko-KR');
    document.getElementById('last-page').textContent = data.lastSync.page;
    document.getElementById('last-count').textContent = data.lastSync.count + '건';
  } else {
    statusEl.textContent = '⏳ CRM 페이지를 열어주세요';
    statusEl.className = 'status waiting';
  }
});

document.getElementById('open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://hensuuuu.github.io/adot-dashboard/' });
  window.close();
});

document.getElementById('manual-sync').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'startCollection' }, (res) => {
    if (res?.status === 'started') {
      document.getElementById('status').textContent = '🔄 수집 중...';
      setTimeout(() => window.close(), 1500);
    }
  });
});
