import {
  DEFAULT_SETTINGS, localDate, addDays, diffDays, computeAll, todayQueue,
  spreadOverflow, projectDates, parseQuickInput, expandRange, RATING, isWeak, weakScore, subjectSummary,
} from './scheduler.js';
import { emptyDb, migrate, markDirty, markAllDirty } from './merge.js';
import * as sync from './sync.js';
import { VAPID_PUBLIC_KEY } from './config.js';

// ---------- 저장소 ----------
const KEY = 'ebbing-planner-v1';

function load() {
  try {
    const m = migrate(JSON.parse(localStorage.getItem(KEY)));
    if (m) return m;
  } catch (e) { console.warn('load failed', e); }
  return emptyDb(DEFAULT_SETTINGS);
}
let db = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('저장 실패: 저장 공간을 확인하세요'); }
  if (db.sync.dirty.length) scheduleSync(1500);
}
// 기록을 고칠 때: 수정 시각을 찍고 동기화 대상으로 표시
function touch(kind, rec) {
  rec.updatedAt = Math.max(Date.now(), (rec.updatedAt || 0) + 1);
  markDirty(db, kind, kind === 'settings' ? 'main' : rec.id);
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const S = () => ({ ...DEFAULT_SETTINGS, ...db.settings });
const today = () => addDays(localDate(new Date(), S().dayStartHour), db.dayOffset || 0);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ds) => { const [, m, d] = ds.split('-'); return `${+m}/${+d}`; };
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const dow = (ds) => DOW[new Date(ds + 'T00:00:00').getDay()];

// ---------- 되돌리기 토스트 ----------
let toastTimer;
function toast(msg, undo, label = '되돌리기') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = esc(msg) + (undo ? ` <button>${esc(label)}</button>` : '');
  if (undo) el.querySelector('button').onclick = () => { undo(); el.remove(); render(); };
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

// ---------- 과목 ----------
const PALETTE = ['#4a7dff', '#e5534b', '#3fb950', '#d4a72c', '#a371f7', '#f778ba', '#39c5cf', '#db6d28'];
const subjects = () => S().subjects || [];
const colorOf = (name) => subjects().find((x) => x.name === name)?.color || '#8f8f8f';
const nextColor = () => PALETTE[subjects().length % PALETTE.length];
function setSubjects(list) {
  db.settings = { ...db.settings, subjects: list };
  touch('settings', db.settings);
}
// 항목에 쓰였는데 등록 안 된 과목은 자동 등록 (#새과목 입력, 다른 기기에서 받은 항목 등)
function ensureSubjects() {
  const have = new Set(subjects().map((x) => x.name));
  const add = [];
  for (const it of [...db.items, ...db.tasks]) {
    if (it.status === 'active' && it.subject && !have.has(it.subject)) { have.add(it.subject); add.push(it.subject); }
  }
  if (!add.length) return false;
  const list = [...subjects()];
  for (const name of add) list.push({ name, color: PALETTE[list.length % PALETTE.length] });
  setSubjects(list);
  return true;
}
// 이 기기에서 고른 과목 (기기마다 따로, 동기화 안 함)
const UI_KEY = 'ebbing-planner-ui';
const ui = (() => { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; } })();
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };

// ---------- 동작 ----------
// 지우기는 실제로 지우지 않고 표시만 (다른 기기에도 전해지도록)
function undoLogs(ids) {
  for (const l of db.logs) if (ids.has(l.id) && !l.deleted) { l.deleted = true; touch('log', l); }
  save();
}

// 입력할 때 '공부한 날' (null = 오늘). 날이 바뀌면 다시 오늘로
let addOn = null, addOnSetDay = null;
const addDate = () => {
  const t = today();
  if (!addOn || addOnSetDay !== t || addOn >= t) { addOn = null; return t; }
  return addOn;
};
function setAddOn(d) { addOn = d && d < today() ? d : null; addOnSetDay = today(); }

function addItems(text) {
  const parsed = parseQuickInput(text, ui.subject || '기타');
  const t = addDate();
  for (const p of parsed) {
    const it = { id: uid(), title: p.title, subject: p.subject, note: '', studiedOn: t, status: 'active', createdAt: Date.now() };
    touch('item', it);
    db.items.push(it);
  }
  save();
  return parsed.length;
}

// ---------- 할 일 ----------
// task: { id, title, subject, on(할 날), doneOn(끝낸 날|null), itemIds(끝낼 때 만든 복습 항목), status }
// 끝내면 그날 공부한 것으로 항목을 만들고 복습이 시작됨. 못 끝낸 건 다음 날 목록에 계속 남음
const mode = () => (ui.mode === 'did' ? 'did' : 'plan');
// 할 날 (null = 오늘). 날이 바뀌면 다시 오늘로
let planOn = null, planOnSetDay = null;
const planDate = () => {
  const t = today();
  if (!planOn || planOnSetDay !== t || planOn <= t) { planOn = null; return t; }
  return planOn;
};
function setPlanOn(d) { planOn = d && d > today() ? d : null; planOnSetDay = today(); }

function addTasks(text) {
  const parsed = parseQuickInput(text, ui.subject || '기타', { expand: false });
  const on = planDate();
  for (const p of parsed) {
    const x = { id: uid(), title: p.title, subject: p.subject, on, doneOn: null, itemIds: [], status: 'active', createdAt: Date.now() };
    touch('task', x);
    db.tasks.push(x);
  }
  save();
  return parsed.length;
}
const findTask = (id) => db.tasks.find((x) => x.id === id && x.status === 'active');
// 끝낸 할 일로 만든 항목 중 아직 남아 있는 것
const taskItems = (x) => (x.itemIds || []).map((id) => db.items.find((i) => i.id === id)).filter((i) => i && i.status === 'active');
// 오늘 목록: 오늘까지 할 일 중 못 끝낸 것 + 오늘 끝낸 것
const todayTasks = (t) => db.tasks
  .filter((x) => x.status === 'active' && ((!x.doneOn && x.on <= t) || x.doneOn === t))
  .sort((a, b) => a.on.localeCompare(b.on) || (a.createdAt || 0) - (b.createdAt || 0));

function completeTask(id) {
  const x = findTask(id);
  if (!x || x.doneOn) return;
  const t = today();
  const ids = [];
  for (const title of expandRange(x.title)) {
    const it = { id: uid(), title, subject: x.subject, note: '', studiedOn: t, status: 'active', createdAt: Date.now(), taskId: x.id };
    touch('item', it);
    db.items.push(it);
    ids.push(it.id);
  }
  x.doneOn = t; x.itemIds = ids;
  touch('task', x);
  save();
  // 모의고사처럼 복습할 필요 없는 일은 바로 뺄 수 있게
  toast(`끝! 복습 ${ids.length}개 시작`, () => dropTaskReview(x), '복습 빼기');
}
function dropTaskReview(x) {
  for (const it of taskItems(x)) { it.status = 'deleted'; touch('item', it); }
  x.itemIds = [];
  touch('task', x);
  save();
}
// 체크 풀기: 만든 항목도 지움 (이미 복습한 항목은 기록이 있으니 남김)
function uncheckTask(id) {
  const x = findTask(id);
  if (!x || !x.doneOn) return;
  const reviewed = new Set(db.logs.filter((l) => l.kind === 'review' && !l.deleted).map((l) => l.itemId));
  for (const it of taskItems(x)) if (!reviewed.has(it.id)) { it.status = 'deleted'; touch('item', it); }
  x.doneOn = null; x.itemIds = [];
  touch('task', x);
  save();
  toast('체크를 풀었어요');
}
function removeTask(id) {
  const x = findTask(id);
  if (!x) return;
  x.status = 'deleted';
  touch('task', x);
  save();
  toast('삭제됨', () => { x.status = 'active'; touch('task', x); save(); });
}

