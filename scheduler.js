// 복습 스케줄 계산 (순수 함수만 — UI/저장소와 분리)
// 원칙: "다음 복습일"은 저장하지 않고 항목 + 로그에서 매번 계산한다.

export const DEFAULT_SETTINGS = {
  intervals: [1, 3, 7, 15, 30], // 일 단위 복습 간격
  dayStartHour: 4,              // 새벽 4시 전은 전날로 침
  dailyLimit: 30,               // 하루 복습 상한
  examDate: null,               // 'YYYY-MM-DD' | null
  subjects: [],                 // [{ name, color }] 등록한 과목
  notify: { morning: '09:00', evening: '21:00' }, // 알림 시각 ('' = 끔)
};

// ---------- 날짜 유틸 (로컬 날짜 문자열 'YYYY-MM-DD' 기준) ----------
const pad = (n) => String(n).padStart(2, '0');

export function localDate(now = new Date(), dayStartHour = 4) {
  const d = new Date(now.getTime() - dayStartHour * 3600 * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parse(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return Date.UTC(y, m - 1, d); // 날짜 연산은 UTC 자정으로 해서 DST 영향 제거
}

export function addDays(ds, n) {
  const t = new Date(parse(ds) + n * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function diffDays(a, b) {
  // a - b (일)
  return Math.round((parse(a) - parse(b)) / 86400000);
}

// ---------- 평가 ----------
export const RATING = { FORGOT: 1, HARD: 2, GOOD: 3 };

// ---------- 항목 하나의 상태 계산 ----------
// logs: 해당 항목의 로그(시간순). 종류:
//   { kind:'review', on, rating }   복습 완료
//   { kind:'postpone', on, to }     예정일만 옮김(단계 유지)
// 반환: { step, due, mastered, reviews, lapses }
export function computeState(item, logs, settings = DEFAULT_SETTINGS) {
  const I = settings.intervals;
  let step = 0;
  let due = addDays(item.studiedOn, I[0]);
  let mastered = false;
  let reviews = 0;
  let lapses = 0;

  for (const log of logs) {
    if (log.kind === 'postpone') {
      if (!mastered) due = log.to;
      continue;
    }
    if (log.kind !== 'review') continue;
    reviews++;
    // 늦게 했으면 실제 완료일 기준으로 다음 간격 계산
    if (log.rating === RATING.FORGOT) {
      lapses++;
      step = 0;
      mastered = false;
      due = addDays(log.on, I[0]);
    } else if (log.rating === RATING.HARD) {
      // 같은 단계 간격을 한 번 더
      due = addDays(log.on, I[Math.min(step, I.length - 1)]);
    } else {
      step++;
      if (step >= I.length) {
        mastered = true;
        due = null;
      } else {
        due = addDays(log.on, I[step]);
      }
    }
  }

  // 시험일 이후로 잡힌 복습은 시험 전날로 당김
  if (due && settings.examDate && diffDays(due, settings.examDate) >= 0) {
    const eve = addDays(settings.examDate, -1);
    if (diffDays(eve, item.studiedOn) > 0) due = eve;
  }

  return { step, due, mastered, reviews, lapses };
}

// 모든 항목의 상태 계산
// 지워진 로그(deleted)는 빼고, 여러 기기에서 합쳐진 로그를 날짜→기록 시각 순으로 정렬해서 계산
export function computeAll(items, logs, settings) {
  const byItem = new Map();
  const live = logs.filter((l) => !l.deleted)
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : (a.at || 0) - (b.at || 0)));
  for (const l of live) {
    if (!byItem.has(l.itemId)) byItem.set(l.itemId, []);
    byItem.get(l.itemId).push(l);
  }
  const out = new Map();
  for (const it of items) {
    if (it.status === 'deleted') continue;
    out.set(it.id, computeState(it, byItem.get(it.id) || [], settings));
  }
  return out;
}

// ---------- 오늘 목록 ----------
// 오늘까지 예정된 것 = due <= today. 많이 밀린 것 우선.
export function todayQueue(items, states, today, settings) {
  const due = [];
  for (const it of items) {
    if (it.status !== 'active') continue;
    const s = states.get(it.id);
    if (!s || s.mastered || !s.due) continue;
    if (diffDays(s.due, today) <= 0) {
      due.push({ item: it, state: s, overdue: diffDays(today, s.due) });
    }
  }
  due.sort((a, b) => b.overdue - a.overdue || a.item.createdAt - b.item.createdAt);
  return {
    now: due.slice(0, settings.dailyLimit),
    overflow: due.slice(settings.dailyLimit),
  };
}

// 넘친 항목을 다음 날들로 나눠 배치 → postpone 로그 목록 반환
export function spreadOverflow(overflow, items, states, today, settings) {
  const load = new Map(); // date -> count (이미 예정된 양)
  for (const it of items) {
    if (it.status !== 'active') continue;
    const s = states.get(it.id);
    if (s && s.due && diffDays(s.due, today) > 0) load.set(s.due, (load.get(s.due) || 0) + 1);
  }
  const logs = [];
  let day = addDays(today, 1);
  for (const q of overflow) {
    while ((load.get(day) || 0) >= settings.dailyLimit) day = addDays(day, 1);
    load.set(day, (load.get(day) || 0) + 1);
    logs.push({ kind: 'postpone', itemId: q.item.id, on: today, to: day });
  }
  return logs;
}

// 달력용: 앞으로 모두 '기억남'으로 진행한다고 가정한 예상 복습일
export function projectDates(item, state, settings) {
  if (!state.due || state.mastered) return [];
  const I = settings.intervals;
  const dates = [state.due];
  let d = state.due;
  for (let s = state.step + 1; s < I.length; s++) {
    d = addDays(d, I[s]);
    dates.push(d);
  }
  return dates;
}

// ---------- 빠른 입력 파싱 ----------
// "행정법 3장 행정행위 #행정법" → { title, subject }
export function parseQuickInput(text, fallbackSubject = '기타') {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/#(\S+)/);
      const subject = m ? m[1] : fallbackSubject;
      const title = line.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
      return { title: title || line, subject };
    });
}
