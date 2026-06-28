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
  sodaDirectEnabled = settings.lyricsDirectEnabled;
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
