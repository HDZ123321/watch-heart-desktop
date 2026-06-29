const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

if (app.isPackaged) {
  process.env.WINDOWS_MEDIA_SESSIONS_BACKEND = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'windows-media-sessions',
    'bin',
    'win-x64',
    'windows-media-sessions-backend.exe'
  );
}

const {
  searchSyncedLyrics,
  setOnlineLyricsEnabled,
  startMediaMonitor,
  stopMediaMonitor
} = require('./media-service');
const { SodaLyricsDirectService } = require('./soda-lyrics-service');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  if (app.isReady()) showMainWindow();
});

let mainWindow;
let overlayWindow;
let tray;
let bluetoothSelectionCallback;
let discoveredDevices = new Map();
let isQuitting = false;
let overlayScale = 1;
let overlayWidth = 580;
let overlayPassthrough = false;
let overlayPosition;
let settingsSaveTimer;
let unlockShortcuts = [];
let overlayTheme = createDefaultOverlayTheme();
let gameMode = false;
let lyricsMode = 'auto';
let automaticMediaState = null;
let manualLyricsOverride = null;
let sodaLyricsDirect;
let initialLaunchHidden = process.argv.includes('--hidden');
let updaterReady = false;
const OVERLAY_MIN_SCALE = 0.5;
const OVERLAY_MAX_SCALE = 2;
const OVERLAY_MIN_WIDTH = 360;
const OVERLAY_MAX_WIDTH = 1000;
const OVERLAY_BASE_HEIGHT = 96;
const OVERLAY_THEMES = new Set([
  'pulse',
  'neon',
  'ice',
  'amber',
  'minimal',
  'custom'
]);
const LYRICS_MODES = new Set(['auto', 'soda', 'online']);
let overlayState = {
  bpm: null,
  zone: '等待心率',
  connected: false,
  weather: null,
  media: null,
  sodaLyric: null
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'overlay-settings.json');
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function sanitizeHexColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function createDefaultOverlayTheme() {
  return {
    preset: 'pulse',
    accent: '#ff315d',
    background: '#0a0c12',
    text: '#f7f8fb',
    lyric: '#e8eaf0',
    opacity: 88,
    blur: 16,
    radius: 18,
    fontScale: 100
  };
}

function normalizeOverlayTheme(theme) {
  const defaults = createDefaultOverlayTheme();
  const preset = OVERLAY_THEMES.has(theme?.preset) ? theme.preset : defaults.preset;
  return {
    preset,
    accent: sanitizeHexColor(theme?.accent, defaults.accent),
    background: sanitizeHexColor(theme?.background, defaults.background),
    text: sanitizeHexColor(theme?.text, defaults.text),
    lyric: sanitizeHexColor(theme?.lyric, defaults.lyric),
    opacity: clampNumber(theme?.opacity, 35, 100, defaults.opacity),
    blur: clampNumber(theme?.blur, 0, 28, defaults.blur),
    radius: clampNumber(theme?.radius, 8, 30, defaults.radius),
    fontScale: clampNumber(theme?.fontScale, 80, 130, defaults.fontScale)
  };
}

function loadOverlaySettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    overlayScale = Math.min(
      OVERLAY_MAX_SCALE,
      Math.max(OVERLAY_MIN_SCALE, Number(saved.scale) || 1)
    );
    overlayWidth = Math.min(
      OVERLAY_MAX_WIDTH,
      Math.max(OVERLAY_MIN_WIDTH, Number(saved.width) || 580)
    );
    if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
      const visible = screen.getAllDisplays().some(({ workArea }) => (
        saved.x >= workArea.x - 80 &&
        saved.x < workArea.x + workArea.width &&
        saved.y >= workArea.y - 40 &&
        saved.y < workArea.y + workArea.height
      ));
      if (visible) overlayPosition = { x: saved.x, y: saved.y };
    }
    overlayTheme = normalizeOverlayTheme(saved.theme);
    if (LYRICS_MODES.has(saved.lyricsMode)) lyricsMode = saved.lyricsMode;
  } catch {
    // First launch or invalid settings: use safe defaults.
  }
}

