/**
 * ffmpeg 自举：解析已有二进制，找不到就按平台下载并落盘。
 *
 * 插件本身不带 60MB 的视频工具（那会让安装从两秒变成一分钟），
 * 而是第一次真正要抓帧时才准备：优先复用 PATH / 已知缓存，其次
 * 从 npm 镜像拉官方的预编译包，解出单个二进制，之后永久复用。
 *
 * 解析顺序（先命中先返回）：
 *   1. config.ffmpegPath（用户显式指定）
 *   2. 环境变量 DSH_FFMPEG
 *   3. DSH_HOME/tools/ffmpeg[.exe]（本插件与 cloudflared 等共用的工具目录）
 *   4. PATH 里的 ffmpeg
 *   5. 按平台下载到 DSH_HOME/tools/
 */
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { extractLargest } from './targz.js'

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/** 官方预编译包；darwin-arm64 / linux-arm64 的版本号与 x64 不同。 */
const PACKAGES = {
  'win32-x64': { name: 'win32-x64', version: '4.1.0' },
  'win32-ia32': { name: 'win32-ia32', version: '4.1.0' },
  'darwin-x64': { name: 'darwin-x64', version: '4.1.0' },
  'darwin-arm64': { name: 'darwin-arm64', version: '4.1.5' },
  'linux-x64': { name: 'linux-x64', version: '4.1.0' },
  'linux-arm64': { name: 'linux-arm64', version: '4.1.4' },
  'linux-ia32': { name: 'linux-ia32', version: '4.1.0' },
}

const MIRRORS = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

const DOWNLOAD_TIMEOUT_MS = 180_000

/** DSH 的 home 目录（默认 ~/.dsh，可用 DSH_HOME 覆盖）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 工具缓存目录。 */
export function toolsDir() {
  return join(dshHome(), 'tools')
}

/** 缓存里的目标路径。 */
export function cachedFfmpegPath() {
  return join(toolsDir(), EXE)
}

/** 当前平台键，如 `win32-x64`。 */
export function platformKey() {
  return `${process.platform}-${process.arch}`
}

async function isExecutable(path) {
  try {
    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 缓存里的 ffmpeg 是否真的就位。 */
export async function hasCachedFfmpeg() {
  return isExecutable(cachedFfmpegPath())
}

async function fromPath() {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of raw.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, EXE)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * 下载并解出 ffmpeg 到工具目录。
 *
 * @param {(text: string) => void} [onProgress]
 * @returns {Promise<string>} 二进制路径
 */
export async function downloadFfmpeg(onProgress = () => {}) {
  const key = platformKey()
  const pkg = PACKAGES[key]
  if (pkg === undefined) {
    throw new Error(
      `没有为 ${key} 准备预编译 ffmpeg。装一个系统 ffmpeg 并把路径写进插件配置的 ffmpegPath，或设环境变量 DSH_FFMPEG。`,
    )
  }

  const dir = toolsDir()
  await mkdir(dir, { recursive: true })
  const target = join(dir, EXE)
  const scratch = `${target}.download`

  let lastError
  for (const mirror of MIRRORS) {
    const url = `${mirror}/@ffmpeg-installer/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`
    try {
      onProgress(`正在从 ${new URL(mirror).host} 下载 ffmpeg（${pkg.name} ${pkg.version}）…`)
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const tgz = Buffer.from(await response.arrayBuffer())
      const hit = extractLargest(tgz, (name) => /(^|\/)ffmpeg(\.exe)?$/.test(name))
      if (hit === undefined) throw new Error('压缩包内没有 ffmpeg 可执行文件')
      await writeFile(scratch, hit.data)
      await rm(target, { force: true })
      await rename(scratch, target)
      if (process.platform !== 'win32') await chmod(target, 0o755)
      onProgress(`ffmpeg 已就位：${target}`)
      return target
    } catch (error) {
      lastError = error
      await rm(scratch, { force: true }).catch(() => {})
    }
  }

  throw new Error(
    `下载 ffmpeg 失败（最后一个错误：${lastError instanceof Error ? lastError.message : String(lastError)}）。` +
      `可以在 ${target} 手动放一个 ffmpeg 可执行文件，或用配置项 ffmpegPath / 环境变量 DSH_FFMPEG 指定。`,
  )
}

/**
 * 解析出可用的 ffmpeg；全都没有就下载。
 *
 * @param {object} options
 * @param {string} [options.explicit] config.ffmpegPath
 * @param {string[]} [options.extraCandidates] 额外的候选路径（如 node_modules 里的预编译包）
 * @param {boolean} [options.allowDownload]
 * @param {(text: string) => void} [options.onProgress]
 * @returns {Promise<string>}
 */
export async function ensureFfmpeg(options = {}) {
  const { explicit, extraCandidates = [], allowDownload = true, onProgress } = options

  const candidates = []
  if (typeof explicit === 'string' && explicit.trim() !== '') candidates.push(explicit.trim())
  if (typeof process.env.DSH_FFMPEG === 'string' && process.env.DSH_FFMPEG.trim() !== '') {
    candidates.push(process.env.DSH_FFMPEG.trim())
  }
  candidates.push(cachedFfmpegPath(), ...extraCandidates)

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }

  const onPath = await fromPath()
  if (onPath !== undefined) return onPath

  if (!allowDownload) {
    throw new Error(`没有找到 ffmpeg。把它放到 ${cachedFfmpegPath()}，或用 config.ffmpegPath / DSH_FFMPEG 指定。`)
  }
  return downloadFfmpeg(onProgress)
}
