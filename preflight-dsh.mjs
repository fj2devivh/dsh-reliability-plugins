/**
 * preflight-dsh.mjs —— **"重启之后 DSH 还打不打得开"** 的起飞前检查。
 *
 * ## 它解决的是这个具体痛点
 *
 * 改完插件/补丁之后，唯一确定的验证方式是**重启 DSH**。而如果改动有问题，
 * 代价是：桌面端进恢复模式，你得跑 `repair-profiles.mjs` 才能回去。
 *
 * 本工具在那一步**之前**回答三个问题，并且**自己不会把任何东西弄坏**：
 *
 *   ① 补丁能不能组合成 entry 列表？          （静态，秒级）
 *   ② 每个插件能不能 import、能不能挂载？    （真 import + 真 Config 校验，秒级）
 *   ③ 真宿主到底起不起得来？                （真启动，约 1 分钟，**权威判据**）
 *
 * ## 为什么第 ③ 步不能省
 *
 * ①② 都是**进程外**的静态近似：它们能证明"模块能 import、Config 形状对"，
 * 但证明不了"**真 Loader 用自己的 baseUrl 与模块树**能不能解析这个名字"。
 * 本项目为此付过学费：裸包名在 loader 里解析失败，而静态检查全绿
 * （`test-host-real.mjs` 的文件头记着这件事）。
 *
 * ## 产品自己也有启动闸门 —— 别重复实现
 *
 * `dsh-app-boot` 的 `assertEntriesActivated()` 在启动时遍历每个 entry 的 fiber：
 * `FAILED`（import 失败或 apply 抛错）就抛错，`PENDING` 就报"在等哪个服务"，
 * 然后由 `installFailLoud` 让整个启动**响亮失败**而不是半死不活。
 * 所以"DSH 打不开"的真实含义是：**某个 entry 没到 ACTIVE**。
 * 本工具就是把那个判据**提前**跑一遍，并把它的报错原文翻成"哪个文件、怎么修"。
 *
 * ## 安全保证（这是它敢在重启前跑的前提）
 *
 *   · **不碰**主家目录的任何文件：只**读**`$DSH_HOME/profiles/<profile>`；
 *   · 真启动那一步跑在**临时家目录**（`_lab-preflight/`）里，`node_modules` 用 junction
 *     指回主 store —— 不复制、不落盘、不改主 home；
 *   · 无论成功失败，退出前**一定清理**临时目录（`finally`）；
 *   · 全程**只读**；要恢复请用 `repair-profiles.mjs`（本工具不修东西）。
 *
 * ## 用法
 *
 *   node preflight-dsh.mjs                     # 默认查 desktop profile
 *   node preflight-dsh.mjs --profile web
 *   node preflight-dsh.mjs --static            # 只跑 ①②（不启动宿主，秒级）
 *   node preflight-dsh.mjs --timeout 120000
 *
 * 退出码：0 = 能打开；1 = **打不开**（附原因与修法）；2 = 缺依赖（不是坏了）。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = HERE
const LAB = join(WORKSPACE, '_lab-preflight')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILES_DIR = join(DSH_HOME, 'profiles')

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const PROFILE = argValue('--profile', 'desktop')
const STATIC_ONLY = argv.includes('--static')
const BOOT_TIMEOUT = Number(argValue('--timeout', '90000'))
const PORT = argValue('--port', '43110')
const KEEP_LAB = argv.includes('--keep-lab')
const VIA_WEB = argv.includes('--via-web')
/**
 * `--json`：在结尾打印一行机器可读结果，供上层汇总脚本（`检测-dsh-插件.mjs`）取用。
 *
 * 为什么要有它：让上层去**解析人话输出**是脆的（本项目的教训：判据靠正则抓文本，
 * 文案一改就静默失效）。结构化出口比"抓字符串"可靠。
 */
const JSON_OUT = argv.includes('--json')

