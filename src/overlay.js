const bpmElement = document.querySelector('#overlay-bpm');
const heartElement = document.querySelector('#overlay-heart');
const weatherIcon = document.querySelector('#overlay-weather-icon');
const temperature = document.querySelector('#overlay-temperature');
const weatherLabel = document.querySelector('#overlay-weather-label');
const lyricElement = document.querySelector('#overlay-lyric');
const lockButton = document.querySelector('#overlay-lock');
const controlsElement = document.querySelector('.overlay-controls');
let mediaState;
let sodaLyric;
let passthroughEnabled = false;
let controlsInteractive = false;
let displayedLyric = '';
let sodaDirectEnabled = false;
let lyricsMode = 'auto';
const DEFAULT_THEME = {
  accent: '#ff315d',
  background: '#0a0c12',
  text: '#f7f8fb',
  lyric: '#e8eaf0',
  opacity: 88,
  blur: 16,
  radius: 18,
  fontScale: 100
};

function hexToRgb(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return [10, 12, 18];
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function applyTheme(theme = {}) {
  const merged = { ...DEFAULT_THEME, ...theme };
  const [r, g, b] = hexToRgb(merged.background);
  const alpha = Math.min(1, Math.max(0.35, Number(merged.opacity) / 100));
  const root = document.documentElement.style;
  root.setProperty('--overlay-accent', merged.accent);
  root.setProperty('--overlay-bg', `rgba(${r}, ${g}, ${b}, ${alpha})`);
  root.setProperty('--overlay-text', merged.text);
  root.setProperty('--overlay-lyric', merged.lyric);
  root.setProperty('--overlay-blur', `${Number(merged.blur) || 0}px`);
  root.setProperty('--overlay-radius', `${Number(merged.radius) || 18}px`);
  root.setProperty('--overlay-font-scale', `${Number(merged.fontScale) || 100}%`);
}

function mediaPosition(media) {
  if (!media) return 0;
  return Math.max(
    0,
    media.positionMs + (media.playing ? Date.now() - media.capturedAt : 0)
  );
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

function updateLyrics() {
  let text;
  if (sodaDirectEnabled && sodaLyric?.text) {
    text = sodaLyric.text;
  } else if (!mediaState) {
    text = '播放音乐后显示同步歌词';
  } else {
    text =
      lyricAt(mediaState.lyrics, mediaPosition(mediaState)) ||
      (mediaState.lyrics?.length
        ? '♪'
        : mediaState.lyricsStatus === 'loading'
          ? '正在匹配歌词…'
          : mediaState.lyricsStatus === 'disabled'
            ? lyricsMode === 'soda'
              ? '等待汽水音乐直读歌词'
              : '在线歌词未启用'
          : mediaState.lyricsStatus === 'metadata-missing'
            ? '播放器未提供歌曲信息'
            : '未找到同步歌词');
  }
  if (text === displayedLyric) return;
  displayedLyric = text;
  lyricElement.textContent = text;
  lyricElement.title = text;
  lyricElement.style.fontSize =
    text.length > 34 ? '10px' : text.length > 22 ? '11px' : '';
}

window.overlay.onState((state) => {
  if (state.connected && state.bpm) {
    bpmElement.textContent = String(state.bpm);
    heartElement.classList.add('active');
    heartElement.style.setProperty(
      '--beat-duration',
      `${Math.max(0.28, 60 / state.bpm)}s`
    );
  } else {
    bpmElement.textContent = '--';
    heartElement.classList.remove('active');
  }

  if (state.weather) {
    weatherIcon.textContent = state.weather.icon;
    temperature.textContent = `${Math.round(state.weather.temperature)}°`;
    weatherLabel.textContent = `${state.weather.city} · ${state.weather.label}`;
  }

  mediaState = state.media;
  sodaLyric = state.sodaLyric;
  updateLyrics();
});

window.overlay.onSettings((settings) => {
  passthroughEnabled = settings.passthrough;
  if (!passthroughEnabled) controlsInteractive = false;
  lockButton.classList.toggle('active', settings.passthrough);
  lockButton.title = settings.passthrough
    ? '取消鼠标穿透'
    : '开启鼠标穿透';
  document.body.classList.toggle('game-mode', settings.gameMode);
  applyTheme(settings.theme);
  lyricsMode = settings.lyricsMode || (settings.lyricsDirectEnabled ? 'auto' : 'online');
  sodaDirectEnabled = lyricsMode !== 'online';
  updateLyrics();
});

document.querySelector('#overlay-smaller').addEventListener('click', () => {
  window.overlay.resizeStep(-1);
});
document.querySelector('#overlay-larger').addEventListener('click', () => {
  window.overlay.resizeStep(1);
});
lockButton.addEventListener('click', () => {
  window.overlay.setPassthrough(!passthroughEnabled);
});
document.querySelector('#overlay-close').addEventListener('click', () => {
  window.overlay.close();
});

setInterval(updateLyrics, 250);

document.addEventListener('mousemove', (event) => {
  if (!passthroughEnabled) return;
  const bounds = controlsElement.getBoundingClientRect();
  const interactive =
    event.clientX >= bounds.left &&
    event.clientX <= bounds.right &&
    event.clientY >= bounds.top &&
    event.clientY <= bounds.bottom;
  if (interactive === controlsInteractive) return;
  controlsInteractive = interactive;
  window.overlay.setControlsInteractive(interactive);
});

document.addEventListener('mouseleave', () => {
  if (!passthroughEnabled || !controlsInteractive) return;
  controlsInteractive = false;
  window.overlay.setControlsInteractive(false);
});
