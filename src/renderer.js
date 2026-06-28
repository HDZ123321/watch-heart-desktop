const HEART_RATE_SERVICE = 'heart_rate';
const HEART_RATE_MEASUREMENT = 'heart_rate_measurement';
const MAX_POINTS = 120;

const elements = {
  alwaysOnTop: document.querySelector('#always-on-top'),
  statusDot: document.querySelector('#status-dot'),
  statusText: document.querySelector('#status-text'),
  deviceName: document.querySelector('#device-name'),
  heartPulse: document.querySelector('#heart-pulse'),
  bpm: document.querySelector('#bpm-value'),
  zone: document.querySelector('#zone-pill'),
  connect: document.querySelector('#connect-button'),
  disconnect: document.querySelector('#disconnect-button'),
  min: document.querySelector('#min-value'),
  avg: document.querySelector('#avg-value'),
  max: document.querySelector('#max-value'),
  canvas: document.querySelector('#heart-chart'),
  chartEmpty: document.querySelector('#chart-empty'),
  modal: document.querySelector('#device-modal'),
  deviceList: document.querySelector('#device-list'),
  cancelScan: document.querySelector('#cancel-scan')
};

const overlayControls = {
  visible: document.querySelector('#overlay-visible'),
  size: document.querySelector('#overlay-size'),
  sizeValue: document.querySelector('#overlay-size-value'),
  width: document.querySelector('#overlay-width'),
  widthValue: document.querySelector('#overlay-width-value'),
  passthrough: document.querySelector('#overlay-passthrough'),
  gameMode: document.querySelector('#game-mode')
};

const weatherElements = {
  form: document.querySelector('#weather-form'),
  city: document.querySelector('#weather-city'),
  icon: document.querySelector('#weather-icon'),
  temperature: document.querySelector('#weather-temperature'),
  description: document.querySelector('#weather-description'),
  feelsLike: document.querySelector('#weather-feels-like'),
  wind: document.querySelector('#weather-wind'),
  location: document.querySelector('#weather-location'),
  locate: document.querySelector('#weather-locate')
};

const mediaElements = {
  title: document.querySelector('#music-title'),
  artist: document.querySelector('#music-artist'),
  lyric: document.querySelector('#music-lyric'),
  form: document.querySelector('#lyrics-form'),
  searchTitle: document.querySelector('#lyrics-title'),
  searchArtist: document.querySelector('#lyrics-artist'),
  automatic: document.querySelector('#lyrics-auto'),
  sodaDirect: document.querySelector('#lyrics-direct'),
  sodaAutoHide: document.querySelector('#lyrics-auto-hide'),
  sodaDirectReconnect: document.querySelector('#lyrics-direct-reconnect'),
  sodaDirectStatus: document.querySelector('#lyrics-direct-status')
};

let bluetoothDevice;
let heartRateCharacteristic;
let reconnectTimer;
let reconnectAttempts = 0;
let intentionalDisconnect = false;
let samples = [];
let lastKnownDevices = [];
let lowResourceMode = false;

function setStatus(type, text) {
  elements.statusDot.className = `status-dot ${type || ''}`.trim();
  elements.statusText.textContent = text;
}

function setControls(connected) {
  elements.connect.disabled = connected;
  elements.disconnect.disabled = !connected && !bluetoothDevice;
}

function showModal() {
  elements.modal.classList.remove('hidden');
  elements.deviceList.innerHTML = '<div class="device-placeholder">正在搜索…</div>';
}

function hideModal() {
  elements.modal.classList.add('hidden');
}

function renderDeviceList(devices) {
  lastKnownDevices = devices;
  elements.deviceList.replaceChildren();

  if (!devices.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'device-placeholder';
    placeholder.textContent = '尚未发现设备，请确认 iPhone 正在广播';
    elements.deviceList.append(placeholder);
    return;
  }

  for (const device of devices) {
    const button = document.createElement('button');
    button.className = 'device-item';
    button.type = 'button';

    const name = document.createElement('span');
    name.textContent = device.name;
    const action = document.createElement('small');
    action.textContent = '连接';

    button.append(name, action);
    button.addEventListener('click', () => {
      window.desktop.selectBluetoothDevice(device.id);
      hideModal();
      setStatus('scanning', '正在连接');
    });
    elements.deviceList.append(button);
  }
}

