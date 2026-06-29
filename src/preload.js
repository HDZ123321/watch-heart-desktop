const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  onBluetoothDevices: (handler) => {
    ipcRenderer.on('bluetooth-devices', (_event, devices) => handler(devices));
  },
  selectBluetoothDevice: (deviceId) => {
    ipcRenderer.send('bluetooth-select', deviceId);
  },
  cancelBluetoothSelection: () => {
    ipcRenderer.send('bluetooth-cancel');
  },
  setAlwaysOnTop: (enabled) => {
    ipcRenderer.send('set-always-on-top', enabled);
  },
  setAutoStart: (enabled) => {
    ipcRenderer.send('set-auto-start', enabled);
  },
  onAppSettings: (handler) => {
    ipcRenderer.on('app-settings', (_event, settings) => handler(settings));
  },
  checkForUpdates: () => {
    ipcRenderer.send('check-for-updates');
  },
  installUpdate: () => {
    ipcRenderer.send('install-update');
  },
  onUpdateStatus: (handler) => {
    ipcRenderer.on('update-status', (_event, status) => handler(status));
  },
  onTrayHeartRateReconnect: (handler) => {
    ipcRenderer.on('tray-heart-rate-reconnect', () => handler());
  },
  setOverlayVisible: (visible) => {
    ipcRenderer.send('overlay-toggle', visible);
  },
  setOverlayScale: (scale) => {
    ipcRenderer.send('overlay-scale', scale);
  },
  setOverlayWidth: (width) => {
    ipcRenderer.send('overlay-width', width);
  },
  setOverlayTheme: (theme) => {
    ipcRenderer.send('overlay-theme', theme);
  },
  setOverlayPassthrough: (enabled) => {
    ipcRenderer.send('overlay-passthrough', enabled);
  },
  updateHeartRate: (state) => {
    ipcRenderer.send('heart-rate-update', state);
  },
  updateWeather: (weather) => {
    ipcRenderer.send('weather-update', weather);
  },
  onOverlaySettings: (handler) => {
    ipcRenderer.on('overlay-settings', (_event, settings) => handler(settings));
  },
  locateAddress: (coordinates) => {
    return ipcRenderer.invoke('reverse-geocode', coordinates);
  },
  onMediaState: (handler) => {
    ipcRenderer.on('media-state', (_event, media) => handler(media));
  },
  searchLyrics: (query) => {
    return ipcRenderer.invoke('lyrics-search', query);
  },
  useAutomaticLyrics: () => {
    ipcRenderer.send('lyrics-auto-mode');
  },
  setGameMode: (enabled) => {
    ipcRenderer.send('game-mode', enabled);
  },
  setSodaDirectEnabled: (enabled) => {
    ipcRenderer.send('soda-direct-toggle', enabled);
  },
  setLyricsMode: (mode) => {
    ipcRenderer.send('lyrics-mode', mode);
  },
  reconnectSodaDirect: () => {
    ipcRenderer.send('soda-direct-reconnect');
  },
  setSodaAutoHide: (enabled) => {
    ipcRenderer.send('soda-auto-hide', enabled);
  },
  onSodaDirectStatus: (handler) => {
    ipcRenderer.on('soda-direct-status', (_event, status) => handler(status));
  }
});
