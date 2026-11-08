# dsh-tool-camera

> Give DeepSeek Harness eyes — the agent captures a frame from your webcam itself, no screenshots from you.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin (bundle).
After installing, the agent gains two tools:

| Tool | What it does |
| --- | --- |
| `camera_snapshot` | Capture a live frame and **hand the actual image to the model**. Optional device / frame count / quality |
| `camera_devices` | List cameras, ffmpeg readiness, and the active capture backend |

Key point: **no Camera app, no foreground window, no screen capture.**
ffmpeg talks to the native capture backend, and pixels go straight from the device to the model.

---

## The problem it solves

To let an agent see the physical world the usual trick is: open the Camera app → position the
window → screenshot → feed the image. That breaks down when nobody is at the desk, when the
session is remote, or when another window covers the preview.

This plugin captures a frame with one ffmpeg invocation, saves it as an attachment, and returns
it as an `image` content block — the exact same render path as the built-in `read_image`.

---

## Install

The package is 16 KB (ffmpeg is not bundled). **Restart DSH** afterwards — the tools only appear on a fresh load.

### Option 1: one-shot script (recommended on Windows)

```powershell
pwsh -File install.ps1 -Tgz .\dsh-tool-camera-1.0.0.tgz
```

The script finds your profile directory, finds pnpm (PATH → corepack → the pnpm shipped with
DSH → npx fallback), backs up `package.json` and `pnpm-lock.yaml`, then does both steps:
`pnpm add` and registering the package in `dsh.profile.bundles`.
To roll back, rename the generated `*.bak-camera-<stamp>` files.

### Option 2: two manual steps

```bash
cd ~/.dsh/profiles/desktop
pnpm add /path/to/dsh-tool-camera-1.0.0.tgz
```

Then append the package name to the `dsh.profile.bundles` array in the same `package.json`:

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

**Do not skip this.** `bundles` decides which packages are loaded into the layer stack;
a dependency that is not listed there never gets mounted.

### Option 3: after publishing to npm

```bash
pnpm add dsh-tool-camera
```

and add it to `dsh.profile.bundles` as above.

### Uninstall

```bash
cd ~/.dsh/profiles/desktop
pnpm remove dsh-tool-camera
```

then drop `dsh-tool-camera` from `dsh.profile.bundles`. This package's `cordis.patch.yml`
only inserts its own row and reconfigures nothing else, so removal is clean.

---

## Usage

After restart, just ask the agent to "take a look at the camera"; it calls `camera_snapshot` itself.

```
Take a snapshot with camera_snapshot, 8 frames
```

| Parameter | Default | Description |
| --- | --- | --- |
| `device` | first available | Device name (see `camera_devices`) |
| `frames` | 5 | Frames captured, keep the last. Early frames are often black or over-exposed |
| `quality` | 3 | JPEG quality 1–31, lower is better |

---

## Where ffmpeg comes from

The plugin does **not** bundle ffmpeg (60 MB would turn a two-second install into a one-minute one).
On the first real capture it resolves in this order:

1. `ffmpegPath` from plugin config
2. `DSH_FFMPEG` environment variable
3. `$DSH_HOME/tools/ffmpeg` (`ffmpeg.exe` on Windows)
4. `ffmpeg` on `PATH`
5. None found → download the official prebuilt package for this platform from an npm mirror,
   extract the single binary into `$DSH_HOME/tools/`

Downloads try `registry.npmmirror.com` first, then `registry.npmjs.org`. Once in place the binary
is reused forever and nothing else hits the network.

Supported: `win32-x64 / win32-ia32 / darwin-x64 / darwin-arm64 / linux-x64 / linux-arm64 / linux-ia32`.

Offline: set `autoDownload: false`, drop an ffmpeg into `$DSH_HOME/tools/`, or point `ffmpegPath` at one.

---

## Configuration

Override the same row in your profile's `cordis.patch.yml` (no need to touch files inside the package):

```yaml
- id: tool-camera
  config:
    device: ov9734_azurewave_camera   # pin one camera
    frames: 8
    quality: 2
    timeoutMs: 30000
    autoDownload: true
```

| Key | Default | Description |
| --- | --- | --- |
| `ffmpegPath` | `''` | Explicit ffmpeg binary, highest priority |
| `device` | `''` | Pin a device; empty means first available |
| `frames` | `5` | Frames captured, max 30 |
| `quality` | `3` | JPEG quality 1–31 |
| `timeoutMs` | `20000` | Per-capture timeout |
| `autoDownload` | `true` | Fetch ffmpeg when missing |

---

## Platform notes

**Windows** — DirectShow backend. Device names look like `ov9734_azurewave_camera`.
If the Camera app, WeChat video, or a meeting client holds the device, ffmpeg reports
`Could not run graph`; the plugin translates that into a readable message.

**macOS** — AVFoundation backend, devices are indices (`0`, `1`, …).
Grant camera access to DSH/Terminal in System Settings → Privacy & Security → Camera on first use.

**Linux** — V4L2 backend, devices are `/dev/videoN`. The current user must be in the `video` group.

---

## Known limits

- **One still frame per call**, not a video stream. Call repeatedly for continuous observation.
- A camera can only be opened by one program at a time; ffmpeg holds it during capture.
- Frames are raw device output with no rotation correction — built-in laptop cameras are often
  flipped or mirrored depending on the driver.
- `camera_snapshot` declares `isConcurrencySafe: () => false`, so concurrent calls queue instead of
  fighting over the device.

---

## License

MIT