function parseHeartRate(dataView) {
  const flags = dataView.getUint8(0);
  const usesUint16 = (flags & 0x01) !== 0;
  return usesUint16 ? dataView.getUint16(1, true) : dataView.getUint8(1);
}

function zoneFor(bpm) {
  if (bpm < 60) return ['zone-low', '低强度'];
  if (bpm < 100) return ['zone-normal', '舒缓区间'];
  if (bpm < 140) return ['zone-warm', '活跃区间'];
  return ['zone-high', '高强度'];
}

function updateHeartRate(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0 || bpm > 255) return;

  elements.bpm.textContent = String(bpm);
  elements.heartPulse.classList.add('active');
  elements.heartPulse.style.setProperty(
    '--beat-duration',
    `${Math.max(0.28, 60 / bpm)}s`
  );

  const [zoneClass, zoneLabel] = zoneFor(bpm);
  elements.zone.className = `zone-pill ${zoneClass}`;
  elements.zone.textContent = zoneLabel;

  samples.push({ bpm, time: Date.now() });
  if (samples.length > MAX_POINTS) samples.shift();

  const values = samples.map((sample) => sample.bpm);
  elements.min.textContent = String(Math.min(...values));
  elements.max.textContent = String(Math.max(...values));
  elements.avg.textContent = String(
    Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  );
  elements.chartEmpty.classList.add('hidden');
  if (!document.hidden && !lowResourceMode) drawChart();
  window.desktop.updateHeartRate({
    bpm,
    connected: true,
    zone: zoneLabel
  });
}

function onHeartRateChanged(event) {
  updateHeartRate(parseHeartRate(event.target.value));
}

async function connectGatt() {
  if (!bluetoothDevice) return;

  clearTimeout(reconnectTimer);
  setStatus('scanning', reconnectAttempts ? '正在重新连接' : '正在连接');

  try {
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(HEART_RATE_SERVICE);
    heartRateCharacteristic = await service.getCharacteristic(
      HEART_RATE_MEASUREMENT
    );
    heartRateCharacteristic.addEventListener(
      'characteristicvaluechanged',
      onHeartRateChanged
    );
    await heartRateCharacteristic.startNotifications();

    reconnectAttempts = 0;
    setStatus('connected', '已连接');
    setControls(true);
    window.desktop.updateHeartRate({ connected: true });
  } catch (error) {
    scheduleReconnect(error);
  }
}

function scheduleReconnect(error) {
  if (intentionalDisconnect || !bluetoothDevice) {
    setStatus('error', '连接已断开');
    return;
  }

  reconnectAttempts += 1;
  const delay = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempts - 1, 4));
  setStatus('error', `${Math.round(delay / 1000)} 秒后重连`);
  console.error('BLE connection failed:', error);
  reconnectTimer = setTimeout(connectGatt, delay);
}

function onGattDisconnected() {
  setControls(false);
  window.desktop.updateHeartRate({ connected: false });
  scheduleReconnect(new Error('GATT disconnected'));
}

async function requestAndConnect() {
  if (!navigator.bluetooth) {
    setStatus('error', '当前系统不支持蓝牙');
    return;
  }

  intentionalDisconnect = false;
  showModal();
  setStatus('scanning', '正在扫描');

  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE_SERVICE] }]
    });

    bluetoothDevice = device;
    elements.deviceName.textContent = device.name || 'iPhone';
    bluetoothDevice.addEventListener('gattserverdisconnected', onGattDisconnected);
    setControls(false);
    await connectGatt();
  } catch (error) {
    hideModal();
    if (error.name === 'NotFoundError') {
      setStatus('', '已取消扫描');
    } else {
      setStatus('error', '扫描或连接失败');
      console.error('Bluetooth request failed:', error);
    }
  }
}

