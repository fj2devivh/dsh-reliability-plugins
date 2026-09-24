/**
 * dsh-intent-guard 的离线回归 smoke。
 *
 * ## 它守的是什么
 *
 * 双区模式的安全保证只有一条：**意图层拿到 `deny: [write, edit]` 的工具掩码**。
 * 这条保证此前没有任何离线断言 —— 插件目录里只有 `index.js`/`package.json`，
 * 而 `STAND.md` 的步骤台账里根本没有它。本脚本就是那条断言。
 *
 * ## 三条设计纪律（都是本项目付过学费的）
 *
 * 1. **判据不能是猜的工具名。** 每个被断言的工具名都从**产品真身**读出来：
 *    `resources/app.asar` 里各 `@deepseek-ai/dsh-tool-*` 包的 `defineTool({ name })` 字面量，
 *    再与 preset 组合文件里**真正挂载**的 `tool-*` 行取交集。
 *    `str_replace_editor` 就是这条纪律的样本：它在 asar 里存在，但本组合没挂它 ——
 *    去 restrict 一个没挂的名字会让 `tools.restrict()` 响亮失败（见 README）。
 * 2. **必须跑真实的 `apply`。** 这里不重写 `apply` 的逻辑，只 import 它、喂给真 Cordis。
 *    （`dsh-executor-view` 曾经把手写假 ctx 喂给 apply，得到恒真断言 —— 假对象天然拥有一切属性。
 *     所以这里用真 `Context`，agent 的 scoped ctx 由真 `@deepseek-ai/dsh-scope` 的
 *     `createScope` 铸造，掩码落点按 `ScopedLayers` 的真实语义按 scope 记账。）
 * 3. **负对照必须有判别力。** 见文件末尾「负对照」一节：判据被喂进真实的 `apply` 配置里跑一遍，
 *    必须变红；同时把判据函数**当函数**喂进恶意输入，必须返回 false —— 证明它不是恒真。
 *
 * ## 为什么 `tools` 是测试替身
 *
 * 真的 `@deepseek-ai/dsh-tools` 无法 import：它依赖整条 preset 运行时（code runtime、
 * JSON-schema 编译器、PTC、presentation）。所以闸门插件的 `inject` 只声明 `agents`，
 * 而 `tools` 在**每个 agent 的 scoped ctx** 上由真产品提供。
 * 因此这里提供一份**忠实替身**：`restrict()` 的三条拒绝规则是逐字从真实现抄的
 * （`node_modules/@deepseek-ai/dsh-tools/lib/index.js:2790-2805`，路径在 app.asar 内）：
 *   - 没有 scope 就拒绝；
 *   - 名字里含 `run_code` 就拒绝（保留的 PTC transport 名）；
 *   - 名字不在本 scope 的 `restrictableNames` 里就拒绝。
 * 「替身」只影响本脚本，不影响生产；它的价值是**在真 apply 路径上真的会被触发**。
 *
 * ## 跑法
 *
 *     node "D:\<dsh-plugin-root>\DSH Desktop\插件\dsh-intent-guard\smoke.mjs"
 *
 * 退出码：0 全绿 / 1 有断言失败 / 2 缺依赖（**不是插件坏了**）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGINS_ROOT = dirname(PLUGIN_DIR)
const VENDOR = join(PLUGINS_ROOT, '_tools', 'vendor', 'node_modules')
const ASAR = 'D:\\<dsh-plugin-root>\\DSH Desktop\\resources\\app.asar'
const ASAR_INNER_ROOT = 'node_modules/@deepseek-ai'
const PRESET_ID = 'dual'
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const PRESET_FILE = [
  join(dshHome, '.agent-presets', PRESET_ID, 'agent.cordis.yml'),
  join(PLUGIN_DIR, 'fixtures', `agent.cordis.${PRESET_ID}.yml`),
].find((candidate) => existsSync(candidate))

let passed = 0
const failures = []
const ok = (label, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${String(detail).slice(0, 400)}`}`)
  }
}

//#region 缺依赖必须响亮（exit 2，不是断言失败）

const cordisPath = [
  join(VENDOR, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  join(PLUGINS_ROOT, '_asar', 'dsh-client-modules', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
].find((candidate) => existsSync(candidate))
const scopePath = [
  join(VENDOR, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js'),
].find((candidate) => existsSync(candidate))
/** `_asar` 只是调试 dump，随时可能被清掉 —— 只当**回退**用，绝不当前置依赖。 */
const ASAR_DUMP = join(PLUGINS_ROOT, '_asar')
const BASE_PATCH_IN_ASAR = `${ASAR_INNER_ROOT}/dsh-base/cordis.patch.yml`
const BASE_PATCH_IN_DUMP = join(ASAR_DUMP, 'dsh-base', 'cordis.patch.yml')

if (cordisPath === undefined || scopePath === undefined || !existsSync(ASAR) || PRESET_FILE === undefined) {
  console.error('缺依赖，不是插件坏了：')
  if (cordisPath === undefined) console.error(`  - 找不到真 cordis（既不在 ${VENDOR}，也不在 _asar 回退位）`)
  if (scopePath === undefined) console.error(`  - 找不到真 @deepseek-ai/dsh-scope（本回归用它铸造真实 scoped agent ctx）`)
  if (!existsSync(ASAR)) console.error(`  - 找不到 app.asar：${ASAR}（工具名出处的唯一真身）`)
  if (PRESET_FILE === undefined) console.error(`  - 找不到 preset 组合文件：${join(dshHome, '.agent-presets', PRESET_ID, 'agent.cordis.yml')}`)
  console.error('本脚本不读环境变量之外的东西，也不回退到猜出来的工具名 —— 缺什么就报什么。')
  process.exit(2)
}

console.log(`cordis   来源：${relative(PLUGINS_ROOT, cordisPath)}`)
console.log(`dsh-scope来源：${relative(PLUGINS_ROOT, scopePath)}`)
console.log(`app.asar 来源：${ASAR}`)
console.log(`preset   来源：${PRESET_FILE}`)

const { Context, Service } = await import(pathToFileURL(cordisPath).href)
const { createScope, scopeOf } = await import(pathToFileURL(scopePath).href)

//#endregion

//#region 工具名出处：从 app.asar 的 defineTool({ name }) 字面量里读

/** 读 asar 头部（布局与 _tools/asar-read.mjs 一致，已实测核对）。 */
function asarHeader() {
  const fd = openSync(ASAR, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerPickleSize = head.readUInt32LE(8)
    const headerBuffer = Buffer.alloc(headerPickleSize - 4)
    readSync(fd, headerBuffer, 0, headerBuffer.length, 16)
    return { header: JSON.parse(headerBuffer.toString('utf8')), dataOffset: 12 + headerPickleSize }
  } finally {
    closeSync(fd)
  }
}

