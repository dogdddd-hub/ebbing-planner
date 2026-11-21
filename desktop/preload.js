// 웹앱(app.js)에서 window.desktop 으로 쓰는 최소한의 통로
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // 오늘 상태 알리기: { date: 'YYYY-MM-DD', due: 남은 복습 수 }
  report: (r) => ipcRenderer.send('planner:report', { date: String(r.date), due: Number(r.due) || 0 }),
  // 1분마다 오는 신호 (하루가 바뀌었는지 확인용)
  onTick: (cb) => ipcRenderer.on('planner:tick', () => cb()),
});
