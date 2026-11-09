/**
 * dsh-tool-camera —— 给 agent 一双眼睛：直接抓本机摄像头的一帧画面。
 *
 * 设计要点：
 *  - 走 ffmpeg 的原生采集后端（Windows DirectShow / macOS AVFoundation / Linux V4L2），
 *    不依赖「相机」应用，也不需要任何窗口在前台。
 *  - 抓多帧只保留最后一帧：摄像头刚打开时前几帧常常全黑或过曝，最后一帧最接近实时画面。
 *  - 抓到的 JPEG 交给 attachments 服务落盘成 attachment，再以 image content block 回传，
 *    与内置 read_image 走同一条渲染链路。
 *  - ffmpeg 不在包里：首次抓帧时才按平台下载官方预编译包，之后永久复用。
 *  - 摄像头被别的程序占用时 ffmpeg 会报 Could not run graph，这里翻译成人话。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ensureFfmpeg, cachedFfmpegPath, downloadFfmpeg, platformKey } from './ffmpeg-bootstrap.js'

const execFileAsync = promisify(execFile)

/** Cordis 插件名。 */
export const name = 'tool-camera'
/** 需要工具注册表与附件存储。 */
export const inject = ['tools', 'attachments']

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_FRAMES = 5
const DEFAULT_QUALITY = 3
const MAX_FRAMES = 30

/* ------------------------------------------------------------------ */
/* 采集后端                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每个平台的差异只有三处：输入格式名、设备标注方式、枚举输出的解析。
 * Windows 用设备名，macOS 用索引，Linux 用设备节点。
 */
function backend() {
  if (process.platform === 'win32') {
    return {
      format: 'dshow',
      input: (device) => `video=${device}`,
      listArgs: ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'],
      parse: parseDshow,
      hint: 'Windows 上设备名形如 ov9734_azurewave_camera，可用 camera_devices 列出。',
    }
  }
  if (process.platform === 'darwin') {
    return {
      format: 'avfoundation',
      input: (device) => (device === '' ? 'default:none' : `${device}:none`),
      listArgs: ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      parse: parseAvfoundation,
      hint: 'macOS 上设备用索引（0、1…），可用 camera_devices 看编号；首次使用需在「系统设置 → 隐私与安全性 → 摄像头」里给终端/DSH 授权。',
    }
  }
  return {
    format: 'v4l2',
    input: (device) => (device === '' ? '/dev/video0' : device),
    listArgs: ['-f', 'v4l2', '-list_formats', 'all', '-i', '/dev/video0'],
    parse: parseV4l2,
    hint: 'Linux 上设备是 /dev/videoN（可用 camera_devices 列出），用户需要在 video 组里。',
  }
}

/** DirectShow：段落标题 + 引号设备名，后面还跟一行 Alternative name。 */
function parseDshow(text) {
  const devices = []
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    if (/DirectShow video devices/i.test(line)) { section = 'video'; continue }
    if (/DirectShow audio devices/i.test(line)) { section = 'audio'; continue }
    if (section !== 'video') continue
    if (/Alternative name/i.test(line)) continue
    const name = line.match(/"([^"]+)"/)
    if (name !== null) devices.push(name[1])
  }
  return [...new Set(devices)]
}

/** AVFoundation：`[0] FaceTime HD Camera`，索引就是这个数字。 */
function parseAvfoundation(text) {
  const devices = []
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    if (/AVFoundation video devices/i.test(line)) { section = 'video'; continue }
    if (/AVFoundation audio devices/i.test(line)) { section = 'audio'; continue }
    if (section !== 'video') continue
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (m !== null) devices.push(`${m[1]}: ${m[2]}`)
  }
  return [...new Set(devices)]
}

