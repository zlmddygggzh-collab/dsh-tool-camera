# Changelog

本包遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 1.0.2 — 2026-11-08

### 发布

- 已发布到 npm，README 的「方式三」由「发布到 npm 之后」改为「从 npm 直接装（已发布）」。
## 1.0.1 — 2026-11-08

### `install.ps1`

- `-Tgz` 现在也接受 `http(s)://` 地址，装插件不必先手动下载。
- 传 URL 时优先让 pnpm 自己下载，依赖里记的是 URL，之后 `pnpm install` 仍可重新拉取；
  若 pnpm 的原生网络栈被系统拒绝（`os error 10013`），自动回退到 `curl.exe` 下载到
  `<profile>\.dsh-tool-camera\` 再本地安装。
- 修好 `-Tgz` 相对路径从非仓库目录调用时的解析，以及脚本被外部工具重写后丢失 UTF-8 BOM
  导致 PowerShell 5.1 按 ANSI 解析中文的问题。

### 元数据

- 作者与版权行改为项目署名，不再指向个人。

## 1.0.0 — 2026-11-08

首个公开版本。

### 工具

- `camera_snapshot` — 抓一帧摄像头画面并以 `image` content block 回传给模型，
  支持 `device` / `frames` / `quality`。抓多帧只保留最后一帧，避开刚起流时的黑屏与曝光未收敛。
- `camera_devices` — 列出摄像头、ffmpeg 路径与版本、当前采集后端；`install: false` 只做检查不下载。

### 采集后端

- Windows：DirectShow（`-f dshow`，设备名）。
- macOS：AVFoundation（`-f avfoundation`，设备索引）。
- Linux：V4L2（`-f v4l2`，`/dev/videoN`）。

### ffmpeg

- 不随包分发。首次抓帧时按 `ffmpegPath` → `DSH_FFMPEG` → `$DSH_HOME/tools/ffmpeg` →
  `PATH` → 自动下载 的顺序解析。
- 自动下载走 `@ffmpeg-installer/*` 预编译包，先试 `registry.npmmirror.com` 再试 `registry.npmjs.org`，
  用内置的极简 tar.gz 读取器解出单个二进制（不引入 tar 依赖），落盘后永久复用。
- 覆盖平台：`win32-x64 / win32-ia32 / darwin-x64 / darwin-arm64 / linux-x64 / linux-arm64 / linux-ia32`。

### 打包

- 以 DSH bundle 形式发布：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，
  安装后自动把 `tool-camera` 行插入 profile 层栈。
- `apply()` 阶段不触网、不碰设备，冷启动零阻塞。
