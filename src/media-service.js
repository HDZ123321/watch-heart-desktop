const {
  getAllSessions,
  onSessionsChanged,
  shutdown
} = require('windows-media-sessions');

const lyricsCache = new Map();
let unsubscribe;
let activeTrackKey = '';
let activeLyrics = [];
let lyricsStatus = 'idle';
let requestGeneration = 0;
let onlineLyricsEnabled = true;

function cleanText(value, maxLength = 200) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
    : '';
}

function splitLyricSegments(value) {
  const text = cleanText(
    value.replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, ''),
    300
  );
  if (!text) return [];

  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const mostlyCjk = cjkCount >= Math.max(4, text.length * 0.35);
  const strongSeparator = mostlyCjk
    ? /(?:\u3000|[|｜/／]+|[，。！？；;]+\s*|\s{2,})/
    : /(?:\u3000|[|｜/／]+|\s{3,})/;
  let segments = text.split(strongSeparator).map((part) => part.trim()).filter(Boolean);

  if (
    mostlyCjk &&
    segments.length === 1 &&
    text.length >= 14 &&
    /\s/.test(text)
  ) {
    const spaced = text.split(/\s+/).map((part) => part.trim()).filter(Boolean);
    if (spaced.length > 1 && spaced.every((part) => part.length >= 3)) {
      segments = spaced;
    }
  }
  return segments.slice(0, 8);
}

function parseSyncedLyrics(source) {
  if (typeof source !== 'string' || source.length > 500_000) return [];

  const rawEntries = [];
  for (const rawLine of source.split(/\r?\n/).slice(0, 3000)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    if (!timestamps.length) continue;
    const text = rawLine.replace(/\[[^\]]+\]/g, '').trim();
    if (!text) continue;

    for (const match of timestamps) {
      const timeMs = (Number(match[1]) * 60 + Number(match[2])) * 1000;
      if (Number.isFinite(timeMs)) rawEntries.push({ timeMs, text });
    }
  }

  rawEntries.sort((left, right) => left.timeMs - right.timeMs);

  // Multiple texts at the same timestamp are usually original/translation pairs.
  // Keep the first language instead of displaying both at once.
  const uniqueEntries = [];
  for (const entry of rawEntries) {
    if (uniqueEntries.at(-1)?.timeMs === entry.timeMs) continue;
    uniqueEntries.push(entry);
  }

  const expanded = [];
  uniqueEntries.forEach((entry, index) => {
    const segments = splitLyricSegments(entry.text);
    if (!segments.length) return;
    const nextTime = uniqueEntries[index + 1]?.timeMs;
    const availableMs =
      Number.isFinite(nextTime) && nextTime > entry.timeMs
        ? nextTime - entry.timeMs
        : 3000;
    const segmentDuration = Math.max(650, availableMs / segments.length);
    segments.forEach((text, segmentIndex) => {
      expanded.push({
        timeMs: Math.round(entry.timeMs + segmentDuration * segmentIndex),
        text
      });
    });
  });

  return expanded.slice(0, 2000);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'WatchHeart/1.2.0'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) return null;

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 2_000_000) return null;
  return response.json();
}