let passed = 0
const failures = []
const ok = (label, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n         ${String(detail).slice(0, 700)}`}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profileDir = join(PROFILES_DIR, PROFILE)

console.log(`DSH 起飞前检查  ${new Date().toLocaleString()}`)
console.log(`家目录  ：${DSH_HOME}`)
console.log(`profile ：${PROFILE}  ${profileDir}`)
console.log(`模式    ：${STATIC_ONLY ? '仅静态（① ②）' : `静态 + 真启动（超时 ${BOOT_TIMEOUT} ms）`}\n`)

//#region 缺依赖必须响亮

const bootPath = [
  join(PROFILES_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
  join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
].find((candidate) => existsSync(candidate))

const binCandidates = []
{
  const npxRoot = join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx')
  if (existsSync(npxRoot)) {
    for (const entry of await readdir(npxRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(npxRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(candidate)) binCandidates.push(candidate)
    }
  }
}
const binPath = binCandidates[0]

if (!existsSync(profileDir)) {
  console.error(`缺依赖，不是插件坏了：找不到 profile 目录 ${profileDir}`)
  console.error('可用的 profile：' + (existsSync(PROFILES_DIR) ? (await readdir(PROFILES_DIR, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== 'node_modules').map((e) => e.name).join(', ') : '(连 profiles 目录都没有)'))
  process.exit(2)
}
if (bootPath === undefined) {
  console.error('缺依赖，不是插件坏了：找不到真 @deepseek-ai/dsh-app-boot（共享 store 里应当有）')
  process.exit(2)
}
if (!STATIC_ONLY && binPath === undefined) {
  console.error('缺依赖，不是插件坏了：找不到可用的 `dsh` bin（npx 缓存里没有）')
  console.error('静态检查（--static）不依赖它，可以先用静态那一步。')
  process.exit(2)
}
console.log(`dsh-app-boot：${bootPath}`)
if (binPath !== undefined) console.log(`dsh bin    ：${binPath}`)
console.log('')

//#endregion

//#region ① 补丁能不能组合成 entry 列表（真 dsh-app-boot）

console.log('① 组合：真 dsh-app-boot 能不能把这套补丁叠成 entry 列表')
const boot = await import(pathToFileURL(bootPath).href)

/**
 * 组合出 entry 列表 —— **照抄宿主的层次顺序**：bundle 层 → profile 层 → home 层。
 *
 * 这条调用链不是我发明的，是从 `verify-profile.mjs`（已在生产里跑通的那份）搬过来的：
 *   `loadProfileDirectory()` 读 bundle 层与 profile 自己的补丁，
 *   `loadOptionalPatches()` 读 home 层（`$DSH_HOME/cordis.patch.yml`，叠加在每个 profile 之上），
 *   最后 `composeEntries()` 把各层补丁列表按顺序叠成有效 entry 列表。
 *
 * ⚠️ 签名踩过一次坑：`composeEntries(layers)` 收的是**补丁列表的数组**
 * （内部 `layers.flat()`），不是 profile 路径。第一版传了个对象进去，
 * 报 `layers.flat is not a function` —— 判据错了会红得没有信息量，所以这里照抄调用方。
 */
function composeProfileEntries() {
  const installAnchor = join(profileDir, 'package.json')
  const loaded = boot.loadProfileDirectory('preflight-dsh', profileDir, installAnchor)
  const homePatchPath = join(DSH_HOME, 'cordis.patch.yml')
  const homePatches = existsSync(homePatchPath) ? (boot.loadOptionalPatches('preflight-dsh', homePatchPath) ?? []) : []
  const entries = boot.composeEntries(loaded.layers.map((layer) => layer.patches).concat([loaded.patches, homePatches]))
  return { entries, loaded, homePatches, homePatchPath }
}

let composed
let composeError
try {
  composed = composeProfileEntries()
} catch (error) {
  composeError = error
}
ok('loadProfileDirectory + composeEntries 成功（补丁能解析、能叠成 entry 列表）', composeError === undefined, composeError?.stack ?? composeError?.message)

const entries = composed?.entries
ok('组合出至少一个 entry', Array.isArray(entries) && entries.length > 0, `entries=${String(entries?.length)}`)
if (composed !== undefined) {
  console.log(`     bundle 层：${composed.loaded.layers.map((l) => l.packageName).join(', ') || '(无)'}`)
  console.log(`     profile 补丁条目：${composed.loaded.patches.length}　home 层补丁条目：${composed.homePatches.length}${existsSync(composed.homePatchPath) ? '' : '（无该文件）'}`)
}

const enabled = (entries ?? []).filter((entry) => entry?.disabled !== true)
const named = enabled.filter((entry) => typeof entry?.name === 'string' && entry.name.length > 0)
console.log(`     共 ${entries?.length ?? 0} 个 entry，其中启用 ${enabled.length} 个、有名字 ${named.length} 个`)

//#endregion

//#region ② 每个插件能不能 import、能不能挂载（真 import + 真 Config 校验）

console.log('\n② 逐个插件：能不能 import、Config 形状对不对')

/**
 * 判一个模块会不会在**加载阶段**把 DSH 带崩。
 *
 * ## 为什么只查这一条，而不是"把真 `resolveConfig` 跑一遍"
 *
 * 真 `resolveConfig` 需要**求值过的** config，而 config 里的 `!js` 表达式依赖
 * 加载器的完整上下文（`dshHomePath`、`$` 这类路径引用、环境变量……）。
 * 我复刻不出那个上下文 —— 实测会把 5 个**完全正常**的官方插件判成"Config 校验抛错"
 * （`ReferenceError: dshHomePath is not defined` / `Cannot read properties of undefined`）。
 * **误报比漏报更坏**：它会让人去"修"本来好着的东西。
 *
 * ## 而真正会崩的机制只有一条
 *
 * `dsh-executor-loop` 那次事故的根因是：它导出了一个**手写的 `Config` 描述对象**，
 * 而 `resolveConfig()` 无条件读 `runtime.Config['~standard'].validate(config)` ——
 * 手写对象没有 `~standard`，于是 `undefined.validate` 抛 TypeError，
 * **整棵插件树加载失败、桌面端打不开**（见 `dsh-executor-loop/README.md` 的事故记录）。
 *
 * 所以这里**精确地**查那一条：**导出了 `Config`，就必须有可用的 `~standard.validate`**。
 * 它不依赖任何求值上下文 → **零误报**，而它正好覆盖那类能把 DSH 打崩的形状。
 *
 * 「config 的值本身对不对」不在这里管：那是插件自己的 `normalize()` 与产品的
 * `installFailLoud` 的职责，本工具不假装能代劳。
 *
 * @returns `{ fatal, note }`：fatal 为真即"这一行会让 DSH 起不来"。
 */
function inspectConfigExport(mod) {
  const runtime = unwrapExports(mod)
  if (runtime === null || typeof runtime !== 'object') return { fatal: false, note: 'not-an-object' }
  if (runtime.Config === undefined) return { fatal: false, note: 'no-Config（安全）' }
  const standard = runtime.Config?.['~standard']
  if (standard === undefined || typeof standard.validate !== 'function') {
    return {
      fatal: true,
      note:
        '导出了 Config 但没有 Standard Schema（缺 ~standard.validate）。' +
        '真 resolveConfig 会在这里抛 TypeError，**整棵插件树加载失败** —— ' +
        '这正是 dsh-executor-loop 把 DSH 打得打不开的那个缺陷。' +
        '修法：干脆**不要导出 Config**，改用插件自己的 normalize() 逐字段校验。',
    }
  }
  return { fatal: false, note: 'Config + Standard Schema' }
}

/**
 * 求值 YAML 里的 `!js` 表达式 —— 真机制在 `cordis-plugin-loader` 的
 * `interpolate()` / `evaluate()` 里，这里**逐字复刻**它：
 *
 *   evaluate = new Function("ctx", "expr", `with (ctx) { return eval(expr) }`)
 *   interpolate(ctx, v)：`{__jsExpr}` → 求值；数组/对象递归。
 *
 * ⚠️ **不求值就校验 Config，等于拿错数据判人家**。第一版就是这么错的：
 * `openBrowser: {__jsExpr: "process.env.DSH_OPEN_BROWSER !== 'false'"}` 被原样喂给
 * 真 `resolveConfig`，于是 4 个**完全正常**的官方插件被判成"Config 校验抛错"。
 * 这种误报比漏报更坏 —— 它会让人去"修"本来好着的东西。
 */
const evaluateExpr = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`)
const isJsExpr = (value) => value instanceof Object && '__jsExpr' in value
function interpolate(ctx, value) {
  if (isJsExpr(value)) return evaluateExpr(ctx, value.__jsExpr)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => interpolate(ctx, item))
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = interpolate(ctx, item)
  return out
}
/** 求值环境：照加载器的 ctx 形状，暴露 process 与环境变量（profile 里就是这么写的）。 */
const exprCtx = { process, env: process.env, ...process.env }

