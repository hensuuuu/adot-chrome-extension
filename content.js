// ============================================
// 에이닷 CRM 데이터 수집 Content Script
// ============================================

const SUPABASE_URL = 'https://brpruzsnysqmydsgeexe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_TJaiY1pCJL2fbWxF5S2quA_yBSxs6jB';

// Supabase REST API 호출
async function supabaseInsert(table, data) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(Array.isArray(data) ? data : [data])
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[에이닷] ${table} insert 실패:`, err);
    return false;
  }
  console.log(`[에이닷] ${table} insert 성공: ${Array.isArray(data) ? data.length : 1}건`);
  return true;
}

async function supabaseSelect(table, query = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  return res.json();
}

// ============================================
// 현재 URL 감지
// ============================================
const currentPath = window.location.pathname;
const currentUrl = window.location.href;
const currentSearch = window.location.search;

console.log('[에이닷 CRM 수집기] 페이지 감지:', currentPath, currentSearch);

// ============================================
// 학생 목록 페이지 파서
// URL: /contents/contents?m_no1=4&m_no2=68&db_name=student
// 또는 /contents/studentlist.html
// 
// 테이블: table.tbstyle_a
// 컬럼순: No | 분원 | 학습반 | 학생코드 | OT일 | 담당T | 수업일 | 성명(이니셜) | 아이디 | 학교 | 학생연락처 | 강사선택 | 관리
// 인덱스:  0     1      2       3       4      5      6        7         8      9       10       11      12
// ============================================
async function parseStudentList() {
  const rows = document.querySelectorAll('table.tbstyle_a tbody tr.a');
  if (rows.length === 0) {
    console.log('[에이닷] 학생 행 없음');
    return [];
  }

  console.log(`[에이닷] 학생 ${rows.length}행 발견`);

  // 먼저 branches/teachers 캐시 (이미 DB에 있는 것 활용)
  const existingBranches = await supabaseSelect('branches', 'select=id,name');
  const existingTeachers = await supabaseSelect('teachers', 'select=id,name,username');

  const students = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 11) return;

    const branch = cells[1]?.textContent?.trim();
    const className = cells[2]?.textContent?.trim();
    const studentCode = cells[3]?.textContent?.trim();
    const otDate = cells[4]?.textContent?.trim();
    
    // 담당T: "조*영 T\n(jka****)" 형태
    const teacherRaw = cells[5]?.textContent?.trim();
    const teacherName = teacherRaw?.split('T')[0]?.trim()?.replace(/\s+/g, '') || '';
    const teacherUsername = teacherRaw?.match(/\(([^)]+)\)/)?.[1]?.trim() || '';
    
    const classDay = cells[6]?.textContent?.trim();
    const name = cells[7]?.textContent?.trim();
    const username = cells[8]?.textContent?.trim();
    
    // 학교: "함지고 (대구) 고1" 형태
    const schoolRaw = cells[9]?.textContent?.trim();
    const schoolParts = schoolRaw?.split(/\s+/).filter(Boolean) || [];
    const school = schoolParts[0] || '';
    const grade = schoolParts[schoolParts.length - 1] || '';
    
    const phone = cells[10]?.textContent?.trim();

    // 관리 버튼에서 idx 추출 (내부 ID)
    const modBtn = cells[12]?.querySelector('input[onclick*="studentAdd"]');
    const crmId = modBtn?.getAttribute('onclick')?.match(/studentAdd\('(\d+)'\)/)?.[1] || '';

    students.push({
      student_code: studentCode,
      name,
      school,
      grade,
      phone,
      class_name: className,
      // 메타 정보 (매핑용)
      _branch: branch,
      _teacher_name: teacherName,
      _teacher_username: teacherUsername,
      _crm_id: crmId
    });
  });

  console.log(`[에이닷] 학생 ${students.length}명 파싱 완료`);
  
  // 선생님 매칭 함수: 마스킹 이름(조*영) → 풀네임(조재영) 매칭
  function matchTeacher(maskedName, username) {
    if (!maskedName && !username) return null;
    
    // 1. username 매칭 (가장 정확)
    if (username) {
      const found = existingTeachers.find(t => t.username === username);
      if (found) return found;
    }
    
    // 2. 풀네임 포함 매칭
    if (maskedName) {
      const found = existingTeachers.find(t => t.name?.includes(maskedName));
      if (found) return found;
    }
    
    // 3. 첫글자 + 끝글자 매칭 (마스킹 해제)
    if (maskedName && maskedName.includes('*')) {
      const clean = maskedName.replace(/\*/g, '');
      const first = clean[0];
      const last = clean[clean.length - 1];
      if (first && last) {
        const found = existingTeachers.find(t => 
          t.name && t.name[0] === first && t.name[t.name.length - 1] === last
        );
        if (found) return found;
      }
    }
    
    return null;
  }

  // 매칭 안 되는 선생님은 새로 등록
  const newTeachers = new Map(); // maskedName → teacher record
  
  const records = [];
  for (const s of students) {
    if (!s.student_code) continue;
    
    const branch = existingBranches.find(b => b.name === s._branch);
    let teacher = matchTeacher(s._teacher_name, s._teacher_username);
    
    // 매칭 안 되면 새 teacher 등록
    if (!teacher && s._teacher_name) {
      const key = s._teacher_name + '|' + (s._teacher_username || '');
      if (!newTeachers.has(key)) {
        const newT = { name: s._teacher_name, is_active: true };
        if (s._teacher_username) newT.username = s._teacher_username;
        const ok = await supabaseInsert('teachers', newT);
        if (ok) {
          console.log(`[에이닷] 새 선생님 등록: ${s._teacher_name}`);
          // 다시 조회
          const refreshed = await supabaseSelect('teachers', 'select=id,name,username');
          existingTeachers.length = 0;
          existingTeachers.push(...refreshed);
          teacher = matchTeacher(s._teacher_name, s._teacher_username);
        }
        newTeachers.set(key, teacher);
      } else {
        teacher = newTeachers.get(key);
      }
    }

    const record = {
      student_code: s.student_code,
      name: s.name,
      school: s.school,
      grade: s.grade,
      phone: s.phone,
      class_name: s.class_name,
      is_active: true
    };

    if (branch) record.branch_id = branch.id;
    if (teacher) record.teacher_id = teacher.id;
    records.push(record);
  }

  if (records.length > 0) {
    console.log(`[에이닷] ${records.length}명 배치 insert 시도...`);
    const ok = await supabaseInsert('students', records);
    if (ok) {
      console.log(`[에이닷] students 배치 insert 성공: ${records.length}건`);
    } else {
      console.log('[에이닷] 배치 실패 — 개별 insert 시도');
      let success = 0, fail = 0;
      for (const r of records) {
        const ok2 = await supabaseInsert('students', r);
        if (ok2) success++; else fail++;
      }
      console.log(`[에이닷] 개별 insert 결과: 성공 ${success}, 실패 ${fail}`);
    }
  }

  return students;
}

// ============================================
// SMS 로그 파서
// URL: /contents/sms_log.html
// 테이블: table.tbstyle_a
// 컬럼순: No | 분원 | 수신자이름 | 수신번호 | 발신자 | 발신번호 | 문자종류 | 발송시간 | 발송결과
// 인덱스:  0     1       2         3        4        5        6        7        8
// ============================================
async function parseSmsLog() {
  const rows = document.querySelectorAll('table.tbstyle_a tbody tr');
  if (rows.length === 0) return [];

  console.log(`[에이닷] SMS 로그 ${rows.length}행 발견`);

  const existingTeachers = await supabaseSelect('teachers', 'select=id,name,username');
  const logs = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 8) return;

    const recipientName = cells[2]?.textContent?.trim();
    const recipientPhone = cells[3]?.textContent?.trim();
    
    // 발신자: "박은식(joseph22)" 형태
    const senderRaw = cells[4]?.textContent?.trim();
    const senderName = senderRaw?.split('(')[0]?.trim() || '';
    const senderUsername = senderRaw?.match(/\(([^)]+)\)/)?.[1]?.trim() || '';
    
    const senderPhone = cells[5]?.textContent?.trim();
    const msgType = cells[6]?.textContent?.trim();
    const sentAt = cells[7]?.textContent?.trim();
    const result = cells[8]?.textContent?.trim();

    const teacher = existingTeachers.find(t =>
      (senderUsername && t.username === senderUsername) ||
      (senderName && t.name === senderName)
    );

    logs.push({
      recipient_name: recipientName,
      recipient_phone: recipientPhone,
      sender_phone: senderPhone,
      message_type: msgType,
      sent_at: sentAt ? new Date(sentAt).toISOString() : new Date().toISOString(),
      result: result,
      teacher_id: teacher?.id || null
    });
  });

  if (logs.length > 0) {
    // 배치로 한번에 전송
    await supabaseInsert('sms_logs', logs);
    console.log(`[에이닷] SMS 로그 ${logs.length}건 저장`);
  }

  return logs;
}

// ============================================
// 수강권 결제 현황 파서
// URL: 수강권결제현황 페이지
// 컬럼순: No | 담당T | 수강시작일 | 지점 | 학습반 | 이름(닉네임) | 학생코드 | 학교/학년 | 성별 | 학생HP | 학부모HP | 납부금액 | 납부일 | 결제정보
// ============================================
// 날짜 문자열 안전 파싱 (yyyy-mm-dd, yyyy.mm.dd, yyyy/mm/dd, mm/dd, 한글 등)
function safeDateParse(dateStr) {
  if (!dateStr || dateStr.trim() === '' || dateStr === '-') return null;
  const s = dateStr.trim();
  // yyyy-mm-dd or yyyy.mm.dd or yyyy/mm/dd
  const m1 = s.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2,'0')}-${m1[3].padStart(2,'0')}`;
  // mm/dd/yyyy or mm-dd-yyyy
  const m2 = s.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (m2) return `${m2[3]}-${m2[1].padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
  // fallback: Date 파싱 시도
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch(e) {}
  return null;
}

async function parsePayments() {
  return await parsePaymentsAllPages(document);
}

async function parsePaymentsAllPages(initialDoc) {
  const url = new URL(window.location.href);
  const baseParams = new URLSearchParams(url.search);

  const existingTeachers = await supabaseSelect('teachers', 'select=id,name');
  const existingStudents = await supabaseSelect('students', 'select=id,student_code');
  const allPayments = [];
  let page = parseInt(baseParams.get('page') || '1');

  // 기존 결제 데이터 조회 (중복 방지용)
  const existingPayments = await supabaseSelect('payments', `select=student_id,period_year,period_month`);
  const existingSet = new Set(existingPayments.map(p => `${p.student_id}_${p.period_year}_${p.period_month}`));
  console.log(`[에이닷] 기존 결제 ${existingPayments.length}건 로드 (중복 체크용)`);

  // 페이지 제목에서 n월 추출 시도
  const titleText = initialDoc.querySelector('h2, h3, .title, .sub_title')?.textContent || '';
  const monthMatch = titleText.match(/(\d{1,2})월/);
  const yearMatch = titleText.match(/(\d{4})년/) || titleText.match(/20(\d{2})/);
  const now = new Date();
  const periodMonth = monthMatch ? parseInt(monthMatch[1]) : now.getMonth() + 1;
  const periodYear = yearMatch ? parseInt(yearMatch[1]) : now.getFullYear();

  while (true) {
    let doc;
    if (page === parseInt(baseParams.get('page') || '1') && allPayments.length === 0) {
      doc = initialDoc;
    } else {
      baseParams.set('page', page);
      const pageUrl = `${url.origin}${url.pathname}?${baseParams.toString()}`;
      try {
        const res = await fetch(pageUrl, { credentials: 'include' });
        const html = await res.text();
        if (html.includes('login') && html.length < 5000) {
          console.error('[에이닷] CRM 로그인 만료');
          break;
        }
        const parser = new DOMParser();
        doc = parser.parseFromString(html, 'text/html');
      } catch(e) {
        console.error(`[에이닷] 결제 ${page}페이지 fetch 실패:`, e);
        break;
      }
    }

    const rows = doc.querySelectorAll('table.tbstyle_a tbody tr');
    if (rows.length === 0) {
      console.log(`[에이닷] 결제 ${page}페이지: 데이터 없음 — 종료`);
      break;
    }

    console.log(`[에이닷] 결제 ${page}페이지: ${rows.length}행 발견`);
    showBadge(`💳 결제 ${page}페이지 수집 중... (누적 ${allPayments.length}건)`);

    const pagePayments = [];
    let skipped = 0;
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 12) { skipped++; return; }

      const teacherRaw = cells[1]?.textContent?.trim()?.replace(/T$/, '').trim(); // "김*경"
      const amount = parseInt(cells[11]?.textContent?.replace(/[^0-9]/g, '') || '0');
      const paymentStatus = cells[12]?.textContent?.trim(); // 납부현황: 납부완료/미납 등
      const paidDateRaw = cells[13]?.textContent?.trim();   // 납부일: 2026-03-17
      const studentCode = cells[6]?.textContent?.trim();

      // 마스킹 이름 매칭: "김*경" → /^김.경$/ 패턴으로 DB 이름과 비교
      let teacher = null;
      if (teacherRaw) {
        const pattern = new RegExp('^' + teacherRaw.replace(/\*/g, '.') + '$');
        teacher = existingTeachers.find(t => t.name && pattern.test(t.name));
        if (!teacher) {
          // fallback: 첫글자+끝글자 매칭
          const first = teacherRaw[0], last = teacherRaw[teacherRaw.length - 1];
          if (first && last && first !== '*' && last !== '*') {
            teacher = existingTeachers.find(t => t.name && t.name[0] === first && t.name[t.name.length - 1] === last && t.name.length === teacherRaw.length);
          }
        }
      }
      const student = existingStudents.find(s => s.student_code === studentCode);
      
      // student 매칭 안 되면 스킵 (합계행 등 노이즈 제거)
      if (!student) {
        console.log(`[에이닷] 학생코드 ${studentCode} 매칭 실패 — 스킵`);
        skipped++;
        return;
      }

      const paidDate = safeDateParse(paidDateRaw);
      // 납부현황이 "납부완료"인데 날짜가 없으면 오늘 날짜로 대체
      const isPaid = paymentStatus?.includes('완료') || paymentStatus?.includes('납부');
      const _pd = new Date();
      const _todayLocal = `${_pd.getFullYear()}-${String(_pd.getMonth()+1).padStart(2,'0')}-${String(_pd.getDate()).padStart(2,'0')}`;
      const finalPaidAt = paidDate || (isPaid ? _todayLocal : null);

      pagePayments.push({
        student_id: student.id,
        teacher_id: teacher?.id || null,
        amount: amount,
        period_year: periodYear,
        period_month: periodMonth,
        paid_at: finalPaidAt
      });
    });

    if (pagePayments.length === 0) {
      console.log(`[에이닷] 결제 ${page}페이지: 유효 데이터 0건 (스킵 ${skipped}) — 종료`);
      break;
    }

    // 중복 제거: 이미 DB에 있는 student+period 조합 스킵
    const newPayments = pagePayments.filter(p => {
      const key = `${p.student_id}_${p.period_year}_${p.period_month}`;
      if (existingSet.has(key)) return false;
      existingSet.add(key); // 이번 수집 내 중복도 방지
      return true;
    });

    if (newPayments.length > 0) {
      await supabaseInsert('payments', newPayments);
      console.log(`[에이닷] 결제 ${page}페이지 ${newPayments.length}건 저장 (${pagePayments.length - newPayments.length}건 중복 스킵)`);
    } else {
      console.log(`[에이닷] 결제 ${page}페이지: 전부 중복 — ${pagePayments.length}건 스킵`);
    }
    allPayments.push(...newPayments);

    // 다음 페이지 시도
    page++;
  }

  const totalAmount = allPayments.reduce((s, p) => s + (p.amount || 0), 0);
  console.log(`[에이닷] 결제 수집 완료: ${allPayments.length}건, 총 ${totalAmount.toLocaleString()}원`);
  showBadge(`💳 결제 ${allPayments.length}건 (${totalAmount.toLocaleString()}원)`);
  return allPayments;
}

// ============================================
// 전체 페이지 자동 순회 (fetch 방식)
// ============================================
async function collectAllPages() {
  // 현재 URL에서 base URL 추출
  const url = new URL(window.location.href);
  const baseParams = new URLSearchParams(url.search);
  
  let page = 1;
  let totalStudents = 0;
  const allStudents = [];

  // 먼저 현재 페이지의 데이터 저장용 캐시
  const existingBranches = await supabaseSelect('branches', 'select=id,name');
  const existingTeachers = await supabaseSelect('teachers', 'select=id,name,username');
  
  // 기존 학생 코드 조회 (중복 방지)
  const existingStudents = await supabaseSelect('students', 'select=student_code');
  const existingCodes = new Set(existingStudents.map(s => s.student_code).filter(Boolean));
  console.log(`[에이닷] 기존 학생 ${existingCodes.size}명 로드 (중복 체크용)`);

  while (true) {
    console.log(`[에이닷] 학생 목록 ${page}페이지 수집 중...`);
    showBadge(`📊 ${page}페이지 수집 중... (누적 ${totalStudents}명)`);
    
    baseParams.set('page', page);
    const pageUrl = `${url.origin}${url.pathname}?${baseParams.toString()}`;
    
    try {
      const res = await fetch(pageUrl, { credentials: 'include' });
      const html = await res.text();
      
      // HTML 파싱
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const rows = doc.querySelectorAll('table.tbstyle_a tbody tr.a');
      
      console.log(`[에이닷] ${page}페이지 HTML 길이: ${html.length}, 행 수: ${rows.length}`);
      
      // 로그인 체크
      if (html.includes('login') && html.length < 5000) {
        console.error('[에이닷] CRM 로그인 세션 만료! 다시 로그인 필요');
        showBadge('❌ CRM 로그인 필요');
        break;
      }
      
      if (rows.length === 0) {
        // tr.a가 없으면 tr만으로도 시도
        const fallbackRows = doc.querySelectorAll('table.tbstyle_a tbody tr');
        console.log(`[에이닷] ${page}페이지: tr.a 없음, tr 전체: ${fallbackRows.length}`);
        if (fallbackRows.length === 0) {
          console.log(`[에이닷] ${page}페이지: 데이터 없음 — 순회 종료`);
          break;
        }
        // fallback으로 tr 사용 — 아래에서 처리
      }

      // 학생 파싱 (tr.a 우선, 없으면 tr 전체)
      const actualRows = rows.length > 0 ? rows : doc.querySelectorAll('table.tbstyle_a tbody tr');
      const pageStudents = [];
      actualRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 11) return;

        const branch = cells[1]?.textContent?.trim();
        const className = cells[2]?.textContent?.trim();
        const studentCode = cells[3]?.textContent?.trim();
        const teacherRaw = cells[5]?.textContent?.trim();
        const teacherName = teacherRaw?.split('T')[0]?.trim()?.replace(/\s+/g, '') || '';
        const teacherUsername = teacherRaw?.match(/\(([^)]+)\)/)?.[1]?.trim() || '';
        const name = cells[7]?.textContent?.trim();
        const schoolRaw = cells[9]?.textContent?.trim();
        const schoolParts = schoolRaw?.split(/\s+/).filter(Boolean) || [];
        const school = schoolParts[0] || '';
        const grade = schoolParts[schoolParts.length - 1] || '';
        const phone = cells[10]?.textContent?.trim();

        if (!studentCode) return;
        
        // 담당T 없으면 비수강 → 스킵
        if (!teacherName) return;

        // 선생님 매칭
        let teacher = null;
        if (teacherUsername) {
          teacher = existingTeachers.find(t => t.username === teacherUsername);
        }
        if (!teacher && teacherName) {
          teacher = existingTeachers.find(t => t.name?.includes(teacherName));
        }
        if (!teacher && teacherName.includes('*')) {
          const clean = teacherName.replace(/\*/g, '');
          const first = clean[0], last = clean[clean.length - 1];
          if (first && last) {
            teacher = existingTeachers.find(t => t.name && t.name[0] === first && t.name[t.name.length - 1] === last);
          }
        }

        const record = {
          student_code: studentCode,
          name, school, grade, phone,
          class_name: className,
          is_active: true,
          teacher_id: teacher ? teacher.id : null
        };
        
        pageStudents.push(record);
      });

      // 중복 제거
      const newStudents = pageStudents.filter(s => {
        if (existingCodes.has(s.student_code)) return false;
        existingCodes.add(s.student_code);
        return true;
      });

      if (newStudents.length > 0) {
        const ok = await supabaseInsert('students', newStudents);
        const matched = newStudents.filter(s => s.teacher_id).length;
        console.log(`[에이닷] ${page}페이지: ${newStudents.length}명 저장 (${pageStudents.length - newStudents.length}명 중복 스킵, 선생님 매칭 ${matched}명)`);
        totalStudents += newStudents.length;
        allStudents.push(...newStudents);
        
        // background에 진행 상황 보고
        try {
          chrome.runtime.sendMessage({
            action: 'collectionProgress',
            message: `${page}페이지 완료 — 누적 ${totalStudents}명`
          });
        } catch(e) {}
      }

      page++;
      // 0.5초 대기 (서버 부하 방지)
      await new Promise(r => setTimeout(r, 500));
      
    } catch(e) {
      console.error(`[에이닷] ${page}페이지 수집 에러:`, e);
      break;
    }
  }

  console.log(`[에이닷] ✅ 자동 수집 완료 — 총 ${totalStudents}명 (${page - 1}페이지)`);
  showBadge(`✅ 자동 수집 완료 — ${totalStudents}명`);
  return allStudents;
}

// ============================================
// 수행도 수집 (DOM 직접 읽기 — JS 렌더링 대기)
// ============================================
// ============================================
// 수업 관리 — 요일별 학생 스케줄 수집
// ============================================
async function collectClassSchedule() {
  console.log('[에이닷] 수업 관리 — 학생 스케줄 수집 시작');
  showBadge('📅 수업 스케줄 로딩 대기...');

  // JS 렌더링 대기
  let cards = [];
  for (let i = 0; i < 30; i++) {
    cards = document.querySelectorAll('.st_select');
    if (cards.length > 0) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (cards.length === 0) {
    console.log('[에이닷] 수업 관리: 학생 카드 없음');
    showBadge('❌ 수업 데이터 없음');
    return [];
  }

  // 담당 필터를 "전체"로 설정
  const teacherSelect = document.querySelector('#selectWeek')?.closest('#class-header-search-option')?.querySelector('#selectTeacher');
  const teacherNice = document.querySelectorAll('.nice-select')[0];
  if (teacherNice) {
    const current = teacherNice.querySelector('.current')?.textContent?.trim();
    if (!current?.includes('전체')) {
      teacherNice.click();
      await new Promise(r => setTimeout(r, 300));
      const allOpt = teacherNice.querySelector('li[data-value=""]');
      if (allOpt) {
        allOpt.click();
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // 요일 필터를 "전체"로 설정
  const dayNice = document.querySelector('#day-custom .nice-select');
  if (dayNice) {
    const current = dayNice.querySelector('.current')?.textContent?.trim();
    if (current !== '전체') {
      dayNice.click();
      await new Promise(r => setTimeout(r, 300));
      const allOpt = dayNice.querySelector('li[data-value=""]');
      if (allOpt) {
        allOpt.click();
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // 다시 카드 수집 (필터 변경 후)
  cards = document.querySelectorAll('.st_select');
  console.log(`[에이닷] 수업 관리: ${cards.length}개 카드 발견`);
  showBadge(`📅 수업 ${cards.length}명 수집 중...`);

  const dayMap = { '월': '월요일', '화': '화요일', '수': '수요일', '목': '목요일', '금': '금요일', '토': '토요일', '일': '일요일' };
  const schedules = [];

  cards.forEach(card => {
    const studentCode = card.dataset.st_code || '';
    const studentId = card.dataset.st_id || '';
    const ps = card.querySelectorAll('p');
    
    const name = ps[0]?.textContent?.trim() || '';
    const gradeSchool = ps[1]?.textContent?.trim() || '';
    const dayTimeRaw = ps[2]?.textContent?.trim() || ''; // "월 (11:30~12:00)"

    // 요일+시간 파싱
    const dayMatch = dayTimeRaw.match(/^([월화수목금토일])\s*\((.+?)\)/);
    const classDay = dayMatch ? dayMap[dayMatch[1]] || dayMatch[1] : '';
    const classTime = dayMatch ? dayMatch[2] : '';

    if (studentCode && classDay) {
      schedules.push({
        student_code: studentCode,
        student_id: studentId,
        name: name,
        class_day: classDay,
        class_time: classTime,
        grade_school: gradeSchool
      });
    }
  });

  console.log(`[에이닷] 수업 스케줄 ${schedules.length}건 파싱 완료`);

  // students 테이블에 class_name 필드로 요일+시간 업데이트
  // (class_name 컬럼을 "월요일 11:30~12:00" 형태로 활용)
  const existingStudents = await supabaseSelect('students', 'select=id,student_code');
  let updated = 0;

  for (const s of schedules) {
    const student = existingStudents.find(st => st.student_code === s.student_code);
    if (student) {
      const classInfo = `${s.class_day} ${s.class_time}`;
      try {
        const url = `${SUPABASE_URL}/rest/v1/students?id=eq.${student.id}`;
        await fetch(url, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ class_name: classInfo })
        });
        updated++;
      } catch(e) {
        console.error(`[에이닷] 학생 업데이트 실패: ${s.name}`, e);
      }
    }
  }

  console.log(`[에이닷] 수업 스케줄: ${updated}/${schedules.length}명 DB 업데이트 완료`);
  showBadge(`📅 수업 ${updated}명 업데이트 완료`);
  
  // 수업일지 수집도 연이어 실행
  await collectClassJournals(schedules);
  
  return schedules;
}

// ============================================
// 수업일지 미작성 체크 (카드 클릭 → DOM 읽기)
// ============================================
async function collectClassJournals(schedules) {
  console.log('[에이닷] 수업일지 체크 시작 (카드 클릭 방식)...');
  showBadge('📝 수업일지 체크 중...');

  const dayNameMap = { 0: '일요일', 1: '월요일', 2: '화요일', 3: '수요일', 4: '목요일', 5: '금요일', 6: '토요일' };
  
  const today = new Date();
  // 로컬 날짜 포맷 (UTC 변환 방지)
  const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayStr = localDateStr(today);
  
  // 최근 3영업일 체크 (오늘 제외, 일요일 건너뜀)
  const checkDates = [];
  let offset = 1;
  while (checkDates.length < 3) {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    offset++;
    if (d.getDay() === 0) continue; // 일요일 스킵
    const dateStr = localDateStr(d);
    checkDates.push({ date: dateStr, dayName: dayNameMap[d.getDay()] });
  }
  
  console.log(`[에이닷] 체크 대상 날짜:`, checkDates.map(d => `${d.date}(${d.dayName})`).join(', '));

  const journalResults = [];
  let checked = 0, missing = 0;
  
  for (const checkDate of checkDates) {
    // 해당 요일로 필터 변경
    const dayNice = document.querySelector('#day-custom .nice-select');
    if (dayNice) {
      dayNice.click();
      await new Promise(r => setTimeout(r, 300));
      const opts = dayNice.querySelectorAll('li.option');
      let clicked = false;
      for (const opt of opts) {
        if (opt.textContent.trim() === checkDate.dayName) { opt.click(); clicked = true; break; }
      }
      if (!clicked) { console.log(`[에이닷] ${checkDate.dayName} 필터 없음`); continue; }
      await new Promise(r => setTimeout(r, 1500));
    }
    
    const dayStudents = [...document.querySelectorAll('.st_select, [data-st_code]')].map(card => ({
      student_code: card.dataset?.st_code || '',
      name: card.querySelector('p.text-w-700')?.textContent?.trim() || ''
    })).filter(s => s.student_code);
    
    if (dayStudents.length === 0) continue;
    console.log(`[에이닷] ${checkDate.date}(${checkDate.dayName}): ${dayStudents.length}명 체크`);
    
    for (const student of dayStudents) {
      try {
        
        // 학생 카드 클릭 → DOM에서 수업일지 확인
        const card = [...document.querySelectorAll('.st_select, [data-st_code]')].find(c => c.dataset?.st_code === student.student_code);
        if (!card) { console.log(`[에이닷] 카드 못 찾음: ${student.name}`); continue; }
        
        card.click();
        
        // #class-log-items 로딩 대기
        let logItems = null;
        for (let w = 0; w < 15; w++) {
          await new Promise(r => setTimeout(r, 300));
          logItems = document.querySelector('#class-log-items');
          if (logItems && logItems.children.length > 0) break;
        }
        
        // 날짜 형식: "2026년 03월 15일"
        const [cy, cm, cd] = checkDate.date.split('-');
        const dateKr = `${cy}년 ${cm}월 ${cd}일`;
        
        let hasJournal = false;
        if (logItems) {
          const dateTags = logItems.querySelectorAll('.history-title p.text-w-700');
          hasJournal = [...dateTags].some(p => p.textContent.includes(dateKr));
        }
        
        checked++;
        if (!hasJournal) {
          missing++;
          journalResults.push({
            student_code: student.student_code,
            student_name: student.name,
            class_day: checkDate.dayName,
            class_date: checkDate.date
          });
          console.log(`[에이닷] ❌ ${student.name}: ${checkDate.date} 일지 미작성`);
        } else {
          console.log(`[에이닷] ✅ ${student.name}: ${checkDate.date} 일지 있음`);
        }
        
        if (checked % 10 === 0) {
          showBadge(`📝 일지 ${checked}명... (미작성 ${missing}건)`);
          await new Promise(r => setTimeout(r, 100));
        }
      } catch(e) {
        console.error(`[에이닷] 일지 체크 실패: ${student.name}`, e);
      }
    }
  }
  
  console.log(`[에이닷] 수업일지 체크 완료: ${checked}명, 미작성 ${missing}건`);
  
  // DB 저장 — 기존 class_journal 전체 삭제 후 재삽입
  try {
    const delRes = await fetch(`${SUPABASE_URL}/rest/v1/attendance_records?type=eq.class_journal`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation' }
    });
    if (!delRes.ok) {
      const errText = await delRes.text();
      console.error(`[에이닷] 수업일지 DELETE 실패 (${delRes.status}):`, errText);
    } else {
      const deleted = await delRes.json();
      console.log(`[에이닷] 수업일지 기존 ${deleted.length}건 삭제 완료`);
    }
  } catch(e) {
    console.error('[에이닷] 수업일지 DELETE 에러:', e);
  }
  
  if (journalResults.length > 0) {
    const existingStudents = await supabaseSelect('students', 'select=id,student_code,teacher_id');
    
    const records = journalResults.map(j => {
      const student = existingStudents.find(s => s.student_code === j.student_code);
      return {
        student_id: student?.id || null,
        teacher_id: student?.teacher_id || null,
        record_date: j.class_date,
        type: 'class_journal',
        status: JSON.stringify({
          name: j.student_name, class_day: j.class_day, class_date: j.class_date,
          journal_written: false, checked_at: new Date().toISOString()
        })
      };
    });
    
    const insertOk = await supabaseInsert('attendance_records', records);
    console.log(`[에이닷] 수업일지 미작성 ${records.length}건 DB 저장 ${insertOk ? '성공' : '실패'}`);
  }
  
  showBadge(`📝 일지 미작성 ${missing}건`);
  return journalResults;
}

async function waitAndCollectPerformance() {
  console.log('[에이닷] 수행도 수집 — DOM 렌더링 대기 중...');
  showBadge('📊 수행도 데이터 로딩 대기...');
  
  // nice-select 렌더링 대기
  let niceSelect = null;
  for (let i = 0; i < 20; i++) {
    niceSelect = document.querySelector('.nice-select.form-select');
    if (niceSelect) break;
    await new Promise(r => setTimeout(r, 500));
  }
  
  // "전체" 선택 (모든 학생 표시)
  if (niceSelect) {
    const currentText = niceSelect.querySelector('.current')?.textContent?.trim();
    if (currentText !== '전체') {
      console.log('[에이닷] 담당 토글 → "전체"로 변경');
      // nice-select 열기
      niceSelect.click();
      await new Promise(r => setTimeout(r, 300));
      // "전체" 옵션 클릭
      const allOption = niceSelect.querySelector('li[data-value=""]');
      if (allOption) {
        allOption.click();
        console.log('[에이닷] "전체" 클릭 완료 — 데이터 갱신 대기...');
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    console.log('[에이닷] 담당: 전체 선택됨');
  }
  
  // JS가 데이터 렌더링할 때까지 대기 — 학생 수가 안정될 때까지
  let boxes = [];
  let prevCount = 0;
  let stableCount = 0;
  for (let i = 0; i < 40; i++) {
    boxes = document.querySelectorAll('.weekly-homework-list-box');
    if (boxes.length > 0 && boxes.length === prevCount) {
      stableCount++;
      if (stableCount >= 3) break; // 1.5초간 변화 없으면 안정
    } else {
      stableCount = 0;
    }
    prevCount = boxes.length;
    console.log(`[에이닷] 대기 중... ${boxes.length}명 (${i * 500}ms)`);
    await new Promise(r => setTimeout(r, 500));
  }
  
  if (boxes.length === 0) {
    console.log('[에이닷] 수행도 데이터 없음 (15초 대기 후)');
    showBadge('❌ 수행도 데이터 없음');
    return [];
  }

  console.log(`[에이닷] 수행도 ${boxes.length}명 발견!`);
  showBadge(`📊 수행도 ${boxes.length}명 수집 중...`);

  const existingStudents = await supabaseSelect('students', 'select=id,name,student_code,teacher_id');
  const records = [];
  const _now = new Date();
  const today = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;

  boxes.forEach(box => {
    const nameEl = box.querySelector('.student-info1');
    const schoolEl = box.querySelector('.student-info2');
    const progressBar = box.querySelector('.progress-bar .progress-bar');
    const progressVals = box.querySelectorAll('.progress-val span');
    
    if (!nameEl) return;

    const studentName = nameEl.textContent?.trim();
    const studentUsername = nameEl.dataset?.st_id || '';
    const weekDate = nameEl.dataset?.weekly || '';
    const schoolInfo = schoolEl?.textContent?.trim() || '';
    
    const hwCompleted = progressVals[0]?.textContent?.trim() || '-';
    const hwAssigned = progressVals[1]?.textContent?.trim() || '-';
    
    // 진행률: 숙제 건수로 직접 계산
    const hwC = parseInt(hwCompleted) || 0;
    const hwA = parseInt(hwAssigned) || 0;
    const progressPct = hwA > 0 ? Math.round((hwC / hwA) * 100) : 0;
    
    const divs = box.querySelectorAll(':scope > div.text-w-400');
    const classDay = divs[0]?.textContent?.trim() || '';
    const dDay = divs[1]?.textContent?.trim() || '';
    
    // 학생 매칭: 풀네임 ↔ 마스킹 이름 (첫글자+끝글자+길이)
    let student = existingStudents.find(s => s.name === studentName);
    if (!student && studentName) {
      const fn = studentName.replace(/[0-9]/g, ''); // 숫자 제거 (김보민2 → 김보민)
      student = existingStudents.find(s => {
        const masked = (s.name || '').replace(/[0-9]/g, '');
        if (masked.length < 2 || fn.length < 2) return false;
        return masked[0] === fn[0] && masked[masked.length-1] === fn[fn.length-1] && masked.length === fn.length;
      });
    }

    const detail = {
      name: studentName,
      school: schoolInfo,
      username: studentUsername,
      class_day: classDay,
      d_day: dDay,
      hw_assigned: hwAssigned,
      hw_completed: hwCompleted,
      progress_pct: progressPct,
      week_date: weekDate
    };

    records.push({
      student_id: student?.id || null,
      teacher_id: student?.teacher_id || null,
      record_date: today,
      type: 'homework',
      status: JSON.stringify(detail)
    });
    
    console.log(`[에이닷] ${studentName}: ${hwCompleted}/${hwAssigned} = ${progressPct}% (${dDay})`);
  });

  if (records.length > 0) {
    // 중복 방지: 오늘 이미 수집된 attendance 삭제 후 재삽입
    const _td = new Date();
    const today = `${_td.getFullYear()}-${String(_td.getMonth()+1).padStart(2,'0')}-${String(_td.getDate()).padStart(2,'0')}`;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/attendance_records?record_date=eq.${today}&type=eq.homework`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        }
      });
      console.log(`[에이닷] 기존 수행도 삭제 (${today}) → 재삽입`);
    } catch(e) {
      console.error('[에이닷] 기존 수행도 삭제 실패:', e);
    }
    
    await supabaseInsert('attendance_records', records);
    const stats = records.map(r => JSON.parse(r.status));
    const done = stats.filter(s => s.progress_pct >= 100).length;
    const doing = stats.filter(s => s.progress_pct > 0 && s.progress_pct < 100).length;
    const zero = stats.filter(s => s.progress_pct === 0).length;
    console.log(`[에이닷] ✅ 수행도 저장 완료: ✅${done}명 / 🔄${doing}명 / ❌${zero}명`);
    
    // 학생 이름 풀네임 업데이트: 수행도에 풀네임이 있으면 students 테이블 갱신
    let nameUpdated = 0;
    for (const r of records) {
      if (!r.student_id) continue;
      try {
        const detail = JSON.parse(r.status);
        const fullName = detail.name;
        if (!fullName || fullName.includes('*')) continue;
        
        const url = `${SUPABASE_URL}/rest/v1/students?id=eq.${r.student_id}`;
        await fetch(url, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ name: fullName })
        });
        nameUpdated++;
      } catch(e) {
        console.error('[에이닷] 이름 업데이트 실패:', e);
      }
    }
    if (nameUpdated > 0) {
      console.log(`[에이닷] 학생 이름 풀네임 업데이트: ${nameUpdated}명`);
    }
  }

  showBadge(`✅ 수행도 ${records.length}명 수집 완료`);
  return records;
}