function disconnect() {
  intentionalDisconnect = true;
  clearTimeout(reconnectTimer);

  if (heartRateCharacteristic) {
    heartRateCharacteristic.removeEventListener(
      'characteristicvaluechanged',
      onHeartRateChanged
    );
  }
  if (bluetoothDevice?.gatt?.connected) bluetoothDevice.gatt.disconnect();

  heartRateCharacteristic = undefined;
  bluetoothDevice = undefined;
  reconnectAttempts = 0;
  elements.deviceName.textContent = '';
  elements.heartPulse.classList.remove('active');
  elements.zone.className = 'zone-pill zone-idle';
  elements.zone.textContent = '等待心率';
  setStatus('', '尚未连接');
  setControls(false);
  window.desktop.updateHeartRate({
    bpm: null,
    connected: false,
    zone: '等待心率'
  });
}

const weatherCodes = {
  0: ['晴朗', '☀'],
  1: ['大致晴朗', '☀'],
  2: ['多云', '◒'],
  3: ['阴天', '☁'],
  45: ['有雾', '≋'],
  48: ['雾凇', '≋'],
  51: ['轻微细雨', '🌦'],
  53: ['细雨', '🌦'],
  55: ['较强细雨', '🌧'],
  56: ['冻雨', '🌧'],
  57: ['冻雨', '🌧'],
  61: ['小雨', '🌦'],
  63: ['中雨', '🌧'],
  65: ['大雨', '🌧'],
  66: ['冻雨', '🌧'],
  67: ['强冻雨', '🌧'],
  71: ['小雪', '❄'],
  73: ['中雪', '❄'],
  75: ['大雪', '❄'],
  77: ['雪粒', '❄'],
  80: ['阵雨', '🌦'],
  81: ['较强阵雨', '🌧'],
  82: ['强阵雨', '🌧'],
  85: ['阵雪', '❄'],
  86: ['强阵雪', '❄'],
  95: ['雷暴', 'ϟ'],
  96: ['雷暴冰雹', 'ϟ'],
  99: ['强雷暴冰雹', 'ϟ']
};

async function loadWeatherCoordinates(latitude, longitude, location, persist) {
  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current:
      'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    timezone: 'auto'
  });
  const forecastResponse = await fetch(forecastUrl);
  if (!forecastResponse.ok) throw new Error('天气查询失败');
  const forecast = await forecastResponse.json();
  const current = forecast.current;
  const [label, icon] = weatherCodes[current.weather_code] || ['天气未知', '◌'];
  const weather = {
    city: location.city,
    temperature: current.temperature_2m,
    apparentTemperature: current.apparent_temperature,
    windSpeed: current.wind_speed_10m,
    label,
    icon
  };

  weatherElements.city.value = location.city;
  weatherElements.icon.textContent = icon;
  weatherElements.temperature.textContent = `${Math.round(weather.temperature)}°`;
  weatherElements.description.textContent = label;
  weatherElements.feelsLike.textContent =
    `${Math.round(weather.apparentTemperature)}°`;
  weatherElements.wind.textContent = `${Math.round(weather.windSpeed)} km/h`;
  weatherElements.location.textContent =
    [location.city, location.region].filter(Boolean).join(' · ');
  weatherElements.location.title = location.displayName || '';
  if (persist) localStorage.setItem('weatherCity', location.city);
  window.desktop.updateWeather(weather);
}

async function loadWeather(city, persist = false) {
  const trimmedCity = city.trim();
  if (!trimmedCity) return;

  weatherElements.description.textContent = '正在更新…';

  try {
    const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
    geocodeUrl.search = new URLSearchParams({
      name: trimmedCity,
      count: '1',
      language: 'zh',
      format: 'json'
    });
    const geocodeResponse = await fetch(geocodeUrl);
    if (!geocodeResponse.ok) throw new Error('城市查询失败');
    const geocode = await geocodeResponse.json();
    const location = geocode.results?.[0];
    if (!location) throw new Error('未找到该城市');
    await loadWeatherCoordinates(
      location.latitude,
      location.longitude,
      {
        city: location.name,
        region: location.admin1 || location.country || '',
        displayName: ''
      },
      persist
    );
  } catch (error) {
    weatherElements.description.textContent = error.message;
    console.error('Weather update failed:', error);
  }
}