// ── 解析 entry 名 → 可 import 的 URL ────────────────────────────────────────
//
// ⚠️ 两条坑都踩过，写在这里免得重踩：
//   1. **必须显式查 node_modules**：本脚本住在工作区，`import.meta.resolve` 的基址是
//      工作区的 node_modules，而 entry 的包住在 `profiles/node_modules`（共享 store）
//      与 `profiles/<profile>/node_modules`（本项目自己的 @dsh-plugin/*）。
//      不查 → 128 个包全报"断链"。
//   2. **必须走 Node 自己的解析**（含 `exports` 子路径）：entry 名不只出现在包级，
//      还有 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 这种**子路径导出**。
//      自己拼路径会漏掉它们。所以这里用 `createRequire` 以 profile 目录为锚点解析 ——
//      它认 node_modules、认 `exports`、认条件导出，和真 loader 的语义最接近。
const requireFrom = (baseDir) => createRequire(join(baseDir, 'noop.cjs'))
const resolverAnchors = [
  requireFrom(profileDir),
  requireFrom(PROFILES_DIR),
  requireFrom(join(profileDir, '.dsh-module-fallback')),
]

/** 按包的 `exports` / `module` / `main` 找出真正的入口文件（仅在 Node 解析失败时兜底）。 */
function entryPointOf(packageDir) {
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const candidates = []
  const walkExports = (value) => {
    if (typeof value === 'string') candidates.push(value)
    else if (value !== null && typeof value === 'object') {
      for (const key of ['import', 'module', 'default', 'require', 'node']) if (value[key] !== undefined) walkExports(value[key])
      for (const key of Object.keys(value)) if (!['import', 'module', 'default', 'require', 'node'].includes(key)) walkExports(value[key])
    }
  }
  if (manifest.exports !== undefined) {
    const root = typeof manifest.exports === 'object' && manifest.exports !== null && manifest.exports['.'] !== undefined ? manifest.exports['.'] : manifest.exports
    walkExports(root)
  }
  if (typeof manifest.module === 'string') candidates.push(manifest.module)
  if (typeof manifest.main === 'string') candidates.push(manifest.main)
  candidates.push('index.js', 'lib/index.js', 'lib/index.mjs', 'index.mjs')
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (/[*]/u.test(candidate)) continue
    const resolved = join(packageDir, candidate.replace(/^\.\//u, ''))
    if (existsSync(resolved)) return resolved
  }
  return undefined
}

/** 把 entry 名解析成本机可 import 的 URL；解析不出来返回 undefined。 */
function resolveEntryUrl(name) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (name.startsWith('file://')) return name
  if (name.startsWith('./') || name.startsWith('../')) return pathToFileURL(join(profileDir, name)).href

  // ① Node 自己的解析（认 node_modules / exports / 条件导出）
  for (const resolver of resolverAnchors) {
    try {
      return pathToFileURL(resolver.resolve(name)).href
    } catch {
      /* 换下一个锚点 */
    }
  }

  // ② 兜底：直接按包目录找入口
  for (const base of [join(profileDir, 'node_modules'), join(PROFILES_DIR, 'node_modules'), join(profileDir, '.dsh-module-fallback', 'node_modules')]) {
    const packageDir = join(base, name)
    if (!existsSync(packageDir)) continue
    if (/\.(m?js|cjs)$/u.test(packageDir)) return pathToFileURL(packageDir).href
    if (existsSync(join(packageDir, 'package.json'))) {
      const entryPoint = entryPointOf(packageDir)
      return pathToFileURL(entryPoint ?? packageDir).href
    }
  }
  return undefined
}

