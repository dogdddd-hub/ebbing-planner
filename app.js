import {
  DEFAULT_SETTINGS, localDate, addDays, diffDays, computeAll, todayQueue,
  spreadOverflow, projectDates, parseQuickInput, RATING,
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
function toast(msg, undo) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = esc(msg) + (undo ? ' <button>되돌리기</button>' : '');
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
  for (const it of db.items) {
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

function addItems(text) {
  const parsed = parseQuickInput(text, ui.subject || '기타');
  const t = today();
  for (const p of parsed) {
    const it = { id: uid(), title: p.title, subject: p.subject, note: '', studiedOn: t, status: 'active', createdAt: Date.now() };
    touch('item', it);
    db.items.push(it);
  }
  save();
  return parsed.length;
}

function review(itemId, rating) {
  const log = { id: uid(), kind: 'review', itemId, on: today(), rating, at: Date.now() };
  touch('log', log);
  db.logs.push(log);
  save();
  const label = { 1: '잊음', 2: '애매', 3: '기억남' }[rating];
  toast(`${label} 기록됨`, () => undoLogs(new Set([log.id])));
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
  reportDesktop(states, t, s);
  $('#today-label').textContent = `${fmt(t)} (${dow(t)})${db.dayOffset ? ` · 시간이동 ${db.dayOffset > 0 ? '+' : ''}${db.dayOffset}일` : ''}`;
  if (view === 'today') renderToday(states, t, s);
  if (view === 'calendar') renderCalendar(states, t, s);
  if (view === 'subjects') renderSubjects(states, t);
  if (view === 'settings') renderSettings(s);
}

// PC 앱(Electron)이면 트레이·알림용으로 오늘 남은 복습 수와 알림 시각을 알려 줌
function reportDesktop(states, t, s) {
  if (!window.desktop) return;
  states ||= computeAll(db.items, db.logs, s);
  const q = todayQueue(db.items, states, t, s);
  window.desktop.report({ date: t, due: q.now.length + q.overflow.length, notify: s.notify });
}

const tagHTML = (name) => { const c = colorOf(name); return `<span class="tag" style="background:${c}2e;color:${c}">${esc(name)}</span>`; };

function cardHTML(it, st, t, withRate) {
  const late = st.due ? diffDays(t, st.due) : 0;
  const info = st.mastered ? '완료'
    : `${st.step + 1}/${S().intervals.length}회차 · ${late > 0 ? `<span class="late">${late}일 밀림</span>` : st.due === t ? '오늘' : `다음 ${fmt(st.due)}`}`;
  return `<li class="card" data-id="${it.id}">
    <div class="top"><div><div class="t">${esc(it.title)}</div><div class="meta">${info}${st.lapses ? ` · 잊음 ${st.lapses}회` : ''}</div></div>
    ${tagHTML(it.subject)}</div>
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
  $('#quick-input').placeholder = ui.subject ? `${ui.subject}에서 공부한 것 (여러 줄 가능)` : '공부한 것 #과목  (여러 줄 가능)';
}

function renderToday(states, t, s) {
  renderChips();
  const q = todayQueue(db.items, states, t, s);
  const doneToday = db.logs.filter((l) => l.kind === 'review' && !l.deleted && l.on === t).length;
  const addedToday = db.items.filter((i) => i.status === 'active' && i.studiedOn === t).length;
  $('#stats').innerHTML = `
    <div><b>${q.now.length + q.overflow.length}</b><span>남은 복습</span></div>
    <div><b>${doneToday}</b><span>오늘 완료</span></div>
    <div><b>${addedToday}</b><span>오늘 추가</span></div>`;
  $('#today-list').innerHTML = q.now.map((x) => cardHTML(x.item, x.state, t, true)).join('');
  $('#empty-today').classList.toggle('hidden', q.now.length > 0);
  $('#overflow-box').classList.toggle('hidden', q.overflow.length === 0);
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
  const first = `${calMonth}-01`;
  const startOffset = new Date(first + 'T00:00:00').getDay();
  let cells = DOW.map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i - startOffset);
    const n = byDate.get(d)?.length || 0;
    const cls = ['d', d.slice(0, 7) !== calMonth && 'out', d === t && 'today', d === calSel && 'sel', d === s.examDate && 'exam'].filter(Boolean).join(' ');
    cells += `<div class="${cls}" data-d="${d}"><span>${+d.slice(8)}</span>${n ? `<span class="n">${n}</span>` : ''}</div>`;
  }
  $('#cal-grid').innerHTML = cells;
  const list = calSel ? byDate.get(calSel) || [] : [];
  $('#cal-day-list').innerHTML = calSel
    ? `<li class="hint">${fmt(calSel)} (${dow(calSel)}) — ${list.length}개${calSel === s.examDate ? ' · 시험일' : ''}</li>` +
      list.map((x) => cardHTML(x.it, x.st, t, false)).join('')
    : '';
}

function renderSubjects(states, t) {
  const groups = new Map(subjects().map((x) => [x.name, []]));
  for (const it of db.items) {
    if (it.status !== 'active') continue;
    if (!groups.has(it.subject)) groups.set(it.subject, []);
    groups.get(it.subject).push(it);
  }
  const form = `<form id="subj-form" class="subj-form">
      <input id="subj-name" placeholder="새 과목 이름 (예: 행정법)" maxlength="20">
      <button type="submit">추가</button></form>`;
  if (!groups.size) { $('#subject-list').innerHTML = form + '<p class="empty">과목을 추가하거나, 입력할 때 #과목을 붙여 보세요.</p>'; return; }
  $('#subject-list').innerHTML = form + [...groups].map(([name, items]) => {
    const done = items.filter((i) => states.get(i.id)?.mastered).length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    const c = colorOf(name);
    const rows = items
      .sort((a, b) => (states.get(a.id).due || '9999').localeCompare(states.get(b.id).due || '9999'))
      .map((i) => cardHTML(i, states.get(i.id), t, false).replace('</li>', `<button class="mini del" data-id="${i.id}">삭제</button></li>`))
      .join('');
    return `<div class="subj" data-name="${esc(name)}"><h3>
        <span class="subj-title"><button class="dot" data-act="color" title="색 바꾸기" style="background:${c}"></button>${esc(name)}</span>
        <span class="subj-tools"><span class="hint">${done}/${items.length} 완료</span>
          <button class="mini" data-act="rename">이름</button><button class="mini" data-act="remove">삭제</button></span></h3>
      <div class="bar"><i style="width:${pct}%;background:${c}"></i></div><ul class="list">${rows}</ul></div>`;
  }).join('');
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
  setSubjects(subjects().filter((x) => x.name !== name));
  save();
  toast('과목 삭제됨');
}

function renderSettings(s) {
  renderSync();
  renderPush();
  $('#set-intervals').value = s.intervals.join(', ');
  $('#set-daystart').value = s.dayStartHour;
  $('#set-limit').value = s.dailyLimit;
  $('#set-exam').value = s.examDate || '';
  $('#set-morning').value = s.notify?.morning || '';
  $('#set-evening').value = s.notify?.evening || '';
  $('#set-offset').value = db.dayOffset || 0;
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
  const n = addItems(qi.value);
  qi.value = ''; qi.style.height = 'auto';
  toast(`${n}개 추가 · 첫 복습 ${fmt(addDays(today(), S().intervals[0]))}`);
  render();
};

$('#today-list').onclick = (e) => {
  const b = e.target.closest('button[data-r]');
  if (!b) return;
  review(b.closest('.card').dataset.id, Number(b.dataset.r));
  render();
};
$('#subject-list').onclick = (e) => {
  const b = e.target.closest('button.del');
  if (b) { removeItem(b.dataset.id); render(); return; }
  const a = e.target.closest('button[data-act]');
  if (!a) return;
  const name = a.closest('.subj').dataset.name;
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

$('#save-settings').onclick = () => {
  const intervals = $('#set-intervals').value.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!intervals.length) return toast('간격을 1 이상의 정수로 입력하세요');
  db.settings = {
    ...db.settings,
    notify: { morning: $('#set-morning').value || '', evening: $('#set-evening').value || '' },
    intervals,
    dayStartHour: Math.min(12, Math.max(0, Number($('#set-daystart').value) || 0)),
    dailyLimit: Math.max(1, Number($('#set-limit').value) || 30),
    examDate: $('#set-exam').value || null,
  };
  touch('settings', db.settings);
  db.dayOffset = Number($('#set-offset').value) || 0;
  save();
  toast('저장됨');
  render();
};

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
  const head = '<h3>이 기기 알림</h3>';
  if (window.desktop) { box.innerHTML = head + '<p class="hint">PC 앱은 위 시각에 Windows 알림을 띄웁니다.</p>'; return; }
  if (!sync.configured() || !syncUser) { box.innerHTML = head + '<p class="hint">알림을 받으려면 먼저 아래 동기화에서 로그인하세요.</p>'; return; }
  if (!pushSupported()) {
    box.innerHTML = head + `<p class="hint">${isIOS && !standalone()
      ? '아이폰은 Safari 공유 버튼 → "홈 화면에 추가"로 설치한 앱에서만 알림을 받을 수 있습니다.'
      : '이 브라우저는 푸시 알림을 지원하지 않습니다.'}</p>`;
    return;
  }
  const sub = await currentPushSub();
  if (Notification.permission === 'denied') {
    box.innerHTML = head + '<p class="hint">알림이 차단되어 있습니다. 기기 설정에서 이 앱의 알림을 허용하세요.</p>';
    return;
  }
  box.innerHTML = head + (sub
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
  window.desktop.onTick(() => { if (today() !== renderedDay) render(); else reportDesktop(null, today(), S()); });
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// 저장소 영구 보존 요청 (지원 브라우저만)
navigator.storage?.persist?.();

render();
