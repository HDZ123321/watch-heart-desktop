const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onState: (handler) => {
    ipcRenderer.on('overlay-state', (_event, state) => handler(state));
  },
  onSettings: (handler) => {
    ipcRenderer.on('overlay-settings', (_event, settings) => handler(settings));
  },
  resizeStep: (step) => {
    ipcRenderer.send('overlay-resize-step', step);
  },
  setPassthrough: (enabled) => {
    ipcRenderer.send('overlay-passthrough', enabled);
  },
  setControlsInteractive: (interactive) => {
    ipcRenderer.send('overlay-interactive-region', interactive);
  },
  close: () => {
    ipcRenderer.send('overlay-close');
  }
});