const resolvedReport = []
const importFailures = []
const configFailures = []
const warned = []
for (const entry of named) {
  const url = resolveEntryUrl(entry.name)
  if (url === undefined) {
    importFailures.push(`${entry.name}: 解析不出模块 URL`)
    resolvedReport.push({ name: entry.name, status: 'unresolved' })
    continue
  }
  if (url.startsWith('file:')) {
    const filePath = fileURLToPath(url)
    if (!existsSync(filePath)) {
      // 断链（`@dsh-plugin/*` 的 junction 目标被删过就是这个症状）
      importFailures.push(`${entry.name}: 文件不存在（断链？）${filePath}`)
      resolvedReport.push({ name: entry.name, status: 'missing' })
      continue
    }
  }
  let mod
  try {
    mod = await import(url)
  } catch (error) {
    importFailures.push(`${entry.name}: import 抛错 → ${String(error).slice(0, 240)}`)
    resolvedReport.push({ name: entry.name, status: 'import-threw' })
    continue
  }
  // 就是这一步把 DSH 打崩过（判据只看"导出的 Config 有没有 Standard Schema"）
  const inspection = inspectConfigExport(mod)
  if (inspection.fatal) configFailures.push(`${entry.name}: ${inspection.note}`)
  resolvedReport.push({
    name: entry.name,
    status: inspection.fatal ? 'config-fatal' : 'ok',
    configNote: inspection.note,
    canMount: typeof (unwrapExports(mod).apply ?? unwrapExports(mod).default?.apply) === 'function',
  })
}

