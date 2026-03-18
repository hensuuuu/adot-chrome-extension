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

// Extension 연결 상태 알림 (버전 포함)
window.postMessage({
  from: 'adot-extension',
  action: 'bridgeReady',
  version: chrome.runtime.getManifest().version
}, DASHBOARD_ORIGIN);

// 대시보드 진입 시 자동 수집 (1시간 간격)
chrome.storage.local.get('lastSync', (data) => {
  const last = data.lastSync?.time;
  const elapsed = last ? (Date.now() - new Date(last).getTime()) : Infinity;
  const MIN_INTERVAL = 60 * 60 * 1000; // 1시간

  if (elapsed > MIN_INTERVAL) {
    console.log(`[에이닷] 마지막 수집 ${Math.round(elapsed/60000)}분 전 → 자동 수집 시작`);
    // lastSync를 먼저 갱신해서 중복 트리거 방지
    chrome.storage.local.set({ lastSync: { time: new Date().toISOString(), status: 'collecting' } });
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'startCollection' }, (res) => {
        console.log('[에이닷] 자동 수집 응답:', res);
      });
    }, 3000);
  } else {
    console.log(`[에이닷] 마지막 수집 ${Math.round(elapsed/60000)}분 전 → 자동 수집 스킵`);
  }
});