const { header: ASAR_HEADER, dataOffset: ASAR_DATA } = asarHeader()
const asarNode = (innerPath) => {
  let node = ASAR_HEADER
  for (const segment of innerPath.split('/').filter(Boolean)) node = node?.files?.[segment]
  return node
}
const asarRead = (innerPath) => {
  const node = asarNode(innerPath)
  if (node === undefined || node.files !== undefined) throw new Error(`asar: not a file: ${innerPath}`)
  const fd = openSync(ASAR, 'r')
  try {
    const buffer = Buffer.alloc(Number(node.size))
    readSync(fd, buffer, 0, buffer.length, ASAR_DATA + Number(node.offset))
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}
const asarList = (innerPath) => {
  const node = innerPath === '' ? ASAR_HEADER : asarNode(innerPath)
  if (node?.files === undefined) throw new Error(`asar: not a directory: ${innerPath}`)
  return Object.keys(node.files)
}

/**
 * 全局工具名 → 出处。判据是 `defineTool({ name: "..." })` 字面量；
 * 另外收 `toolName: "..."` 字面量（`dsh-tool-subagent` 是同一个包按配置挂多个工具，
 * 名字写在 config 的 `toolName` 里 —— 只扫 defineTool 会漏掉 `subagent`/`subagent_fork`）。
 */
function buildCatalog() {
  const catalog = new Map()
  for (const pkg of asarList(ASAR_INNER_ROOT).filter((name) => name.startsWith('dsh-tool'))) {
    for (const file of asarList(`${ASAR_INNER_ROOT}/${pkg}/lib`).filter((name) => name.endsWith('.js'))) {
      const inner = `${ASAR_INNER_ROOT}/${pkg}/lib/${file}`
      const source = asarRead(inner)
      for (const pattern of [/defineTool\(\s*\{\s*name:\s*"([^"]+)"/gu, /toolName:\s*"([^"]+)"/gu]) {
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split('\n').length
          if (!catalog.has(match[1])) catalog.set(match[1], `${inner}:${line}`)
        }
      }
    }
  }
  return catalog
}
const CATALOG = buildCatalog()

/** 某个全局工具名在真产品里是否真的存在于某个包里（用于「出处」核对）。 */
const originOf = (name) => CATALOG.get(name)

//#endregion

//#region 组合事实：preset 真正挂了哪些工具（工具名 → 挂载它的包）

/**
 * 从 preset 组合文件里抽 `- id: <row>` / `name: '<pkg>'` 行，并抽该行的 `disabled`。
 * 只做行级扫描：本文件是 `dsh-agent-presets` 的 `Include` 文本，行结构稳定，
 * 且**任何解析失败都会走断言**（下方 ok('preset 行级解析…')），不会静默丢行。
 */
function parsePresetRows(text) {
  const lines = text.split(/\r?\n/u)
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s*id:\s*(\S+)\s*$/u.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const row = { rowId: match[2], line: index + 1, packageName: undefined, toolName: undefined, disabled: false, config: [] }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (/^\s*-\s*id:\s*\S+\s*$/u.test(line) && line.search(/\S/u) <= indent) break
      if (/^\s*#/u.test(line) || line.trim().length === 0) continue
      const indentation = line.search(/\S/u)
      if (indentation <= indent) break
      const packageMatch = /^\s*name:\s*'?([^'\s]+)'?\s*$/u.exec(line)
      if (packageMatch !== null && row.packageName === undefined) row.packageName = packageMatch[1]
      const toolNameMatch = /^\s*toolName:\s*(\S+)\s*$/u.exec(line)
      if (toolNameMatch !== null) row.toolName = toolNameMatch[1]
      if (/^\s*disabled:\s*true\s*$/u.test(line)) row.disabled = true
      // `disabled: !!js process.platform === 'win32'` 这类行要**求值**，不能一律当禁用：
      // tool-bash 在 Windows 上确实不挂，而 tool-pwsh 在 Windows 上**是挂的** ——
      // 把后者误判成禁用，就会把「pwsh 必须保留」这条断言建在空气上。
      const platformMatch = /^\s*disabled:\s*!!js\s*(.+process\.platform[^\n]*)$/u.exec(line)
      if (platformMatch !== null) {
        const predicate = platformMatch[1].replace(/^process\.platform/u, 'PLATFORM')
        try {
          // eslint-disable-next-line no-new-func -- 求值的是产品自己的 preset 表达式，不是用户输入
          if (new Function('PLATFORM', `return (${predicate})`)(process.platform) === true) row.disabled = true
        } catch {
          row.disabled = true
        }
      }
      row.config.push(line)
    }
    rows.push(row)
    index += 0
  }
  return rows
}

const PRESET_TEXT = readFileSync(PRESET_FILE, 'utf8')
// base patch **优先从真 app.asar 取**，`_asar` dump 只当回退。
// 踩过的坑（独立复核者点名）：这里原本硬编码 `_asar\dsh-base\cordis.patch.yml`，
// 而 `_asar` 是 23 MB 的临时 dump、随时可能被清掉 —— 它一没，`readFileSync` 会以
// ENOENT **崩成 exit 1**，把「缺依赖」误报成「插件/回归坏了」。现在两条路都不通时走 exit 2。
const baseTextFromAsar = (() => {
  try {
    return asarRead(BASE_PATCH_IN_ASAR)
  } catch {
    return undefined
  }
})()
const baseTextFromDump = existsSync(BASE_PATCH_IN_DUMP) ? readFileSync(BASE_PATCH_IN_DUMP, 'utf8') : undefined
const BASE_TEXT = baseTextFromAsar ?? baseTextFromDump
const BASE_SOURCE = baseTextFromAsar !== undefined
  ? `app.asar:${BASE_PATCH_IN_ASAR}`
  : baseTextFromDump !== undefined ? `_asar 回退:${relative(PLUGINS_ROOT, BASE_PATCH_IN_DUMP)}` : undefined
console.log(`base patch 来源：${BASE_SOURCE ?? '(两处都取不到)'}`)
if (BASE_TEXT === undefined) {
  console.error('缺依赖，不是插件坏了：')
  console.error(`  - 取不到 dsh-base 的 cordis.patch.yml：既不在 ${ASAR} 内的 ${BASE_PATCH_IN_ASAR}，也不在回退位 ${BASE_PATCH_IN_DUMP}`)
  console.error('  （它是「host 组合挂了哪些工具」的另一半真身；缺了它就无法判定 write/edit 是否真在本组合里）')
  process.exit(2)
}
const rows = [...parsePresetRows(BASE_TEXT), ...parsePresetRows(PRESET_TEXT)]

/** 包名 → 该包贡献的全局工具名。名字不是猜的：每个都必须在 asar 的 defineTool 里出现过。 */
const PACKAGE_TOOLS = {
  '@deepseek-ai/dsh-tool-fs': ['read', 'write', 'edit', 'read_image'],
  '@deepseek-ai/dsh-tool-fs-search': ['glob', 'grep'],
  '@deepseek-ai/dsh-tool-pwsh': ['pwsh'],
  '@deepseek-ai/dsh-tool-bash': ['bash'],
  '@deepseek-ai/dsh-tool-jobs': ['job_list', 'job_output', 'job_kill'],
  '@deepseek-ai/dsh-tool-todo': ['todo_write'],
  '@deepseek-ai/dsh-tool-goal': ['get_goal', 'create_goal', 'update_goal'],
  '@deepseek-ai/dsh-tool-subagent-control': ['send_message', 'interrupt_agent'],
  '@deepseek-ai/dsh-tool-skill': ['skill'],
  '@deepseek-ai/dsh-tool-web': ['web_search', 'web_fetch'],
  '@deepseek-ai/dsh-tool-present': ['present'],
  '@deepseek-ai/dsh-tool-ask-user': ['ask_user_question'],
  '@deepseek-ai/dsh-tool-str-replace-editor': ['str_replace_editor'],
}

const mountedToolNames = new Set()
for (const row of rows) {
  if (row.disabled || row.packageName === undefined) continue
  for (const tool of PACKAGE_TOOLS[row.packageName] ?? []) mountedToolNames.add(tool)
  if (row.packageName === '@deepseek-ai/dsh-tool-subagent' && row.toolName !== undefined) mountedToolNames.add(row.toolName)
}

/**
 * 「写类」工具：名字由**产品自身的全局工具目录**逐字点名（`dsh-base/README.zh.md`
 * 「默认文件编辑使用 `read`、`write` 和 `edit`」+ 两个包里的 `defineTool` 字面量），
 * 这里只断言「写类 ∩ 本组合真正挂载的」这一集合 —— 也就是掩码**必须**覆盖的集合。
 */
const WRITE_CLASS = ['write', 'edit', 'str_replace_editor']

/**
 * **眼睛**（2026-09-19 用户要求"能力级的不可看"）。
 *
 * 这几个工具必须**从意图层的工具表里整个消失** —— 不是"拦一下"，
 * 是它在自己的模型可见面上看不到这些工具。它能自己打开的只剩指南针
 * （`read_compass` / `list_compass`，实现里只有一条白名单）。
 *
 * 注意 `READ_ONLY` 的**含义变了**：它原来包含 `read`/`glob`/`grep`/`pwsh`
 * （那时意图层必须保留这些去"亲自验收"）。用户 2026-09-19 推翻了那个设计
 * （「那就是它越界了」），所以现在它们属于**必须拿掉**的那一半；
 * 「不许被误删」的那一半变成：派活 / 派审计 / 记账 / 对话 / 指南针。
 */
const EYES_CLASS = ['read', 'read_image', 'glob', 'grep', 'pwsh', 'bash']
/** 意图层**必须**保留的工具（拿掉它们，它就干不了活了）。 */
const KEEP_ALWAYS = ['subagent', 'dispatch_audit', 'send_message', 'list_agents', 'ask_user_question', 'todo_write', 'read_compass', 'list_compass']