function normalizeComparable(value) {
  return cleanText(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(
      /[\[(（【][^\])）】]*(official|video|audio|lyrics?|live|remaster|mv|完整版|歌词版|动态歌词|高音质)[^\])）】]*[\])）】]/gi,
      ' '
    )
    .replace(/\b(?:feat|ft)\.?\s+.+$/i, ' ')
    .replace(/\.(mp3|flac|wav|m4a|aac)$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function metadataCandidates(track) {
  const candidates = [{
    title: track.title,
    artist: track.artist
  }];
  const parts = track.title.split(/\s+[-–—]\s+/).map((part) => part.trim());
  if (!track.artist && parts.length === 2 && parts.every(Boolean)) {
    candidates.push(
      { title: parts[1], artist: parts[0] },
      { title: parts[0], artist: parts[1] }
    );
  }
  return candidates;
}

function textScore(expected, actual, exactScore, partialScore) {
  const left = normalizeComparable(expected);
  const right = normalizeComparable(actual);
  if (!left || !right) return 0;
  if (left === right) return exactScore;
  if (left.includes(right) || right.includes(left)) return partialScore;
  return 0;
}

function scoreLyricsMatch(track, candidate) {
  if (!candidate?.syncedLyrics) return -1;
  let best = 0;
  for (const expected of metadataCandidates(track)) {
    let score = textScore(expected.title, candidate.trackName, 70, 38);
    if (expected.artist) {
      score += textScore(expected.artist, candidate.artistName, 30, 16);
    }
    best = Math.max(best, score);
  }

  const targetDuration = track.durationMs / 1000;
  const candidateDuration = Number(candidate.duration);
  if (
    targetDuration > 0 &&
    targetDuration < 20 * 60 &&
    Number.isFinite(candidateDuration)
  ) {
    const difference = Math.abs(targetDuration - candidateDuration);
    if (difference <= 2) best += 25;
    else if (difference <= 5) best += 16;
    else if (difference <= 10) best += 8;
    else if (difference > 30) best -= 15;
  }
  return best;
}

async function findLyrics(track) {
  const cacheKey =
    `${normalizeComparable(track.artist)}\u0000${normalizeComparable(track.title)}`;
  if (lyricsCache.has(cacheKey)) return lyricsCache.get(cacheKey);

  const primary = metadataCandidates(track)[0];
  const searchUrl = new URL('https://lrclib.net/api/search');
  if (primary.artist) {
    searchUrl.searchParams.set('track_name', normalizeComparable(primary.title));
    searchUrl.searchParams.set('artist_name', normalizeComparable(primary.artist));
  } else {
    searchUrl.searchParams.set('q', normalizeComparable(primary.title));
  }
  let matches = await fetchJson(searchUrl);

  if (!Array.isArray(matches) || !matches.some((entry) => entry?.syncedLyrics)) {
    const fallbackUrl = new URL('https://lrclib.net/api/search');
    fallbackUrl.searchParams.set(
      'q',
      normalizeComparable([track.artist, track.title].filter(Boolean).join(' '))
    );
    matches = await fetchJson(fallbackUrl);
  }

  const result = Array.isArray(matches)
    ? matches
        .filter((entry) => entry?.syncedLyrics)
        .map((entry) => ({ entry, score: scoreLyricsMatch(track, entry) }))
        .sort((left, right) => right.score - left.score)
        .find(({ score }) => score >= 38)?.entry
    : null;

  const lyrics = parseSyncedLyrics(result?.syncedLyrics);
  if (lyricsCache.size >= 50) lyricsCache.delete(lyricsCache.keys().next().value);
  lyricsCache.set(cacheKey, lyrics);
  return lyrics;
}

function hasUsableMetadata(track) {
  if (!track.title || track.title.length < 2) return false;
  if (
    !track.artist &&
    /(抖音|记录美好生活|douyin|youtube|正在播放|unknown)/i.test(track.title)
  ) {
    return false;
  }
  return true;
}

async function searchSyncedLyrics({ title, artist = '', durationMs = 0 }) {
  const safeTrack = {
    title: cleanText(title),
    artist: cleanText(artist),
    album: '',
    durationMs: Math.max(0, Number(durationMs) || 0)
  };
  if (!safeTrack.title) return [];
  return findLyrics(safeTrack);
}

function normalizeSession(session) {
  if (!session?.title) return null;
  return {
    id: cleanText(session.id, 300),
    title: cleanText(session.title),
    artist: cleanText(session.artist),
    album: cleanText(session.albumTitle),
    playing: session.playbackStatus === 'playing',
    positionMs: Math.max(0, Number(session.timeline?.positionMs) || 0),
    durationMs: Math.max(0, Number(session.timeline?.durationMs) || 0),
    capturedAt: Date.now(),
    lyrics: []
  };
}

async function processSessions(sessions, onUpdate) {
  const selected =
    sessions.find((session) => session.playbackStatus === 'playing' && session.title) ||
    sessions.find((session) => session.playbackStatus === 'paused' && session.title);
  const track = normalizeSession(selected);

  if (!track) {
    activeTrackKey = '';
    activeLyrics = [];
    lyricsStatus = 'idle';
    requestGeneration += 1;
    onUpdate(null);
    return;
  }

  const trackKey = `${track.id}\u0000${track.artist}\u0000${track.title}`;
  const changedTrack = trackKey !== activeTrackKey;
  if (changedTrack) {
    activeLyrics = [];
    lyricsStatus = onlineLyricsEnabled ? 'loading' : 'disabled';
  }
  activeTrackKey = trackKey;
  track.lyrics = changedTrack ? activeLyrics : undefined;
  track.lyricsStatus = lyricsStatus;

  if (!hasUsableMetadata(track)) {
    activeLyrics = [];
    lyricsStatus = 'metadata-missing';
    track.lyrics = [];
    track.lyricsStatus = lyricsStatus;
    onUpdate(track);
    return;
  }

  onUpdate(track);

  if (!onlineLyricsEnabled) return;
  if (!changedTrack) return;
  const generation = ++requestGeneration;

  try {
    activeLyrics = await findLyrics(track);
    lyricsStatus = activeLyrics.length ? 'found' : 'missing';
    if (generation === requestGeneration && trackKey === activeTrackKey) {
      const now = Date.now();
      onUpdate({
        ...track,
        lyrics: activeLyrics,
        lyricsStatus,
        positionMs:
          track.positionMs + (track.playing ? now - track.capturedAt : 0),
        capturedAt: now
      });
    }
  } catch (error) {
    lyricsStatus = 'error';
    console.error('Lyrics lookup failed:', error.message);
  }
}

async function startMediaMonitor(onUpdate) {
  const update = (sessions) => {
    processSessions(Array.isArray(sessions) ? sessions : [], onUpdate).catch(
      (error) => console.error('Media session update failed:', error.message)
    );
  };

  update(await getAllSessions());
  unsubscribe = onSessionsChanged(update);
}

function setOnlineLyricsEnabled(enabled) {
  const next = Boolean(enabled);
  if (next === onlineLyricsEnabled) return;
  onlineLyricsEnabled = next;
  activeLyrics = [];
  lyricsStatus = next ? 'idle' : 'disabled';
  requestGeneration += 1;
}

async function stopMediaMonitor() {
  unsubscribe?.();
  unsubscribe = undefined;
  await shutdown().catch(() => {});
}

module.exports = {
  parseSyncedLyrics,
  searchSyncedLyrics,
  setOnlineLyricsEnabled,
  startMediaMonitor,
  stopMediaMonitor
};
