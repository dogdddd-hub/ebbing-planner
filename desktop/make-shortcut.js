// 바탕화면과 시작 메뉴에 '복습 플래너' 바로가기를 만들어요.
// 앱과 같은 AppUserModelID를 넣어서, 작업 표시줄에 고정하면 실행 중인 창과 한 아이콘으로 묶여요.
// 실행: npm run shortcut  (또는 node_modules\electron\dist\electron.exe make-shortcut.js)
const { app, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ICO = path.join(__dirname, 'assets', 'icon.ico');

// PNG 한 장을 담은 .ico 파일 만들기 (윈도우 바로가기 아이콘용)
function writeIco() {
  const png = nativeImage.createFromPath(path.join(__dirname, '..', 'icons', 'icon-512.png'))
    .resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICONDIR: 아이콘 1개
  head.writeUInt8(0, 6); head.writeUInt8(0, 7);                                  // 0 = 256px
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  fs.mkdirSync(path.dirname(ICO), { recursive: true });
  fs.writeFileSync(ICO, Buffer.concat([head, png]));
}

app.whenReady().then(() => {
  writeIco();
  const opts = {
    target: process.execPath,
    args: `"${__dirname}"`,
    cwd: __dirname,
    icon: ICO,
    iconIndex: 0,
    description: '복습 플래너',
    appUserModelId: 'app.ebbing-planner',
  };
  const places = [
    path.join(app.getPath('desktop'), '복습 플래너.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', '복습 플래너.lnk'),
  ];
  for (const p of places) console.log(shell.writeShortcutLink(p, 'create', opts) ? '만듦' : '실패', p);
  app.exit(0);
});