function presetConfigOf(text, rowId) {
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${rowId}\\s*$`, 'u').test(line))
  if (start < 0) return undefined
  const indent = lines[start].search(/\S/u)
  const config = []
  for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.trim().length === 0 || /^\s*#/u.test(line)) continue
    if (line.search(/\S/u) <= indent) break
    config.push(line)
  }
  return config.join('\n')
}

// ⚠️ 2026-09-19 改了**判据的形状**：原来是从 config 文本里正则抠 `deny: [...]`（只认行内数组），
// 生成器换成真 js-yaml 渲染（块写法）之后就抠到空数组、断言全红 —— 东西没坏，是判据长在措辞上。
// 现在走**共享的 preset 读取器**（`_tools/preset-read.mjs`，同一处实现，verify-all / verify-presets 也用它）。
const presetRead = await import(pathToFileURL(join(PLUGINS_ROOT, '_tools', 'preset-read.mjs')).href)
const intentGuardConfig = await presetRead.readPresetConfig(PRESET_FILE, 'intent-guard')
if (intentGuardConfig.ok !== true) {
  console.error(`缺依赖/坏文件（exit 2）：读不出 ${PRESET_FILE} 里 intent-guard 的配置 → ${intentGuardConfig.reason}`)
  process.exit(2)
}
const intentGuardConfigText = JSON.stringify(intentGuardConfig.config ?? {})
const configuredDeny = Array.isArray(intentGuardConfig.config?.deny) ? intentGuardConfig.config.deny.map(String) : []
const configuredEyes = Array.isArray(intentGuardConfig.config?.eyes) ? intentGuardConfig.config.eyes.map(String) : []
const configuredPresetId = intentGuardConfig.config?.presetId

console.log('\n== 判据来源（都是从真产品读出来的，不是猜的） ==')
console.log(`  asar 目录里 dsh-tool-* 包声明的全局工具名字面量：${CATALOG.size} 个`)
console.log(`  preset(${PRESET_ID}) + base patch 真正挂载的工具：${[...mountedToolNames].sort().join(', ')}`)
for (const tool of [...WRITE_CLASS, ...EYES_CLASS]) {
  console.log(`  候选 "${tool}" 的出处：${originOf(tool) ?? '(asar 里没有这个字面量)'}｜本组合是否挂载：${mountedToolNames.has(tool)}`)
}
console.log(`  preset 里 intent-guard 的配置：deny=[${configuredDeny.join(', ')}] eyes=[${configuredEyes.join(', ')}] presetId=${String(configuredPresetId)}`)

ok('preset 行级解析抽到了 intent-guard 行', intentGuardConfigText !== undefined)
ok('preset 里 intent-guard 的 presetId 与目录名一致（否则守卫会去筛别的会话）', configuredPresetId === PRESET_ID, `presetId=${String(configuredPresetId)} vs 目录 ${PRESET_ID}`)
ok('每个写类候选都能在 asar 里找到出处', WRITE_CLASS.every((tool) => originOf(tool) !== undefined), WRITE_CLASS.filter((tool) => originOf(tool) === undefined).join(', '))
ok('**每个"眼睛"都能在 asar 里找到出处**（它们是产品自己的工具名，不是我们编的）', EYES_CLASS.every((tool) => originOf(tool) !== undefined), EYES_CLASS.filter((tool) => originOf(tool) === undefined).join(', '))
ok('组合里真的挂载了 write 与 edit（否则本条保证无从谈起）', mountedToolNames.has('write') && mountedToolNames.has('edit'))
ok(
  '组合里真的挂载了那些"眼睛"（不然这条能力级约束是空转的）',
  EYES_CLASS.filter((tool) => mountedToolNames.has(tool)).length >= 4,
  `挂载了：${EYES_CLASS.filter((tool) => mountedToolNames.has(tool)).join(', ')}｜没挂载：${EYES_CLASS.filter((tool) => !mountedToolNames.has(tool)).join(', ') || '(无)'}`,
)
ok(
  'str_replace_editor 在本组合**没有**挂载 —— 所以 deny 名单里不许出现它（真 restrict 对未知名字是响亮失败）',
  !mountedToolNames.has('str_replace_editor') && !configuredDeny.includes('str_replace_editor'),
  `mounted=${mountedToolNames.has('str_replace_editor')} deny=${JSON.stringify(configuredDeny)}`,
)

/** 掩码**必须**覆盖：写类 ∩ 本组合真实挂载。 */
const REQUIRED_DENY = WRITE_CLASS.filter((tool) => mountedToolNames.has(tool)).sort()
/** **能力级拿掉**的眼睛：eyes ∩ 本组合真实挂载（没挂载的名字不必下发，也下发不了）。 */
const REQUIRED_EYES = EYES_CLASS.filter((tool) => mountedToolNames.has(tool)).sort()
ok(
  'preset 的 `eyes` 声明的就是这一批（不许只在代码里默认、而不写进配置）',
  EYES_CLASS.every((tool) => configuredEyes.includes(tool)),
  `preset eyes=${JSON.stringify(configuredEyes)}`,
)

//#endregion

//#region 真 Cordis 里跑真 apply

/**
 * `tools` 的忠实替身：按 `ScopedLayers` 的真实语义按 scope 记账，
 * `restrict()` 的三条拒绝规则逐字抄自真实现（出处写在文件头注释里）。
 *
 * ⚠️ 它**必须**是 `Service` 的子类，不能是裸对象。
 * Cordis 的 `Service` 构造器会给实例挂 `symbols.tracker = { associate: 'tools', property: 'ctx' }`
 * （真 cordis `lib/index.js:1769-1783`），于是**任何 ctx 读 `tools` 时，`this.ctx` 被影子成调用者的 ctx**。
 * 裸对象没有这个 tracker，`this.ctx` 就是 undefined —— 守卫会收到
 * `TypeError: Cannot read properties of undefined (reading 'Symbol(dsh.scope)')` 而静默失效。
 * 这正是本轮踩到并修掉的洞：**替身不像真产品，回归就会把「守卫坏了」报成「守卫没跑」。**
 */
class ToolsStandIn extends Service {
  constructor(ctx, knownTools, registry) {
    super(ctx, 'tools')
    this.knownTools = knownTools
    this.restrictions = registry.restrictions
    this.layersByScope = registry.scoped
    /** `register()` 要往这里写（全局层 + 定义表）。忘了存它，指南针就注册不上。 */
    this.registry = registry
  }
  /**
   * 指南针那两个工具就是从这里进来的。
   * ⚠️ 注册**必须**落到全局层（`registry.globalTools`）：真 `dsh-tools` 的
   * `view()` 只把**继承来的**名字交给掩码判 —— 挂在 agent 自己那一层的工具，
   * 掩码是按不到的（真实现注释：「A restriction filters what a scope inherits …
   * and never what its OWN layer registers」）。所以指南针必须走这条路，
   * 否则"拿掉眼睛、只留指南针"这句话在真产品里不成立。
   */
  register(definition) {
    if (definition === null || typeof definition !== 'object' || typeof definition.name !== 'string') {
      throw new Error('tools.register() requires a definition with a name')
    }
    if (this.restrictableNames().has(definition.name)) {
      throw new Error(`duplicate tool name "${definition.name}"`)
    }
    this.knownTools.add(definition.name)
    this.registry.globalTools.add(definition.name)
    this.registry.definitions.set(definition.name, definition)
  }
  get(name) {
    return this.registry.definitions.get(name) ?? (this.knownTools.has(name) ? { name, execute: () => '' } : undefined)
  }
  layer(scope) {
    if (!this.layersByScope.has(scope)) this.layersByScope.set(scope, { tools: new Set(), restrictions: [] })
    return this.layersByScope.get(scope)
  }
  restrictableNames() {
    const names = new Set(this.knownTools)
    for (const layer of this.layersByScope.values()) for (const name of layer.tools) names.add(name)
    return names
  }
  restrict(filter) {
    // `this.ctx` 由 Cordis 的影子机制换成**调用者**的 ctx（真产品同款语义）。
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    if (filter.allow === undefined && filter.deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    // 负对照 D′ 的开关：模拟"名字存在、但 restrict 拒绝了"（真产品里那是最危险的形态）。
    if (this.failRestrictFor?.has?.(filter.deny?.[0])) {
      throw new Error(`simulated refusal for "${filter.deny[0]}"`)
    }
    const named = [...(filter.allow ?? []), ...(filter.deny ?? [])]
    if (named.includes('run_code')) {
      throw new Error('tools.restrict() cannot name reserved PTC mode presentation transport "run_code"; restrict end-capability tools instead')
    }
    const known = this.restrictableNames()
    const unknown = named.filter((name) => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    this.layer(scope).restrictions.push({ allow: filter.allow, deny: filter.deny })
    this.restrictions.push({ scope, allow: filter.allow, deny: filter.deny })
    // ⚠️ 替身也要**忠实于真契约**：真 `tools.restrict()` 的文档原文是
    //    `@returns the exact disposer that lifts this restriction`。
    //    第一版这里返回 `() => {}`（空转），于是"解除掩码"这条路在回归里**永远测不出来** ——
    //    而它正是用户 2026-09-21 报的故障（切回标准后工具没回来）。
    const entry = { scope, allow: filter.allow, deny: filter.deny }
    const layerEntry = { allow: filter.allow, deny: filter.deny }
    this.restrictions[this.restrictions.length - 1] = entry
    const layerList = this.layer(scope).restrictions
    layerList[layerList.length - 1] = layerEntry
    this.lifted ??= []
    return () => {
      const at = this.restrictions.indexOf(entry)
      if (at >= 0) this.restrictions.splice(at, 1)
      const flatAt = layerList.indexOf(layerEntry)
      if (flatAt >= 0) layerList.splice(flatAt, 1)
      this.lifted.push({ scope, deny: [...(filter.deny ?? [])], allow: [...(filter.allow ?? [])] })
      // 也记到 registry 上（runApply 返回的是 registry，断言读它）
      this.registry.lifted ??= []
      this.registry.lifted.push({ scope, deny: [...(filter.deny ?? [])], allow: [...(filter.allow ?? [])] })
    }
  }
  scopesWithAllow() {
    return this.restrictions.filter((entry) => entry.allow !== undefined)
  }
}

/** 记所有 restrict 调用，供断言用；scope 身份按 `ScopedLayers` 的真实语义按 key 记账。 */
class ToolRegistryDouble {
  constructor() {
    this.globalTools = new Set()
    this.scoped = new Map()
    this.restrictions = []
    this.definitions = new Map()
  }
  register(name) {
    this.globalTools.add(name)
  }
  /** 某 agent 的 scoped ctx 被剥夺了什么（scope key 与 `scopeOf(agentCtx)` 同一身份）。 */
  denyFor(agentCtx) {
    const scope = scopeOf(agentCtx)
    const denied = new Set()
    for (const entry of this.restrictions) if (entry.scope === scope) for (const name of entry.deny ?? []) denied.add(name)
    return denied
  }
  scopesWithAllow() {
    return this.restrictions.filter((entry) => entry.allow !== undefined)
  }
}

/**
 * 用真 Cordis 装一遍，返回可观察事实。`config` 就是插件的配置（默认取 preset 里那份）。
 */
async function runApply({ label, config, denyConfigText, agentCount = 1, failRestrictFor = [], presetRef = undefined }) {
  const loggerCalls = { info: [], warn: [] }
  const realConsoleError = console.error
  const consoleErrors = []
  console.error = (...args) => consoleErrors.push(args.map(String).join(' '))

  const runtime = new ToolRegistryDouble()
  runtime.failRestrictFor = new Set(failRestrictFor)
  const agents = { roots: () => [], list: () => [] }
  const fixtures = []
  const root = new Context()
  // 拦住 logger：插件用的是 `ctx.logger.info(...)`。根 ctx 的 logger 是继承来的访问器，
  // 不走服务路由（不会被 Cordis 挡），所以直接在**这个根实例上**定义同名自有属性即可。
  const inheritedLogger = root.logger
  Object.defineProperty(root, 'logger', {
    value: { info: (message) => loggerCalls.info.push(String(message)), warn: (message) => loggerCalls.warn.push(String(message)) },
    configurable: true,
    writable: true,
  })
  const hasRealLogger = typeof inheritedLogger?.info === 'function'

  // 1) 通用 provider：提供 agentPresets（真实现里由 dsh-agent-presets 提供；这里只固定返回 presetId）
  await root.plugin({
    name: 'agent-presets-stand-in',
    apply(ctx) {
      ctx.reflect.provide('agentPresets', { composedPreset: (scopedCtx) => (scopeOf(scopedCtx) === undefined ? undefined : (presetRef?.value ?? PRESET_ID)) })
    },
  })

  // 2) 真工具注册进**全局层**（base patch 里 tool-fs / tool-fs-search / tool-pwsh 就是挂在这里）
  for (const name of mountedToolNames) runtime.register(name)

  // 3) tools 服务：**必须由不 inject 它的插件 provide**。
  //    踩过的坑：把 `provide('tools')` 放进一个 `inject: ['tools']` 的插件里会自锁 ——
  //    该 fiber 永远等一个只有它自己才会提供的服务，于是它自己永远 PENDING、
  //    `agents` 也永远不出现，后续插件的 apply 静默不跑（不是报错，是根本不执行）。
  //    另一条：替身**不记**任何 provider ctx。真产品的 `tools` 是单例服务，
  //    `restrict()` 按**调用者自己的 ctx**（`ctx.tools.restrict(...)` → `this.ctx`）定 scope；
  //    替身若把 provider 的 ctx 记下来当 scope，就会永远答「这不是 scoped context」，
  //    于是守卫静默失效 —— 那正好是这条回归要抓的东西，绝不能在测试里把它做出来。
  await root.plugin({
    name: 'tools-stand-in',
    apply(ctx) {
      const service = new ToolsStandIn(ctx, mountedToolNames, runtime)
      service.failRestrictFor = runtime.failRestrictFor
    },
  })

  // 4) agent 造册：在**声明了 inject: ['tools']** 的插件里铸造 scoped ctx
  //    （复刻 dsh-agent 的位置关系：agent 的 ctx 由已注入 tools 的 fiber 派生）
  await root.plugin({
    name: 'agents-stand-in',
    inject: ['tools'],
    apply(ctx) {
      ctx.reflect.provide('agents', agents)
      for (let index = 0; index < agentCount; index += 1) {
        const agent = { id: `session-intent-${index + 1}`, session: {} }
        const handle = createScope(ctx, agent)
        agent.ctx = handle.ctx
        fixtures.push({ agent, handle })
      }
      agents.roots = () => fixtures.map((fixture) => fixture.agent)
    },
  })

  // 5) 被测插件：**真** apply，喂真 ctx。
  //    配置走 `plugin(plugin, config)` 的**第二参数**（Cordis 的正式通道）。
  //    反面踩坑记录：写进插件对象的 `config` 字段会被 schema 归一化掉，
  //    `apply(ctx, cfg)` 收到 undefined —— 那样 `presetId` 就丢了，插件走 fail-open，
  //    而守卫「悄悄失效」看起来和「一切正常」一模一样。
  const intentGuard = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href)
  let applyThrew
  let fiber
  try {
    fiber = root.plugin({ name: 'intent-guard', inject: intentGuard.inject, apply: intentGuard.apply }, config)
  } catch (error) {
    applyThrew = error
  }
  await new Promise((resolve) => setTimeout(resolve, 30))
  console.error = realConsoleError
  const fiberState = fiber?.state

  return { label, runtime, agents, fixtures, loggerCalls, consoleErrors, applyThrew, fiber, fiberState, intentGuard, config, denyConfigText, root, hasRealLogger }
}

/** 判定：给定「被掩码剥夺的工具名集合」和「必须覆盖的两个集合」，掩码是否合格。 */
function judgeMask({ denied, required, eyes = [], keep = [], scopesWithAllow }) {
  if (scopesWithAllow > 0) return false
  for (const tool of required) if (!denied.has(tool)) return false
  for (const tool of eyes) if (!denied.has(tool)) return false
  for (const tool of keep) if (denied.has(tool)) return false
  return true
}

console.log('\n== 真 Cordis + 真 apply（默认配置 = preset 里的那份） ==')
const main = await runApply({
  label: 'preset-config',
  config: { enabled: true, deny: configuredDeny, eyes: configuredEyes, logDenied: true, presetId: configuredPresetId },
  denyConfigText: intentGuardConfigText,
  agentCount: 2,
})

ok('注册阶段没有同步抛错', main.applyThrew === undefined, main.applyThrew?.message)
ok(
  '被测插件真的跑起来了：fiber 到达 ACTIVE（=2）—— 若 apply 根本没执行，下面所有断言都会变成「拿空气当证据」',
  main.fiberState === 2,
  `fiber.state=${String(main.fiberState)}（0=PENDING 说明依赖没满足、apply 从未执行；3=FAILED）`,
)
ok('logger 替身装上了（否则「没有 warn」这条断言是恒真的）', main.hasRealLogger === true)
ok('apply 的 fiber 没有把错误吞进 console.error（响亮失败会留痕）', main.consoleErrors.length === 0, main.consoleErrors.join(' | '))
ok('apply 没有留下任何 logger.warn（fail-open / degraded 必须可见，这里应当一条都没有）', main.loggerCalls.warn.length === 0, main.loggerCalls.warn.join(' | '))
ok('apply 确实调用了 ctx.tools.restrict（真实现里这是唯一能剥夺工具的手段）', main.runtime.restrictions.length > 0, `restrict 调用数=${main.runtime.restrictions.length}`)
ok('restrict 是以 deny-only 形式调用的（没有 allow —— allow 会把只读工具也一并剥夺）', main.runtime.scopesWithAllow().length === 0, JSON.stringify(main.runtime.scopesWithAllow()))
ok(
  'restrict 落在了**每个意图层会话自己的 scoped ctx** 上（不是全局层：全局层会锁死所有人，包括执行层）',
  main.fixtures.every((fixture) => main.runtime.restrictions.some((entry) => entry.scope === scopeOf(fixture.agent.ctx))),
  `agent 数=${main.fixtures.length}，被掩码的 scope 数=${new Set(main.runtime.restrictions.map((entry) => entry.scope)).size}`,
)

const deniedForIntentLayer = main.fixtures[0] === undefined ? new Set() : main.runtime.denyFor(main.fixtures[0].agent.ctx)
console.log(`  意图层实际被剥夺：${[...deniedForIntentLayer].sort().join(', ') || '(空)'}`)
ok(
  `deny 覆盖全部「写类 ∩ 本组合已挂载」工具 [${REQUIRED_DENY.join(', ')}]`,
  REQUIRED_DENY.every((tool) => deniedForIntentLayer.has(tool)),
  `缺 ${REQUIRED_DENY.filter((tool) => !deniedForIntentLayer.has(tool)).join(', ') || '(无)'}`,
)
ok(
  `**"眼睛"被能力级拿掉** [${REQUIRED_EYES.join(', ')}] —— 那些工具在它的工具表里不存在`,
  REQUIRED_EYES.every((tool) => deniedForIntentLayer.has(tool)),
  `没拿掉：${REQUIRED_EYES.filter((tool) => !deniedForIntentLayer.has(tool)).join(', ') || '(无)'}`,
)
ok(
  `**干活要用的工具一个都没被误删** [${KEEP_ALWAYS.join(', ')}]`,
  KEEP_ALWAYS.every((tool) => !deniedForIntentLayer.has(tool)),
  `误删 ${KEEP_ALWAYS.filter((tool) => deniedForIntentLayer.has(tool)).join(', ') || '(无)'}`,
)
ok(
  'deny 不含「本组合没挂载的写类工具」（对未知名字 restrict 会响亮失败）',
  [...deniedForIntentLayer].every((tool) => mountedToolNames.has(tool)),
  [...deniedForIntentLayer].filter((tool) => !mountedToolNames.has(tool)).join(', '),
)
ok(
  '掩码合格判定为 true（同一把尺子要能变红，见下面负对照）',
  judgeMask({ denied: deniedForIntentLayer, required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: main.runtime.scopesWithAllow().length }) === true,
)
ok('日志里可见「被剥夺了哪些工具」（事故排障时这条日志是唯一的现场）', main.loggerCalls.info.some((message) => message.includes('read-only for tools')), JSON.stringify(main.loggerCalls.info))
ok(
  '**没有被静默跳过的名字**（跳过的意思是"以为蒙上了其实没蒙"）',
  !main.loggerCalls.warn.some((message) => message.includes('却没能拿掉')),
  main.loggerCalls.warn.join(' | '),
)
ok(
  '  本组合里本来就没有的眼睛（例如 Windows 上没有 bash）记成 info，**不是 warn**（不然天天喊狼来了）',
  main.loggerCalls.info.some((message) => /在本组合里本来就没有/u.test(message)) || EYES_CLASS.every((tool) => mountedToolNames.has(tool)),
  main.loggerCalls.info.filter((message) => /本来就没有/u.test(message)).join(' | ') || '(没有任何缺失的名字)',
)

// ── 指南针：意图层唯一能自己打开的东西 ──
const registeredNames = [...main.runtime.definitions.keys()].sort()
ok(
  '**指南针注册进了全局层**（read_compass / list_compass）',
  registeredNames.includes('read_compass') && registeredNames.includes('list_compass'),
  JSON.stringify(registeredNames),
)
const compassDef = main.runtime.definitions.get('read_compass')
ok(
  '指南针的工具定义是 provider 会接受的那种（parameters.type === "object"）',
  compassDef?.parameters?.type === 'object' && typeof compassDef?.parameters?.properties?.path === 'object',
  JSON.stringify(compassDef?.parameters)?.slice(0, 200),
)
ok('  描述里说清"别的路径一律读不到"（模型看得见边界）', /别的路径一律读不到/.test(String(compassDef?.description)))
ok(
  '  指南针**不在**被拿走的那一批里（拿掉它，意图层就瞎了）',
  !deniedForIntentLayer.has('read_compass') && !deniedForIntentLayer.has('list_compass'),
)

// 模块自述的默认名单必须与 preset 里跑起来的那份一致：两处漂移会让「默认安全」变成错觉。
const defaultDeny = [...main.intentGuard.DEFAULT_DENY].sort()
ok(
  'index.js 的 DEFAULT_DENY 与 preset 实际配置逐字一致',
  JSON.stringify(defaultDeny) === JSON.stringify([...configuredDeny].sort()),
  `DEFAULT_DENY=${JSON.stringify(defaultDeny)} vs preset deny=${JSON.stringify(configuredDeny)}`,
)
ok(
  'index.js 的 DEFAULT_EYES 与 preset 的 `eyes` 逐字一致',
  JSON.stringify([...main.intentGuard.DEFAULT_EYES].sort()) === JSON.stringify([...configuredEyes].sort()),
  `DEFAULT_EYES=${JSON.stringify(main.intentGuard.DEFAULT_EYES)} vs preset eyes=${JSON.stringify(configuredEyes)}`,
)

// 替身的拒绝规则必须与真实现一致 —— 用真实现会拒绝的输入喂它，它也必须拒绝。
// 注意：`restrict()` 只在**真有 scope 的 ctx 上**才会走到那两条规则，所以这里得先造一个 scoped ctx
// （这也正是真实现的入口条件：`tools.restrict() requires a scoped context`）。
const probeLane = await runApply({ label: 'validator-probe', config: { enabled: false }, agentCount: 1 })
const probeCtx = probeLane.fixtures[0]?.agent.ctx
const rejectedByDouble = []
for (const [name, filter] of [['unknown-name', { deny: ['definitely_not_a_tool'] }], ['reserved-run_code', { deny: ['run_code'] }]]) {
  try {
    probeCtx.tools.restrict(filter)
  } catch (error) {
    rejectedByDouble.push(`${name}:${String(error).slice(0, 60)}`)
  }
}
ok('替身复刻了真 restrict 的两条拒绝规则（未知名字 / run_code）', rejectedByDouble.length === 2, JSON.stringify(rejectedByDouble))

//#endregion

//#region 负对照：判据必须有判别力（不是恒真）

console.log('\n== 负对照 A：把写类工具从 deny 里拿掉，判据必须变红 ==')
const withoutWrite = REQUIRED_DENY.filter((tool) => tool !== 'write')
const controlA = await runApply({
  label: 'missing-write',
  config: { enabled: true, deny: withoutWrite, eyes: configuredEyes, logDenied: true, presetId: configuredPresetId },
  agentCount: 1,
})
const controlADenied = controlA.fixtures[0] === undefined ? new Set() : controlA.runtime.denyFor(controlA.fixtures[0].agent.ctx)
console.log(`  这一趟 apply 真实剥夺的：${[...controlADenied].sort().join(', ') || '(空)'}`)
ok(
  `负对照 A 的掩码判定必须为 false（deny=${JSON.stringify(withoutWrite)} 少了 write）`,
  judgeMask({ denied: controlADenied, required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 0 }) === false,
  '判据没有变红 —— 说明它恒真，整份回归没有判别力',
)
ok('负对照 A 的正向断言（deny 必须覆盖 write）确实失败 —— 即上面那条 ok 用的是同一把尺子', !controlADenied.has('write'), `denied=${JSON.stringify([...controlADenied])}`)
ok('负对照 A 里 apply 依然没有抛错（缺名字不会让插件在 apply 期炸掉）', controlA.applyThrew === undefined, controlA.applyThrew?.message)

console.log('\n== 负对照 A′：把"眼睛"从 eyes 里拿掉，判据必须变红 ==')
const controlAEyes = await runApply({
  label: 'missing-eyes',
  config: { enabled: true, deny: configuredDeny, eyes: ['read'], logDenied: true, presetId: configuredPresetId },
  agentCount: 1,
})
const controlAEyesDenied = controlAEyes.fixtures[0] === undefined ? new Set() : controlAEyes.runtime.denyFor(controlAEyes.fixtures[0].agent.ctx)
ok(
  '负对照 A′ 的掩码判定必须为 false（eyes 只剩 read ⇒ glob/grep/pwsh/bash 还在它手里）',
  judgeMask({ denied: controlAEyesDenied, required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 0 }) === false,
  `实际剥夺：${[...controlAEyesDenied].sort().join(', ')}`,
)

console.log('\n== 负对照 B：把"干活要用的工具"塞进 deny，判据必须变红 ==')
// 2026-09-19：判据的含义变了 —— `read` 现在是**该被拿掉**的那一半（"眼睛"），
// 所以"多塞一个只读工具"不再算错。真正会出事的是**误删干活要用的工具**：
// 拿掉 subagent 它没法派活，拿掉 dispatch_audit 它没法验收，拿掉指南针它直接瞎。
const controlB = await runApply({
  label: 'deny-subagent',
  config: { enabled: true, deny: [...configuredDeny, 'subagent'], eyes: configuredEyes, logDenied: true, presetId: configuredPresetId },
  agentCount: 1,
})
const controlBDenied = controlB.fixtures[0] === undefined ? new Set() : controlB.runtime.denyFor(controlB.fixtures[0].agent.ctx)
ok(
  `负对照 B 的掩码判定必须为 false（deny 里混进了 subagent：${JSON.stringify([...controlBDenied])}）`,
  judgeMask({ denied: controlBDenied, required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 0 }) === false,
  '判据没有变红',
)

console.log('\n== 负对照 C：判据函数本身不能恒真（直接喂恶意输入） ==')
ok(
  'judgeMask：写类 + 眼睛都覆盖、且不误删干活工具 → true',
  judgeMask({ denied: new Set([...REQUIRED_DENY, ...REQUIRED_EYES]), required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 0 }) === true,
)
ok(
  'judgeMask：少一个写类工具 → false',
  judgeMask({ denied: new Set(REQUIRED_EYES), required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 0 }) === false,
)
ok(
  'judgeMask：少一个"眼睛" → false',
  judgeMask({ denied: new Set(REQUIRED_DENY), required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 0 }) === false,
)
ok(
  'judgeMask：误删一个干活工具 → false',
  judgeMask({ denied: new Set([...REQUIRED_DENY, ...REQUIRED_EYES, 'read_compass']), required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 0 }) === false,
)
ok(
  'judgeMask：出现任何 allow 形式 → false（allow 会把指南针也一并剥夺）',
  judgeMask({ denied: new Set([...REQUIRED_DENY, ...REQUIRED_EYES]), required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 1 }) === false,
)
ok(
  'judgeMask：空 deny → false（守卫静默失效必须被判红）',
  judgeMask({ denied: new Set(), required: REQUIRED_DENY, eyes: REQUIRED_EYES, keep: KEEP_ALWAYS, scopesWithAllow: 0 }) === false,
)

console.log('\n== 负对照 D：写错一个工具名，**只跳过它自己**，其余照旧生效（而且响亮） ==')
const controlD = await runApply({
  label: 'str-replace-editor',
  config: { enabled: true, deny: [...REQUIRED_DENY, 'str_replace_editor'], eyes: configuredEyes, logDenied: true, presetId: configuredPresetId },
  agentCount: 1,
})
const controlDDenied = controlD.fixtures[0] === undefined ? new Set() : controlD.runtime.denyFor(controlD.fixtures[0].agent.ctx)
console.log(`  这一趟 apply 之后被剥夺的：${[...controlDDenied].sort().join(', ') || '(空)'}`)
// ⚠️ 这一条的**期望值改过**（2026-09-19）。旧实现是把整张名单一次性交给 `restrict()`，
// 于是名单里有一个不存在的名字 ⇒ 真实现响亮失败 ⇒ **一条掩码都没装上**（denied.size === 0）。
// 也就是说：产品哪天把 `read` 改个名，意图层就会**照旧握着它**，而日志里只有一句 warn。
// 现在改成逐个名字下发：改名的那个只跳过它自己，其余照旧，并且跳过的那个会被点名。
ok(
  '写错一个名字 ⇒ 只有它被跳过（掩码不整体失效）',
  controlDDenied.has('write') && controlDDenied.has('edit') && controlDDenied.has('read') && !controlDDenied.has('str_replace_editor'),
  `denied=${JSON.stringify([...controlDDenied])}`,
)
ok(
  '  并且**响亮记下来**（跳过的名字必须点名，绝不静默）',
  controlD.loggerCalls.info.some((message) => message.includes('本来就没有') && message.includes('str_replace_editor')),
  JSON.stringify(controlD.loggerCalls.info),
)
ok('  即便有名字被跳过，apply 也没有把整个 preset 拖死', controlD.applyThrew === undefined && controlD.fiber !== undefined, controlD.applyThrew?.message)

console.log('\n== 负对照 D′：**有这个名字却没拿掉**（restrict 拒绝）⇒ 必须 warn，不能混进"本来就没有" ==')
// 这一条是"能力级那一层到底有没有生效"的**唯一报警器**：
// 真产品里如果 `restrict()` 因为任何原因拒绝了（产品改名、层语义变了、服务被换掉），
// 意图层就**照旧握着 read/pwsh**。那时必须是 warn，而不是一句"本组合里没有"糊过去。
const controlDPrime = await runApply({
  label: 'restrict-refuses',
  config: { enabled: true, deny: configuredDeny, eyes: configuredEyes, logDenied: true, presetId: configuredPresetId },
  agentCount: 1,
  failRestrictFor: ['read'],
})
ok(
  '  这一趟 read **没能被拿掉**（模拟真产品拒绝）',
  controlDPrime.fixtures[0] !== undefined && !controlDPrime.runtime.denyFor(controlDPrime.fixtures[0].agent.ctx).has('read'),
  JSON.stringify([...controlDPrime.runtime.denyFor(controlDPrime.fixtures[0].agent.ctx)]),
)
ok(
  '  ⇒ 日志里出现 **warn「这些工具存在、却没能拿掉」**，并点名 read',
  controlDPrime.loggerCalls.warn.some((message) => message.includes('却没能拿掉') && message.includes('read')),
  JSON.stringify(controlDPrime.loggerCalls.warn),
)
ok(
  '  ⇒ 而且它**不许**被算成"本来就没有"（两者混起来，就等于把报警器拆了）',
  !controlDPrime.loggerCalls.info.some((message) => message.includes('本来就没有') && message.includes('read')),
  JSON.stringify(controlDPrime.loggerCalls.info),
)

//#endregion

//#region 无菌室：**意图层不读源码、不读原始日志、不跑项目代码**

console.log('\n== 无菌室：把意图层的眼睛蒙上，只让它看报表 ==')

// 用户的原话（2026-09-19，架构级修正）：
//   「'意图层本来也需要重新跑一遍执行层的代码' —— **这就是它越界了**……
//    他不仅查不出真正的结构问题，还会被工地的灰尘呛死，最后满脑子都是
//    '这堵墙的水泥标号不够'，完全忘了大楼的整体设计。」
//   「把它的眼睛蒙上，只允许它看报表。把它的手绑住，只允许它写任务。」

// 无菌室是**纯函数判据**，不需要宿主 —— 直接 import 本插件自己那一份导出即可。
const gateRoom = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href)
const room = gateRoom.DEFAULT_CLEAN_ROOM
const judge = (tool, args) => gateRoom.judgeCleanRoom(tool, args, room)

ok(
  '**读源码 ⇒ 拒**',
  ['private_app/champion_v4_hist.py', 'scripts/bench.py', 'src/index.js', 'main.mjs', 'x.ps1'].every((path) => {
    const verdict = judge('read', { file_path: path })
    return verdict !== undefined && /无菌室/.test(verdict)
  }),
)
ok(
  '**读原始日志 ⇒ 拒**',
  ['run.log', '_r19_work/stdout.txt', '_f1_work/stderr.log', 'bench.out', 'a/b.out.txt'].every(
    (path) => judge('read', { file_path: path }) !== undefined,
  ),
)
ok(
  '**但判据 / 原话 / 鉴证报告照读不误**（那是它唯一该看的现场）',
  ['notes/AGENTS.md', 'notes/_user_requirements.json', 'notes/_endstate/spec.json', 'notes/_endstate/audits/T-001-x.json', 'notes/交接文件.md'].every(
    (path) => judge('read', { file_path: path }) === undefined,
  ),
)
ok('  `grep` / `glob` 也按同一套路径判（不是只管 read）', judge('grep', { pattern: 'private_app/*.py' }) !== undefined && judge('glob', { pattern: 'notes/**/*.md' }) === undefined)
ok(
  '**用 shell 读被禁的路径 ⇒ 也拒**（不然 read 那条闸门绕过去了）',
  (() => {
    const verdict = judge('pwsh', { command: "Get-Content 'private_app/champion_v4_hist.py' | Select-Object -First 50" })
    return verdict !== undefined && /命令里在读/.test(verdict)
  })(),
)
ok(
  '**跑项目代码 ⇒ 拒**（验收是审计层的活）',
  ['python scripts/bench.py --seed 42', 'python3 -c "print(1)"', 'node build.mjs', 'pytest -q'].every((command) => {
    const verdict = judge('pwsh', { command })
    return verdict !== undefined && /无菌室/.test(verdict)
  }),
)
ok(
  '  裸解释器（命令里没有源码路径）走的是"裁判长"那条话术，并点名是哪个程序',
  (() => {
    const verdict = judge('pwsh', { command: 'pytest -q' })
    return /裁判长/.test(verdict) && /pytest/.test(verdict) && !/py…|py\)/.test(verdict)
  })(),
)
ok(
  '  带源码路径的 ⇒ 走"读源码"那条话术（两条闸门各管一段，不互相顶替）',
  /命令里在读/.test(judge('pwsh', { command: 'python scripts/bench.py' })),
)
ok('**看一眼环境的命令放行**（它们不碰源码，也不做验收）', judge('pwsh', { command: 'git status --short' }) === undefined && judge('pwsh', { command: 'git log --oneline -5' }) === undefined)
ok('  别的工具一律不管（这条闸门只管"看"与"跑"）', judge('todo_write', {}) === undefined && judge('dispatch_audit', { prompt: 'x' }) === undefined)
ok(
  '**拒绝理由里给出了正确的出路**（派审计 + 收报告），而不是只说"不行"',
  (() => {
    const verdict = judge('read', { file_path: 'private_app/x.py' })
    return /dispatch_audit/.test(verdict) && /鉴证报告/.test(verdict) && /水泥标号/.test(verdict)
  })(),
)
ok(
  '**glob 折正则**：`**/` 匹配零层或多层目录，`*` 不跨目录',
  (() => {
    const r = (pattern, path) => gateRoom.globToRegExp(pattern).test(path)
    return (
      r('**/*.py', 'a.py') === true &&
      r('**/*.py', 'deep/nested/a.py') === true &&
      r('notes/**/*.md', 'notes/x.md') === true &&
      r('notes/**/*.md', 'notes/deep/x.md') === true &&
      r('notes/*.md', 'notes/deep/x.md') === false &&
      r('notes/_endstate/**', 'notes/_endstate/audits/T-1.json') === true
    )
  })(),
)
ok('  路径分隔符两种写法都认（Windows 的反斜杠折成正斜杠再判）', gateRoom.matchesAny('private_app\\x.py', ['**/*.py']) === true)
ok('  关掉开关就不判（`cleanRoom.enabled: false` ⇒ 由 apply 决定不装守卫）', gateRoom.normalize({ cleanRoom: { enabled: false } }).cleanRoom.enabled === false)

// ── `onlyAllow`：从"列黑名单"改成"**只能看这几样**"（2026-09-19 晚）──────────
//
// 用户的原话是一条**硬性约束**：
//   「**严禁意图层读取原始代码、原始报错日志。意图层只能接收由审计层生成的《结构化验收报告》。**」
// 黑名单漏一个扩展名（`.json` / `.csv` / `.npy`），意图层就能接着读现场的泥浆 ——
// 所以判据反过来：**能读的只有 allow 里那几样**。
ok('  默认就是 `onlyAllow`（"只能看报表"，不是"别看源码"）', room.onlyAllow === true && gateRoom.normalize({}).cleanRoom.onlyAllow === true)
ok('  可以由人关掉（退化成黑名单模式）', gateRoom.normalize({ cleanRoom: { onlyAllow: false } }).cleanRoom.onlyAllow === false)
ok(
  '**放行名单照旧：原话 / 判据 / 任务 / 鉴证报告**',
  ['notes/AGENTS.md', 'notes/_user_requirements.json', 'notes/_endstate/spec.json', 'notes/_endstate/tasks.json', 'notes/_endstate/audits/T-001-x.json', 'notes/交接文件.md', 'README.md'].every(
    (path) => judge('read', { file_path: path }) === undefined,
  ),
)
ok(
  '**名单外的现场数据也拒**（这正是一条黑名单永远做不到的："只能"）',
  ['notes/_state.json', '_pair_v6.json', 'notes/成绩.csv', 'notes/日志.txt', 'data/input.npy', 'private_app/model.pkl'].every((path) => {
    const verdict = judge('read', { file_path: path })
    return verdict !== undefined && /只看得到那几样东西/.test(verdict)
  }),
)
ok(
  '  拒绝理由回答了那两件事：**我该看什么**、**人要怎么放宽**',
  (() => {
    const verdict = judge('read', { file_path: '_pair_v6.json' })
    return (
      /measure_gap/.test(verdict) &&
      /dispatch_audit/.test(verdict) &&
      /notes\/_endstate\/audits/.test(verdict) &&
      /请人把它写进/.test(verdict) &&
      /cleanRoom\.allow/.test(verdict) &&
      /只有人能放宽它/.test(verdict)
    )
  })(),
)
ok(
  '  源码/日志仍然走"读源码"那条话术（两条理由各管一段，不互相顶替）',
  /这是源码或原始日志/.test(judge('read', { file_path: 'scripts/bench.py' })) && /这是源码或原始日志/.test(judge('read', { file_path: 'run.log' })),
)
ok(
  '**`glob` / `grep` 也按同一套判，但"范围收进 notes 就不拦"**',
  judge('glob', { pattern: 'notes/**/*.md' }) === undefined &&
    judge('glob', { pattern: '**/*.py' }) !== undefined &&
    judge('grep', { pattern: 'TODO', path: 'notes/_endstate/audits' }) === undefined &&
    judge('grep', { pattern: 'T-001', path: 'notes/_endstate' }) === undefined,
)
ok(
  '  `grep.pattern` 是**正文正则、不是路径**：`grep({pattern:"private_app/*.py"})` 不该被当成"在读源码"',
  (() => {
    const verdict = judge('grep', { pattern: 'private_app/*.py' })
    return verdict !== undefined && !/这是源码或原始日志/.test(verdict)
  })(),
)
ok(
  '  `grep.include` 是文件过滤，也算范围（`include: "*.md"` ⇒ 只扫人写的东西 ⇒ 放行）',
  judge('grep', { pattern: 'T-001', include: '*.md' }) === undefined && judge('grep', { pattern: 'import', include: '*.py' }) !== undefined,
)
ok('  没写范围（想全仓扫）⇒ 拒，并说明"没写范围 = 想全仓扫"', /没写范围/.test(judge('grep', { pattern: 'T-001' })))
ok('  但 `notes` 这种"半开"的目录仍然拒（它下面既有 md 也有现场数据）', judge('grep', { pattern: 'x', path: 'notes' }) !== undefined)
ok(
  '**shell 里读名单外的东西也拒**（`_pair_v6.json` 这种"跑出来的中间产物"）',
  (() => {
    const verdict = judge('pwsh', { command: 'Get-Content _pair_v6.json' })
    return verdict !== undefined && /只看得到那几样东西/.test(verdict)
  })(),
)
ok(
  '  但 shell 里读**放行名单里**的东西照旧放行（不能把正常读写一起禁掉）',
  judge('pwsh', { command: 'Get-Content notes/AGENTS.md' }) === undefined && judge('pwsh', { command: 'git status --short' }) === undefined,
)
ok(
  '  关掉 `onlyAllow` 之后就退回黑名单模式（`_pair_v6.json` 又能读）',
  gateRoom.judgeCleanRoom('read', { file_path: '_pair_v6.json' }, { ...room, onlyAllow: false }) === undefined,
)

ok(
  '  路径政策**可以由人改**（配置能整条替换，不是写死的）',
  (() => {
    const custom = gateRoom.normalize({ cleanRoom: { allow: ['secret/**'], deny: ['**/*.txt'] } })
    return gateRoom.matchesAny('secret/a.txt', custom.cleanRoom.allow) === true && gateRoom.matchesAny('x.txt', custom.cleanRoom.deny) === true
  })(),
)

//#endregion

//#region 指南针：意图层**唯一**能自己打开的东西（真文件，真读）

console.log('\n== 指南针：拿掉通用读工具之后，它靠什么活 ==')

// 用户的原话（2026-09-19）：
//   「是需要**能力级的不可看**，只有那些最重要的东西作为意图层的指南针，
//    因为意图层就**必须贯彻我的意志，不能自作主张**。」
//
// 所以判据分两层：① 通用读工具**不存在**（上面的掩码，已在真 ctx 上断言过）；
// ② 指南针的实现里**只有一条白名单** —— 别的路径它压根不会打开。
{
  const lab = mkdtempSync(join(tmpdir(), 'intent-guard-compass-'))
  const ws = join(lab, 'ws')
  mkdirSync(join(ws, 'notes', '_endstate', 'audits'), { recursive: true })
  mkdirSync(join(ws, 'private_app'), { recursive: true })
  writeFileSync(join(ws, 'notes', 'AGENTS.md'), '# 我的原话\n> 排班顺序不许自己发明\n', 'utf8')
  writeFileSync(join(ws, 'notes', '_endstate', 'spec.json'), '{"schema":"endstate-spec/v1","clauses":[]}\n', 'utf8')
  writeFileSync(join(ws, 'notes', '_endstate', 'audits', 'T-001-x.json'), '{"clause":"T-001","verdict":"conforms"}\n', 'utf8')
  writeFileSync(join(ws, 'notes', '_state.json'), '{"workers":12}\n', 'utf8')
  writeFileSync(join(ws, 'notes', '成绩.csv'), 'a,b\n1,2\n', 'utf8')
  writeFileSync(join(ws, 'private_app', 'champion.py'), 'print(1)\n', 'utf8')
  writeFileSync(join(ws, '_pair_v6.json'), '{"disc":{"reward":72}}\n', 'utf8')
  const read = (path, extra = {}) => gateRoom.readCompassFile({ cwd: ws, path, ...extra })

  ok('**指南针能打开人的原话**', read('notes/AGENTS.md').ok === true && /不许自己发明/.test(read('notes/AGENTS.md').text))
  ok('  也能打开判据、终局定义、**鉴证报告**', read('notes/_endstate/spec.json').ok === true && read('notes/_endstate/audits/T-001-x.json').ok === true)
  ok('  返回带行号（要能引用 `notes/AGENTS.md:2` 这种出处）', /^\s*1: /m.test(read('notes/AGENTS.md').text) && /<lines>1-3 \/ 3<\/lines>/.test(read('notes/AGENTS.md').text), read('notes/AGENTS.md').text)

  ok('**源码打不开**（private_app/*.py）', read('private_app/champion.py').ok === false && /指南针/.test(read('private_app/champion.py').text))
  ok('**现场数据打不开**（notes/_state.json / _pair_v6.json / *.csv）', [read('notes/_state.json'), read('_pair_v6.json'), read('notes/成绩.csv')].every((r) => r.ok === false))
  ok(
    '**`..` 逃逸打不开**（`notes/../../x.md` 这类，一律拒 —— 不存在"解析之后再判"那套把戏）',
    ['notes/../../x.md', '../x.md', 'notes/..', 'notes/a/../../b.md'].every((path) => read(path).ok === false && /\.\./.test(read(path).text)),
  )
  ok(
    '**绝对路径打不开**（Windows 盘符 / UNC / 根）',
    ['C:/Windows/system.ini', 'C:\\Windows\\win.ini', '/etc/passwd', '//server/share/x.md'].every((path) => {
      const verdict = read(path)
      return verdict.ok === false && /绝对路径/.test(verdict.text)
    }),
  )
  ok(
    '  目录不给读（列目录要用 list_compass）',
    read('notes/_endstate/audits').ok === false && /是个目录/.test(read('notes/_endstate/audits').text),
    read('notes/_endstate/audits').text,
  )
  ok('  半开的目录（notes / notes/_endstate）**连名单都过不去**，走的是"不在指南针里"', read('notes').ok === false && /不在放行名单里/.test(read('notes').text))
  ok(
    '  不存在的文件说"没有这个文件"，不是静默空串',
    read('notes/nope.md').ok === false && /没有这个文件/.test(read('notes/nope.md').text),
    read('notes/nope.md').text,
  )
  ok('  二进制不给读', (() => {
    writeFileSync(join(ws, 'notes', 'bin.md'), Buffer.from([0x00, 0x01, 0x02]))
    return read('notes/bin.md').ok === false && /二进制/.test(read('notes/bin.md').text)
  })())
  ok('  超大文件不给读（指南针不搬大文件）', (() => {
    writeFileSync(join(ws, 'notes', 'big.md'), 'x'.repeat(2000), 'utf8')
    return read('notes/big.md', { maxBytes: 100 }).ok === false && /超过上限/.test(read('notes/big.md', { maxBytes: 100 }).text)
  })())
  ok('  分页（offset / limit）真的按行切', (() => {
    writeFileSync(join(ws, 'notes', 'lines.md'), Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 行`).join('\n'), 'utf8')
    const page = read('notes/lines.md', { offset: 3, limit: 2 })
    return page.ok === true && /<lines>3-4 \/ 10<\/lines>/.test(page.text) && /3: 第 3 行/.test(page.text) && !/第 5 行/.test(page.text)
  })())
  ok('  上限由配置兜住（`maxLines` 不给就能一次读爆上下文）', read('notes/lines.md', { limit: 999, maxLines: 4 }).text.includes('<lines>1-4 / 10</lines>'))

  const list = (pattern) => gateRoom.listCompassFiles({ cwd: ws, pattern })
  ok('**list 只列指南针里的东西**（源码/现场数据一个都不出现）', (() => {
    const text = list('').text
    return text.includes('notes/AGENTS.md') && text.includes('notes/_endstate/audits/T-001-x.json') && !text.includes('champion.py') && !text.includes('_state.json') && !text.includes('_pair_v6.json') && !text.includes('成绩.csv')
  })(), list('').text)
  ok('  可以按 glob 收窄', (() => {
    const text = list('notes/**/*.md').text
    return text.includes('notes/AGENTS.md') && !text.includes('spec.json')
  })(), list('notes/**/*.md').text)
  ok('  list 的 pattern 也不许是绝对路径 / 带 `..`', list('C:/Windows/*.md').ok === false && list('../**/*.md').ok === false)
  ok('  一个都找不到时**说清为什么**（不是空白）', (() => {
    const text = list('notes/**/*.zzz').text
    return /没找到/.test(text) && /指南针只看得到/.test(text)
  })(), list('notes/**/*.zzz').text)

  rmSync(lab, { recursive: true, force: true })
}

