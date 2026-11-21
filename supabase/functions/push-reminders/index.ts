// 복습 알림 푸시 (Supabase Edge Function)
// - 5분마다 pg_cron이 x-cron-secret 헤더로 부름 → 아침·밤 정한 시각이 지났고 오늘 안 보낸 사용자에게 푸시
// - 앱의 "테스트 알림" 버튼은 로그인 토큰으로 부름 → 그 사용자 기기로 바로 한 번 보냄
// scheduler.js는 배포 때 상위 폴더에서 복사해 옴 (desktop처럼 같은 계산 코드를 씀)
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import { DEFAULT_SETTINGS, computeAll, todayQueue, addDays, subjectSummary } from './scheduler.js';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') || 'https://dogdddd-hub.github.io/ebbing-planner/',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);
const APP_URL = 'https://dogdddd-hub.github.io/ebbing-planner/';
const WINDOW_MIN = 180; // 정한 시각에서 3시간이 지나면 그날은 안 보냄

const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
const pad = (n: number) => String(n).padStart(2, '0');
const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const validHM = (v: unknown) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : '');

// 사용자 시간대의 지금 시각(분)과 플래너 날짜(하루 시작 시각 반영)
function clock(tz: string, dayStartHour: number) {
  let p: Record<string, string>;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  } catch { return clock('Asia/Seoul', dayStartHour); }
  const h = Number(p.hour) % 24, min = Number(p.minute);
  const calDate = `${p.year}-${p.month}-${p.day}`;
  const day = h < dayStartHour ? addDays(calDate, -1) : calDate;
  return { minutes: h * 60 + min, day, hm: `${pad(h)}:${pad(min)}` };
}

async function allRecords(userId: string) {
  const rows: { kind: string; data: any }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('records').select('kind,data').eq('user_id', userId).in('kind', ['item', 'log']).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function settingsOf(userId: string) {
  const { data } = await db.from('records').select('data').eq('user_id', userId).eq('kind', 'settings').eq('id', 'main').maybeSingle();
  return { ...DEFAULT_SETTINGS, ...(data?.data || {}) };
}

async function dueCount(userId: string, settings: any, day: string) {
  const rows = await allRecords(userId);
  const items = rows.filter((r) => r.kind === 'item').map((r) => r.data);
  const logs = rows.filter((r) => r.kind === 'log').map((r) => r.data);
  const q = todayQueue(items, computeAll(items, logs, settings), day, settings);
  const all = [...q.now, ...q.overflow];
  return { n: all.length, detail: subjectSummary(all) };
}

async function sendTo(subs: any[], payload: object) {
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
      ok++;
    } catch (e: any) {
      // 기기에서 알림을 끄거나 앱을 지운 경우 → 목록에서 뺌
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      else console.error('push failed', e?.statusCode, e?.body || e?.message);
    }
  }
  return ok;
}

// 예약 실행: 모든 사용자 확인
async function runScheduled() {
  const { data: subs, error } = await db.from('push_subscriptions').select('*');
  if (error) throw error;
  const byUser = new Map<string, any[]>();
  for (const s of subs) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s]);
  const report: any[] = [];
  for (const [userId, list] of byUser) {
    const settings = await settingsOf(userId);
    const notify = settings.notify || {};
    const c = clock(list[0].tz || 'Asia/Seoul', Number(settings.dayStartHour) || 0);
    const m = validHM(notify.morning), e = validHM(notify.evening);
    const slots: { key: string; at: string }[] = [];
    if (m) slots.push({ key: 'm', at: m });
    if (e) slots.push({ key: 'e', at: e });
    for (const slot of slots) {
      const since = c.minutes - toMin(slot.at);
      if (since < 0 || since >= WINDOW_MIN) continue;
      if (slot.key === 'm' && e && toMin(e) > toMin(m) && c.minutes >= toMin(e)) continue; // 밤 시각이 지났으면 아침 알림은 생략
      // 먼저 기록 → 같은 시각에 두 번 실행돼도 한 번만 보냄
      const { error: insErr } = await db.from('push_sent').insert({ user_id: userId, day: c.day, slot: slot.key });
      if (insErr) continue; // 이미 보냄 (기본 키 충돌)
      const { n, detail } = await dueCount(userId, settings, c.day);
      if (n <= 0) { report.push({ userId, slot: slot.key, skipped: 'none due' }); continue; }
      const head = slot.key === 'm' ? `오늘 복습할 항목이 ${n}개 있어요.` : `아직 남은 복습이 ${n}개 있어요.`;
      const body = detail ? `${head}\n${detail}` : head;
      const sent = await sendTo(list, { title: '복습 플래너', body, url: APP_URL, tag: `review-${slot.key}`, count: n });
      report.push({ userId, slot: slot.key, due: n, sent });
    }
  }
  // 오래된 발송 기록 정리 (30일)
  await db.from('push_sent').delete().lt('sent_at', new Date(Date.now() - 30 * 864e5).toISOString());
  return report;
}

// 테스트: 로그인한 사용자 기기로 바로 보냄
async function runTest(token: string) {
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const userId = data.user.id;
  const { data: subs } = await db.from('push_subscriptions').select('*').eq('user_id', userId);
  if (!subs?.length) return Response.json({ sent: 0, devices: 0 });
  const settings = await settingsOf(userId);
  const c = clock(subs[0].tz || 'Asia/Seoul', Number(settings.dayStartHour) || 0);
  const { n, detail } = await dueCount(userId, settings, c.day);
  const sent = await sendTo(subs, { title: '복습 플래너 (테스트)', body: `알림이 잘 와요. 지금 남은 복습 ${n}개${detail ? `\n${detail}` : ''}`, url: APP_URL, tag: 'review-test', count: n });
  return Response.json({ sent, devices: subs.length });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET) {
      return Response.json({ ok: true, report: await runScheduled() });
    }
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const res = token ? await runTest(token) : new Response('forbidden', { status: 403 });
    Object.entries(CORS).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 500, headers: CORS });
  }
});
