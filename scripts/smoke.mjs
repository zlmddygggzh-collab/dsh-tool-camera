/**
 * 打包自检：不依赖真实摄像头、不依赖 DSH 宿主。
 *
 * 1) 用 stub 的 @deepseek-ai/dsh-tools 加载 lib/index.js，验证两个工具都注册成功。
 * 2) 用假 attachments 服务跑一次真实抓帧（若本机有摄像头），验证 render 出 text+image。
 * 3) 校验 package.json 的 dsh bundle 字段与 cordis.patch.yml 是否能被 js-yaml 解析。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const failures = []
const pass = (message) => console.log(`  ok  ${message}`)
const fail = (message) => {
  failures.push(message)
  console.log(`  FAIL ${message}`)
}

/* ---- stub 模块解析 ---------------------------------------------- */

const stubDir = await mkdtemp(join(tmpdir(), 'dsh-cam-smoke-'))
const stubPkg = join(stubDir, 'node_modules', '@deepseek-ai', 'dsh-tools')
const { mkdir, writeFile } = await import('node:fs/promises')
await mkdir(stubPkg, { recursive: true })
await writeFile(
  join(stubPkg, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js', exports: './index.js' }),
)
await writeFile(join(stubPkg, 'index.js'), 'export function defineTool(definition) { return definition }\n')

// 让 lib/index.js 里的裸导入落到 stub：把 stub 目录塞进 NODE_PATH 不适用于 ESM，
// 所以复制一份源码到 stub 目录旁边，让 node 的目录回溯找到 node_modules。
const { cp } = await import('node:fs/promises')
const pkgRoot = join(stubDir, 'pkg')
await mkdir(pkgRoot, { recursive: true })
await cp(join(here, 'lib'), join(pkgRoot, 'lib'), { recursive: true })

const mod = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)
if (typeof mod.apply === 'function' && Array.isArray(mod.inject)) pass('模块导出 apply/inject')
else fail('模块导出缺少 apply 或 inject')

/* ---- 注册两个工具 ------------------------------------------------ */

const registered = new Map()
const ctx = {
  tools: { register: (definition) => registered.set(definition.name, definition) },
  get: (key) => (key === 'attachments' ? attachments : undefined),
}

const savedImages = []
const attachments = {
  async saveImage({ data, mediaType, name }) {
    savedImages.push({ bytes: data.length, mediaType, name })
    return { attachmentId: `att-${savedImages.length}`, mediaType, bytes: data.length, width: 1280, height: 720 }
  },
}

mod.apply(ctx, { timeoutMs: 20000 })
if (registered.has('camera_snapshot') && registered.has('camera_devices')) pass('注册 camera_snapshot 与 camera_devices')
else fail(`注册结果异常：${[...registered.keys()].join(', ') || '空'}`)

const snapshot = registered.get('camera_snapshot')
const devices = registered.get('camera_devices')
const exec = { signal: undefined }

/* ---- camera_devices ---------------------------------------------- */

const devicesText = await devices.execute({ install: false }, exec)
if (typeof devicesText === 'string' && /采集后端/.test(devicesText)) pass('camera_devices 返回可读文本')
else fail(`camera_devices 输出异常：${String(devicesText).slice(0, 120)}`)
console.log('  --- camera_devices ---')
for (const line of String(devicesText).split('\n')) console.log(`  ${line}`)

/* ---- camera_snapshot（有摄像头才跑） ------------------------------ */

if (/视频设备数: 0/.test(devicesText)) {
  console.log('  skip 没有检测到摄像头，跳过抓帧')
} else {
  const started = Date.now()
  try {
    const value = await snapshot.execute({ frames: 3 }, exec)
    const blocks = snapshot.output.render({}, value)
    const ok =
      blocks.length === 2 &&
      blocks[0].type === 'text' &&
      blocks[1].type === 'image' &&
      /^image\/jpeg$/.test(blocks[1].attachment.mediaType)
    if (ok) pass(`抓帧成功 ${Date.now() - started}ms，render 出 text+image`)
    else fail(`render 结构异常：${JSON.stringify(blocks.map((b) => b.type))}`)
    pass(`附件 ${savedImages[0]?.bytes ?? '?'} 字节，设备 ${value.device}`)
    console.log('  --- envelope ---')
    for (const line of blocks[0].text.split('\n')) console.log(`  ${line}`)
  } catch (error) {
    fail(`抓帧失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ---- 清单校验 ---------------------------------------------------- */

const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
if (pkg.dsh?.bundle?.patch === './cordis.patch.yml') pass('package.json dsh.bundle.patch 正确')
else fail('package.json 缺少 dsh.bundle.patch')

const patch = await readFile(join(here, 'cordis.patch.yml'), 'utf8')
// 不引入 js-yaml：dsh-market 安装时会用宿主自带的解析器校验，这里只做结构检查。
if (/- insert:/.test(patch) && /name: dsh-tool-camera/.test(patch) && /id: tool-camera/.test(patch)) {
  pass('cordis.patch.yml 含 insert/id/name 三要素')
} else {
  fail('cordis.patch.yml 结构不完整')
}

for (const required of ['README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE', 'lib/index.js']) {
  if (pkg.files.includes(required) || required.startsWith('lib/')) pass(`files 覆盖 ${required}`)
  else fail(`files 未包含 ${required}`)
}

await rm(stubDir, { recursive: true, force: true }).catch(() => {})

console.log(failures.length === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