const LABEL = { 1: '잊음', 2: '애매', 3: '기억남' };
const RCLS = { 1: 'f', 2: 'h', 3: 'g' };
function review(itemId, rating) {
  const log = { id: uid(), kind: 'review', itemId, on: today(), rating, at: Date.now() };
  touch('log', log);
  db.logs.push(log);
  save();
  toast(`${LABEL[rating]} 기록됨`, () => undoLogs(new Set([log.id])));
}

// 오늘 한 복습의 평가 바꾸기: 원래 기록은 지움 표시, 같은 날·같은 순서로 새 기록
function changeRating(logId, rating) {
  const old = db.logs.find((l) => l.id === logId && !l.deleted);
  if (!old || old.rating === rating) return;
  old.deleted = true;
  touch('log', old);
  const log = { id: uid(), kind: 'review', itemId: old.itemId, on: old.on, rating, at: old.at };
  touch('log', log);
  db.logs.push(log);
  save();
  toast(`${LABEL[rating]}(으)로 바꿨어요`, () => {
    log.deleted = true; touch('log', log);
    old.deleted = false; touch('log', old);
    save();
  });
}
function cancelReview(logId) {
  const old = db.logs.find((l) => l.id === logId && !l.deleted);
  if (!old) return;
  undoLogs(new Set([old.id]));
  toast('복습 기록을 취소했어요', () => { old.deleted = false; touch('log', old); save(); });
}

// 이 항목만 내일로 (단계는 그대로)
function postponeItem(itemId) {
  const t = today();
  const log = { id: uid(), kind: 'postpone', itemId, on: t, to: addDays(t, 1), at: Date.now() };
  touch('log', log);
  db.logs.push(log);
  save();
  toast('내일로 미뤘어요', () => undoLogs(new Set([log.id])));
}

function removeItem(itemId) {
  const it = db.items.find((i) => i.id === itemId);
  if (!it) return;
  const prev = it.status;
  it.status = 'deleted';
  touch('item', it);
  save();
  toast('삭제됨', () => { it.status = prev; touch('item', it); save(); });
}

// ---------- 렌더링 ----------
let view = 'today';
let calMonth = null; // 'YYYY-MM'
let calSel = null;

let renderedDay = null;
function render() {
  const s = S();
  const t = today();
  renderedDay = t;
  if (ensureSubjects()) save();
  const states = computeAll(db.items, db.logs, s);
  reportToday(states, t, s);
  $('#today-label').textContent = `${fmt(t)} (${dow(t)})${db.dayOffset ? ` · 시간이동 ${db.dayOffset > 0 ? '+' : ''}${db.dayOffset}일` : ''}`;
  if (view === 'today') renderToday(states, t, s);
  if (view === 'calendar') renderCalendar(states, t, s);
  if (view === 'subjects') renderSubjects(states, t);
  if (view === 'settings') renderSettings(s);
}

