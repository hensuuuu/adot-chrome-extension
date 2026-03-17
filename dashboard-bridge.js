// ============================================
// 대시보드 ↔ Extension 브릿지
// hensuuuu.github.io/adot-dashboard 에서 동작
// ============================================

console.log('[에이닷] 대시보드 브릿지 활성화');

// 대시보드 → Extension: postMessage 수신
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.from !== 'adot-dashboard') return;

  if (event.data.action === 'startCollection') {
    console.log('[에이닷] 수집 요청 수신 → background로 전달');
    chrome.runtime.sendMessage({ action: 'startCollection' }, (response) => {
      window.postMessage({
        from: 'adot-extension',
        action: 'collectionStatus',
        status: response?.status || 'error',
        message: response?.message || '알 수 없는 오류'
      }, '*');
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
    }, '*');
  }
});

// Extension 연결 상태 알림
window.postMessage({
  from: 'adot-extension',
  action: 'bridgeReady'
}, '*');

// 대시보드 진입 시 자동 수집 시작 (마지막 수집 후 30분 이상 경과 시)
chrome.storage.local.get('lastSync', (data) => {
  const last = data.lastSync?.time;
  const elapsed = last ? (Date.now() - new Date(last).getTime()) : Infinity;
  const MIN_INTERVAL = 30 * 60 * 1000; // 30분

  if (elapsed > MIN_INTERVAL) {
    console.log(`[에이닷] 마지막 수집 ${Math.round(elapsed/60000)}분 전 → 자동 수집 시작`);
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'startCollection' }, (res) => {
        console.log('[에이닷] 자동 수집 응답:', res);
      });
    }, 2000); // 대시보드 로딩 후 2초 대기
  } else {
    console.log(`[에이닷] 마지막 수집 ${Math.round(elapsed/60000)}분 전 → 자동 수집 스킵`);
  }
});
