import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS as S, computeState, addDays, diffDays, localDate,
  todayQueue, spreadOverflow, computeAll, parseQuickInput, projectDates,
} from '../scheduler.js';

const item = { id: 'a', studiedOn: '2026-11-01', status: 'active', createdAt: 1 };
const rv = (on, rating) => ({ kind: 'review', itemId: 'a', on, rating });

test('날짜 연산: 월·연도 경계', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(diffDays('2027-01-02', '2026-12-30'), 3);
});

test('하루 시작 시각: 새벽 3시는 전날', () => {
  assert.equal(localDate(new Date(2026, 10, 21, 3, 0), 4), '2026-11-20');
  assert.equal(localDate(new Date(2026, 10, 21, 5, 0), 4), '2026-11-21');
});

test('첫 복습은 학습 다음날', () => {
  assert.equal(computeState(item, [], S).due, '2026-11-02');
});

test('기억남이면 1→3→7→15→30 후 완료', () => {
  let logs = [];
  let s = computeState(item, logs, S);
  const expected = ['2026-11-05', '2026-11-12', '2026-11-27', '2026-12-27'];
  for (const e of expected) {
    logs.push(rv(s.due, 3));
    s = computeState(item, logs, S);
    assert.equal(s.due, e);
  }
  logs.push(rv(s.due, 3));
  assert.equal(computeState(item, logs, S).mastered, true);
});

test('늦게 하면 실제 완료일 기준', () => {
  const s = computeState(item, [rv('2026-11-06', 3)], S); // 4일 늦음
  assert.equal(s.due, '2026-11-09');
});

test('잊음이면 처음 간격으로', () => {
  const s = computeState(item, [rv('2026-11-02', 3), rv('2026-11-05', 1)], S);
  assert.equal(s.step, 0);
  assert.equal(s.due, '2026-11-06');
  assert.equal(s.lapses, 1);
});

test('애매면 같은 간격 반복', () => {
  const s = computeState(item, [rv('2026-11-02', 3), rv('2026-11-05', 2)], S);
  assert.equal(s.step, 1);
  assert.equal(s.due, '2026-11-08');
});

test('시험일 이후 복습은 시험 전날로', () => {
  const st = { ...S, examDate: '2026-11-10' };
  const s = computeState(item, [rv('2026-11-02', 3), rv('2026-11-05', 3)], st);
  assert.equal(s.due, '2026-11-09');
});

test('상한 초과분 분산', () => {
  const st = { ...S, dailyLimit: 2 };
  const items = [1, 2, 3, 4, 5].map((i) => ({ id: 'i' + i, studiedOn: '2026-11-01', status: 'active', createdAt: i }));
  let logs = [];
  let states = computeAll(items, logs, st);
  const q = todayQueue(items, states, '2026-11-02', st);
  assert.equal(q.now.length, 2);
  assert.equal(q.overflow.length, 3);
  logs = spreadOverflow(q.overflow, items, states, '2026-11-02', st);
  states = computeAll(items, logs, st);
  const dues = items.map((i) => states.get(i.id).due).sort();
  assert.deepEqual(dues, ['2026-11-02', '2026-11-02', '2026-11-03', '2026-11-03', '2026-11-04']);
});

test('빠른 입력 파싱', () => {
  const r = parseQuickInput('행정법 3장 #행정법\n\n  영어 단어 Day1  \n');
  assert.deepEqual(r, [
    { title: '행정법 3장', subject: '행정법' },
    { title: '영어 단어 Day1', subject: '기타' },
  ]);
});

test('달력 예상일', () => {
  const s = computeState(item, [], S);
  assert.deepEqual(projectDates(item, s, S), ['2026-11-02', '2026-11-05', '2026-11-12', '2026-11-27', '2026-12-27']);
});

test('지워진 로그는 무시하고, 섞인 순서의 로그는 날짜순으로 계산', () => {
  const items = [item];
  const logs = [
    { ...rv('2026-11-05', 3), at: 2 },
    { ...rv('2026-11-02', 3), at: 1 },
    { ...rv('2026-11-05', 1), at: 3, deleted: true },
  ];
  const s = computeAll(items, logs, S).get('a');
  assert.equal(s.step, 2);
  assert.equal(s.due, '2026-11-12');
  assert.equal(s.lapses, 0);
});

test('지난 날짜로 넣은 항목 → 첫 복습이 이미 지났으면 오늘 목록에, 한 항목 미루기는 단계 유지', () => {
  const t = '2026-11-21';
  const old = { id: 'p', studiedOn: '2026-11-19', status: 'active', createdAt: 1 }; // 첫 복습 11/20 (하루 밀림)
  let st = computeAll([old], [], S).get('p');
  assert.equal(st.due, '2026-11-20');
  assert.equal(todayQueue([old], new Map([['p', st]]), t, S).now.length, 1);
  // 내일로 미루기
  const logs = [{ kind: 'postpone', itemId: 'p', on: t, to: '2026-11-22', at: 1 }];
  st = computeAll([old], logs, S).get('p');
  assert.deepEqual([st.due, st.step], ['2026-11-22', 0]);
  assert.equal(todayQueue([old], new Map([['p', st]]), t, S).now.length, 0);
  // 미룬 뒤 같은 날 바로 복습하면 복습 기준으로 다시 계산
  logs.push({ kind: 'review', itemId: 'p', on: t, rating: 3, at: 2 });
  st = computeAll([old], logs, S).get('p');
  assert.deepEqual([st.due, st.step], [addDays(t, S.intervals[1]), 1]);
});