function saveOverlaySettings() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    const bounds = overlayWindow?.getBounds();
    const data = {
      scale: overlayScale,
      width: overlayWidth,
      x: bounds?.x,
      y: bounds?.y,
      theme: overlayTheme,
      lyricsMode
    };
    fs.writeFile(settingsPath(), JSON.stringify(data), () => {});
  }, 250);
}

function isMainSender(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents);
}

function isOverlaySender(event) {
  return Boolean(overlayWindow && event.sender === overlayWindow.webContents);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isAutoStartEnabled() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings({
    path: process.execPath,
    args: ['--hidden']
  }).openAtLogin;
}

function sendAppSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app-settings', {
    autoStart: isAutoStartEnabled(),
    trayAvailable: Boolean(tray)
  });
}

function sendUpdateStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update-status', {
    state: String(status?.state || 'idle'),
    message: String(status?.message || '').slice(0, 160),
    version: status?.version ? String(status.version).slice(0, 40) : '',
    percent: Number.isFinite(Number(status?.percent))
      ? Math.round(Number(status.percent))
      : null
  });
}

function readableUpdateError(error) {
  const message = String(error?.message || error || '');
  if (/latest\.ya?ml|404|Cannot find/i.test(message)) {
    return '暂未发布可自动更新的安装包，请先在 GitHub Release 上传 latest.yml 和 Setup.exe';
  }
  if (/net::|ENOTFOUND|ECONN|timeout|TLS|SSL/i.test(message)) {
    return '网络连接失败，稍后再检查更新';
  }
  return `更新检查失败：${message.slice(0, 90)}`;
}

function looksMojibake(text) {
  return /�|锟|�/.test(text) || (text.match(/�/g) || []).length >= 2;
}

async function readChinaResponseText(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim().toLowerCase();
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (charset && /gbk|gb2312|gb18030/i.test(charset)) {
    return new TextDecoder('gb18030').decode(buffer);
  }
  return looksMojibake(utf8)
    ? new TextDecoder('gb18030').decode(buffer)
    : utf8;
}

function weatherIconFor(label) {
  if (/雷/.test(label)) return 'ϟ';
  if (/雪|冰/.test(label)) return '❄';
  if (/雨/.test(label)) return '🌧';
  if (/云/.test(label)) return '◒';
  if (/阴/.test(label)) return '☁';
  if (/晴/.test(label)) return '☀';
  return '◌';
}

function parseTemperatureRange(value) {
  const numbers = String(value || '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (!numbers.length) return { temperature: 0, text: '--°' };
  const average = numbers.reduce((sum, item) => sum + item, 0) / numbers.length;
  return {
    temperature: average,
    text: numbers.length >= 2 ? `${numbers[0]}~${numbers[1]}°` : `${numbers[0]}°`
  };
}

async function fetchChinaWeather(city) {
  const safeCity = String(city || '').trim().replace(/市$/, '').slice(0, 40);
  if (!safeCity) throw new Error('请输入城市名');
  const url = new URL('https://v.api.aa1.cn/api/api-tianqi-3/index.php');
  url.search = new URLSearchParams({ msg: safeCity, type: '1' });
  const response = await fetch(url, {
    headers: { Accept: 'application/json,text/plain,*/*' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('国内天气接口暂时不可用');
  const result = JSON.parse(await readChinaResponseText(response));
  const today = Array.isArray(result?.data) ? result.data[0] : null;
  if (!today) throw new Error('未找到该城市天气');
  const label = String(today.tianqi || '天气未知').slice(0, 40);
  const { temperature, text } = parseTemperatureRange(today.wendu);
  const windSpeed = Number(String(today.fengdu || '').match(/\d+/)?.[0] || 0);
  return {
    city: safeCity,
    region: '中国大陆天气源',
    temperature,
    temperatureText: text,
    apparentTemperature: temperature,
    windSpeed,
    windText: String(today.fengdu || '').slice(0, 40),
    label,
    icon: weatherIconFor(label),
    airQuality: String(today.pm || '').slice(0, 20)
  };
}

async function locateChinaCityByIp() {
  const response = await fetch('https://whois.pconline.com.cn/ipJson.jsp?json=true', {
    headers: { Accept: 'application/json,text/plain,*/*' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('IP 定位失败');
  const text = await readChinaResponseText(response);
  const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const data = JSON.parse(jsonText);
  const city = String(data.city || data.pro || '').replace(/市$/, '').trim();
  if (!city) throw new Error('未能识别当前位置城市');
  return {
    city,
    region: String(data.pro || '').trim(),
    displayName: String(data.addr || '').trim()
  };
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking', message: '正在检查更新…' });
  });
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({
      state: 'available',
      message: `发现新版本 ${info.version}，正在下载…`,
      version: info.version
    });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ state: 'none', message: '当前已是最新版本' });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      state: 'downloading',
      message: `正在下载更新 ${Math.round(progress.percent || 0)}%`,
      percent: progress.percent
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({
      state: 'downloaded',
      message: `新版本 ${info.version} 已下载，点击安装并重启`,
      version: info.version
    });
  });
  autoUpdater.on('error', (error) => {
    sendUpdateStatus({
      state: 'error',
      message: readableUpdateError(error)
    });
  });
  updaterReady = true;
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    sendUpdateStatus({
      state: 'dev',
      message: '开发模式不检查更新，打包安装版后生效'
    });
    return;
  }
  if (!updaterReady) setupAutoUpdater();
  if (manual) sendUpdateStatus({ state: 'checking', message: '正在检查更新…' });
  autoUpdater.checkForUpdates().catch((error) => {
    sendUpdateStatus({
      state: 'error',
      message: readableUpdateError(error)
    });
  });
}

