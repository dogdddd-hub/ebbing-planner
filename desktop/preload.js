// 웹앱(app.js)에서 window.desktop 으로 쓰는 최소한의 통로
const { contextBridge, ipcRenderer } = require('electron');

// ---------- 백업 파일 (%APPDATA%\ebbing-planner-desktop\backup.json) ----------
// PC를 켤 때 앱 저장소(localStorage)가 가끔 빈 채로 뜨는 일이 있어서,
// 데이터·화면 설정·로그인을 파일로도 남겨 두고, 비어 있으면 웹앱이 읽기 전에 되살려요.
const DATA_KEY = 'ebbing-planner-v1';
const KEYS = [DATA_KEY, 'ebbing-planner-ui', 'ebbing-planner-auth'];

try {
  if (localStorage.getItem(DATA_KEY) == null) {
    const b = ipcRenderer.sendSync('planner:backup-read');
    if (b && typeof b[DATA_KEY] === 'string') {
      for (const k of KEYS) if (typeof b[k] === 'string' && localStorage.getItem(k) == null) localStorage.setItem(k, b[k]);
      console.info('저장소가 비어 있어 백업 파일에서 되살렸어요');
    }
  }
} catch (e) { console.warn('백업 복구 실패', e); }

function snapshot() {
  try {
    const o = {};
    for (const k of KEYS) { const v = localStorage.getItem(k); if (v != null) o[k] = v; }
    if (o[DATA_KEY]) ipcRenderer.send('planner:backup-write', o); // 데이터가 없으면 백업을 덮지 않아요
  } catch {}
}
let snapTimer = null;
const snapSoon = () => { clearTimeout(snapTimer); snapTimer = setTimeout(snapshot, 2000); };
setInterval(snapshot, 30000); // 동기화·로그인 갱신처럼 저장 신호 없이 바뀌는 것도 잡아요
window.addEventListener('beforeunload', snapshot);

contextBridge.exposeInMainWorld('desktop', {
  // 오늘 상태 알리기: { date: 'YYYY-MM-DD', due: 남은 복습 수, notify: { morning, evening }, detail: '행정법 3, 국어 2' }
  report: (r) => ipcRenderer.send('planner:report', {
    date: String(r.date), due: Number(r.due) || 0, detail: String(r.detail || '').slice(0, 120),
    notify: { morning: String(r.notify?.morning || ''), evening: String(r.notify?.evening || '') },
  }),
  // 1분마다 오는 신호 (하루가 바뀌었는지 확인용)
  onTick: (cb) => ipcRenderer.on('planner:tick', () => cb()),
  // 저장할 때마다 (2초 모아서) 백업 파일도 고쳐 쓰기
  backup: () => snapSoon(),
  // "데이터 전체 초기화" 때 백업도 지워서 되살아나지 않게
  clearBackup: () => { clearTimeout(snapTimer); ipcRenderer.send('planner:backup-clear'); },
});
