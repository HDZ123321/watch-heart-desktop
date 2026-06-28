const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 19228;
const BRIDGE_MARKER = 'WATCH_HEART_SODA_LYRICS_BRIDGE_V2';
const UNINSTALL_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

class SodaLyricsDirectService {
  constructor({ onLyric, onStatus }) {
    this.onLyric = onLyric;
    this.onStatus = onStatus;
    this.enabled = false;
    this.autoHideDesktopLyrics = false;
    this.server = undefined;
    this.lastStatus = '';
    this.lastLyricKey = '';
    this.lastReceivedAt = 0;
    this.staleTimer = undefined;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return;
    this.enabled = next;
    this.clearLyric();
    if (!next) {
      this.setStatus('未开启');
      return;
    }
    this.startServer();
    this.preparePlayer().catch((error) => {
      console.error('SodaMusic direct lyrics setup failed:', error);
      this.setStatus('汽水音乐直读初始化失败，已使用在线歌词');
    });
  }

  setGameMode() {
    // The injected bridge only sends when the lyric changes or once per second.
  }

  setAutoHideDesktopLyrics(enabled) {
    this.autoHideDesktopLyrics = Boolean(enabled);
    if (this.enabled && this.lastReceivedAt) {
      this.setStatus(
        this.autoHideDesktopLyrics
          ? '播放器直读中 · 汽水桌面歌词已自动隐藏'
          : '播放器直读中：在线歌词仅作备用'
      );
    }
  }

  reconnect() {
    if (!this.enabled) {
      this.setStatus('请先开启汽水音乐播放器直读');
      return;
    }
    this.clearLyric();
    this.preparePlayer({
      allowInstall: true,
      allowLaunch: true
    }).catch((error) => {
      console.error('SodaMusic direct lyrics reconnect failed:', error);
      this.setStatus('汽水音乐直读重连失败，已使用在线歌词');
    });
  }

  stop() {
    this.enabled = false;
    clearInterval(this.staleTimer);
    this.staleTimer = undefined;
    this.clearLyric();
    this.server?.close();
    this.server = undefined;
  }

  setStatus(status) {
    const safeStatus = String(status || '').slice(0, 100);
    if (safeStatus === this.lastStatus) return;
    this.lastStatus = safeStatus;
    this.onStatus(safeStatus);
  }

  publishLyric(lyric) {
    const text = String(lyric?.text || '').trim().slice(0, 500);
    const translation = String(lyric?.translation || '').trim().slice(0, 500);
    const key = `${text}\n${translation}`;
    if (key === this.lastLyricKey) return;
    this.lastLyricKey = key;
    this.onLyric(text ? { text, translation, source: 'soda-direct' } : null);
  }

  clearLyric() {
    this.lastReceivedAt = 0;
    this.publishLyric(null);
  }

