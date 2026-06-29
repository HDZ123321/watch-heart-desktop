# Watch Heart

Watch Heart 是一个 Windows 桌面心率悬浮工具，用来把 Apple Watch 经 iPhone 心率广播转发出来的 BLE 心率数据显示到电脑上。它面向游戏场景：可以显示心率、天气、同步歌词，并提供可调主题、鼠标穿透、心率区间报警和自动更新。

## 功能

- Apple Watch / iPhone 心率广播接收
- 游戏悬浮条
  - 缩放、宽度可调
  - 可拖动定位
  - 鼠标穿透
  - 低占用游戏模式
- 悬浮条主题系统
  - 心率红、赛博霓虹、冰蓝 HUD、琥珀电竞、极简透明
  - 支持自定义强调色、背景色、文字色、歌词色、透明度、圆角、字体大小
- 心率区间与报警
  - 可配置热身、高强度、危险阈值
  - 危险区间声音提醒
  - 悬浮条自动随心率区间变色，危险区间闪烁
- 天气信息
  - 已切换为中国大陆天气源
  - 支持城市手动更新
  - 支持国内 IP 城市定位
- 歌词显示
  - 自动：汽水音乐直读优先，在线歌词备用
  - 仅汽水直读
  - 仅在线匹配
  - 支持手动匹配歌词
- 汽水音乐桌面歌词直读
  - 不截图，不 OCR
  - 通过本地桥接读取当前桌面歌词行
  - 可自动隐藏汽水音乐自带桌面歌词，但不影响读取
- 系统托盘
  - 关闭主窗口后继续后台运行
  - 托盘菜单可显示/隐藏悬浮条、重连心率、退出程序
- 开机启动
- 自动更新
  - 基于 GitHub Release
  - 安装版支持检查、下载、安装并重启

## 下载与安装

建议使用安装版：

```text
Watch-Heart-版本号-Setup.exe
```

便携版也可以运行，但自动更新主要面向 NSIS 安装版：

```text
Watch-Heart-版本号-portable.exe
```

## 心率连接方式

Apple Watch 不能直接作为标准蓝牙心率设备连接 Windows。推荐链路是：

```text
Apple Watch 测量心率
        ↓
iPhone 心率广播 App
        ↓
Windows Watch Heart 通过 Web Bluetooth 连接 iPhone 广播
```

使用步骤：

1. 在 Apple Watch 上开始测量心率。
2. 在 iPhone 上打开“心率广播”类 App，并确认正在广播标准 BLE Heart Rate Service。
3. 启动 Watch Heart。
4. 点击 `扫描并连接`。
5. 在设备列表中选择 iPhone 广播设备。

## 游戏悬浮条

主界面顶部可以控制悬浮条：

- 显示 / 隐藏
- 缩放
- 宽度
- 鼠标穿透
- 低占用游戏模式

快捷键：

```text
Ctrl+Shift+H          显示 / 隐藏悬浮条
Ctrl+Shift+L          取消鼠标穿透
Ctrl+Alt+Shift+L      备用取消鼠标穿透
```

鼠标穿透适合游戏时使用。如果误开穿透导致点不到悬浮条，按 `Ctrl+Shift+L` 即可恢复。

## 悬浮条主题

内置主题：

- 心率红
- 赛博霓虹
- 冰蓝 HUD
- 琥珀电竞
- 极简透明
- 自定义

可调项：

- 强调色
- 背景色
- 文字色
- 歌词色
- 透明度
- 圆角
- 字体大小

设置会自动保存，下次启动恢复。

## 心率区间与报警

默认阈值：

```text
热身      100 BPM
高强度    140 BPM
危险      170 BPM
```

区间逻辑：

```text
< 60                  低强度
60 ~ 热身阈值          舒缓区间
热身阈值 ~ 高强度阈值   活跃区间
高强度阈值 ~ 危险阈值   高强度
>= 危险阈值            危险区间
```

开启 `危险区间声音提醒` 后，进入危险区间会播放短提示音，并带有冷却时间，避免连续乱响。

悬浮条会按区间自动变色：

- 正常：绿色边框
- 热身：黄色提示
- 高强度：红色提示
- 危险：深红背景并闪烁

## 天气

天气已切换为中国大陆天气源。

支持：

- 手动输入城市并更新
- 自动定位城市
- 每 15 分钟自动刷新