async function locateWeather() {
  if (!navigator.geolocation) {
    weatherElements.description.textContent = '系统不支持定位';
    return;
  }

  weatherElements.locate.disabled = true;
  weatherElements.description.textContent = '正在获取位置…';

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 12000,
        maximumAge: 10 * 60 * 1000
      });
    });
    const coordinates = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    };
    const address = await window.desktop.locateAddress(coordinates);
    await loadWeatherCoordinates(
      coordinates.latitude,
      coordinates.longitude,
      address,
      true
    );
  } catch (error) {
    const denied = error?.code === 1;
    weatherElements.description.textContent =
      denied ? '定位权限未开启' : '自动定位失败';
    console.error('Location lookup failed:', error);
  } finally {
    weatherElements.locate.disabled = false;
  }
}

function mediaPosition(media) {
  if (!media) return 0;
  const elapsed = media.playing ? Date.now() - media.capturedAt : 0;
  return Math.max(0, media.positionMs + elapsed);
}

function lyricAt(lyrics, positionMs) {
  if (!Array.isArray(lyrics) || !lyrics.length) return '';
  let low = 0;
  let high = lyrics.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lyrics[middle].timeMs <= positionMs + 120) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match >= 0 ? lyrics[match].text : '';
}

let mediaState;

function updateMediaDisplay() {
  if (document.hidden || lowResourceMode) return;
  if (!mediaState) {
    mediaElements.title.textContent = '等待播放器';
    mediaElements.artist.textContent = '播放音乐后会自动读取 Windows 媒体会话';
    mediaElements.lyric.textContent = '找到时间轴歌词后将同步到游戏悬浮条';
    return;
  }

  mediaElements.title.textContent = mediaState.title || '未知曲目';
  mediaElements.artist.textContent =
    mediaState.artist ||
    (mediaState.lyricsStatus === 'metadata-missing'
      ? '播放器没有提供实际歌曲名或歌手'
      : '未知艺术家');
  mediaElements.lyric.textContent =
    lyricAt(mediaState.lyrics, mediaPosition(mediaState)) ||
    (mediaState.lyrics?.length
      ? '♪'
      : mediaState.lyricsStatus === 'loading'
        ? '正在匹配同步歌词…'
        : mediaState.lyricsStatus === 'metadata-missing'
          ? '无法自动识别，请在下方手动输入歌曲名'
        : '未找到同步歌词');
}

function drawChart() {
  const canvas = elements.canvas;
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const padding = 10;
  const chartWidth = rect.width - padding * 2;
  const chartHeight = rect.height - padding * 2;

  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.lineWidth = 1;
  for (let index = 0; index < 4; index += 1) {
    const y = padding + (chartHeight * index) / 3;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(rect.width - padding, y);
    ctx.stroke();
  }

  if (!samples.length) return;

  const points = samples.map((sample, index) => ({
    x:
      padding +
      (samples.length === 1 ? chartWidth / 2 : (chartWidth * index) / (MAX_POINTS - 1)),
    y: padding + chartHeight - ((sample.bpm - 40) / 180) * chartHeight
  }));

  const gradient = ctx.createLinearGradient(0, padding, 0, rect.height - padding);
  gradient.addColorStop(0, 'rgba(255,49,93,0.34)');
  gradient.addColorStop(1, 'rgba(255,49,93,0)');

  ctx.beginPath();
  ctx.moveTo(points[0].x, rect.height - padding);
  for (const point of points) ctx.lineTo(point.x, point.y);
  ctx.lineTo(points.at(-1).x, rect.height - padding);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = '#ff315d';
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,49,93,0.5)';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