// 오늘 남은 복습 수 알리기: PC 앱은 트레이·알림, 폰·브라우저는 앱 아이콘 숫자
function reportToday(states, t, s) {
  states ||= computeAll(db.items, db.logs, s);
  const q = todayQueue(db.items, states, t, s);
  const all = [...q.now, ...q.overflow];
  if (window.desktop) {
    window.desktop.report({ date: t, due: all.length, notify: s.notify, detail: subjectSummary(all) });
    return;
  }
  setBadge(all.length);
}
// 홈 화면 앱 아이콘의 숫자 (아이폰은 알림을 허용한 홈 화면 앱에서만 보임)
// 알림이 올 때 서비스 워커도 숫자를 바꾸므로, 기억해 두지 않고 매번 맞춤
function setBadge(n) {
  if (!('setAppBadge' in navigator)) return;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// 며칠 연속 공부했는지 (복습했거나 새로 공부한 날). 오늘 아직 안 했으면 어제까지로 셈
function streakDays(t) {
  const days = new Set();
  for (const l of db.logs) if (l.kind === 'review' && !l.deleted) days.add(l.on);
  for (const i of db.items) if (i.status !== 'deleted') days.add(i.studiedOn);
  for (const x of db.tasks) if (x.status === 'active' && x.doneOn) days.add(x.doneOn);
  let d = days.has(t) ? t : addDays(t, -1), n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

const tagHTML = (name) => { const c = colorOf(name); return `<span class="tag" style="background:${c}2e;color:${c}">${esc(name)}</span>`; };

function cardHTML(it, st, t, withRate) {
  const late = st.due ? diffDays(t, st.due) : 0;
  const info = st.mastered ? '완료'
    : `${st.step + 1}/${S().intervals.length}회차 · ${late > 0 ? `<span class="late">${late}일 밀림</span>` : st.due === t ? '오늘' : `다음 ${fmt(st.due)}`}`;
  return `<li class="card" data-id="${it.id}">
    <div class="top" data-edit="1"><div><div class="t">${esc(it.title)}</div><div class="meta">${info}${st.lapses ? ` · 잊음 ${st.lapses}회` : ''}${st.hards ? ` · 애매 ${st.hards}회` : ''}</div>
    ${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}</div>
    <div class="side">${tagHTML(it.subject)}<button class="more" data-edit="1" aria-label="고치기">⋯</button></div></div>
    ${withRate ? `<div class="rate">
      <button class="f" data-r="${RATING.FORGOT}">잊음</button>
      <button class="h" data-r="${RATING.HARD}">애매</button>
      <button class="g" data-r="${RATING.GOOD}">기억남</button></div>` : ''}
  </li>`;
}

function renderChips() {
  const list = subjects();
  if (ui.subject && !list.some((x) => x.name === ui.subject)) { ui.subject = null; saveUi(); }
  $('#subject-chips').innerHTML = list.map((x) =>
    `<button type="button" class="chip${ui.subject === x.name ? ' on' : ''}" data-name="${esc(x.name)}" style="--c:${x.color}">${esc(x.name)}</button>`).join('') +
    `<button type="button" class="chip add" data-add="1">＋ 과목</button>`;
  const plan = mode() === 'plan';
  $('#quick-input').placeholder = ui.subject ? `${ui.subject}에서 ${plan ? '할 것' : '공부한 것'} (예: 3~5장)`
    : plan ? '할 것 (예: 행정법 3~5장 #행정법)' : '공부한 것 (예: 행정법 3~5장 #행정법)';
}

// 할 일이면 오늘·내일·날짜 선택(앞날), 공부한 것이면 오늘·어제·날짜 선택(지난날)
function renderDateRow(t) {
  const plan = mode() === 'plan';
  document.querySelectorAll('#mode-seg [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode()));
  $('#date-label').textContent = plan ? '할 날' : '공부한 날';
  $('#date-k1').textContent = plan ? '내일' : '어제';
  const on = plan ? planDate() : addDate();
  const k = Math.abs(diffDays(on, t));
  $('#date-row').querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', Number(b.dataset.k) === k));
  const pick = $('#date-pick');
  pick.classList.toggle('on', k > 1);
  pick.firstChild.textContent = k > 1 ? `${fmt(on)} (${dow(on)})` : '날짜 선택';
  const inp = $('#quick-date');
  inp.removeAttribute(plan ? 'max' : 'min');
  if (plan) inp.min = addDays(t, 1); else inp.max = addDays(t, -1);
  inp.value = k > 1 ? on : '';
  $('#added-today').classList.toggle('hidden', plan);
}

function taskHTML(x, t) {
  const done = !!x.doneOn;
  const n = done ? taskItems(x).length : 0;
  const late = !done && x.on < t ? diffDays(t, x.on) : 0;
  const sub = done ? (n ? `복습 ${n}개 시작` : '복습 안 함')
    : late ? `${late === 1 ? '어제' : fmt(x.on)} 못 한 것` : '';
  return `<li class="task${done ? ' done' : ''}" data-task="${x.id}">
    <button type="button" class="tbox" data-check="1" aria-label="${done ? '체크 풀기' : '끝냄'}">${done ? '✓' : ''}</button>
    <div class="tb"><div class="tt">${esc(x.title)}</div>${sub ? `<div class="meta${late ? ' carry' : ''}">${sub}</div>` : ''}</div>
    <div class="side">${tagHTML(x.subject)}<button type="button" class="more" data-tedit="1" aria-label="고치기">⋯</button></div></li>`;
}

function renderPlan(t) {
  const list = todayTasks(t);
  $('#plan').classList.toggle('hidden', !list.length);
  const done = list.filter((x) => x.doneOn).length;
  $('#plan-count').textContent = list.length ? (done === list.length ? '다 끝냄 ✓' : `${done} / ${list.length}`) : '';
  $('#plan-list').innerHTML = list.map((x) => taskHTML(x, t)).join('');
}

function renderToday(states, t, s) {
  renderChips();
  renderDateRow(t);
  renderPlan(t);
  const q = todayQueue(db.items, states, t, s);
  const doneToday = db.logs.filter((l) => l.kind === 'review' && !l.deleted && l.on === t).length;
  const addedToday = db.items.filter((i) => i.status === 'active' && i.studiedOn === t).length;
  $('#added-today').textContent = addedToday ? `오늘 공부 ${addedToday}개` : '';
  // 오늘 복습 진행: 끝낸 것 / (끝낸 것 + 남은 것)
  const remaining = q.now.length + q.overflow.length;
  const total = doneToday + remaining;
  $('#progress').classList.toggle('hidden', total === 0);
  $('#progress').classList.toggle('complete', total > 0 && remaining === 0);
  $('#progress-text').innerHTML = remaining ? `<b>${doneToday}</b> / ${total} 끝냄 · 남은 ${remaining}개` : '다 끝냄 ✓';
  $('#progress-bar').style.width = `${total ? Math.round((doneToday / total) * 100) : 0}%`;
  // 과목별로 골라 보기 (과목이 2개 이상일 때만). 고르면 상한 넘은 것까지 그 과목은 전부 보여 줌
  const all = [...q.now, ...q.overflow];
  const counts = new Map();
  for (const x of all) counts.set(x.item.subject, (counts.get(x.item.subject) || 0) + 1);
  if (ui.filter && !counts.has(ui.filter)) ui.filter = null;
  const filterBox = $('#today-filter');
  filterBox.classList.toggle('hidden', counts.size < 2);
  filterBox.innerHTML = counts.size < 2 ? '' :
    `<button type="button" class="chip${ui.filter ? '' : ' on'}" data-f="">전체 ${all.length}</button>` +
    [...counts].map(([name, n]) => `<button type="button" class="chip${ui.filter === name ? ' on' : ''}" data-f="${esc(name)}" style="--c:${colorOf(name)}">${esc(name)} ${n}</button>`).join('');
  const shown = ui.filter ? all.filter((x) => x.item.subject === ui.filter) : q.now;
  $('#today-list').innerHTML = shown.map((x) => cardHTML(x.item, x.state, t, true)).join('');
  $('#kbd-hint').classList.toggle('hidden', !shown.length);
  $('#empty-today').classList.toggle('hidden', shown.length > 0);
  const streak = streakDays(t);
  $('#empty-today').textContent = !db.items.some((i) => i.status === 'active')
    ? (db.tasks.some((x) => x.status === 'active') ? '할 일을 끝내고 체크하면 복습이 여기에 잡혀요.' : '위에 오늘 할 일을 적어 보세요. 끝내고 체크하면 복습일은 알아서 잡아 드려요.')
    : doneToday ? `오늘 복습을 다 끝냈어요. 수고했어요!${streak >= 2 ? ` 연속 ${streak}일째예요.` : ''}` : '오늘 복습할 항목이 없습니다.';
  renderWeek(states, t, s);
  renderDone(t);
  $('#overflow-box').classList.toggle('hidden', q.overflow.length === 0 || !!ui.filter);
  $('#overflow-text').textContent = `상한(${s.dailyLimit}개)을 넘은 복습 ${q.overflow.length}개가 더 있습니다.`;
  $('#spread-btn').onclick = () => {
    const logs = spreadOverflow(q.overflow, db.items, states, t, s).map((l) => ({ ...l, id: uid(), at: Date.now() }));
    logs.forEach((l) => touch('log', l));
    db.logs.push(...logs);
    save();
    const ids = new Set(logs.map((l) => l.id));
    toast(`${logs.length}개를 다음 날들로 옮겼습니다`, () => undoLogs(ids));
    render();
  };
}

// 앞으로 7일 동안 잡힌 복습 수 (+ 시험 D-day)
function renderWeek(states, t, s) {
  const counts = Array(7).fill(0);
  for (const it of db.items) {
    if (it.status !== 'active') continue;
    const st = states.get(it.id);
    if (!st || st.mastered || !st.due) continue;
    const k = diffDays(st.due, t);
    if (k >= 1 && k <= 7) counts[k - 1]++;
  }
  const box = $('#week');
  const any = counts.some(Boolean);
  const dd = s.examDate ? diffDays(s.examDate, t) : null;
  const dday = dd !== null && dd >= 0 ? `<span class="dday">시험 ${dd === 0 ? 'D-day' : `D-${dd}`}</span>` : '';
  box.classList.toggle('hidden', !any && !dday);
  if (!any && !dday) { box.innerHTML = ''; return; }
  const max = Math.max(1, ...counts);
  box.innerHTML = `<div class="week-head"><span class="hint">앞으로 7일</span>${dday}</div><div class="week">` +
    counts.map((n, i) => {
      const d = addDays(t, i + 1);
      return `<button type="button" class="wd${n > s.dailyLimit ? ' over' : ''}" data-d="${d}" title="${fmt(d)} 복습 ${n}개">
        <span class="barv"><i style="height:${Math.round((n / max) * 100)}%"></i></span><b>${n}</b><span>${i === 0 ? '내일' : dow(d)}</span></button>`;
    }).join('') + '</div>';
}

// 오늘 한 것: 새로 공부한 것 + 끝낸 복습(평가 바꾸기·취소) + 끝낸 할 일 수
const newRowHTML = (it) => `<li class="done-row click" data-item="${it.id}"><div class="dl"><span class="t">${esc(it.title)}</span>${tagHTML(it.subject)}</div></li>`;
function renderDone(t) {
  const byId = new Map(db.items.map((i) => [i.id, i]));
  const logs = db.logs.filter((l) => l.kind === 'review' && !l.deleted && l.on === t && byId.get(l.itemId)?.status === 'active')
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const rows = logs.map((l) => {
    const it = byId.get(l.itemId);
    return `<li class="done-row" data-log="${l.id}"><div class="dl"><span class="t">${esc(it.title)}</span>${tagHTML(it.subject)}</div>
      <div class="rate small">${[1, 2, 3].map((r) => `<button class="${RCLS[r]}${l.rating === r ? ' on' : ''}" data-rr="${r}">${LABEL[r]}</button>`).join('')}
      <button class="x" data-cancel="1" title="이 복습 기록 취소">취소</button></div></li>`;
  }).join('');
  const added = db.items.filter((i) => i.status === 'active' && i.studiedOn === t);
  const tasksDone = db.tasks.filter((x) => x.status === 'active' && x.doneOn === t).length;
  const parts = [added.length && `새로 공부 ${added.length}`, logs.length && `복습 ${logs.length}`, tasksDone && `할 일 ${tasksDone}`].filter(Boolean);
  $('#done-box').classList.toggle('hidden', !parts.length);
  $('#done-sum').textContent = parts.length ? '· ' + parts.join(' · ') : '';
  $('#done-new-h').classList.toggle('hidden', !added.length);
  $('#done-new').innerHTML = added.map(newRowHTML).join('');
  $('#done-list-h').classList.toggle('hidden', !logs.length);
  $('#done-list').innerHTML = rows;
}

function renderCalendar(states, t, s) {
  if (!calMonth) calMonth = t.slice(0, 7);
  const [y, m] = calMonth.split('-').map(Number);
  $('#cal-title').textContent = `${y}년 ${m}월`;
  // 날짜별 예정 항목
  const byDate = new Map();
  for (const it of db.items) {
    if (it.status !== 'active') continue;
    const st = states.get(it.id);
    if (!st) continue;
    const dates = projectDates(it, st, s);
    dates.forEach((d, i) => {
      // 밀린 첫 예정일은 오늘에 표시
      const dd = i === 0 && diffDays(d, t) < 0 ? t : d;
      if (!byDate.has(dd)) byDate.set(dd, []);
      byDate.get(dd).push({ it, st, first: i === 0 });
    });
  }
  // 지난 날: 그날 끝낸 복습 (지운 항목 것은 빼고)
  const byId = new Map(db.items.map((i) => [i.id, i]));
  const counted = (l) => l.kind === 'review' && !l.deleted && byId.has(l.itemId) && byId.get(l.itemId).status !== 'deleted';
  const doneBy = new Map();
  for (const l of db.logs) {
    if (!counted(l) || l.on >= t) continue;
    if (!doneBy.has(l.on)) doneBy.set(l.on, []);
    doneBy.get(l.on).push(l);
  }
  // 할 일: 지난 날은 그날 끝낸 것, 오늘·앞날은 그날 할 것 (오늘은 밀린 것도)
  const tasksOn = (d) => db.tasks.filter((x) => x.status === 'active' &&
    (d < t ? x.doneOn === d : d === t ? (x.doneOn === t || (!x.doneOn && x.on <= t)) : (!x.doneOn && x.on === d)));
  const taskDays = new Set();
  for (const x of db.tasks) {
    if (x.status !== 'active') continue;
    if (x.doneOn) taskDays.add(x.doneOn);
    else taskDays.add(x.on < t ? t : x.on);
  }
  const monthDone = db.logs.filter((l) => counted(l) && l.on.startsWith(calMonth)).length;
  const streak = streakDays(t);
  $('#cal-stats').innerHTML = `${streak ? `<b>연속 ${streak}일째</b> 공부 중 · ` : ''}${m}월에 복습 <b>${monthDone}</b>개`;
  const first = `${calMonth}-01`;
  const startOffset = new Date(first + 'T00:00:00').getDay();
  let cells = DOW.map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i - startOffset);
    const past = d < t;
    const n = (past ? doneBy.get(d) : byDate.get(d))?.length || 0;
    const cls = ['d', d.slice(0, 7) !== calMonth && 'out', d === t && 'today', d === calSel && 'sel', d === s.examDate && 'exam'].filter(Boolean).join(' ');
    cells += `<div class="${cls}" data-d="${d}"><span>${+d.slice(8)}</span>${taskDays.has(d) ? '<i class="tdot"></i>' : ''}${n ? `<span class="n${past ? ' done' : ''}">${n}</span>` : ''}</div>`;
  }
  $('#cal-grid').innerHTML = cells;
  if (!calSel) { $('#cal-day-list').innerHTML = ''; return; }
  const dayTasks = tasksOn(calSel);
  const head = (txt) => `<li class="hint">${fmt(calSel)} (${dow(calSel)}) — ${txt}</li>`;
  const sec = (txt) => `<li class="hint sub-h">${txt}</li>`;
  const taskRows = dayTasks.length ? sec(calSel < t ? '끝낸 할 일' : '할 일') + `<li><ul class="plan-list cal-day-tasks">${dayTasks.map((x) => taskHTML(x, t)).join('')}</ul></li>` : '';
  if (calSel < t) {
    // 지난 날: 그날 끝낸 할 일, 새로 공부한 것, 한 복습
    const logs = doneBy.get(calSel) || [];
    const added = db.items.filter((i) => i.status === 'active' && i.studiedOn === calSel);
    const parts = [dayTasks.length && `할 일 ${dayTasks.length}개`, added.length && `새로 공부 ${added.length}개`,
      (logs.length || (!dayTasks.length && !added.length)) && `복습 ${logs.length}개`].filter(Boolean);
    $('#cal-day-list').innerHTML = head(parts.join(' · ')) + taskRows +
      (added.length ? sec('새로 공부한 것') + added.map(newRowHTML).join('') : '') +
      (logs.length ? sec('복습') : '') +
      logs.map((l) => {
        const it = byId.get(l.itemId);
        return it ? `<li class="done-row"><div class="dl"><span class="t">${esc(it.title)}</span>
          <span class="side"><span class="rl ${RCLS[l.rating]}">${LABEL[l.rating]}</span>${tagHTML(it.subject)}</span></div></li>` : '';
      }).join('');
    return;
  }
  const list = byDate.get(calSel) || [];
  const txt = [dayTasks.length && `할 일 ${dayTasks.length}개`,
    (list.length || !dayTasks.length) && (calSel === t ? `남은 복습 ${list.length}개` : `복습 ${list.length}개 예정`),
    calSel === s.examDate && '시험일'].filter(Boolean).join(' · ');
  $('#cal-day-list').innerHTML = head(txt) + taskRows + (list.length && dayTasks.length ? sec('복습') : '') +
    list.map((x) => cardHTML(x.it, x.st, t, false)).join('');
}

let subjQuery = '';
function renderSubjects(states, t) {
  const groups = new Map(subjects().map((x) => [x.name, []]));
  for (const it of db.items) {
    if (it.status !== 'active') continue;
    if (!groups.has(it.subject)) groups.set(it.subject, []);
    groups.get(it.subject).push(it);
  }
  $('#show-done').checked = !!ui.showDone;
  $('#only-weak').checked = !!ui.onlyWeak;
  const weakN = db.items.filter((i) => i.status === 'active' && isWeak(states.get(i.id))).length;
  $('#weak-count').textContent = weakN ? `(${weakN})` : '';
  const q = subjQuery.trim().toLowerCase();
  const weak = !!ui.onlyWeak;
  const filtering = !!q || weak;
  const match = (i) => (!q || i.title.toLowerCase().includes(q) || (i.note || '').toLowerCase().includes(q))
    && (!weak || isWeak(states.get(i.id)));
  const collapsed = new Set(ui.collapsed || []);
  $('.subj-search').classList.toggle('hidden', !db.items.some((i) => i.status === 'active'));
  const form = `<form id="subj-form" class="subj-form">
      <input id="subj-name" placeholder="새 과목 이름 (예: 행정법)" maxlength="20">
      <button type="submit">추가</button></form>`;
  if (!groups.size) { $('#subject-list').innerHTML = form + '<p class="empty">과목을 추가하거나, 입력할 때 #과목을 붙여 보세요.</p>'; return; }
  let found = 0;
  const html = [...groups].map(([name, items]) => {
    const done = items.filter((i) => states.get(i.id)?.mastered).length;
    const dueNow = items.filter((i) => { const st = states.get(i.id); return st && !st.mastered && st.due && st.due <= t; }).length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    const c = colorOf(name);
    const visible = items.filter((i) => match(i) && (ui.showDone || filtering || !states.get(i.id)?.mastered));
    found += filtering ? visible.length : 0;
    if (filtering && !visible.length) return '';
    const open = filtering || !collapsed.has(name);
    const byDue = (a, b) => (states.get(a.id).due || '9999').localeCompare(states.get(b.id).due || '9999');
    const rows = visible
      .sort(weak ? (a, b) => weakScore(states.get(b.id)) - weakScore(states.get(a.id)) || byDue(a, b) : byDue)
      .map((i) => cardHTML(i, states.get(i.id), t, false)).join('');
    const hidden = !filtering && !ui.showDone && done ? `<li class="hint more-done">완료한 ${done}개 숨김</li>` : '';
    return `<div class="subj${open ? '' : ' closed'}" data-name="${esc(name)}"><h3>
        <span class="subj-title"><button class="dot" data-act="color" title="색 바꾸기" style="background:${c}"></button>
          <span class="fold" data-act="fold">${esc(name)} <span class="caret">${open ? '▾' : '▸'}</span></span></span>
        <span class="subj-tools"><span class="hint">${dueNow ? `오늘 ${dueNow} · ` : ''}${done}/${items.length} 완료</span>
          <button class="mini" data-act="rename">이름</button><button class="mini" data-act="remove">삭제</button></span></h3>
      <div class="bar"><i style="width:${pct}%;background:${c}"></i></div>${open ? `<ul class="list">${rows}${hidden}</ul>` : ''}</div>`;
  }).join('');
  const none = q ? `'${esc(subjQuery.trim())}'에 맞는 항목이 없어요.` : '자주 잊는 항목이 없어요. 잘하고 있어요!';
  const weakHint = weak && found ? '<p class="hint">잊음 2번 이상, 또는 잊음·애매 합쳐 3번 이상인 항목 · 많이 틀린 순</p>' : '';
  $('#subject-list').innerHTML = filtering
    ? (found ? weakHint + html : `<p class="empty">${none}</p>`)
    : html + form;
}

function addSubject(name) {
  name = name.trim().replace(/^#/, '').replace(/\s+/g, ' ');
  if (!name) return false;
  if (subjects().some((x) => x.name === name)) { toast('이미 있는 과목입니다'); return false; }
  setSubjects([...subjects(), { name, color: nextColor() }]);
  save();
  return true;
}

function renameSubject(oldName) {
  const name = prompt('새 과목 이름', oldName)?.trim().replace(/^#/, '');
  if (!name || name === oldName) return;
  if (subjects().some((x) => x.name === name)) return toast('이미 있는 과목입니다');
  for (const it of db.items) if (it.subject === oldName) { it.subject = name; touch('item', it); }
  for (const x of db.tasks) if (x.subject === oldName) { x.subject = name; touch('task', x); }
  setSubjects(subjects().map((x) => (x.name === oldName ? { ...x, name } : x)));
  if (ui.subject === oldName) { ui.subject = name; saveUi(); }
  save();
}

function cycleColor(name) {
  setSubjects(subjects().map((x) => (x.name === name ? { ...x, color: PALETTE[(PALETTE.indexOf(x.color) + 1) % PALETTE.length] } : x)));
  save();
}

function removeSubject(name) {
  const n = db.items.filter((i) => i.status === 'active' && i.subject === name).length;
  if (n) return toast(`항목 ${n}개가 있어 지울 수 없습니다. 항목을 먼저 지우세요`);
  const k = db.tasks.filter((x) => x.status === 'active' && !x.doneOn && x.subject === name).length;
  if (k) return toast(`남은 할 일 ${k}개가 있어 지울 수 없습니다`);
  setSubjects(subjects().filter((x) => x.name !== name));
  save();
  toast('과목 삭제됨');
}

function renderSettings(s) {
  renderSync();
  renderPush();
  const setVal = (sel, v) => { const el = $(sel); if (el !== document.activeElement) el.value = v; };
  setVal('#set-intervals', s.intervals.join(', '));
  setVal('#set-daystart', s.dayStartHour);
  setVal('#set-limit', s.dailyLimit);
  setVal('#set-exam', s.examDate || '');
  setVal('#set-morning', s.notify?.morning || '');
  setVal('#set-evening', s.notify?.evening || '');
  setVal('#set-offset', db.dayOffset || 0);
  if (db.dayOffset) $('#adv').open = true;
}

// ---------- 이벤트 ----------
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => {
  view = b.dataset.view;
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
  $('#title').textContent = b.textContent;
  render();
}));

const qi = $('#quick-input');
qi.addEventListener('input', () => { qi.style.height = 'auto'; qi.style.height = Math.min(qi.scrollHeight, 200) + 'px'; });
qi.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !qi.value.includes('\n')) { e.preventDefault(); $('#quick-form').requestSubmit(); }
});
$('#quick-form').onsubmit = (e) => {
  e.preventDefault();
  if (!qi.value.trim()) return;
  if (mode() === 'plan') {
    const on = planDate();
    const n = addTasks(qi.value);
    qi.value = ''; qi.style.height = 'auto';
    toast(on === today() ? `오늘 할 일 ${n}개 추가` : `${fmt(on)} (${dow(on)}) 할 일 ${n}개 추가 · 달력에서 보여요`);
    render();
    return;
  }
  const on = addDate();
  const n = addItems(qi.value);
  qi.value = ''; qi.style.height = 'auto';
  const first = addDays(on, S().intervals[0]);
  toast(`${n}개 추가${on !== today() ? ` (${fmt(on)} 공부)` : ''} · 첫 복습 ${first <= today() ? '오늘' : fmt(first)}`);
  render();
};

