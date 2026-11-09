# Changelog

本包遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 1.0.3 — 2026-11-09

### 弱光也能拍清楚

之前摄像头在暗光房间里抓回来的基本是全黑，只能看清亮着的那盏灯。现在 `camera_snapshot`
多了一组后期参数，抓帧时直接交给 ffmpeg 的滤镜链处理，不用另外再开个软件拉曲线：

- 新增工具参数与同名配置：`brightness`（−1~1）、`gamma`（0.1~10）、`contrast`（0~3）、
  `sharpen`（0~2）、`autoLevel`（布尔）。
- `autoLevel` 走 `normalize=blackpt=black:whitept=white`，把画面拉伸到全动态范围，
  不知道环境有多暗时一把梭；和手动参数可以叠加（`normalize` 在前，`eq` 在后，`unsharp` 最后）。
- 默认值全部保持「不改动画面」（`0 / 1 / 1 / 0 / false`），所以正常光线下拍出来的结果
  和 1.0.2 完全一致，不会因为升级就过曝。
- 参数逐项做了范围钳制，传超范围的值不会让 ffmpeg 直接失败。
- README 中英文的参数表与配置表同步补齐，并给出弱光推荐值（`gamma 1.4~1.8`、
  `brightness 0.2~0.35`、`contrast 1.2~1.4`、`sharpen 0.6~1.0`）。

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