elements.connect.addEventListener('click', requestAndConnect);
elements.disconnect.addEventListener('click', disconnect);
elements.cancelScan.addEventListener('click', () => {
  window.desktop.cancelBluetoothSelection();
  hideModal();
  setStatus('', '已取消扫描');
});
elements.alwaysOnTop.addEventListener('change', (event) => {
  window.desktop.setAlwaysOnTop(event.target.checked);
});
overlayControls.visible.addEventListener('change', (event) => {
  window.desktop.setOverlayVisible(event.target.checked);
});
overlayControls.size.addEventListener('input', (event) => {
  const value = Number(event.target.value);
  overlayControls.sizeValue.textContent = `${value}%`;
  window.desktop.setOverlayScale(value / 100);
});
overlayControls.width.addEventListener('input', (event) => {
  const value = Number(event.target.value);
  overlayControls.widthValue.textContent = String(value);
  window.desktop.setOverlayWidth(value);
});
overlayControls.passthrough.addEventListener('change', (event) => {
  window.desktop.setOverlayPassthrough(event.target.checked);
});
overlayControls.gameMode.addEventListener('change', (event) => {
  localStorage.setItem('gameMode', String(event.target.checked));
  window.desktop.setGameMode(event.target.checked);
});
weatherElements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  loadWeather(weatherElements.city.value, true);
});
weatherElements.locate.addEventListener('click', locateWeather);
mediaElements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = mediaElements.searchTitle.value.trim();
  if (!title) return;
  mediaElements.lyric.textContent = '正在搜索同步歌词…';
  try {
    const result = await window.desktop.searchLyrics({
      title,
      artist: mediaElements.searchArtist.value.trim()
    });
    if (!result.found) mediaElements.lyric.textContent = result.reason;
  } catch (error) {
    mediaElements.lyric.textContent = '歌词服务暂时不可用';
    console.error('Manual lyrics search failed:', error);
  }
});
mediaElements.automatic.addEventListener('click', () => {
  window.desktop.useAutomaticLyrics();
});
mediaElements.sodaDirect.addEventListener('change', (event) => {
  localStorage.setItem('lyricsDirect', String(event.target.checked));
  window.desktop.setSodaDirectEnabled(event.target.checked);
  mediaElements.sodaDirectStatus.textContent =
    event.target.checked ? '正在连接汽水音乐播放器…' : '未开启';
});
mediaElements.sodaDirectReconnect.addEventListener('click', () => {
  mediaElements.sodaDirectStatus.textContent = '正在安装/重连汽水音乐…';
  window.desktop.reconnectSodaDirect();
});
mediaElements.sodaAutoHide.addEventListener('change', (event) => {
  localStorage.setItem('sodaAutoHide', String(event.target.checked));
  window.desktop.setSodaAutoHide(event.target.checked);
});

window.desktop.onBluetoothDevices(renderDeviceList);
window.desktop.onOverlaySettings((settings) => {
  const wasLowResourceMode = lowResourceMode;
  lowResourceMode = settings.gameMode;
  overlayControls.visible.checked = settings.visible;
  overlayControls.passthrough.checked = settings.passthrough;
  overlayControls.size.value = String(Math.round(settings.scale * 100));
  overlayControls.sizeValue.textContent = `${Math.round(settings.scale * 100)}%`;
  overlayControls.width.value = String(settings.width);
  overlayControls.widthValue.textContent = String(settings.width);
  overlayControls.gameMode.checked = settings.gameMode;
  if (wasLowResourceMode && !lowResourceMode) {
    drawChart();
    updateMediaDisplay();
  }
});
window.desktop.onMediaState((media) => {
  mediaState = media;
  updateMediaDisplay();
});
window.desktop.onSodaDirectStatus((status) => {
  mediaElements.sodaDirectStatus.textContent = status;
});
window.addEventListener('resize', drawChart);
drawChart();

const savedWeatherCity = localStorage.getItem('weatherCity') || '香港';
weatherElements.city.value = savedWeatherCity;
loadWeather(savedWeatherCity);
setInterval(() => loadWeather(weatherElements.city.value), 15 * 60 * 1000);
setInterval(updateMediaDisplay, 500);

const savedGameMode = localStorage.getItem('gameMode') === 'true';
overlayControls.gameMode.checked = savedGameMode;
window.desktop.setGameMode(savedGameMode);

const savedLyricsDirectValue = localStorage.getItem('lyricsDirect');
const savedLyricsDirect =
  savedLyricsDirectValue === null
    ? (
        localStorage.getItem('lyricsCdp') === 'true' ||
        localStorage.getItem('lyricsCapture') === 'true'
      )
    : savedLyricsDirectValue === 'true';
mediaElements.sodaDirect.checked = savedLyricsDirect;
window.desktop.setSodaDirectEnabled(savedLyricsDirect);

const savedSodaAutoHide = localStorage.getItem('sodaAutoHide') === 'true';
mediaElements.sodaAutoHide.checked = savedSodaAutoHide;
window.desktop.setSodaAutoHide(savedSodaAutoHide);
