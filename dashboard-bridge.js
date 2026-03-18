// ============================================
// 대시보드 ↔ Extension 브릿지
// hensuuuu.github.io/adot-dashboard 에서 동작
// ============================================

const DASHBOARD_ORIGIN = 'https://hensuuuu.github.io';

console.log('[에이닷] 대시보드 브릿지 활성화');

// 대시보드 → Extension: postMessage 수신
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== DASHBOARD_ORIGIN) return;
  if (!event.data || event.data.from !== 'adot-dashboard') return;

  if (event.data.action === 'startCollection') {
    console.log('[에이닷] 수집 요청 수신 → background로 전달');
    chrome.runtime.sendMessage({ action: 'startCollection' }, (response) => {
      window.postMessage({
        from: 'adot-extension',
        action: 'collectionStatus',
        status: response?.status || 'error',
        message: response?.message || '알 수 없는 오류'
      }, DASHBOARD_ORIGIN);
    });
  }
});

// Extension → 대시보드: 수집 완료 알림
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'collectionProgress' || msg.action === 'collectionDone') {
    window.postMessage({
      from: 'adot-extension',
      action: msg.action,
      ...msg
    }, DASHBOARD_ORIGIN);
  }
});

// Extension 연결 상태 알림
window.postMessage({
  from: 'adot-extension',
  action: 'bridgeReady'
}, DASHBOARD_ORIGIN);

// 자동 수집 비활성화 — 대시보드 '🔄 CRM 수집' 버튼으로만 수집
// (자동 수집이 무한 루프 유발: service worker 재시작 시 플래그 리셋)
chrome.storage.local.get('lastSync', (data) => {
  const last = data.lastSync?.time;
  const elapsed = last ? (Date.now() - new Date(last).getTime()) : Infinity;
  if (last) {
    console.log(`[에이닷] 마지막 수집 ${Math.round(elapsed/60000)}분 전 — 자동 수집 OFF (수동만 가능)`);
  } else {
    console.log(`[에이닷] 수집 기록 없음 — 대시보드에서 '🔄 CRM 수집' 버튼 클릭해서 수집 시작`);
  }
});