function setAutoStart(enabled) {
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: ['--hidden']
    });
  }
  sendAppSettings();
  rebuildTrayMenu();
}

function requestHeartRateReconnect() {
  showMainWindow();
  mainWindow.webContents.send('tray-heart-rate-reconnect');
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开 Watch Heart',
      click: showMainWindow
    },
    {
      label: overlayWindow?.isVisible() ? '隐藏游戏悬浮条' : '显示游戏悬浮条',
      click: () => setOverlayVisible(!overlayWindow?.isVisible())
    },
    {
      label: '重连心率',
      click: requestHeartRateReconnect
    },
    { type: 'separator' },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: isAutoStartEnabled(),
      click: (item) => setAutoStart(item.checked)
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

async function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  let icon;
  try {
    icon = await app.getFileIcon(process.execPath, { size: 'small' });
  } catch {
    icon = nativeImage.createFromPath(process.execPath);
  }
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Watch Heart');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  rebuildTrayMenu();
  return tray;
}

function sendDeviceList() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    'bluetooth-devices',
    [...discoveredDevices.values()].map(({ deviceId, deviceName }) => ({
      id: deviceId,
      name: deviceName || '未命名心率设备'
    }))
  );
}

function finishBluetoothSelection(deviceId = '') {
  if (!bluetoothSelectionCallback) return;
  const callback = bluetoothSelectionCallback;
  bluetoothSelectionCallback = undefined;
  const selectedId = discoveredDevices.has(deviceId) ? deviceId : '';
  discoveredDevices.clear();
  callback(selectedId);
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

function sendOverlayState() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('overlay-state', overlayState);
}

function publishMediaState(media) {
  const sameTrack =
    media &&
    automaticMediaState &&
    media.id === automaticMediaState.id &&
    media.title === automaticMediaState.title &&
    media.artist === automaticMediaState.artist;
  automaticMediaState = media
    ? {
        ...(sameTrack ? automaticMediaState : {}),
        ...media,
        lyrics:
          media.lyrics === undefined && sameTrack
            ? automaticMediaState.lyrics
            : media.lyrics
      }
    : null;
  const effective =
    automaticMediaState && manualLyricsOverride
      ? {
          ...automaticMediaState,
          title: manualLyricsOverride.title,
          artist: manualLyricsOverride.artist,
          lyrics: manualLyricsOverride.lyrics,
          lyricsStatus: 'found',
          manualLyrics: true
        }
      : automaticMediaState;
  overlayState.media = effective;
  sendOverlayState();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.webContents.send('media-state', effective);
  }
}