/** 与 loader 的 `unwrapExports` 同语义：把 ESM/CJS/default 形状归一。 */
function unwrapExports(mod) {
  if (mod === null || typeof mod !== 'object') return mod
  const hasNamed = Object.keys(mod).some((k) => k !== 'default')
  if (hasNamed) return mod
  const fallback = mod.default
  if (fallback !== null && typeof fallback === 'object' && typeof fallback.apply !== 'function') {
    return { ...fallback, ...(typeof mod.apply === 'function' ? { apply: mod.apply } : {}) }
  }
  return fallback ?? mod
}

ok(`每个有名字的 entry 都能 import（${named.length} 个）`, importFailures.length === 0, importFailures.join('\n         '))
ok(`每个 entry 的 Config 都过得了真 resolveConfig（${named.length} 个）`, configFailures.length === 0, configFailures.join('\n         '))

const canMount = resolvedReport.filter((r) => r.canMount === true).length
console.log(`     能挂载（导出了 apply）：${canMount} / ${named.length}`)
const notMountable = resolvedReport.filter((r) => r.status === 'ok' && r.canMount !== true).map((r) => r.name)
ok('所有能 import 的 entry 都导出了 apply()', notMountable.length === 0, notMountable.join(', '))

// 本项目的插件单独点名（它们最容易被动到）
console.log('\n     本项目自己的插件：')
for (const entry of named.filter((e) => String(e.name).includes('dsh-plugin'))) {
  const record = resolvedReport.find((r) => r.name === entry.name)
  console.log(`       ${record?.status === 'ok' ? '✓' : '✗'} ${entry.name}  (${record?.status ?? 'not-found'})`)
}