// 카드의 제목이나 ⋯을 누르면 고치기
const editTarget = (e) => e.target.closest('[data-edit]')?.closest('.card')?.dataset.id;
$('#today-list').onclick = (e) => {
  const b = e.target.closest('button[data-r]');
  if (b) { review(b.closest('.card').dataset.id, Number(b.dataset.r)); render(); return; }
  const id = editTarget(e);
  if (id) openEditor(id);
};
$('#cal-day-list').onclick = (e) => {
  const task = e.target.closest('[data-task]')?.dataset.task;
  if (task) { openTaskEditor(task); return; }
  const item = e.target.closest('[data-item]')?.dataset.item;
  if (item) { openEditor(item); return; }
  const id = editTarget(e);
  if (id) openEditor(id);
};
$('#today-filter').onclick = (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  ui.filter = b.dataset.f || null;
  saveUi();
  render();
};
$('#date-row').onclick = (e) => {
  const b = e.target.closest('button[data-k]');
  if (b) {
    const k = Number(b.dataset.k);
    if (mode() === 'plan') setPlanOn(addDays(today(), k)); else setAddOn(addDays(today(), -k));
    render();
    return;
  }
  if (e.target.closest('#date-pick')) { try { $('#quick-date').showPicker(); } catch {} }
};
$('#quick-date').onchange = (e) => {
  if (mode() === 'plan') setPlanOn(e.target.value || null); else setAddOn(e.target.value || null);
  render();
};
$('#mode-seg').onclick = (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === mode()) return;
  ui.mode = b.dataset.mode;
  saveUi();
  render();
  qi.focus();
};
$('#plan-list').onclick = (e) => {
  const row = e.target.closest('[data-task]');
  if (!row) return;
  if (e.target.closest('[data-tedit]')) { openTaskEditor(row.dataset.task); return; }
  const x = findTask(row.dataset.task);
  if (!x) return;
  if (x.doneOn) uncheckTask(x.id); else completeTask(x.id);
  render();
};
$('#done-new').onclick = (e) => { const id = e.target.closest('[data-item]')?.dataset.item; if (id) openEditor(id); };

