// Supabase 연결 정보
// 이 두 값은 브라우저에 공개되는 것을 전제로 만든 값입니다 (publishable/anon 키).
// 데이터는 서버의 RLS 규칙("로그인한 본인 기록만")으로 보호됩니다. secret/service_role 키는 절대 넣지 마세요.
export const SUPABASE_URL = 'https://kaguxhczmxkavcvgsfge.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_5QS2pI5wCsy3nSWmnc1z3g_Aw8s40AQ';
// 가입 확인 메일의 링크가 돌아올 주소
export const SITE_URL = 'https://dogdddd-hub.github.io/ebbing-planner/';
// 웹 푸시 공개 키 (VAPID public). 짝이 되는 비밀 키는 Supabase 함수 비밀값에만 있음
export const VAPID_PUBLIC_KEY = 'BD2JXP4ISAC1STJAZJAyALXY0vYZ_OGu_-VjChVFgaOEHjZY-YJdc2ehT9eTXGSnBByADcgdd9rAypoHs4cMKgI';