function sendOverlaySettings() {
  const settings = {
    visible: Boolean(overlayWindow?.isVisible()),
    passthrough: overlayPassthrough,
    scale: overlayScale,
    width: overlayWidth,
    unlockShortcuts,
    gameMode,
    lyricsMode,
    lyricsDirectEnabled: lyricsMode !== 'online',
    theme: overlayTheme
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-settings', settings);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-settings', settings);
  }
  rebuildTrayMenu();
}

function publishSodaLyric(lyric) {
  overlayState.sodaLyric = lyric;
  sendOverlayState();
}

function publishSodaDirectStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    'soda-direct-status',
    String(status || '').slice(0, 100)
  );
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  overlayWindow = new BrowserWindow({
    width: Math.round(overlayWidth * overlayScale),
    height: Math.round(OVERLAY_BASE_HEIGHT * overlayScale),
    minWidth: Math.round(OVERLAY_MIN_WIDTH * OVERLAY_MIN_SCALE),
    minHeight: Math.round(OVERLAY_BASE_HEIGHT * OVERLAY_MIN_SCALE),
    maxWidth: Math.round(OVERLAY_MAX_WIDTH * OVERLAY_MAX_SCALE),
    maxHeight: Math.round(OVERLAY_BASE_HEIGHT * OVERLAY_MAX_SCALE),
    ...(overlayPosition || {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      backgroundThrottling: false
    }
  });

  hardenWindow(overlayWindow);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.setZoomFactor(overlayScale);
    sendOverlayState();
    sendOverlaySettings();
  });
  overlayWindow.on('move', saveOverlaySettings);
  overlayWindow.on('closed', () => {
    overlayWindow = undefined;
    overlayPassthrough = false;
    sendOverlaySettings();
    if (!mainWindow || mainWindow.isDestroyed()) app.quit();
  });
  return overlayWindow;
}

function setOverlayVisible(visible) {
  const window = createOverlayWindow();
  if (visible) {
    window.showInactive();
  } else {
    setOverlayPassthrough(false);
    window.hide();
  }
  sendOverlaySettings();
}

function setOverlayPassthrough(enabled) {
  overlayPassthrough = Boolean(enabled);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(overlayPassthrough, { forward: true });
  }
  sendOverlaySettings();
}

function setOverlayControlsInteractive(interactive) {
  if (!overlayPassthrough || !overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}

function setGameMode(enabled) {
  gameMode = Boolean(enabled);
  sodaLyricsDirect?.setGameMode(gameMode);
  sendOverlaySettings();
}

function setOverlayScale(scale) {
  overlayScale = Math.min(
    OVERLAY_MAX_SCALE,
    Math.max(OVERLAY_MIN_SCALE, Number(scale) || 1)
  );
  const window = createOverlayWindow();
  window.webContents.setZoomFactor(overlayScale);
  resizeOverlayWindow(window);
  saveOverlaySettings();
  sendOverlaySettings();
}

function setOverlayWidth(width) {
  overlayWidth = Math.min(
    OVERLAY_MAX_WIDTH,
    Math.max(OVERLAY_MIN_WIDTH, Number(width) || 580)
  );
  const window = createOverlayWindow();
  resizeOverlayWindow(window);
  saveOverlaySettings();
  sendOverlaySettings();
}

function setOverlayTheme(theme) {
  overlayTheme = normalizeOverlayTheme({ ...overlayTheme, ...(theme || {}) });
  saveOverlaySettings();
  sendOverlaySettings();
}

function setLyricsMode(mode) {
  lyricsMode = LYRICS_MODES.has(mode) ? mode : 'auto';
  setOnlineLyricsEnabled(lyricsMode !== 'soda');
  sodaLyricsDirect?.setEnabled(lyricsMode !== 'online');
  if (lyricsMode === 'online') publishSodaLyric(null);
  saveOverlaySettings();
  sendOverlaySettings();
  publishSodaDirectStatus(
    lyricsMode === 'online'
      ? '当前仅使用在线歌词'
      : sodaLyricsDirect?.lastStatus || '未开启'
  );
}

function resizeOverlayWindow(window) {
  const current = window.getBounds();
  const width = Math.round(overlayWidth * overlayScale);
  const height = Math.round(OVERLAY_BASE_HEIGHT * overlayScale);
  const display = screen.getDisplayMatching(current);
  const area = display.workArea;
  const centeredX = current.x + Math.round((current.width - width) / 2);
  const centeredY = current.y + Math.round((current.height - height) / 2);
  const x = Math.min(
    area.x + area.width - width,
    Math.max(area.x, centeredX)
  );
  const y = Math.min(
    area.y + area.height - height,
    Math.max(area.y, centeredY)
  );
  window.setBounds({ x, y, width, height }, false);
}

function createWindow() {
  const showOnCreate = !initialLaunchHidden;
  initialLaunchHidden = false;
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#090b10',
    title: 'Watch Heart',
    show: showOnCreate,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false
    }
  });

  hardenWindow(mainWindow);
  mainWindow.webContents.on(
    'select-bluetooth-device',
    (event, deviceList, callback) => {
      event.preventDefault();
      bluetoothSelectionCallback = callback;
      for (const device of deviceList) {
        discoveredDevices.set(device.deviceId, device);
      }
      sendDeviceList();
    }
  );

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    finishBluetoothSelection();
    mainWindow = undefined;
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('media-state', overlayState.media);
    publishSodaDirectStatus(sodaLyricsDirect?.lastStatus || '未开启');
    sendOverlaySettings();
    sendAppSettings();
  });
  mainWindow.on('show', () => {
    mainWindow.webContents.send('media-state', overlayState.media);
    sendOverlaySettings();
  });
}