// ---------- 할 일 고치기 ----------
let taskEditId = null;
const tdlg = $('#task-dlg');
function openTaskEditor(id) {
  const x = findTask(id);
  if (!x) return;
  taskEditId = id;
  const t = today();
  const names = subjects().map((s) => s.name);
  if (!names.includes(x.subject)) names.push(x.subject);
  $('#tk-title').value = x.title;
  $('#tk-subject').innerHTML = names.map((n) => `<option${n === x.subject ? ' selected' : ''}>${esc(n)}</option>`).join('');
  $('#tk-date-label').classList.toggle('hidden', !!x.doneOn);
  $('#tk-date').value = x.on;
  $('#tk-date').min = x.on < t ? x.on : t;
  const n = taskItems(x).length;
  $('#tk-info').textContent = x.doneOn
    ? `${fmt(x.doneOn)} 끝냄 · ${n ? `복습 ${n}개 시작함 (복습 항목은 따로 고쳐요)` : '복습 안 함'}`
    : x.on < t ? `${fmt(x.on)}에 하려던 일이에요` : '';
  $('#tk-tomorrow').classList.toggle('hidden', !!x.doneOn);
  tdlg.showModal();
  document.activeElement?.blur();
}
$('#task-form').onsubmit = (e) => {
  e.preventDefault();
  const x = findTask(taskEditId);
  if (!x) return tdlg.close();
  const title = $('#tk-title').value.trim().replace(/\s+/g, ' ');
  if (!title) return toast('할 일을 입력하세요');
  const next = { title, subject: $('#tk-subject').value };
  if (!x.doneOn) {
    const d = $('#tk-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return toast('할 날을 고르세요');
    next.on = d;
  }
  if (Object.keys(next).some((k) => x[k] !== next[k])) { Object.assign(x, next); touch('task', x); save(); toast('고쳤어요'); }
  tdlg.close();
  render();
};
$('#tk-cancel').onclick = () => tdlg.close();
$('#tk-tomorrow').onclick = () => {
  const x = findTask(taskEditId);
  if (x && !x.doneOn) {
    const prev = x.on;
    x.on = addDays(today(), 1);
    touch('task', x); save();
    toast('내일로 미뤘어요', () => { x.on = prev; touch('task', x); save(); });
  }
  tdlg.close();
  render();
};
$('#tk-delete').onclick = () => { removeTask(taskEditId); tdlg.close(); render(); };
tdlg.addEventListener('click', (e) => { if (e.target === tdlg) tdlg.close(); });

// ---------- 항목 고치기 ----------
let editId = null;
const dlg = $('#edit-dlg');
function openEditor(id) {
  const it = db.items.find((i) => i.id === id && i.status === 'active');
  if (!it) return;
  editId = id;
  const t = today();
  const st = computeAll(db.items, db.logs, S()).get(id);
  const names = subjects().map((x) => x.name);
  if (!names.includes(it.subject)) names.push(it.subject);
  $('#ed-title').value = it.title;
  $('#ed-subject').innerHTML = names.map((n) => `<option${n === it.subject ? ' selected' : ''}>${esc(n)}</option>`).join('');
  $('#ed-date').value = it.studiedOn;
  $('#ed-date').max = t;
  $('#ed-note').value = it.note || '';
  $('#ed-info').textContent = `복습 ${st.reviews}회${st.lapses ? ` · 잊음 ${st.lapses}회` : ''}${st.hards ? ` · 애매 ${st.hards}회` : ''} · ` +
    (st.mastered ? '모든 회차 완료' : st.due === t ? '오늘 복습' : st.due < t ? `${fmt(st.due)} 복습 예정이었음 (${diffDays(t, st.due)}일 밀림)` : `다음 복습 ${fmt(st.due)} (${dow(st.due)})`);
  $('#ed-postpone').classList.toggle('hidden', st.mastered || !st.due || st.due > t);
  // 지금(미리) 복습하기. 모든 회차를 끝낸 항목은 처음부터 다시
  $('#ed-rate').innerHTML = st.mastered
    ? `<span class="hint">다 끝낸 항목이에요</span><div class="rate one"><button type="button" class="f" data-er="${RATING.FORGOT}">처음부터 다시 복습</button></div>`
    : `<span class="hint">${st.due <= t ? '지금 복습' : `미리 복습 (예정 ${fmt(st.due)})`}</span><div class="rate">` +
      [1, 2, 3].map((r) => `<button type="button" class="${RCLS[r]}" data-er="${r}">${LABEL[r]}</button>`).join('') + '</div>';
  dlg.showModal();
  document.activeElement?.blur(); // 폰에서 열자마자 키보드가 올라오지 않게
}
$('#edit-form').onsubmit = (e) => {
  e.preventDefault();
  const it = db.items.find((i) => i.id === editId);
  if (!it) return dlg.close();
  const title = $('#ed-title').value.trim().replace(/\s+/g, ' ');
  const date = $('#ed-date').value;
  if (!title) return toast('제목을 입력하세요');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) return toast('공부한 날은 오늘이나 그 이전이어야 해요');
  const next = { title, subject: $('#ed-subject').value, studiedOn: date, note: $('#ed-note').value.trim() };
  if (Object.keys(next).some((k) => (it[k] || '') !== next[k])) {
    Object.assign(it, next);
    touch('item', it);
    save();
    toast('고쳤어요');
  }
  dlg.close();
  render();
};
$('#ed-cancel').onclick = () => dlg.close();
$('#ed-rate').onclick = (e) => {
  const b = e.target.closest('button[data-er]');
  if (!b) return;
  review(editId, Number(b.dataset.er));
  dlg.close();
  render();
};
$('#done-list').onclick = (e) => {
  const b = e.target.closest('button');
  const row = e.target.closest('[data-log]');
  if (!b || !row) return;
  if (b.dataset.cancel) cancelReview(row.dataset.log);
  else if (b.dataset.rr) changeRating(row.dataset.log, Number(b.dataset.rr));
  render();
};
$('#week').onclick = (e) => {
  const b = e.target.closest('button[data-d]');
  if (!b) return;
  calSel = b.dataset.d;
  calMonth = calSel.slice(0, 7);
  document.querySelector('nav button[data-view="calendar"]').click();
};
$('#subj-search').oninput = (e) => { subjQuery = e.target.value; render(); };
$('#show-done').onchange = (e) => { ui.showDone = e.target.checked; saveUi(); render(); };
$('#only-weak').onchange = (e) => { ui.onlyWeak = e.target.checked; saveUi(); render(); };
// PC: 1·2·3 키로 맨 위 카드 평가 (입력 중이 아닐 때)
document.addEventListener('keydown', (e) => {
  if (view !== 'today' || dlg.open || tdlg.open || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const r = { 1: 1, 2: 2, 3: 3 }[e.key];
  const card = $('#today-list .card');
  if (!r || !card) return;
  e.preventDefault();
  review(card.dataset.id, r);
  render();
});
$('#ed-postpone').onclick = () => { postponeItem(editId); dlg.close(); render(); };
$('#ed-delete').onclick = () => { removeItem(editId); dlg.close(); render(); };
// 바깥(어두운 곳)을 누르면 닫기
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

$('#subject-list').onclick = (e) => {
  const id = editTarget(e);
  if (id) { openEditor(id); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const name = a.closest('.subj').dataset.name;
  if (a.dataset.act === 'fold') {
    const set = new Set(ui.collapsed || []);
    set.has(name) ? set.delete(name) : set.add(name);
    ui.collapsed = [...set];
    saveUi();
  }
  if (a.dataset.act === 'rename') renameSubject(name);
  if (a.dataset.act === 'color') cycleColor(name);
  if (a.dataset.act === 'remove' && confirm(`'${name}' 과목을 지울까요?`)) removeSubject(name);
  render();
};
$('#subject-list').onsubmit = (e) => {
  if (e.target.id !== 'subj-form') return;
  e.preventDefault();
  if (addSubject($('#subj-name').value)) { toast('과목 추가됨'); render(); $('#subj-name')?.focus(); }
};
$('#subject-chips').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.add) { document.querySelector('nav button[data-view="subjects"]').click(); $('#subj-name')?.focus(); return; }
  ui.subject = ui.subject === b.dataset.name ? null : b.dataset.name;
  saveUi();
  renderChips();
  qi.focus();
};
$('#cal-grid').onclick = (e) => {
  const d = e.target.closest('.d');
  if (d) { calSel = d.dataset.d; render(); }
};
const shiftMonth = (k) => {
  const [y, m] = calMonth.split('-').map(Number);
  const dt = new Date(y, m - 1 + k, 1);
  calMonth = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  render();
};
$('#cal-prev').onclick = () => shiftMonth(-1);
$('#cal-next').onclick = () => shiftMonth(1);

