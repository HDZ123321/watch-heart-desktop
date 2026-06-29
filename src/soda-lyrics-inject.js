const bridgeToken = '__WATCH_HEART_BRIDGE_TOKEN__';
const endpoint = 'http://127.0.0.1:19228/soda-lyric';
const controlEndpoint =
  `http://127.0.0.1:19228/soda-control?token=${encodeURIComponent(bridgeToken)}`;
let lastPayload = '';
let lastSentAt = 0;
let lastControlAt = 0;
let desktopLyricsHidden = false;

const hideStyle = document.createElement('style');
hideStyle.textContent = `
  html.watch-heart-hide-desktop-lyrics body {
    opacity: 0 !important;
  }
  html.watch-heart-hide-desktop-lyrics body * {
    pointer-events: none !important;
  }
`;
document.head.append(hideStyle);

function lockDesktopLyrics() {
  const lockButton = document.querySelector(
    '.controls .right > .button:nth-last-child(2)'
  );
  if (!lockButton || lockButton.classList.contains('locker')) return;
  lockButton.click();
  sessionStorage.setItem('watchHeartLockedDesktopLyrics', 'true');
}

function restoreDesktopLyricsLock() {
  if (sessionStorage.getItem('watchHeartLockedDesktopLyrics') !== 'true') return;
  const lockButton = document.querySelector(
    '.controls .right > .button:nth-last-child(2)'
  );
  if (lockButton?.classList.contains('locker')) lockButton.click();
  sessionStorage.removeItem('watchHeartLockedDesktopLyrics');
}

function setDesktopLyricsHidden(hidden) {
  const next = Boolean(hidden);
  if (next === desktopLyricsHidden) return;
  desktopLyricsHidden = next;
  if (next) {
    lockDesktopLyrics();
    document.documentElement.classList.add('watch-heart-hide-desktop-lyrics');
  } else {
    document.documentElement.classList.remove('watch-heart-hide-desktop-lyrics');
    restoreDesktopLyricsLock();
  }
}

async function refreshControl() {
  try {
    const response = await fetch(controlEndpoint, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('Watch Heart is unavailable');
    const control = await response.json();
    lastControlAt = Date.now();
    setDesktopLyricsHidden(control.hideDesktopLyrics);
  } catch {
    if (desktopLyricsHidden && Date.now() - lastControlAt > 3000) {
      setDesktopLyricsHidden(false);
    }
  }
}

function currentLyric() {
  const root = document.querySelector('.lyrics');
  if (!root) {
    return {
      text: '',
      translation: '',
      hint: '',
      desktopLyricsHidden
    };
  }
  const hint =
    root.querySelector('.paragraph.no-lyric .line')?.textContent?.trim() || '';
  const paragraphs = Array.from(root.querySelectorAll(':scope > .paragraph'))
    .filter((element) =>
      !element.classList.contains('placeholder') &&
      !element.classList.contains('no-lyric')
    );
  const paragraph = paragraphs[0];
  return {
    text: paragraph?.querySelector('.line')?.textContent?.trim() || '',
    translation:
      paragraph?.querySelector('.translation')?.textContent?.trim() || '',
    hint,
    desktopLyricsHidden
  };
}

function send(payload) {
  fetch(`${endpoint}?token=${encodeURIComponent(bridgeToken)}`, {
    method: 'POST',
    mode: 'no-cors',
    cache: 'no-store',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: payload,
    keepalive: true
  }).catch(() => {
    const image = new Image();
    image.src =
      `${endpoint}?token=${encodeURIComponent(bridgeToken)}&data=${encodeURIComponent(payload)}`;
  });
}

setInterval(() => {
  const payload = JSON.stringify(currentLyric());
  const now = Date.now();
  if (payload === lastPayload && now - lastSentAt < 1000) return;
  lastPayload = payload;
  lastSentAt = now;
  send(payload);
}, 160);

refreshControl();
setInterval(refreshControl, 1000);
window.addEventListener('beforeunload', () => setDesktopLyricsHidden(false));