app.whenReady().then(async () => {
  loadOverlaySettings();

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(
        (
          webContents === mainWindow?.webContents &&
          ['bluetooth', 'geolocation'].includes(permission)
        )
      );
    }
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => (
      (
        webContents === mainWindow?.webContents &&
        ['bluetooth', 'geolocation'].includes(permission)
      )
    )
  );

  ipcMain.on('bluetooth-select', (event, deviceId) => {
    if (!isMainSender(event)) return;
    finishBluetoothSelection(deviceId);
  });

  ipcMain.on('bluetooth-cancel', (event) => {
    if (!isMainSender(event)) return;
    finishBluetoothSelection();
  });

  ipcMain.on('set-always-on-top', (event, enabled) => {
    if (!isMainSender(event)) return;
    mainWindow?.setAlwaysOnTop(Boolean(enabled));
  });

  ipcMain.on('set-auto-start', (event, enabled) => {
    if (!isMainSender(event)) return;
    setAutoStart(Boolean(enabled));
  });

  ipcMain.on('check-for-updates', (event) => {
    if (!isMainSender(event)) return;
    checkForUpdates(true);
  });

  ipcMain.on('install-update', (event) => {
    if (!isMainSender(event)) return;
    isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.on('overlay-toggle', (event, visible) => {
    if (!isMainSender(event)) return;
    setOverlayVisible(Boolean(visible));
  });

  ipcMain.on('overlay-scale', (event, scale) => {
    if (!isMainSender(event)) return;
    setOverlayScale(scale);
  });

  ipcMain.on('overlay-width', (event, width) => {
    if (!isMainSender(event)) return;
    setOverlayWidth(width);
  });

  ipcMain.on('overlay-theme', (event, theme) => {
    if (!isMainSender(event)) return;
    setOverlayTheme(theme);
  });

  ipcMain.on('overlay-resize-step', (event, step) => {
    if (!isOverlaySender(event)) return;
    setOverlayScale(overlayScale + (Number(step) > 0 ? 0.1 : -0.1));
  });

  ipcMain.on('overlay-passthrough', (event, enabled) => {
    if (!isMainSender(event) && !isOverlaySender(event)) return;
    setOverlayPassthrough(Boolean(enabled));
  });

  ipcMain.on('overlay-interactive-region', (event, interactive) => {
    if (!isOverlaySender(event)) return;
    setOverlayControlsInteractive(Boolean(interactive));
  });

  ipcMain.on('game-mode', (event, enabled) => {
    if (!isMainSender(event)) return;
    setGameMode(enabled);
  });

  ipcMain.on('soda-direct-toggle', (event, enabled) => {
    if (!isMainSender(event)) return;
    setLyricsMode(Boolean(enabled) ? 'auto' : 'online');
  });

  ipcMain.on('lyrics-mode', (event, mode) => {
    if (!isMainSender(event)) return;
    setLyricsMode(String(mode || 'auto'));
  });

  ipcMain.on('soda-direct-reconnect', (event) => {
    if (!isMainSender(event)) return;
    sodaLyricsDirect?.reconnect();
  });

  ipcMain.on('soda-auto-hide', (event, enabled) => {
    if (!isMainSender(event)) return;
    sodaLyricsDirect?.setAutoHideDesktopLyrics(Boolean(enabled));
  });

  ipcMain.on('overlay-close', (event) => {
    if (!isOverlaySender(event)) return;
    setOverlayVisible(false);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      app.quit();
    }
  });

  ipcMain.on('heart-rate-update', (event, state) => {
    if (!isMainSender(event)) return;
    const bpm = state?.bpm == null ? null : Number(state.bpm);
    overlayState = {
      ...overlayState,
      bpm: Number.isFinite(bpm) && bpm > 0 && bpm <= 255 ? bpm : null,
      connected: Boolean(state?.connected),
      zone: String(state?.zone || '').slice(0, 40),
      zoneLevel: String(state?.zoneLevel || 'idle').slice(0, 20)
    };
    sendOverlayState();
  });

  ipcMain.on('weather-update', (event, weather) => {
    if (!isMainSender(event)) return;
    if (!weather || !Number.isFinite(Number(weather.temperature))) return;
    overlayState.weather = {
      city: String(weather.city || '').slice(0, 80),
      temperature: Number(weather.temperature),
      apparentTemperature: Number(weather.apparentTemperature),
      windSpeed: Number(weather.windSpeed),
      label: String(weather.label || '').slice(0, 40),
      icon: String(weather.icon || '').slice(0, 4)
    };
    sendOverlayState();
  });

  ipcMain.handle('china-weather', async (event, city) => {
    if (!isMainSender(event)) throw new Error('Unauthorized sender');
    return fetchChinaWeather(city);
  });

  ipcMain.handle('china-ip-location', async (event) => {
    if (!isMainSender(event)) throw new Error('Unauthorized sender');
    return locateChinaCityByIp();
  });

  ipcMain.handle('lyrics-search', async (event, query) => {
    if (!isMainSender(event)) throw new Error('Unauthorized sender');
    const title = String(query?.title || '').trim().slice(0, 200);
    const artist = String(query?.artist || '').trim().slice(0, 200);
    if (!title) return { found: false, reason: '请输入歌曲名' };

    const lyrics = await searchSyncedLyrics({
      title,
      artist,
      durationMs: automaticMediaState?.durationMs
    });
    if (!lyrics.length) return { found: false, reason: '未找到同步歌词' };

    manualLyricsOverride = { title, artist, lyrics };
    publishMediaState(automaticMediaState);
    return { found: true, lines: lyrics.length };
  });

  ipcMain.on('lyrics-auto-mode', (event) => {
    if (!isMainSender(event)) return;
    manualLyricsOverride = null;
    publishMediaState(automaticMediaState);
  });

  sodaLyricsDirect = new SodaLyricsDirectService({
    onLyric: publishSodaLyric,
    onStatus: publishSodaDirectStatus
  });
  sodaLyricsDirect.setGameMode(gameMode);
  setOnlineLyricsEnabled(lyricsMode !== 'soda');
  sodaLyricsDirect.setEnabled(lyricsMode !== 'online');

  await createTray();
  createWindow();
  createOverlayWindow();
  setupAutoUpdater();
  setTimeout(() => checkForUpdates(false), 5000);
  startMediaMonitor((media) => {
    publishMediaState(media);
  }).catch((error) => {
    console.error('Media monitor failed:', error.message);
  });

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    const shouldShow = !overlayWindow?.isVisible();
    setOverlayVisible(shouldShow);
    if (!shouldShow && mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  const unlockHandler = () => setOverlayPassthrough(false);
  unlockShortcuts = [
    'CommandOrControl+Shift+L',
    'CommandOrControl+Alt+Shift+L'
  ].filter((accelerator) => globalShortcut.register(accelerator, unlockHandler));
  sendOverlaySettings();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in the notification area until the tray Exit command is used.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = undefined;
});

app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(settingsSaveTimer);
  sodaLyricsDirect?.stop();
  stopMediaMonitor();
});
