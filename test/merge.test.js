import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, emptyDb, markDirty, markAllDirty, dirtyRows, applyRemote, clearPushed } from '../merge.js';

const base = () => {
  const db = emptyDb({ intervals: [1, 3] });
  db.items.push({ id: 'i1', title: 'A', updatedAt: 100, status: 'active' });
  db.logs.push({ id: 'l1', itemId: 'i1', kind: 'review', on: '2026-11-02', rating: 3, at: 200, updatedAt: 200 });
  return db;
};

test('v1 → v2 변환', () => {
  const v1 = { schema: 1, items: [{ id: 'a', createdAt: 5 }], logs: [{ id: 'b', at: 7 }], settings: { dailyLimit: 9 }, dayOffset: 0 };
  const v2 = migrate(v1);
  assert.equal(v2.schema, 2);
  assert.equal(v2.items[0].updatedAt, 5);
  assert.equal(v2.logs[0].updatedAt, 7);
  assert.equal(v2.settings.dailyLimit, 9);
  assert.deepEqual(v2.sync.dirty, []);
  assert.equal(migrate({ schema: 9, items: [], logs: [] }), null);
  assert.equal(migrate(null), null);
});

test('새 기록은 추가, 더 새것은 덮어씀, 더 오래된 것은 무시', () => {
  const db = base();
  const n = applyRemote(db, [
    { kind: 'item', id: 'i2', data: { title: 'B' }, updated_at: 50 },               // 새 항목
    { kind: 'item', id: 'i1', data: { title: 'A-old' }, updated_at: 90 },           // 오래됨 → 무시
    { kind: 'log', id: 'l1', data: { ...db.logs[0], deleted: true }, updated_at: 300 }, // 다른 기기에서 되돌림
    { kind: 'settings', id: 'main', data: { intervals: [2, 4] }, updated_at: 10 },
  ]);
  assert.equal(n, 3);
  assert.equal(db.items.length, 2);
  assert.equal(db.items.find((i) => i.id === 'i1').title, 'A');
  assert.equal(db.items.find((i) => i.id === 'i2').title, 'B');
  assert.equal(db.logs[0].deleted, true);
  assert.deepEqual(db.settings.intervals, [2, 4]);
});

test('같은 걸 두 번 받아도 결과가 같음', () => {
  const db = base();
  const rows = [{ kind: 'item', id: 'i2', data: { title: 'B' }, updated_at: 50 }];
  applyRemote(db, rows);
  assert.equal(applyRemote(db, rows), 0);
  assert.equal(db.items.length, 2);
});

test('올릴 목록: 서버가 더 새로우면 빠지고, 로컬이 더 새로우면 남음', () => {
  const db = base();
  markDirty(db, 'item', 'i1');
  markDirty(db, 'log', 'l1');
  markDirty(db, 'log', 'l1');
  assert.equal(db.sync.dirty.length, 2);
  applyRemote(db, [
    { kind: 'log', id: 'l1', data: { rating: 1 }, updated_at: 999 },
    { kind: 'item', id: 'i1', data: { title: 'old' }, updated_at: 1 },
  ]);
  assert.deepEqual(db.sync.dirty, ['item:i1']);
  assert.deepEqual(dirtyRows(db).map((r) => [r.kind, r.id, r.updated_at]), [['item', 'i1', 100]]);
});

test('올린 뒤 표시 해제, 올리는 사이 또 바뀐 건 남김', () => {
  const db = base();
  markAllDirty(db);
  const rows = dirtyRows(db);
  assert.equal(rows.length, 3);
  db.items[0].updatedAt = 500; // 올리는 도중 수정
  clearPushed(db, rows);
  assert.deepEqual(db.sync.dirty, ['item:i1']);
});
