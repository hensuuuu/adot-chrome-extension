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
    const source = msg.source || COLLECTION_STEPS[currentStep]?.source || 'unknown';
    handleStepDone(source, msg.count);
    return;
  }
});

function handleStepDone(source, count) {
  const step = COLLECTION_STEPS[currentStep];
  console.log(`[에이닷 BG] ${source} 수집 완료: ${count}건`);
  collectionResults[source] = count;

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
      message: `${step.emoji} ${step.name} ${count}건 완료 → ${next.emoji} ${next.name} 수집 중...`
    });
    setTimeout(() => runNextStep(), 1000); // 1초 대기 후 다음
  } else {
    // 전체 완료
    collectionInProgress = false;
    const summary = Object.entries(collectionResults)
      .map(([k, v]) => `${k}: ${v}건`)
      .join(', ');

    // lastSync 저장 — dashboard-bridge 자동수집 중복 방지
    chrome.storage.local.set({ lastSync: { time: new Date().toISOString(), results: collectionResults } });

    notifyAllDashboards({
      action: 'collectionDone',
      message: `✅ 전체 수집 완료! ${summary}`,
      results: collectionResults
    });
  }
}

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

    // 2분 per-step 타임아웃
    const stepIndex = currentStep;
    setTimeout(() => {
      if (collectionInProgress && currentStep === stepIndex && currentTabId === tab.id) {
        console.log(`[에이닷 BG] Step ${stepIndex + 1} 타임아웃 (2분)`);
        handleStepDone(step.source + '_timeout', 0);
      }
    }, 120000);
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

// ============================================
// 자동 업데이트 체크
// ============================================
const VERSION_URL = 'https://raw.githubusercontent.com/hensuuuu/adot-chrome-extension/main/version.json';

async function checkForUpdate() {
  try {
    const res = await fetch(VERSION_URL + '?t=' + Date.now());
    if (!res.ok) return;
    const remote = await res.json();
    const local = chrome.runtime.getManifest().version;
    
    if (remote.version !== local) {
      console.log(`[에이닷] 업데이트 발견: ${local} → ${remote.version}`);
      chrome.storage.local.set({ 
        updateAvailable: { 
          version: remote.version, 
          download: remote.download,
          notes: remote.notes 
        } 
      });
      // 팝업 배지
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#d63031' });
    } else {
      chrome.storage.local.remove('updateAvailable');
      chrome.action.setBadgeText({ text: '' });
    }
  } catch(e) {
    console.log('[에이닷] 업데이트 체크 실패:', e.message);
  }
}

// 시작 시 + 6시간마다 체크
checkForUpdate();
setInterval(checkForUpdate, 6 * 60 * 60 * 1000);

// 메시지 핸들러에 업데이트 체크 추가
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'checkUpdate') {
    checkForUpdate().then(() => sendResponse({ ok: true }));
    return true;
  }
});