// ============================================
// 라우터
// ============================================
async function run() {
  if (isRunning) { console.log('[에이닷] 이미 수집 중 — 스킵'); return; }
  isRunning = true;
  let result = null;
  let pageName = '';

  // 학생 목록 — 전체 페이지 자동 순회
  if (currentSearch.includes('db_name=student') || currentPath.includes('studentlist')) {
    pageName = '학생 목록';
    result = await collectAllPages();
  }
  // 수업 관리 — 요일별 학생 스케줄 수집
  else if (currentPath.includes('classPlannerManager')) {
    pageName = '수업 관리';
    result = await collectClassSchedule();
  }
  // 수행도 관리 — DOM 직접 읽기 (JS 렌더링 대기 후)
  else if (currentPath.includes('performanceManager')) {
    pageName = '수행도 관리';
    // JS가 데이터 렌더링할 시간 대기 (최대 15초)
    result = await waitAndCollectPerformance();
  }
  // SMS 로그
  else if (currentPath.includes('sms_log') || currentPath.includes('sms')) {
    pageName = 'SMS 로그';
    result = await parseSmsLog();
  }
  // 결제 현황
  else if (currentPath.includes('수강권') || currentPath.includes('payment') || currentSearch.includes('결제') || (currentSearch.includes('m_no2=134') && currentSearch.includes('m_no3=136'))) {
    pageName = '수강권 결제';
    result = await parsePayments();
  }

  if (result && result.length > 0) {
    // lastSync는 background.js에서 전체 수집 완료 시 저장함
    showBadge(`${pageName}: ${result.length}건 수집됨`);
    
    // background에 완료 알림 (source 명시)
    const sourceMap = { '학생 목록': 'students', '수강권 결제': 'payments', '수행도 관리': 'performance', '수업 관리': 'schedule', 'SMS 로그': 'sms' };
    try {
      chrome.runtime.sendMessage({ 
        action: 'contentScriptDone', 
        count: result.length, 
        source: sourceMap[pageName] || pageName 
      });
    } catch(e) {}
  } else if (pageName) {
    showBadge(`${pageName}: 데이터 없음`);
    // 데이터 없어도 완료 알림 보내서 다음 스텝 진행
    try {
      const sourceMap = { '학생 목록': 'students', '수강권 결제': 'payments', '수행도 관리': 'performance', '수업 관리': 'schedule', 'SMS 로그': 'sms' };
      chrome.runtime.sendMessage({ 
        action: 'contentScriptDone', 
        count: 0, 
        source: sourceMap[pageName] || pageName 
      });
    } catch(e) {}
  } else {
    console.log('[에이닷] 이 페이지는 수집 대상 아님:', currentPath);
  }
  
  isRunning = false;
  lastUrl = window.location.href; // 수집 중 URL 변경 무시하기 위해 갱신
}

// 수집 상태 뱃지
function showBadge(text) {
  const badge = document.createElement('div');
  badge.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 99999;
    background: #0984e3; color: #fff; padding: 10px 18px;
    border-radius: 8px; font-size: 13px; font-family: -apple-system, sans-serif;
    box-shadow: 0 4px 12px rgba(0,0,0,.15);
    transition: opacity .3s ease;
  `;
  badge.textContent = '📊 ' + text;
  document.body.appendChild(badge);
  
  setTimeout(() => {
    badge.style.opacity = '0';
    setTimeout(() => badge.remove(), 300);
  }, 3000);
}

// 페이지 로드 후 1회만 실행 (SPA가 아니므로 MutationObserver 불필요)
let isRunning = false;
setTimeout(run, 2000);
