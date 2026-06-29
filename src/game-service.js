const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const BUILTIN_GAMES = new Map([
  ['cs2.exe', 'Counter-Strike 2'],
  ['valorant-win64-shipping.exe', 'VALORANT'],
  ['league of legends.exe', '英雄联盟'],
  ['eldenring.exe', 'Elden Ring'],
  ['overwatch.exe', '守望先锋'],
  ['r5apex.exe', 'Apex Legends'],
  ['tslgame.exe', 'PUBG'],
  ['gta5.exe', 'GTA V'],
  ['genshinimpact.exe', '原神'],
  ['yuanshen.exe', '原神'],
  ['starrail.exe', '崩坏：星穹铁道'],
  ['minecraft.exe', 'Minecraft']
]);

function normalizeExecutable(value) {
  const executable = String(value || '').trim().toLowerCase();
  if (!/^[\w .()+-]{1,120}(?:\.exe)?$/.test(executable)) return '';
  return executable.endsWith('.exe') ? executable : `${executable}.exe`;
}

class GameService {
  constructor({ userDataPath, onGameChanged, onState }) {
    this.filePath = path.join(userDataPath, 'game-data.json');
    this.onGameChanged = onGameChanged;
    this.onState = onState;
    this.data = this.load();
    this.activeGame = null;
    this.activeSession = null;
    this.lastSampleAt = 0;
    this.lastZone = 'idle';
    this.timer = undefined;
    this.detecting = false;
  }

  defaults() {
    return {
      enabled: true,
      autoShow: true,
      autoHide: true,
      customGames: [],
      profiles: {},
      defaultProfile: null,
      sessions: []
    };
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        ...this.defaults(),
        ...saved,
        customGames: Array.isArray(saved.customGames)
          ? saved.customGames.map((item) => ({
              executable: normalizeExecutable(item.executable),
              name: String(item.name || item.executable || '').slice(0, 80)
            })).filter((item) => item.executable).slice(0, 100)
          : [],
        profiles: saved.profiles && typeof saved.profiles === 'object' ? saved.profiles : {},
        sessions: Array.isArray(saved.sessions) ? saved.sessions.slice(0, 100) : []
      };
    } catch {
      return this.defaults();
    }
  }

  save() {
    fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), () => {});
  }

  catalog() {
    const catalog = new Map(BUILTIN_GAMES);
    for (const item of this.data.customGames) catalog.set(item.executable, item.name);
    return catalog;
  }

  async processes() {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 2_000_000
    });
    const result = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)"/);
      if (match) result.add(match[1].toLowerCase());
    }
    return result;
  }

  start() {
    clearInterval(this.timer);
    this.detect();
    this.timer = setInterval(() => this.detect(), 3000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.finishSession();
  }

  async detect() {
    if (!this.data.enabled || this.detecting) return;
    this.detecting = true;
    try {
      const running = await this.processes();
      let detected = null;
      for (const [executable, name] of this.catalog()) {
        if (running.has(executable)) {
          detected = { executable, name };
          break;
        }
      }
      if (detected?.executable === this.activeGame?.executable) return;
      const previous = this.activeGame;
      if (previous) this.finishSession();
      this.activeGame = detected;
      if (detected) this.startSession(detected);
      this.onGameChanged({ previous, current: detected });
      this.emit();
    } catch (error) {
      console.error('Game detection failed:', error.message);
    } finally {
      this.detecting = false;
    }
  }

  startSession(game) {
    this.activeSession = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      gameName: game.name,
      executable: game.executable,
      startedAt: Date.now(),
      endedAt: null,
      minBpm: null,
      maxBpm: null,
      bpmTotal: 0,
      sampleCount: 0,
      dangerEvents: 0,
      zoneMs: { low: 0, normal: 0, warm: 0, high: 0, danger: 0 }
    };
    this.lastSampleAt = Date.now();
    this.lastZone = 'idle';
  }

  sessionView(session = this.activeSession) {
    if (!session) return null;
    return {
      ...session,
      durationMs: Math.max(0, (session.endedAt || Date.now()) - session.startedAt),
      averageBpm: session.sampleCount ? Math.round(session.bpmTotal / session.sampleCount) : null
    };
  }

  finishSession() {
    if (!this.activeSession) return;
    this.activeSession.endedAt = Date.now();
    const session = this.sessionView();
    if (session.durationMs >= 10000) {
      this.data.sessions.unshift(session);
      this.data.sessions = this.data.sessions.slice(0, 100);
      this.save();
    }
    this.activeSession = null;
    this.lastSampleAt = 0;
    this.lastZone = 'idle';
  }

  record(bpm, zone) {
    if (!this.activeSession || !Number.isFinite(bpm)) return;
    const now = Date.now();
    const elapsed = Math.min(5000, Math.max(0, now - this.lastSampleAt));
    if (this.activeSession.zoneMs[zone] !== undefined) {
      this.activeSession.zoneMs[zone] += elapsed;
    }
    this.activeSession.minBpm = this.activeSession.minBpm == null
      ? bpm
      : Math.min(this.activeSession.minBpm, bpm);
    this.activeSession.maxBpm = this.activeSession.maxBpm == null
      ? bpm
      : Math.max(this.activeSession.maxBpm, bpm);
    this.activeSession.bpmTotal += bpm;
    this.activeSession.sampleCount += 1;
    if (zone === 'danger' && this.lastZone !== 'danger') {
      this.activeSession.dangerEvents += 1;
    }
    this.lastSampleAt = now;
    this.lastZone = zone;
    this.emit();
  }

  updateSettings(settings) {
    this.data.enabled = Boolean(settings?.enabled);
    this.data.autoShow = Boolean(settings?.autoShow);
    this.data.autoHide = Boolean(settings?.autoHide);
    if (!this.data.enabled) {
      this.finishSession();
      const previous = this.activeGame;
      this.activeGame = null;
      if (previous) this.onGameChanged({ previous, current: null });
    } else {
      this.detect();
    }
    this.save();
    this.emit();
  }

  addCustom(value) {
    const executable = normalizeExecutable(value?.executable);
    if (!executable) return false;
    const name = String(value?.name || executable).trim().slice(0, 80);
    this.data.customGames = [
      ...this.data.customGames.filter((item) => item.executable !== executable),
      { executable, name }
    ].slice(-100);
    this.save();
    this.detect();
    this.emit();
    return true;
  }

  saveProfile(profile, game = this.activeGame) {
    if (game) this.data.profiles[game.executable] = profile;
    else this.data.defaultProfile = profile;
    this.save();
    this.emit();
  }

  profileFor(game) {
    return game
      ? this.data.profiles[game.executable] || this.data.defaultProfile
      : this.data.defaultProfile;
  }

  clearSessions() {
    this.data.sessions = [];
    this.save();
    this.emit();
  }

  state() {
    return {
      enabled: this.data.enabled,
      autoShow: this.data.autoShow,
      autoHide: this.data.autoHide,
      activeGame: this.activeGame,
      activeSession: this.sessionView(),
      sessions: this.data.sessions.slice(0, 30),
      customGames: this.data.customGames,
      currentHasProfile: Boolean(
        this.activeGame && this.data.profiles[this.activeGame.executable]
      )
    };
  }

  emit() {
    this.onState(this.state());
  }
}

module.exports = { GameService };
