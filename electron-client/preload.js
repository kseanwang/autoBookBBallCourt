const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startBooking: (config) => ipcRenderer.invoke('start-booking', config),
  stopBooking: () => ipcRenderer.invoke('stop-booking'),
  onLog: (cb) => ipcRenderer.on('booking-log', (_, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('booking-status', (_, data) => cb(data)),
  removeListeners: () => {
    ipcRenderer.removeAllListeners('booking-log');
    ipcRenderer.removeAllListeners('booking-status');
  },
});