  startServer() {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response);
    });
    this.server.on('error', (error) => {
      console.error('SodaMusic lyrics bridge server failed:', error.message);
      this.setStatus('本地歌词端口被占用，已使用在线歌词');
    });
    this.server.listen(BRIDGE_PORT, BRIDGE_HOST);

    this.staleTimer = setInterval(() => {
      if (
        this.enabled &&
        this.lastReceivedAt &&
        Date.now() - this.lastReceivedAt > 2600
      ) {
        this.clearLyric();
        this.setStatus('播放器直读已断开，当前使用在线歌词');
      }
    }, 1000);
  }

  handleRequest(request, response) {
    if (!this.isLoopback(request.socket.remoteAddress)) {
      response.writeHead(403).end();
      return;
    }

    if (request.method === 'GET' && request.url === '/soda-control') {
      if (!this.enabled) {
        response.writeHead(403, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      response.end(JSON.stringify({
        hideDesktopLyrics: this.autoHideDesktopLyrics
      }));
      return;
    }

    if (!this.enabled) {
      response.writeHead(403).end();
      return;
    }

    if (request.method === 'GET' && request.url?.startsWith('/soda-lyric?')) {
      try {
        const url = new URL(request.url, `http://${BRIDGE_HOST}`);
        this.acceptPayload(JSON.parse(url.searchParams.get('data') || '{}'));
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
      return;
    }

    if (request.method !== 'POST' || request.url !== '/soda-lyric') {
      response.writeHead(404).end();
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on('end', () => {
      try {
        this.acceptPayload(JSON.parse(body));
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  }

  isLoopback(address) {
    return address === BRIDGE_HOST || address === '::1' ||
      address === `::ffff:${BRIDGE_HOST}`;
  }

  acceptPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid lyrics payload');
    }
    this.lastReceivedAt = Date.now();
    if (payload.text) {
      this.publishLyric(payload);
      this.setStatus(
        this.autoHideDesktopLyrics && payload.desktopLyricsHidden
          ? '播放器直读中 · 汽水桌面歌词已自动隐藏'
          : '播放器直读中：在线歌词仅作备用'
      );
    } else {
      this.publishLyric(null);
      this.setStatus(
        payload.hint
          ? `汽水音乐：${String(payload.hint).slice(0, 60)}`
          : '已连接汽水音乐，等待当前歌词'
      );
    }
  }

  async preparePlayer({
    allowInstall = false,
    allowLaunch = false
  } = {}) {
    this.setStatus('正在检查汽水音乐播放器直读组件…');
    const executable = await this.findSodaMusicExecutable();
    if (!executable) {
      this.setStatus('未找到汽水音乐安装目录，当前使用在线歌词');
      return;
    }

    const patched = await this.isBridgeInstalled(executable);
    const running = await this.isSodaMusicRunning();

    if (!patched) {
      if (!allowInstall) {
        this.setStatus(
          running
            ? '直读组件未安装；请退出汽水音乐后点击“安装/重连”'
            : '直读组件未安装，点击“安装/重连”后启用'
        );
        return;
      }
      if (running) {
        this.setStatus('请完全退出汽水音乐，再点击“安装/重连”');
        return;
      }
      await this.installBridge(executable);
      this.setStatus('直读组件安装完成，正在启动汽水音乐…');
    }

    if (!running) {
      if (!allowLaunch) {
        this.setStatus('汽水音乐未运行，当前使用在线歌词');
        return;
      }
      this.launchSodaMusic(executable);
    }
    this.setStatus('等待汽水音乐“桌面歌词”…');
  }

  desktopLyricsAsar(executable) {
    return path.join(
      path.dirname(executable),
      'resources',
      'desktopLyrics.asar'
    );
  }

  async isBridgeInstalled(executable) {
    const archive = this.desktopLyricsAsar(executable);
    if (!fs.existsSync(archive)) return false;
    try {
      const asar = require('@electron/asar');
      const html = asar.extractFile(archive, 'desktopLyrics.html').toString('utf8');
      return html.includes(BRIDGE_MARKER);
    } catch {
      return false;
    }
  }

  async installBridge(executable) {
    const archive = this.desktopLyricsAsar(executable);
    if (!fs.existsSync(archive)) {
      throw new Error('SodaMusic desktopLyrics.asar was not found');
    }

    const asar = require('@electron/asar');
    const html = asar.extractFile(archive, 'desktopLyrics.html').toString('utf8');
    if (html.includes(BRIDGE_MARKER)) return;
    if (!html.includes('</body>')) {
      throw new Error('Unsupported SodaMusic desktopLyrics.html');
    }

    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'watch-heart-soda-lyrics-')
    );
    const tempAsar = `${archive}.watch-heart-${process.pid}.tmp`;
    const oldAsar = `${archive}.watch-heart-old`;
    const backupAsar = `${archive}.watch-heart-backup`;

    try {
      asar.extractAll(archive, tempDirectory);
      const cleanHtml = html
        .replace(
          /\s*<script type="module" src="\.\/watch-heart-lyrics\.js"><\/script>\s*/g,
          '\n'
        )
        .replace(
          /\s*<!-- WATCH_HEART_SODA_LYRICS_BRIDGE_V\d+ -->\s*/g,
          '\n'
        );
      const injectedHtml = cleanHtml.replace(
        '</body>',
        `    <script type="module" src="./watch-heart-lyrics.js"></script>\n` +
          `    <!-- ${BRIDGE_MARKER} -->\n  </body>`
      );
      fs.writeFileSync(
        path.join(tempDirectory, 'desktopLyrics.html'),
        injectedHtml,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempDirectory, 'watch-heart-lyrics.js'),
        fs.readFileSync(path.join(__dirname, 'soda-lyrics-inject.js'))
      );
      await asar.createPackage(tempDirectory, tempAsar);

      const verification = asar.extractFile(
        tempAsar,
        'desktopLyrics.html'
      ).toString('utf8');
      if (!verification.includes(BRIDGE_MARKER)) {
        throw new Error('SodaMusic lyrics bridge verification failed');
      }

      if (!fs.existsSync(backupAsar)) fs.copyFileSync(archive, backupAsar);
      if (fs.existsSync(oldAsar)) fs.rmSync(oldAsar, { force: true });
      fs.renameSync(archive, oldAsar);
      try {
        fs.renameSync(tempAsar, archive);
      } catch (error) {
        fs.renameSync(oldAsar, archive);
        throw error;
      }
      fs.rmSync(oldAsar, { force: true });
    } finally {
      if (fs.existsSync(tempAsar)) fs.rmSync(tempAsar, { force: true });
      const resolvedTemp = path.resolve(tempDirectory);
      const resolvedRoot = path.resolve(os.tmpdir());
      if (resolvedTemp.startsWith(`${resolvedRoot}${path.sep}`)) {
        fs.rmSync(resolvedTemp, { recursive: true, force: true });
      }
    }
  }

  launchSodaMusic(executable) {
    const installRoot = path.dirname(path.dirname(executable));
    const launcher = path.join(installRoot, 'SodaMusicLauncher.exe');
    const launchTarget = fs.existsSync(launcher) ? launcher : executable;
    const child = spawn(launchTarget, [], {
      cwd: path.dirname(launchTarget),
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
  }

  async isSodaMusicRunning() {
    try {
      const { stdout } = await execFileAsync(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq SodaMusic.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true, encoding: 'utf8', timeout: 3000 }
      );
      return /SodaMusic\.exe/i.test(stdout);
    } catch {
      return false;
    }
  }

  async findSodaMusicExecutable() {
    const roots = [];
    try {
      const { stdout } = await execFileAsync(
        'reg.exe',
        ['query', UNINSTALL_KEY, '/s', '/f', 'SodaMusic'],
        { windowsHide: true, encoding: 'utf8', timeout: 5000 }
      );
      const match = stdout.match(/DisplayIcon\s+REG_SZ\s+(.+)/i);
      if (match) roots.push(path.dirname(match[1].trim().replace(/^"|"$/g, '')));
    } catch {
      // Fall through to conventional install locations.
    }

    roots.push(
      path.join(process.env.LOCALAPPDATA || '', 'SodaMusic'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'SodaMusic')
    );

    for (const root of [...new Set(roots.filter(Boolean))]) {
      const direct = path.join(root, 'SodaMusic.exe');
      if (fs.existsSync(direct)) return direct;

      try {
        const config = JSON.parse(
          fs.readFileSync(path.join(root, 'launcher_config.json'), 'utf8')
        );
        if (/^[\w.-]+$/.test(config.cur_path || '')) {
          const current = path.join(root, config.cur_path, 'SodaMusic.exe');
          if (fs.existsSync(current)) return current;
        }
      } catch {
        // Try installed version folders below.
      }

      try {
        const versions = fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) {
          const candidate = path.join(root, version, 'SodaMusic.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch {
        // Continue with the next candidate root.
      }
    }
    return null;
  }
}

module.exports = {
  SodaLyricsDirectService
};