/** V4L2：输出的是 `/dev/video0` 这类节点名。 */
function parseV4l2(text) {
  const devices = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\[video4linux2[^\]]*\]\s+(\/dev\/video\d+)/)
    if (m !== null) devices.push(m[1])
  }
  if (devices.length > 0) return [...new Set(devices)]
  // -list_formats 打不开默认节点时，退回扫描 /dev。
  return []
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function resolveConfig(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    ffmpegPath: typeof cfg.ffmpegPath === 'string' ? cfg.ffmpegPath.trim() : '',
    device: typeof cfg.device === 'string' ? cfg.device.trim() : '',
    frames: Math.min(toPositiveInt(cfg.frames, DEFAULT_FRAMES), MAX_FRAMES),
    quality: Math.min(toPositiveInt(cfg.quality, DEFAULT_QUALITY), 31),
    timeoutMs: toPositiveInt(cfg.timeoutMs, DEFAULT_TIMEOUT_MS),
    autoDownload: cfg.autoDownload !== false,
    brightness: clampNumber(cfg.brightness, -1, 1, 0),
    gamma: clampNumber(cfg.gamma, 0.1, 10, 1),
    contrast: clampNumber(cfg.contrast, 0, 3, 1),
    sharpen: clampNumber(cfg.sharpen, 0, 2, 0),
    autoLevel: cfg.autoLevel === true,
  }
}

/* ------------------------------------------------------------------ */
/* ffmpeg 调用                                                         */
/* ------------------------------------------------------------------ */

function translateError(error, bin, timeoutMs) {
  if (error.code === 'ENOENT') {
    return new Error(`找不到 ffmpeg：${bin}。把 ffmpeg 放到 ${cachedFfmpegPath()}，或用 config.ffmpegPath / 环境变量 DSH_FFMPEG 指定。`)
  }
  const text = `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message ?? ''}`
  if (/Could not run graph|device is being used|already in use|Permission denied|not authorized/i.test(text)) {
    return new Error(
      '摄像头打不开：多半是被别的程序占用或没有系统授权。关掉「相机」、微信视频、会议软件等占用摄像头的程序，' +
        '并确认系统隐私设置里允许 DSH 使用摄像头。',
    )
  }
  if (/I\/O error|No such device|Cannot open video device|No such file or directory/i.test(text)) {
    return new Error(`摄像头无法打开，检查设备是否插好、驱动是否正常。ffmpeg 原始输出：${text.trim().slice(0, 600)}`)
  }
  if (error.killed || /timed out/i.test(text)) {
    return new Error(`ffmpeg 抓帧超时（${timeoutMs}ms）。摄像头可能没有输出画面，或驱动卡住。`)
  }
  return new Error(`ffmpeg 抓帧失败：${text.trim().slice(0, 800)}`)
}

async function runFfmpeg(bin, args, timeoutMs, signal) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      signal,
    })
    return { stdout, stderr }
  } catch (error) {
    throw translateError(error, bin, timeoutMs)
  }
}

async function listVideoDevices(bin, timeoutMs, signal) {
  const b = backend()
  let text = ''
  try {
    const out = await execFileAsync(bin, ['-hide_banner', ...b.listArgs], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      signal,
    })
    text = `${out.stderr ?? ''}${out.stdout ?? ''}`
  } catch (error) {
    if (error.code === 'ENOENT') throw translateError(error, bin, timeoutMs)
    text = `${error.stderr ?? ''}${error.stdout ?? ''}`
  }
  return b.parse(text)
}

/* ------------------------------------------------------------------ */
/* 抓帧                                                                */
/* ------------------------------------------------------------------ */

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// 把亮度/对比度/伽马/锐化/自动拉伸拼成一条 -vf 链。空数组表示不做任何处理。
function buildFilterChain(opts) {
  const chain = []
  if (opts.autoLevel) chain.push('normalize=blackpt=black:whitept=white:smoothing=0')
  const eq = []
  if (Number.isFinite(opts.brightness) && opts.brightness !== 0) eq.push(`brightness=${opts.brightness}`)
  if (Number.isFinite(opts.gamma) && opts.gamma !== 1) eq.push(`gamma=${opts.gamma}`)
  if (Number.isFinite(opts.contrast) && opts.contrast !== 1) eq.push(`contrast=${opts.contrast}`)
  if (eq.length > 0) chain.push(`eq=${eq.join(':')}`)
  if (Number.isFinite(opts.sharpen) && opts.sharpen > 0) chain.push(`unsharp=5:5:${opts.sharpen}`)
  return chain
}