自动定位使用国内 IP 城市定位，不再依赖 OpenStreetMap / Open-Meteo。

如果曾经保存过乱码城市名，新版本会自动清理并回退到默认城市。

## 歌词模式

主界面提供三种歌词方式：

### 自动：汽水直读优先，在线备用

默认推荐。优先读取汽水音乐桌面歌词当前行；如果没有直读歌词，则回退到在线同步歌词。

### 仅汽水直读

只读取汽水音乐播放器自身桌面歌词，不触发在线歌词匹配。

适合：

- 在线歌词匹配慢
- 在线歌词经常匹配错
- 希望显示和播放器完全一致

### 仅在线匹配

不读取汽水音乐直读歌词，只根据 Windows 媒体会话里的歌曲名、歌手、进度去匹配在线同步歌词。

适合：

- 不使用汽水音乐
- 汽水直读组件失效

## 汽水音乐直读说明

Watch Heart 使用汽水音乐桌面歌词页面本地桥接读取当前歌词行。

特点：

- 不持续截图
- 不 OCR
- 不枚举桌面窗口图像
- 只监听本机 `127.0.0.1:19228`
- 只发送当前歌词文字

首次使用：

1. 在 Watch Heart 中选择 `自动` 或 `仅汽水直读`。
2. 完全退出汽水音乐。
3. 点击 `安装/重连`。
4. 打开汽水音乐桌面歌词。

如果汽水音乐升级后直读失效，重复 `安装/重连`。

可选项：

- `自动隐藏汽水桌面歌词`：隐藏汽水音乐原桌面歌词窗口，但继续读取歌词。

## 自动更新

自动更新基于 GitHub Release。

安装版启动后会自动检查更新。也可以在主界面点击：

```text
检查更新
```

如果发现新版本，会自动下载。下载完成后点击：

```text
安装并重启
```

如果提示：

```text
暂未发布可自动更新的安装包，请先在 GitHub Release 上传 latest.yml 和 Setup.exe
```

说明当前 GitHub Release 里缺少自动更新需要的文件。

发布 Release 时需要上传：

```text
Watch-Heart-版本号-Setup.exe
Watch-Heart-版本号-Setup.exe.blockmap
latest.yml
```

注意：portable 便携版不适合作为自动更新目标，建议用户使用安装版。

## 开发

环境：

- Windows
- Node.js
- npm

安装依赖：

```powershell
npm install
```

开发运行：

```powershell
npm start
```

## 打包

生成安装版、便携版和自动更新元数据：

```powershell
npm run pack
```

输出目录：

```text
dist/
```

常见输出：

```text
Watch-Heart-1.7.0-Setup.exe
Watch-Heart-1.7.0-Setup.exe.blockmap
Watch-Heart-1.7.0-portable.exe
latest.yml
```

如果打包时报错：

```text
EBUSY: resource busy or locked, rmdir dist\win-unpacked
```

说明旧的 `dist\win-unpacked\Watch Heart.exe` 正在运行。先退出程序或结束该进程，再重新打包。

## 发布流程

1. 更新版本号：

```powershell
npm version patch
```

2. 打包：

```powershell
npm run pack
```

3. 推送代码和 tag：

```powershell
git push origin main --tags
```

4. 在 GitHub 创建 Release。

5. 上传：

```text
dist/Watch-Heart-版本号-Setup.exe
dist/Watch-Heart-版本号-Setup.exe.blockmap
dist/latest.yml
```

6. 已安装用户即可通过自动更新升级。

## 项目结构

```text
src/main.js                 Electron 主进程、窗口、托盘、自动更新、天气代理
src/renderer.js             主界面逻辑、蓝牙连接、天气、歌词、心率区间
src/overlay.js              悬浮条渲染逻辑
src/overlay.css             悬浮条样式和心率变色
src/media-service.js        Windows 媒体会话和在线歌词匹配
src/soda-lyrics-service.js  汽水音乐桌面歌词直读桥接
src/soda-lyrics-inject.js   注入汽水桌面歌词页面的轻量脚本
```

## 隐私说明

- 心率数据只在本机显示和转发到本机悬浮条。
- 汽水音乐直读只读取当前歌词文本。
- 天气城市会请求国内天气接口。
- 自动定位使用国内 IP 城市定位。
- 自动更新会访问 GitHub Release。

## License

MIT
