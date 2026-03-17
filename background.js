// ============================================
// Background Service Worker
// CRM 데이터 수집 + 대시보드 연동
// ============================================

let collectionInProgress = false;
let currentTabId = null;

// 수집 순서 정의
const COLLECTION_STEPS = [
  {
    name: '학생 목록',
    url: 'https://crm.adotenglish.com/contents/contents?1=1&m_no1=4&m_no2=68&m_no3=&db_name=student&in=1&page=1',
    source: 'students',
    emoji: '🎓'
  },
  {
    name: '결제 현황',
    url: 'https://crm.adotenglish.com/contents/contents?1=1&m_no1=4&m_no2=134&m_no3=136&db_name=&in=1&page=1',
    source: 'payments',
    emoji: '💳'
  },
  {
    name: '수업 관리',
    url: 'https://crm.adotenglish.com/popup/learningManager/classPlannerManager.html',
    source: 'schedule',
    emoji: '📅'
  },
  {
    name: '수행도',
    url: 'https://crm.adotenglish.com/popup/learningManager/performanceManager.html',
    source: 'performance',
    emoji: '📊'
  }
];

let currentStep = 0;
let collectionResults = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openDashboard') {
    chrome.tabs.create({ url: 'https://hensuuuu.github.io/adot-dashboard/' });
    return;
  }

  if (msg.action === 'startCollection') {
    if (collectionInProgress) {
      sendResponse({ status: 'busy', message: '이미 수집 중...' });
      return;
    }
    collectionInProgress = true;
    currentStep = 0;
    collectionResults = {};
    sendResponse({ status: 'started', message: '전체 수집 시작 (학생→결제→수행도)' });
    runNextStep();
    return true;
  }

  if (msg.action === 'collectionProgress') {
    console.log('[에이닷 BG] 진행:', msg.message);
    notifyAllDashboards({
      action: 'collectionProgress',
      message: msg.message
    });
    return;
  }

  if (msg.action === 'contentScriptDone') {
    const step = COLLECTION_STEPS[currentStep];
    const source = msg.source || step?.source || 'unknown';
    console.log(`[에이닷 BG] ${source} 수집 완료: ${msg.count}건`);
    collectionResults[source] = msg.count;

    // 현재 탭 닫기
    if (currentTabId) {
      try { chrome.tabs.remove(currentTabId); } catch(e) {}
      currentTabId = null;
    }

    // 다음 스텝으로
    currentStep++;
    if (currentStep < COLLECTION_STEPS.length) {
      const next = COLLECTION_STEPS[currentStep];
      notifyAllDashboards({
        action: 'collectionProgress',
        message: `${step.emoji} ${step.name} ${msg.count}건 완료 → ${next.emoji} ${next.name} 수집 중...`
      });
      setTimeout(() => runNextStep(), 1000); // 1초 대기 후 다음
    } else {
      // 전체 완료
      collectionInProgress = false;
      const summary = Object.entries(collectionResults)
        .map(([k, v]) => `${k}: ${v}건`)
        .join(', ');
      notifyAllDashboards({
        action: 'collectionDone',
        message: `✅ 전체 수집 완료! ${summary}`,
        results: collectionResults
      });
    }
    return;
  }
});

function runNextStep() {
  if (currentStep >= COLLECTION_STEPS.length) {
    collectionInProgress = false;
    return;
  }

  const step = COLLECTION_STEPS[currentStep];
  console.log(`[에이닷 BG] Step ${currentStep + 1}/${COLLECTION_STEPS.length}: ${step.name}`);
  
  notifyAllDashboards({
    action: 'collectionProgress',
    message: `${step.emoji} ${step.name} 수집 중... (${currentStep + 1}/${COLLECTION_STEPS.length})`
  });

  chrome.tabs.create({ url: step.url, active: false }, (tab) => {
    currentTabId = tab.id;
  });

  // 10분 타임아웃 (전체)
  if (currentStep === 0) {
    setTimeout(() => {
      if (collectionInProgress) {
        console.log('[에이닷 BG] 10분 타임아웃 — 강제 종료');
        collectionInProgress = false;
        if (currentTabId) {
          try { chrome.tabs.remove(currentTabId); } catch(e) {}
          currentTabId = null;
        }
        notifyAllDashboards({
          action: 'collectionDone',
          message: '⚠️ 수집 타임아웃 (10분 초과)',
          error: true
        });
      }
    }, 600000);
  }
}

function notifyAllDashboards(msg) {
  chrome.tabs.query({ url: 'https://hensuuuu.github.io/adot-dashboard/*' }, (tabs) => {
    tabs.forEach(t => {
      try { chrome.tabs.sendMessage(t.id, msg); } catch(e) {}
    });
  });
}
