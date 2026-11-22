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
// 반환: { step, due, mastered, reviews, lapses, hards }
export function computeState(item, logs, settings = DEFAULT_SETTINGS) {
  const I = settings.intervals;
  let step = 0;
  let due = addDays(item.studiedOn, I[0]);
  let mastered = false;
  let reviews = 0;
  let lapses = 0;
  let hards = 0;

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
      hards++;
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

  return { step, due, mastered, reviews, lapses, hards };
}

// 자주 잊는 항목: 잊음 2번 이상, 또는 잊음+애매 합쳐 3번 이상
export const isWeak = (st) => !!st && (st.lapses >= 2 || st.lapses + st.hards >= 3);
export const weakScore = (st) => (st ? st.lapses * 2 + st.hards : 0);

// 알림용 과목별 개수: [{item}] → "행정법 3, 국어 2 외 1과목"
export function subjectSummary(entries, max = 3) {
  const c = new Map();
  for (const e of entries) c.set(e.item.subject, (c.get(e.item.subject) || 0) + 1);
  const arr = [...c].sort((a, b) => b[1] - a[1]);
  const head = arr.slice(0, max).map(([n, k]) => `${n} ${k}`).join(', ');
  return arr.length > max ? `${head} 외 ${arr.length - max}과목` : head;
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
// 범위는 '~'로: "행정법 3~7장" → 3장·4장·…·7장, "영어 Day 1~5" → Day 1·…·Day 5 (최대 30개)
// '-'는 나누지 않음 (2-1처럼 절 번호로 많이 쓰여서)
const UNITS = '회차|일차|주차|차시|단원|챕터|장|강|회|과|편|절';
const RANGE_UNIT = new RegExp(`(\\d+)\\s*(?:${UNITS})?\\s*[~～]\\s*(\\d+)\\s*(${UNITS})`);
const RANGE_PREFIX = /\b(day|ch|chapter|unit|lesson|part|set|test)(\s*)(\d+)\s*[~～]\s*(\d+)/i;
const MAX_RANGE = 30;

export function expandRange(title) {
  const num = (a, n) => (a.length > 1 && a[0] === '0' ? String(n).padStart(a.length, '0') : String(n));
  const build = (whole, a, b, piece) => {
    const s = Number(a), e = Number(b);
    if (!(e > s && e - s < MAX_RANGE)) return null;
    return Array.from({ length: e - s + 1 }, (_, k) => title.replace(whole, piece(num(a, s + k))));
  };
  let m = title.match(RANGE_UNIT);
  let out = m && build(m[0], m[1], m[2], (n) => `${n}${m[3]}`);
  if (out) return out;
  m = title.match(RANGE_PREFIX);
  out = m && build(m[0], m[3], m[4], (n) => `${m[1]}${m[2]}${n}`);
  return out || [title];
}

// expand=false: 범위를 나누지 않음 (할 일은 '3~5장' 한 줄로 두고, 끝냈을 때 나눔)
export function parseQuickInput(text, fallbackSubject = '기타', { expand = true } = {}) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const m = line.match(/#(\S+)/);
      const subject = m ? m[1] : fallbackSubject;
      const title = line.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
      return (expand ? expandRange(title || line) : [title || line]).map((t) => ({ title: t, subject }));
    });
}
