// 기기 간 병합 (순수 함수만 — 네트워크·DOM 접근 금지)
// 기록 단위: item(항목) · log(복습/미루기) · task(할 일) · settings('main' 하나)
// 규칙: 같은 기록이면 updatedAt이 더 큰 쪽이 이김. 지우기는 실제로 지우지 않고 표시만 한다
//       (item·task.status='deleted', log.deleted=true) → 지운 것도 다른 기기로 전해진다.

export const SCHEMA = 3;

export const keyOf = (kind, id) => `${kind}:${id}`;

export function emptyDb(defaultSettings) {
  return { schema: SCHEMA, items: [], logs: [], tasks: [], settings: { ...defaultSettings, updatedAt: 0 }, dayOffset: 0, sync: emptySync() };
}
export const emptySync = () => ({ cursor: null, dirty: [], lastSyncAt: null });

// 저장된 데이터를 최신 스키마로. 알 수 없는 형식이면 null
export function migrate(raw) {
  if (!raw || !Array.isArray(raw.items) || !Array.isArray(raw.logs)) return null;
  if (raw.schema === 1) {
    raw = {
      ...raw,
      schema: 2,
      items: raw.items.map((i) => ({ ...i, updatedAt: i.updatedAt || i.createdAt || 0 })),
      logs: raw.logs.map((l) => ({ ...l, updatedAt: l.updatedAt || l.at || 0 })),
      settings: { ...(raw.settings || {}), updatedAt: raw.settings?.updatedAt || 0 },
      sync: emptySync(),
    };
  }
  if (raw.schema === 2) {
    // 할 일 추가. 옛 버전은 모르는 종류(task)를 건너뛴 채 받기 위치만 넘어갔을 수 있으니 처음부터 다시 받음
    raw = { ...raw, schema: 3, tasks: [], sync: { ...(raw.sync || emptySync()), cursor: null } };
  }
  if (raw.schema !== SCHEMA) return null;
  if (!Array.isArray(raw.tasks)) raw.tasks = [];
  if (!raw.sync) raw.sync = emptySync();
  return raw;
}

// 로컬에서 바꾼 기록 표시 (다음 동기화 때 올림)
export function markDirty(db, kind, id) {
  const k = keyOf(kind, id);
  if (!db.sync.dirty.includes(k)) db.sync.dirty.push(k);
}

// 처음 로그인했을 때: 이 기기의 기록을 전부 올릴 대상으로
export function markAllDirty(db) {
  db.sync.dirty = [
    ...db.items.map((i) => keyOf('item', i.id)),
    ...db.logs.map((l) => keyOf('log', l.id)),
    ...db.tasks.map((x) => keyOf('task', x.id)),
    keyOf('settings', 'main'),
  ];
}

function find(db, kind, id) {
  if (kind === 'item') return db.items.find((x) => x.id === id);
  if (kind === 'log') return db.logs.find((x) => x.id === id);
  if (kind === 'task') return db.tasks.find((x) => x.id === id);
  if (kind === 'settings' && id === 'main') return db.settings;
  return undefined;
}

// 올릴 기록 목록: [{ kind, id, data, updated_at }]
export function dirtyRows(db) {
  const rows = [];
  for (const k of db.sync.dirty) {
    const i = k.indexOf(':');
    const kind = k.slice(0, i), id = k.slice(i + 1);
    const rec = find(db, kind, id);
    if (rec) rows.push({ kind, id, data: rec, updated_at: rec.updatedAt || 0 });
  }
  return rows;
}

// 서버에서 받은 기록을 합침. 반환: 바뀐 기록 수
export function applyRemote(db, rows) {
  let changed = 0;
  // 같은 기록을 빨리 찾도록 색인
  const itemIdx = new Map(db.items.map((x, n) => [x.id, n]));
  const logIdx = new Map(db.logs.map((x, n) => [x.id, n]));
  const taskIdx = new Map(db.tasks.map((x, n) => [x.id, n]));
  const dirty = new Set(db.sync.dirty);
  for (const r of rows) {
    if (!r || !r.data || typeof r.id !== 'string') continue;
    const remote = { ...r.data, updatedAt: Number(r.updated_at) || 0 };
    const local = find(db, r.kind, r.id);
    if (local && (local.updatedAt || 0) >= remote.updatedAt) continue; // 로컬이 같거나 더 새것
    if (r.kind === 'item') {
      remote.id = r.id;
      if (itemIdx.has(r.id)) db.items[itemIdx.get(r.id)] = remote;
      else { itemIdx.set(r.id, db.items.length); db.items.push(remote); }
    } else if (r.kind === 'log') {
      remote.id = r.id;
      if (logIdx.has(r.id)) db.logs[logIdx.get(r.id)] = remote;
      else { logIdx.set(r.id, db.logs.length); db.logs.push(remote); }
    } else if (r.kind === 'task') {
      remote.id = r.id;
      if (taskIdx.has(r.id)) db.tasks[taskIdx.get(r.id)] = remote;
      else { taskIdx.set(r.id, db.tasks.length); db.tasks.push(remote); }
    } else if (r.kind === 'settings' && r.id === 'main') {
      db.settings = remote;
    } else continue;
    dirty.delete(keyOf(r.kind, r.id)); // 서버 것이 더 새로우니 올릴 필요 없음
    changed++;
  }
  db.sync.dirty = [...dirty];
  return changed;
}

// 올리기에 성공한 기록을 표시에서 뺌 (올리는 사이에 또 바뀐 건 남김)
export function clearPushed(db, rows) {
  const sent = new Map(rows.map((r) => [keyOf(r.kind, r.id), r.updated_at]));
  db.sync.dirty = db.sync.dirty.filter((k) => {
    if (!sent.has(k)) return true;
    const i = k.indexOf(':');
    const rec = find(db, k.slice(0, i), k.slice(i + 1));
    return rec && (rec.updatedAt || 0) > sent.get(k);
  });
}