//#endregion

//#region 离开双区 ⇒ **把眼睛还回去**（2026-09-21 用户现场：切回标准后工具没了）
//
// 用户的原话：
//   「现在有个问题，标准模式的工具怎么没了，标准模式不是和双区一个的啊，
//     标准模式是不变的啊，怎么双区的插件还影响到标准模式上面去了」
//
// 现场实据（会话日志 `session-c0d18796`）：创建时是 `standard`，9/20 15:32 选了 `dual`，
// 9/21 19:49 又选回 `standard` —— 可它手里**还是没有 read/pwsh**，模型如实回了一句
// 「我这边没有任何文件/bash 工具」。根因不是"污染标准模式"（标准预设是原厂的、
// profile 层也没挂本插件），而是：**掩码是能力级的、粘在 agent 上**，
// 而第一版把 `restrict()` 返回的**解除器丢掉了** ⇒ 会话切走之后眼睛睁不回来。
console.log('\n== 离开双区 ⇒ 把眼睛还回去（用户 2026-09-21 现场）==')
{
  // **可变**的 preset：模拟"这个会话先属于双区、后来被切回标准"（用户 9/21 19:49 做的事）
  const presetRef = { value: PRESET_ID }
  const switching = await runApply({
    label: 'preset-switch',
    config: { enabled: true, deny: configuredDeny, eyes: configuredEyes, logDenied: true, presetId: configuredPresetId },
    denyConfigText: intentGuardConfigText,
    agentCount: 1,
    presetRef,
  })
  const agent = switching.fixtures[0].agent
  const deniedNow = () => switching.runtime.denyFor(agent.ctx)
  ok('前置：会话属于双区 ⇒ **眼睛确实被拿掉了**', deniedNow().size > 0, `deny=${[...deniedNow()].join(',') || '(空)'}`)

  // 切回标准（界面上改选 preset）—— 这正是 9/21 19:49 那一步
  presetRef.value = 'standard'
  switching.root.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 200))

  ok(
    '**切回标准之后：掩码被解除（工具还回去）** —— 这就是"标准模式没工具"的修法',
    deniedNow().size === 0,
    `还剩 ${[...deniedNow()].join(',') || '(空)'}`,
  )
  ok('  解除的记录看得见（不是静默发生）', (switching.runtime.lifted ?? []).length > 0, `lifted=${(switching.runtime.lifted ?? []).length}`)
  ok(
    '  而且**记了一条日志**说清"它离开了这个 preset"（现场能查）',
    switching.loggerCalls.info.some((m) => m.includes('已离开 preset')),
    switching.loggerCalls.info.slice(-2).join(' | '),
  )
  ok(
    '  解除过程本身不产生 warn（只有"没解掉"才算事故）',
    !switching.loggerCalls.warn.some((m) => m.includes('解除掩码失败')),
    switching.loggerCalls.warn.join(' | '),
  )

  // 负对照：**还在双区**的会话，一条掩码都不许解除
  presetRef.value = PRESET_ID
  const before = (switching.runtime.lifted ?? []).length
  switching.root.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 150))
  ok(
    '**负对照：还在双区的会话，掩码一条都不许解除**（否则"眼睛蒙上"就成了摆设）',
    (switching.runtime.lifted ?? []).length === before && deniedNow().size > 0,
    `lifted 增量=${(switching.runtime.lifted ?? []).length - before}，deny=${[...deniedNow()].join(',') || '(空)'}`,
  )
}

//#endregion

console.log(`\n${'='.repeat(64)}`)
console.log(`intent-guard: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('通过：preset 配置下，真 apply 在真 Cordis 里把 write/edit **与那些"眼睛"**都剥夺了，')
  console.log('      subagent / dispatch_audit / 指南针原样保留；指南针只打得开白名单里的东西；')
  console.log('      负对照全部按预期变红（少一个"眼睛"、误删干活工具、restrict 拒绝时都会报警）。')
}
