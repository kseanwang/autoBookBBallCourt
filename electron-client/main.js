const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const BookingSession = require('./booker');

let mainWindow = null;
let currentSession = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 700,
    minWidth: 720,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (currentSession) currentSession.stop();
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: 開始搶位 ──
ipcMain.handle('start-booking', (event, config) => {
  if (currentSession && currentSession.running) {
    return { success: false, error: '已有進行中的任務' };
  }

  const session = new BookingSession(
    (msg) => { if (mainWindow) mainWindow.webContents.send('booking-log', msg); },
    (data) => { if (mainWindow) mainWindow.webContents.send('booking-status', data); }
  );

  currentSession = session;

  session.start(config).catch((err) => {
    if (mainWindow) {
      mainWindow.webContents.send('booking-log', `❌ 未預期錯誤: ${err.message}`);
      mainWindow.webContents.send('booking-status', { type: 'error', message: err.message });
    }
  });

  return { success: true };
});

// ── IPC: 停止搶位 ──
ipcMain.handle('stop-booking', () => {
  if (currentSession) {
    currentSession.stop();
    currentSession = null;
  }
  return { success: true };
});
