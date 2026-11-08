# dsh-tool-camera

> 给 DeepSeek Harness 一双眼睛 —— agent 自己抓一帧摄像头画面，不用你截图。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件（bundle）。
装完之后 agent 多出两个工具：

| 工具 | 作用 |
| --- | --- |
| `camera_snapshot` | 抓一帧实时画面，**直接把图给模型看**。可指定设备 / 帧数 / 画质 |
| `camera_devices` | 列出摄像头、ffmpeg 就绪状态、当前采集后端 |

关键点：**不打开「相机」应用，不依赖任何窗口在前台，也不截屏**。
走的是 ffmpeg 的原生采集后端，画面直接从设备到模型。

---

## 它解决什么问题

想让 agent 看现实里的东西时，常见做法是：打开相机 App → 摆好窗口 → 截屏 → 喂图。
这套流程在无人值守、远程、或者窗口被别的程序挡住时全废。

本插件用一次 ffmpeg 抓帧拿到像素，落成 attachment，再以 `image` content block 回传，
和内置 `read_image` 走完全同一条渲染链路。所以模型侧收到的就是一张真图。

---

## 安装

包只有 16KB（ffmpeg 不随包走），装完要**重启 DSH** 才会出现工具。

### 方式一：一键脚本（推荐）

连包都不用先下载，直接把 Release 地址喂给它：

```powershell
pwsh -File install.ps1 -Tgz "https://github.com/zlmddygggzh-collab/dsh-tool-camera/releases/download/v1.0.1/dsh-tool-camera-1.0.1.tgz"
```

或者本地已有 tarball：

```powershell
pwsh -File install.ps1 -Tgz .\dsh-tool-camera-1.0.1.tgz
```

脚本会自己找 profile 目录、找 pnpm（PATH → corepack → DSH 自带 → npx 兜底），
备份 `package.json` 与 `pnpm-lock.yaml`，然后做两件事：`pnpm add` + 把包名登记进
`dsh.profile.bundles`。改错了就把 `*.bak-camera-<时间戳>` 改回原名。

传 URL 时脚本先让 pnpm 自己下载（这样依赖里记的是 URL，以后 `pnpm install` 还能重新拉）；
个别 Windows 机器上 pnpm 的原生网络栈会以 `os error 10013` 被拦，脚本会自动改用
`curl.exe` 下载到 `<profile>\.dsh-tool-camera\` 再本地安装。

### 方式二：手动两步

```bash
cd ~/.dsh/profiles/desktop          # Windows: C:\Users\<你>\.dsh\profiles\desktop
pnpm add /path/to/dsh-tool-camera-1.0.0.tgz
```

然后在同一个 `package.json` 里，把包名追加到 `dsh.profile.bundles` 数组末尾：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "dshmarket",
      "...",
      "dsh-tool-camera"
    ]
  }
}
```

**这一步不能省**：`bundles` 决定层栈里加载哪些包，只在 `dependencies` 里装好不会生效。

### 方式三：从 npm 直接装（已发布）

```bash
pnpm add dsh-tool-camera
```

再用上面那句话把它加进 `dsh.profile.bundles`。

### 卸载

```bash
cd ~/.dsh/profiles/desktop
pnpm remove dsh-tool-camera
```

再把 `dsh.profile.bundles` 里的 `dsh-tool-camera` 删掉即可。本包的
`cordis.patch.yml` 只插入自己的那一行，不碰别人的配置，所以卸载是干净的。

---

## 用法

装好重启后，直接跟 agent 说「看一眼摄像头」即可，它会自己调 `camera_snapshot`。

也可以显式点：

```
用 camera_snapshot 拍一张，抓 8 帧
```

工具参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `device` | 自动选第一个 | 设备名（用 `camera_devices` 查） |
| `frames` | 5 | 抓几帧只留最后一帧。摄像头刚开时前几帧常是全黑/过曝 |
| `quality` | 3 | JPEG 质量 1–31，越小越好 |

---

## ffmpeg 怎么来

插件**不打包** ffmpeg（那是 60MB，会让安装从两秒变一分钟）。首次真正抓帧时按以下顺序找：

1. 插件配置里的 `ffmpegPath`
2. 环境变量 `DSH_FFMPEG`
3. `$DSH_HOME/tools/ffmpeg`（Windows 为 `ffmpeg.exe`）
4. `PATH` 里的 `ffmpeg`
5. 都没有 → 自动从 npm 镜像下载对应平台的官方预编译包，解出二进制放到 `$DSH_HOME/tools/`

下载会先试 `registry.npmmirror.com`，失败再试 `registry.npmjs.org`。
成功后永久复用，不再联网。

支持平台：`win32-x64 / win32-ia32 / darwin-x64 / darwin-arm64 / linux-x64 / linux-arm64 / linux-ia32`。

离线环境：把 `autoDownload` 设 `false`，然后自己放一个 ffmpeg 到 `$DSH_HOME/tools/`，
或者用 `ffmpegPath` 指过去。

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖同名行即可（不用改包内文件）：

```yaml
- id: tool-camera
  config:
    device: ov9734_azurewave_camera   # 固定摄像头
    frames: 8                          # 多抓几帧，画面更稳
    quality: 2                         # 画质更好
    timeoutMs: 30000                   # 外接 USB 摄像头起流慢
    autoDownload: true                 # 允许自动装 ffmpeg
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `ffmpegPath` | `''` | 显式指定 ffmpeg，最高优先级 |
| `device` | `''` | 固定设备；留空则自动选第一个 |
| `frames` | `5` | 抓帧数，上限 30 |
| `quality` | `3` | JPEG 质量 1–31 |
| `timeoutMs` | `20000` | 单次抓帧超时 |
| `autoDownload` | `true` | 缺 ffmpeg 时自动下载 |

---

## 各平台说明

**Windows** — 采集后端 DirectShow。设备名形如 `ov9734_azurewave_camera`。
摄像头被「相机」、微信视频、会议软件占用时 ffmpeg 会报 `Could not run graph`，插件会翻译成中文提示。

**macOS** — 采集后端 AVFoundation，设备用索引（`0`、`1`…）。
首次使用需要在「系统设置 → 隐私与安全性 → 摄像头」里给 DSH / 终端授权。

**Linux** — 采集后端 V4L2，设备是 `/dev/videoN`。当前用户需要在 `video` 组里。

---

## 已知边界

- **一次一张静态图**，不是视频流。需要连续观察就多次调用。
- 摄像头同一时刻只能被一个程序占用；ffmpeg 抓帧期间别的程序打不开它。
- 画面是设备原始输出，不做旋转纠正——笔记本内置摄像头常见倒置/镜像，取决于驱动。
- `camera_snapshot` 标了 `isConcurrencySafe: () => false`，并发调用会排队，避免抢设备。

---

## License

MIT
