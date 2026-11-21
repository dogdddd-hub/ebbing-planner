// Supabase 동기화 (네트워크 담당). 병합 규칙은 merge.js
// 서버 테이블: records(user_id, kind, id, data, updated_at, server_at) — supabase/schema.sql 참고
import { SUPABASE_URL, SUPABASE_KEY, SITE_URL } from './config.js';
import { applyRemote, dirtyRows, clearPushed } from './merge.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
const PAGE = 1000;

let client = null;
export const configured = () => !!(SUPABASE_URL && SUPABASE_KEY);

// 라이브러리는 동기화를 쓸 때만 불러옴 (인터넷이 없어도 앱 자체는 동작)
async function getClient() {
  if (!client) {
    const { createClient } = await import(LIB);
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ebbing-planner-auth' },
    });
  }
  return client;
}

export async function currentUser() {
  if (!configured()) return null;
  const c = await getClient();
  const { data } = await c.auth.getSession();
  return data.session?.user || null;
}

const msg = (error) => {
  const m = error?.message || String(error);
  if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 틀렸습니다';
  if (/Email not confirmed/i.test(m)) return '가입 확인 메일의 링크를 먼저 눌러 주세요';
  if (/already registered/i.test(m)) return '이미 가입된 이메일입니다. 로그인하세요';
  if (/Signups not allowed/i.test(m)) return '새 가입이 막혀 있습니다';
  if (/Password should be/i.test(m)) return '비밀번호는 6자 이상이어야 합니다';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '인터넷 연결을 확인하세요';
  return m;
};

export async function signIn(email, password) {
  const c = await getClient();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(msg(error));
  return data.user;
}

// 반환: true = 바로 로그인됨, false = 확인 메일을 눌러야 함
export async function signUp(email, password) {
  const c = await getClient();
  const { data, error } = await c.auth.signUp({ email, password, options: { emailRedirectTo: SITE_URL } });
  if (error) throw new Error(msg(error));
  return !!data.session;
}

export async function signOut() {
  const c = await getClient();
  await c.auth.signOut();
}

// 받기 → 합치기 → 올리기. getDb()로 매번 최신 db를 받음 (동기화 중 가져오기·초기화 대비)
export async function syncNow(getDb, save) {
  const c = await getClient();
  const { data: s } = await c.auth.getSession();
  if (!s.session) throw new Error('로그인이 필요합니다');

  // 1) 받기: 지난번 이후 서버에 바뀐 기록. 동시에 올린 기록을 놓치지 않게 1분 겹쳐서 받음
  const db0 = getDb();
  const since = db0.sync.cursor ? new Date(Date.parse(db0.sync.cursor) - 60000).toISOString() : null;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = c.from('records').select('kind,id,data,updated_at,server_at').order('server_at').range(from, from + PAGE - 1);
    if (since) q = q.gt('server_at', since);
    const { data, error } = await q;
    if (error) throw new Error(msg(error));
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  const db = getDb();
  if (db !== db0) return { pulled: 0, pushed: 0, aborted: true };
  const pulled = applyRemote(db, rows);
  for (const r of rows) if (!db.sync.cursor || r.server_at > db.sync.cursor) db.sync.cursor = r.server_at;
  save();

  // 2) 올리기: 이 기기에서 바꾼 기록
  const out = dirtyRows(db);
  for (let i = 0; i < out.length; i += 500) {
    const chunk = out.slice(i, i + 500).map((r) => ({ kind: r.kind, id: r.id, data: r.data, updated_at: r.updated_at }));
    const { error } = await c.from('records').upsert(chunk, { onConflict: 'user_id,kind,id' });
    if (error) throw new Error(msg(error));
  }
  if (getDb() === db) {
    clearPushed(db, out);
    db.sync.lastSyncAt = Date.now();
    save();
  }
  return { pulled, pushed: out.length };
}

// ---------- 폰 푸시 알림 ----------
export async function savePush(sub) {
  const c = await getClient();
  const { error } = await c.from('push_subscriptions').upsert(sub, { onConflict: 'endpoint' });
  if (error) throw new Error(msg(error));
}

export async function deletePush(endpoint) {
  const c = await getClient();
  const { error } = await c.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) throw new Error(msg(error));
}

// 서버에서 이 계정의 기기들로 테스트 알림 한 번 보내기
export async function testPush() {
  const c = await getClient();
  const { data, error } = await c.functions.invoke('push-reminders', { body: { test: true } });
  if (error) throw new Error(msg(error));
  return data;
}
