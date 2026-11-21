// 복습 플래너 PC 앱 (Electron)
// 상위 폴더의 웹앱(index.html, app.js …)을 그대로 띄우고, PC 전용 기능만 여기서 더해요.
//   - 창을 닫으면 트레이로 숨김, 트레이 아이콘에 오늘 남은 복습 수
//   - PC 켤 때 자동 실행 (시작프로그램 폴더 바로가기)
//   - 새 하루가 시작됐을 때 창이 숨겨져 있으면 "오늘 복습 N개" 알림
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, protocol, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const WEB = path.resolve(__dirname, '..');           // 웹앱 파일이 있는 곳
const ICON = path.join(WEB, 'icons', 'icon-512.png');
const ICO = path.join(__dirname, 'assets', 'icon.ico'); // make-shortcut.js가 만들어요
const AUMID = 'app.ebbing-planner';
const BG = '#141414';

// 뜻밖의 오류는 기록만 남기고 계속 돌아가요 (%APPDATA%\ebbing-planner-desktop\error.log)
function logError(e) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), `[${new Date().toLocaleString()}] ${e?.stack || e}\n`); } catch {}
}
process.on('uncaughtException', logError);
process.on('unhandledRejection', logError);

// ---------- PC 앱 설정 (복습 데이터는 웹앱이 localStorage에 따로 저장) ----------
const confPath = () => path.join(app.getPath('userData'), 'desktop.json');
let conf = { autoStart: true, notified: null };
function loadConf() { try { conf = { ...conf, ...JSON.parse(fs.readFileSync(confPath(), 'utf8')) }; } catch {} }
function saveConf() { try { fs.writeFileSync(confPath(), JSON.stringify(conf, null, 2)); } catch (e) { logError(e); } }

// ---------- app:// 로 웹앱 파일 제공 ----------
// file:// 에서는 ES 모듈이 막혀서, 안전한 자체 주소(app://planner/)로 띄워요.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function serve(req) {
  let p = decodeURIComponent(new URL(req.url).pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.resolve(WEB, '.' + p);
  if (!file.startsWith(WEB + path.sep)) return new Response('forbidden', { status: 403 });
  try {
    return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

// ---------- 창 / 트레이 ----------
let win = null, tray = null;
let report = { date: null, due: 0 };

function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 800, minWidth: 360, minHeight: 520, show: false,
    title: '복습 플래너',
    titleBarStyle: 'hidden', titleBarOverlay: { color: BG, symbolColor: '#ececec', height: 57 },
    backgroundColor: BG,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenu(null);
  win.loadURL('app://planner/index.html');
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  // 앱 밖으로 나가는 이동은 막아요
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}
function showMain() { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function updateTray() {
  if (!tray) return;
  const tip = report.due ? `복습 플래너 · 오늘 남은 복습 ${report.due}개` : '복습 플래너 · 오늘 복습을 모두 끝냈어요';
  tray.setToolTip(tip);
  win?.setTitle(report.due ? `복습 ${report.due}` : '복습 플래너');
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: showMain },
    { type: 'separator' },
    { label: 'PC 켤 때 자동 실행', type: 'checkbox', checked: conf.autoStart, click: (m) => { conf.autoStart = m.checked; saveConf(); applyAutoStart(); } },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' }));
  buildTrayMenu();
  tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : showMain()));
  updateTray();
}

// ---------- 자동 실행: 윈도우 '시작프로그램' 폴더에 바로가기 ----------
const startupLink = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '복습 플래너.lnk');
function applyAutoStart() {
  const link = startupLink();
  if (conf.autoStart) {
    shell.writeShortcutLink(link, 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: app.getAppPath(),
      icon: fs.existsSync(ICO) ? ICO : process.execPath, iconIndex: 0,
      description: '복습 플래너',
      appUserModelId: AUMID,
    });
  } else {
    try { fs.unlinkSync(link); } catch {}
  }
}

// ---------- 웹앱이 알려주는 오늘 상태 → 트레이·알림 ----------
ipcMain.on('planner:report', (e, r) => {
  if (!r || typeof r.date !== 'string') return;
  report = { date: r.date, due: Number(r.due) || 0 };
  updateTray();
  if (conf.notified === report.date) return;
  conf.notified = report.date;
  saveConf();
  // 창을 보고 있을 때는 알림을 띄우지 않아요
  if (report.due > 0 && !(win.isVisible() && win.isFocused()) && Notification.isSupported()) {
    const n = new Notification({ title: '오늘 복습', body: `복습할 항목이 ${report.due}개 있어요.`, icon: ICON });
    n.on('click', showMain);
    n.show();
  }
});

// ---------- 시작 ----------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(() => {
    app.setAppUserModelId(AUMID);
    protocol.handle('app', serve);
    loadConf();
    createWindow();
    createTray();
    applyAutoStart(); // 켤 때마다 바로가기를 지금 앱 위치에 맞춰 둬요
    // 1분마다 웹앱에 알려서, 하루가 바뀌면 화면을 다시 그리게 해요
    setInterval(() => win?.webContents.send('planner:tick'), 60000);
  });
  app.on('window-all-closed', (e) => e.preventDefault?.());
}
