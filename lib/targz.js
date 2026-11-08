/**
 * 极简 .tar.gz 读取器。
 *
 * 只为了从 npm tarball 里取出一个可执行文件，所以刻意不引入 tar 依赖：
 * Node 自带 zlib，tar 的 ustar 头是定长 512 字节，解析成本极低。
 * 支持长文件名（GNU 'L' 与 pax 'x'）与目录项跳过，不做硬链接/设备节点。
 */
import { gunzipSync } from 'node:zlib'

const BLOCK = 512

function cstring(buf, start, end) {
  const slice = buf.subarray(start, end)
  const nul = slice.indexOf(0)
  return slice.toString('utf8', 0, nul === -1 ? slice.length : nul)
}

function octal(buf, start, end) {
  const text = cstring(buf, start, end).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * 解出 tar.gz 里的全部普通文件条目。
 *
 * @param {Buffer} tgzBuffer 未解压的 .tar.gz 原始字节
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function readTarGz(tgzBuffer) {
  const tar = gunzipSync(tgzBuffer)
  const entries = []
  let offset = 0
  let pendingName = ''

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break

    const size = octal(header, 124, 136)
    const type = String.fromCharCode(header.at(156))
    const rawName = cstring(header, 0, 100)
    const prefix = cstring(header, 345, 500)
    const name = pendingName !== '' ? pendingName : prefix === '' ? rawName : `${prefix}/${rawName}`
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'L') {
      // GNU 长文件名：这一段的内容就是下一个条目的名字。
      pendingName = tar.toString('utf8', dataStart, dataEnd).replace(/\0+$/, '')
      offset = next
      continue
    }
    if (type === 'x' || type === 'g' || type === 'K') {
      // pax 扩展头，本用途不需要。
      offset = next
      continue
    }
    pendingName = ''

    if (type === '0' || type === '\0') {
      entries.push({ name, data: tar.subarray(dataStart, dataEnd) })
    }
    offset = next
  }

  return entries
}

/**
 * 取体积最大、且名字满足条件的那个文件——平台包里除了 ffmpeg 还有
 * package.json / README，用体积排一遍就稳了。
 *
 * @param {Buffer} tgzBuffer
 * @param {(name: string) => boolean} predicate
 * @returns {{ name: string, data: Buffer } | undefined}
 */
export function extractLargest(tgzBuffer, predicate) {
  let best
  for (const entry of readTarGz(tgzBuffer)) {
    if (!predicate(entry.name)) continue
    if (best === undefined || entry.data.length > best.data.length) best = entry
  }
  return best
}