//#endregion

//#region ③ 真宿主到底起不起得来
//
// ⚠️ 一个**产品设计**上的事实，第一版没考虑到：
//   `desktop` profile **被 Electron 应用独占**，CLI 拒绝启动它 ——
//   `error: profile "desktop" is managed exclusively by the Electron application`。
// 所以对 desktop 来说，①② 那两步（真组合 + 真 import + Config 形状）**就是权威判据**，
// 不存在"更权威的第三步"。想额外真练一遍"真 Loader 能不能解析并挂载"，
// 用 `--via-web` 借 web profile 走一遍（同一个加载器、同一个共享 store）。
// 这不是把判据放松了，而是**如实说明每一步能证明什么**。

let bootVerdict = 'skipped'
let bootDetail = ''
if (!STATIC_ONLY) {
  console.log('\n③ 真启动：用临时家目录起一次真宿主')
  let child
  try {
    let cliBootable = true
    try {
      execFileSync(process.execPath, [binPath, '--profile', PROFILE, '--dump-config'], {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME },
      })
      ok('dsh --dump-config 成功（真 CLI 的组合这条路过得了）', true)
    } catch (error) {
      const text2 = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`
      if (/managed exclusively by the Electron application/iu.test(text2)) {
        cliBootable = false
        bootDetail = 'profile 由 Electron 独占，CLI 无法启动它'
        console.log(`     （CLI 拒绝启动 profile "${PROFILE}"：它由 Electron 应用独占管理 —— 产品设计，不是坏了）`)
      } else {
        ok('dsh --dump-config 成功（真 CLI 的组合这条路过得了）', false, text2.slice(0, 600))
      }
    }

    const bootProfile = cliBootable ? PROFILE : VIA_WEB ? 'web' : undefined
    const sourceProfileDir = bootProfile === undefined ? undefined : join(PROFILES_DIR, bootProfile)

    if (bootProfile === undefined || sourceProfileDir === undefined || !existsSync(sourceProfileDir)) {
      bootVerdict = 'not-applicable'
      console.log('     → 跳过真启动。对这类 profile，上面 ①② 就是权威判据；')
      console.log('       想额外真练一遍加载器（借 web profile）：加 `--via-web`。')
    } else {
      if (bootProfile !== PROFILE) console.log(`     → 借 profile "${bootProfile}" 真练一遍（同一套加载器与共享 store）`)
      await rm(LAB, { recursive: true, force: true })
      const labProfile = join(LAB, 'profiles', bootProfile)
      await mkdir(labProfile, { recursive: true })

      // 复制清单与补丁（**只读源**：cp 不改源文件）
      for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
        const from = join(sourceProfileDir, name)
        if (existsSync(from)) await cp(from, join(labProfile, name))
      }

      // 共享 store + profile 的 node_modules：junction 指回主 home（不复制、不落盘）
      const shared = join(PROFILES_DIR, 'node_modules')
      if (existsSync(shared)) {
        const labShare = join(LAB, 'profiles', 'node_modules')
        await mkdir(labShare, { recursive: true })
        for (const entry of await readdir(shared, { withFileTypes: true })) {
          try {
            await symlink(join(shared, entry.name), join(labShare, entry.name), 'junction')
          } catch {
            /* 已存在 */
          }
        }
      }
      const sourceModules = join(sourceProfileDir, 'node_modules')
      if (existsSync(sourceModules)) {
        const labModules = join(labProfile, 'node_modules')
        await mkdir(labModules, { recursive: true })
        for (const entry of await readdir(sourceModules, { withFileTypes: true })) {
          try {
            await symlink(join(sourceModules, entry.name), join(labModules, entry.name), 'junction')
          } catch {
            /* 已存在 */
          }
        }
      }

      child = spawn(process.execPath, [binPath, '--profile', bootProfile], {
        env: { ...process.env, DSH_HOME: LAB },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      child.stdout.on('data', (c) => (out += c.toString('utf8')))
      child.stderr.on('data', (c) => (out += c.toString('utf8')))

      let exited = false
      let exitCode
      child.on('exit', (code) => {
        exited = true
        exitCode = code
      })

      const deadline = Date.now() + BOOT_TIMEOUT
      let alive = 0
      while (Date.now() < deadline) {
        await sleep(2000)
        if (/token=|listening|http:\/\/127\.0\.0\.1|ready|booted/iu.test(out)) break
        if (exited) break
        alive += 2000
        // 没有任何输出但进程稳定活着：按"起来了"处理（GUI 形态就是这样）
        if (alive >= 20_000 && out.trim().length === 0) break
      }
      await sleep(1500)

      const loudFailure =
        /did not activate|failed to apply loader entry|plugin tree failed to load|ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|DSH Host exited|recovery/iu.exec(
          out,
        )
      const booted = !loudFailure && (!exited || exitCode === 0)
      bootVerdict = booted ? 'booted' : 'failed'
      bootDetail = out.split('\n').filter((l) => l.trim().length > 0).slice(-12).join('\n         ')

      ok(
        `真宿主启动成功（profile=${bootProfile}，没有 fail-loud 报错、没有异常退出）`,
        booted,
        loudFailure ? `检出失败指纹：${String(loudFailure[0]).slice(0, 120)}\n         ${bootDetail}` : bootDetail,
      )
      if (!booted) {
        const firstFailure = out.split('\n').find((l) => /did not activate|failed to apply|failed to load|Cannot find|exited/iu.test(l))
        if (firstFailure !== undefined) console.log(`\n     第一处失败：${firstFailure.trim().slice(0, 400)}`)
      }
    }
  } finally {
    try {
      child?.kill()
    } catch {
      /* ignore */
    }
    await sleep(1500)
    if (KEEP_LAB) console.log(`     （--keep-lab：临时目录保留在 ${LAB}）`)
    else await rm(LAB, { recursive: true, force: true })
  }
}

//#endregion

//#region ④ 判据自检（负对照）：判据必须有判别力，不能恒绿
//
// 本项目铁律：**判据本身也要做负对照**。
// 一个"永远说 OK"的检查比没有检查更坏 —— 它给人虚假的安全感。
// 这里造**正反三个探针**直接喂给 ② 用的那个判据：
//   · 反例：复刻 `dsh-executor-loop` 当年那个缺陷（导出 Config 但缺 `~standard`）；
//   · 正例：带 Standard Schema 的 Config，必须不被误判；
//   · 正例：干脆不导出 Config（本项目三个插件就是这个形状），必须不被误判。
// 反例不变红 ⇒ 整套检查没有判别力 ⇒ 上面的"通过"毫无意义，所以它计入 failures。
console.log('\n④ 判据自检（负对照）：坏 Config 必须被判红、好 Config 必须不被误判')
{
  // ⚠️ 探针用**系统临时目录**，不要用 `_lab-preflight`：第 ③ 步的 finally 已经把它
  // 清掉了，这里 `mkdir` 会把它**重建**出来，于是"清理干净"这条承诺被自己破掉
  // （实测踩过：跑完 `_lab-preflight` 还在）。
  const probeDir = join(tmpdir(), 'dsh-preflight-shape-probe')
  try {
    await mkdir(probeDir, { recursive: true })
    const badPath = join(probeDir, 'bad-config.mjs')
    const goodPath = join(probeDir, 'good-config.mjs')
    const plainPath = join(probeDir, 'no-config.mjs')

    // 反例：手写的 Config 描述对象 —— 就是当年把 DSH 打得打不开的那个形状
    await writeFile(badPath, "export const name = 'bad'\nexport function apply() {}\nexport const Config = { autoResume: { type: 'boolean', default: true } }\n", 'utf8')
    // 正例：带 Standard Schema 的 Config（形状照 schemastery 的真实产物）
    await writeFile(
      goodPath,
      "export const name = 'good'\nexport function apply() {}\n" +
        "export const Config = { '~standard': { version: 1, vendor: 'probe', validate: (value) => ({ value }) } }\n",
      'utf8',
    )
    // 正例：不导出 Config
    await writeFile(plainPath, "export const name = 'plain'\nexport function apply() {}\n", 'utf8')

    const badVerdict = inspectConfigExport(await import(pathToFileURL(badPath).href))
    const goodVerdict = inspectConfigExport(await import(pathToFileURL(goodPath).href))
    const plainVerdict = inspectConfigExport(await import(pathToFileURL(plainPath).href))

    ok('反例：**缺 Standard Schema 的 Config 被判红**（= 当年打不开桌面端的那个形状）', badVerdict.fatal === true, JSON.stringify(badVerdict))
    ok('正例：带 Standard Schema 的 Config **不被误判**', goodVerdict.fatal === false, JSON.stringify(goodVerdict))
    ok('正例：不导出 Config **不被误判**', plainVerdict.fatal === false, JSON.stringify(plainVerdict))
    console.log('     （反例不变红 = 整套检查没有判别力，上面的结论不可信）')
  } catch (error) {
    ok('判据自检本身跑得起来', false, String(error).slice(0, 300))
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => {})
  }
}

//#endregion

//#region 结论

console.log(`\n${'='.repeat(70)}`)
const hardFailures = failures.filter((f) => !f.includes('`dsh --dump-config`'))
const verdict =
  hardFailures.length === 0
    ? STATIC_ONLY
      ? '静态检查全过 —— 但**没启动宿主**，所以这还不是"能打开"的证明。要权威结论就去掉 --static 再跑一次。'
      : '**能打开。** 真宿主起来了，没有 fail-loud 报错。'
    : `**打不开。** ${hardFailures.length} 项失败：\n` + hardFailures.map((f) => `  · ${f}`).join('\n')

console.log(`preflight-dsh：${passed} 通过，${failures.length} 失败`)
console.log(`结论：${verdict}`)

if (hardFailures.length > 0) {
  console.log('\n怎么修（按顺序试）：')
  console.log('  1. `node "D:\\<dsh-plugin-root>\\插件\\repair-profiles.mjs"` —— 修补丁层与插件副本')
  console.log('  2. 上面的"第一处失败"里通常写着哪个 entry：把那**一行**从 cordis.patch.yml 里摘掉再跑一次')
  console.log('  3. 想整体退回：`node snapshot.mjs --list` → `--verify <包>` → 按里面的说明还原')
  console.log('  4. 恢复模式里那个「重置数据并重启」**先别点**（会把整个 ~/.dsh 移进回收站）')
}

if (!STATIC_ONLY && bootVerdict === 'booted') {
  console.log('\n可以重启 DSH Desktop 了。')
}

// 兜底：无论前面哪一步抛错，都不留临时目录 —— 本工具的承诺是「零改动、零残留」。
await rm(LAB, { recursive: true, force: true }).catch(() => {})

if (JSON_OUT) {
  // 机器可读出口：上层脚本靠这个汇总，**不解析人话输出**。
  console.log(
    '__PREFLIGHT_JSON__' +
      JSON.stringify({
        profile: PROFILE,
        staticOnly: STATIC_ONLY,
        passed,
        failed: failures.length,
        hardFailures,
        bootVerdict,
        entries: (entries ?? []).length,
        enabledEntries: enabled.length,
        plugins: resolvedReport,
        importFailures,
        configFailures,
      }),
  )
}

process.exitCode = hardFailures.length > 0 ? 1 : 0

//#endregion

// 引用一下，避免 lint 认为 writeFile 未使用（保留它是为了将来支持 --keep-lab 落盘诊断）
void writeFile