async function captureFrame(bin, device, frames, quality, timeoutMs, signal, filters = []) {
  const b = backend()
  const dir = join(tmpdir(), `dsh-cam-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  try {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', b.format,
      '-rtbufsize', '100M',
      '-i', b.input(device),
      ...(filters.length > 0 ? ['-vf', filters.join(',')] : []),
      '-frames:v', String(frames),
      '-q:v', String(quality),
      '-y',
      join(dir, 'f_%03d.jpg'),
    ]
    await runFfmpeg(bin, args, timeoutMs, signal)
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort()
    if (files.length === 0) throw new Error(`摄像头「${device}」没有输出任何帧。`)
    const last = join(dir, files[files.length - 1])
    const data = await readFile(last)
    const info = await stat(last)
    return { data, bytes: info.size, framesCaptured: files.length }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function sniffJpeg(data) {
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
}

function jpegSize(data) {
  let i = 2
  while (i < data.length - 9) {
    if (data[i] !== 0xff) { i += 1; continue }
    const marker = data[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = data.readUInt16BE(i + 2)
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)
    if (isSof) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) }
    i += 2 + len
  }
  return { width: 0, height: 0 }
}

/* ------------------------------------------------------------------ */
/* 输出渲染                                                            */
/* ------------------------------------------------------------------ */

function imageEnvelope(value) {
  const { image } = value
  const scaled =
    image.originalDimensions === undefined
      ? ''
      : ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px)`
  return `<camera>${value.device}</camera>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}; captured ${value.framesCaptured} frame(s) at ${value.capturedAt}
</content>`
}

function imageContent(value) {
  return [
    { type: 'text', text: imageEnvelope(value) },
    {
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    },
  ]
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const b = backend()

  // 进程内只解析/下载一次 ffmpeg，之后所有抓帧复用同一个 Promise。
  let ffmpegPromise
  const resolveFfmpeg = (onProgress) => {
    if (ffmpegPromise !== undefined) return ffmpegPromise
    ffmpegPromise = ensureFfmpeg({
      explicit: config.ffmpegPath,
      allowDownload: config.autoDownload,
      onProgress,
    }).catch((error) => {
      ffmpegPromise = undefined
      throw error
    })
    return ffmpegPromise
  }

  const pickDevice = async (requested, timeoutMs, signal) => {
    if (requested !== '') return requested
    if (config.device !== '') return config.device
    const bin = await resolveFfmpeg()
    const devices = await listVideoDevices(bin, timeoutMs, signal)
    if (devices.length === 0) {
      throw new Error(`没有找到任何摄像头设备。${b.hint}`)
    }
    // macOS 的 `0: FaceTime HD Camera` 取索引部分。
    return process.platform === 'darwin' ? devices[0].split(':')[0].trim() : devices[0]
  }

  ctx.tools.register(
    defineTool({
      name: 'camera_snapshot',
      description:
        '用本机摄像头抓一帧实时画面并直接看到图像。不需要打开「相机」应用，也不需要窗口在前台。返回的是真实画面（JPEG），可以直接描述你看到的内容。',
      parameters: {
        device: { type: 'string', description: '摄像头设备，留空自动选第一个（可先用 camera_devices 查看）' },
        frames: { type: 'integer', description: '抓取帧数，只保留最后一帧以避开刚开机的黑屏/曝光未稳，默认 5' },
        quality: { type: 'integer', description: 'JPEG 质量 1-31（越小越好），默认 3' },
        brightness: {
          type: 'number',
          description: '亮度调整 -1..1，默认 0（不改）。弱光环境填 0.2~0.35 明显提亮，太大会过曝',
        },
        gamma: {
          type: 'number',
          description: '伽马 0.1..10，默认 1（不改）。弱光环境填 1.4~1.8 能把暗部细节拉出来且不容易过曝',
        },
        contrast: { type: 'number', description: '对比度 0..3，默认 1（不改）。提亮后如果画面发灰可以填 1.2~1.4' },
        sharpen: { type: 'number', description: '锐化 0..2，默认 0（不锐化）。弱光提亮后噪点会糊，填 0.6~1.0 能找回轮廓' },
        autoLevel: {
          type: 'boolean',
          description: '自动拉伸亮度到全动态范围（normalize 滤镜），适合不知道环境有多暗时一把梭；和上面几个手动参数可以叠加',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            device: { type: 'string', required: true },
            capturedAt: { type: 'string', required: true },
            framesCaptured: { type: 'integer', required: true },
            image: IMAGE_VALUE_SCHEMA,
          },
        },
        render: (_args, value) => imageContent(value),
      },
      timeoutMs: config.timeoutMs + 10_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) throw new Error('附件服务未挂载，无法回传摄像头画面。')
        const bin = await resolveFfmpeg()
        const device = await pickDevice(String(args.device ?? '').trim(), config.timeoutMs, exec.signal)
        const frames = Math.min(toPositiveInt(args.frames, config.frames), MAX_FRAMES)
        const quality = Math.min(toPositiveInt(args.quality, config.quality), 31)
        const filters = buildFilterChain({
          brightness: clampNumber(args.brightness, -1, 1, config.brightness),
          gamma: clampNumber(args.gamma, 0.1, 10, config.gamma),
          contrast: clampNumber(args.contrast, 0, 3, config.contrast),
          sharpen: clampNumber(args.sharpen, 0, 2, config.sharpen),
          autoLevel: args.autoLevel === undefined ? config.autoLevel : args.autoLevel === true,
        })
        const { data, bytes, framesCaptured } = await captureFrame(
          bin,
          device,
          frames,
          quality,
          config.timeoutMs,
          exec.signal,
          filters,
        )
        if (!sniffJpeg(data)) throw new Error('抓到的数据不是合法 JPEG，摄像头输出异常。')
        const size = jpegSize(data)
        const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg', name: `camera-${Date.now()}.jpg` })
        return {
          device,
          capturedAt: new Date().toISOString(),
          framesCaptured,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes ?? bytes,
            width: ref.width,
            height: ref.height,
            ...(size.width > 0 && (size.width !== ref.width || size.height !== ref.height)
              ? { originalDimensions: size }
              : {}),
          },
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'camera_devices',
      description:
        '列出本机可用的摄像头（以及 ffmpeg 是否就绪、走的哪个采集后端），返回的设备名可直接传给 camera_snapshot。',
      parameters: {
        install: {
          type: 'boolean',
          description: 'ffmpeg 还没准备好时是否立即下载安装（默认 true；传 false 只做检查）',
        },
      },
      output: textOutput(),
      timeoutMs: 200_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const lines = [`平台: ${platformKey()}`, `采集后端: ${b.format}`]
        const allowDownload = args.install !== false

        let bin
        try {
          bin = await resolveFfmpeg((text) => lines.push(text))
        } catch (error) {
          lines.push(`ffmpeg: 未就绪 — ${error instanceof Error ? error.message : String(error)}`)
          return lines.join('\n')
        }
        lines.push(`ffmpeg: ${bin}`)

        try {
          const out = await execFileAsync(bin, ['-version'], {
            timeout: config.timeoutMs,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            signal: exec.signal,
          })
          lines.push(`版本: ${String(out.stdout ?? '').split(/\r?\n/)[0]}`)
        } catch {
          lines.push('版本: 读取失败（二进制可能不可执行）')
        }

        const devices = await listVideoDevices(bin, config.timeoutMs, exec.signal)
        lines.push(`视频设备数: ${devices.length}`)
        if (devices.length === 0) {
          lines.push('（没有检测到摄像头）')
          lines.push(b.hint)
        }
        for (const device of devices) lines.push(` - ${device}`)
        if (!allowDownload && bin === '') lines.push('（本次未尝试下载 ffmpeg）')
        return lines.join('\n')
      },
    }),
  )
}

/** 供外部脚本/测试直接调用：只准备 ffmpeg，不注册工具。 */
export { downloadFfmpeg }