// 설정은 칸을 바꾸면 바로 저장 (비운 칸은 원래 값 유지)
function saveSettings() {
  const s = S();
  // 숫자만 골라냄: "1, 3, 7" "1 3 7" "1.3.7" 모두 됨
  const intervals = $('#set-intervals').value.split(/\D+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!intervals.length) { toast('간격을 1 이상의 숫자로 입력하세요'); $('#set-intervals').value = s.intervals.join(', '); return; }
  const num = (sel, def, lo, hi) => {
    const v = $(sel).value;
    const n = v === '' ? def : Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  db.settings = {
    ...db.settings,
    intervals,
    dayStartHour: num('#set-daystart', s.dayStartHour, 0, 12),
    dailyLimit: num('#set-limit', s.dailyLimit, 1, 500),
    examDate: $('#set-exam').value || null,
    notify: { morning: $('#set-morning').value || '', evening: $('#set-evening').value || '' },
  };
  touch('settings', db.settings);
  db.dayOffset = num('#set-offset', 0, -3650, 3650);
  save();
  toast('저장됨');
  render();
}
['#set-intervals', '#set-daystart', '#set-limit', '#set-exam', '#set-morning', '#set-evening', '#set-offset']
  .forEach((sel) => $(sel).addEventListener('change', saveSettings));

$('#export-btn').onclick = () => {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `복습플래너-백업-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#import-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = migrate(JSON.parse(await f.text()));
    if (!data) throw new Error('형식 불일치');
    if (!confirm(`항목 ${data.items.length}개, 기록 ${data.logs.length}개로 현재 데이터를 덮어씁니다.` +
      (syncUser ? '\n동기화 중이므로 서버의 더 최신 기록은 유지되고, 나머지는 다른 기기에도 반영됩니다.' : ''))) return;
    // 동기화 상태는 새로 시작: 전부 다시 받아 합치고(cursor 없음), 백업 내용은 올릴 대상으로
    data.sync = { cursor: null, dirty: [], lastSyncAt: null };
    db = data; markAllDirty(db); save(); toast('가져오기 완료'); render();
  } catch (err) { toast('가져오기 실패: ' + err.message); }
  e.target.value = '';
};
$('#reset-btn').onclick = () => {
  if (!confirm('이 기기의 모든 데이터를 지웁니다. 먼저 내보내기 하셨나요?' + (syncUser ? '\n(로그인 중이면 서버의 기록을 다시 받아옵니다)' : ''))) return;
  localStorage.removeItem(KEY); db = load(); render(); toast('초기화됨');
};

// ---------- 동기화 ----------
let syncUser = null;      // 로그인한 사용자 (없으면 null)
let syncState = 'idle';   // idle | syncing | error
let syncError = '';
let syncTimer = null, syncAgain = false;

function scheduleSync(ms) {
  if (!syncUser) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, ms);
}

async function runSync(manual = false) {
  if (!syncUser) return;
  if (syncState === 'syncing') { syncAgain = true; return; }
  syncState = 'syncing'; syncError = ''; renderSync();
  try {
    const r = await sync.syncNow(() => db, () => {
      try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {}
    });
    syncState = 'idle';
    if (r.pulled) render();
    if (manual) toast(`동기화 완료 · 받음 ${r.pulled} · 올림 ${r.pushed}`);
  } catch (e) {
    syncState = 'error'; syncError = e.message;
    if (manual) toast('동기화 실패: ' + e.message);
  }
  renderSync();
  if (syncAgain) { syncAgain = false; scheduleSync(500); }
}

function renderSync() {
  const box = $('#sync-box');
  if (!box) return;
  const dot = $('#sync-dot');
  if (dot) {
    dot.className = syncUser ? syncState : 'off';
    dot.title = !syncUser ? '동기화 꺼짐' : syncState === 'error' ? '동기화 오류: ' + syncError : syncState === 'syncing' ? '동기화 중' : '동기화됨';
  }
  if (view !== 'settings') return;
  if (!sync.configured()) {
    box.innerHTML = '<p class="hint">서버가 아직 설정되지 않았습니다 (config.js).</p>';
    return;
  }
  if (!syncUser) {
    if (box.dataset.mode === 'login') return; // 입력 중인 값 유지
    box.dataset.mode = 'login';
    box.innerHTML = `
      <p class="hint">로그인하면 폰·PC·브라우저의 기록이 자동으로 합쳐집니다. 이 기기의 기존 기록도 함께 올라갑니다.</p>
      <label>이메일<input id="sync-email" type="email" autocomplete="username"></label>
      <label>비밀번호 (6자 이상)<input id="sync-pw" type="password" autocomplete="current-password"></label>
      <div class="row"><button id="sync-login">로그인</button><button id="sync-signup">처음이면 가입</button></div>`;
    const creds = () => [$('#sync-email').value.trim(), $('#sync-pw').value];
    $('#sync-login').onclick = () => doLogin(() => sync.signIn(...creds()));
    $('#sync-signup').onclick = () => doLogin(async () => {
      const ok = await sync.signUp(...creds());
      if (!ok) { toast('확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요'); return null; }
      return sync.currentUser();
    });
    return;
  }
  box.dataset.mode = 'user';
  const last = db.sync.lastSyncAt ? new Date(db.sync.lastSyncAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '아직 없음';
  const status = syncState === 'syncing' ? '동기화 중…' : syncState === 'error' ? `<span class="late">오류: ${esc(syncError)}</span>` : `마지막 동기화 ${last}`;
  box.innerHTML = `
    <p class="hint">${esc(syncUser.email || '')} 로그인됨 · ${status}${db.sync.dirty.length ? ` · 올릴 기록 ${db.sync.dirty.length}개` : ''}</p>
    <div class="row"><button id="sync-now">지금 동기화</button><button id="sync-logout">로그아웃</button></div>`;
  $('#sync-now').onclick = () => runSync(true);
  $('#sync-logout').onclick = async () => {
    if (!confirm('로그아웃합니다. 이 기기의 기록은 그대로 남고, 동기화만 멈춥니다.')) return;
    try { await sync.signOut(); } catch {}
    syncUser = null; syncState = 'idle';
    db.sync = { cursor: null, dirty: [], lastSyncAt: null };
    const sub = await currentPushSub().catch(() => null);
    if (sub) await sub.unsubscribe().catch(() => {});
    save(); renderSync(); renderPush(); toast('로그아웃됨');
  };
}

async function doLogin(fn) {
  const btns = document.querySelectorAll('#sync-box button');
  btns.forEach((b) => (b.disabled = true));
  try {
    const user = await fn();
    if (user) {
      syncUser = user;
      markAllDirty(db); // 이 기기 기록을 전부 올림 (서버에 더 새것이 있으면 그쪽이 이김)
      db.sync.cursor = null;
      save();
      toast('로그인됨 · 동기화를 시작합니다');
      await runSync(true);
      renderPush();
    }
  } catch (e) {
    toast(e.message);
  }
  btns.forEach((b) => (b.disabled = false));
  renderSync();
}

// ---------- 이 기기 푸시 알림 (폰·브라우저) ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const b64ToBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
async function currentPushSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderPush() {
  const box = $('#push-box');
  if (!box) return;
  if (window.desktop) { box.innerHTML = '<p class="hint">PC 앱은 위 시각에 Windows 알림을 띄웁니다.</p>'; return; }
  if (!sync.configured() || !syncUser) { box.innerHTML = '<p class="hint">알림을 받으려면 먼저 아래 동기화에서 로그인하세요.</p>'; return; }
  if (!pushSupported()) {
    box.innerHTML = `<p class="hint">${isIOS && !standalone()
      ? '아이폰은 Safari 공유 버튼 → "홈 화면에 추가"로 설치한 앱에서만 알림을 받을 수 있습니다.'
      : '이 브라우저는 푸시 알림을 지원하지 않습니다.'}</p>`;
    return;
  }
  const sub = await currentPushSub();
  if (Notification.permission === 'denied') {
    box.innerHTML = '<p class="hint">알림이 차단되어 있습니다. 기기 설정에서 이 앱의 알림을 허용하세요.</p>';
    return;
  }
  box.innerHTML = (sub
    ? `<p class="hint">이 기기로 아침·밤 알림이 옵니다.</p>
       <div class="row"><button id="push-test">테스트 알림</button><button id="push-off">알림 끄기</button></div>`
    : `<p class="hint">켜면 휴대폰이 잠겨 있어도 정한 시각에 알림이 옵니다.</p>
       <button id="push-on">이 기기에서 알림 받기</button>`);
  if (sub) {
    $('#push-test').onclick = async () => {
      try { const r = await sync.testPush(); toast(r?.sent ? `테스트 알림을 보냈습니다 (기기 ${r.sent}대)` : '보낼 기기가 없습니다'); }
      catch (e) { toast('테스트 실패: ' + e.message); }
    };
    $('#push-off').onclick = async () => {
      try { await sync.deletePush(sub.endpoint); } catch {}
      await sub.unsubscribe().catch(() => {});
      toast('이 기기 알림을 껐습니다'); renderPush();
    };
  } else {
    $('#push-on').onclick = enablePush;
  }
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('알림을 허용해야 받을 수 있습니다'); renderPush(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) }));
    const j = sub.toJSON();
    await sync.savePush({
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul', ua: navigator.userAgent.slice(0, 200),
    });
    toast('알림을 켰습니다');
  } catch (e) {
    toast('알림 켜기 실패: ' + e.message);
  }
  renderPush();
}

// 시작할 때 로그인 상태 확인 → 동기화
(async () => {
  if (!sync.configured()) return;
  try { syncUser = await sync.currentUser(); } catch { syncUser = null; }
  renderSync();
  if (syncUser) runSync();
})();
// 1분마다(화면을 보고 있거나 PC 앱일 때) 다른 기기 변경 받기
setInterval(() => { if (!document.hidden || window.desktop) runSync(); }, 60000);

// 날짜가 바뀌면(자정/하루 시작 시각) 다시 그림. 다시 볼 때 동기화도
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); scheduleSync(300); } });

if (window.desktop) {
  // PC 앱: 창 제목줄 자리를 비우고, 1분마다 하루가 바뀌었는지 확인
  document.documentElement.classList.add('desktop');
  window.desktop.onTick(() => { if (today() !== renderedDay) render(); else reportToday(null, today(), S()); });
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// 저장소 영구 보존 요청 (지원 브라우저만)
navigator.storage?.persist?.();

render();
