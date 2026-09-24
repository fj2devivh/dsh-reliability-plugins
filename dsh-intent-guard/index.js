/**
 * dsh-intent-guard —— 意图层的两道硬闸门：**手绑住**、**眼睛蒙上**。
 *
 * ## 这个插件在生产里坏过一次，两个 bug 都写在这里（2026-09-15）
 *
 * 症状：开了双区之后，**没有任何一个会话能改文件** —— 意图层不能（设计如此），
 * 它派出去的执行层也不能（bug），连**别的对话框里的 standard 会话**也不能（bug）。
 *
 * 1. **误锁子 agent**：判据靠嗅探 `agent.session.header` 上的 `origin` / `parentSession`，
 *    而这个判定发生在 `agent/created` 那一刻 —— 那时子会话的身份**还没登记完**，
 *    于是认不出「这是我派出去的手」，把它也锁了。
 *    日志实证：8 条 `is read-only`、**0 条** `left writable`。
 *    → 修法：改用产品自己的定义 `ctx.agents.roots()`
 *      （`dsh-agent` registry：`roots()` = "created without an owning agent context"），
 *      并且**等身份登记完再判**（见 `guard` 的 attempt 重试）。
 *
 * 2. **跨 preset 泄漏**：`ctx.agents.list()` 返回**进程内所有** agent，不只是本 preset 的。
 *    于是在意图层挂载时，它顺手把别的会话（包括 standard 的）也锁了 ——
 *    日志里 `session-2a51223a…`（一个 standard 会话）确实被锁。
 *    → 修法：只用 `agentPresets.composedPreset(agentScopeCtx) === composedPreset(本挂载)`
 *      过滤出**加入了本 preset** 的会话。拿不到这个服务就**一个都不锁**（fail-open 并告警）——
 *      锁错人的代价（所有人都不能干活）远大于少锁一次。
 *
 * ## 两道闸门（2026-09-19 的第二道）
 *
 * | 闸门 | 手段 | 强度 |
 * |---|---|---|
 * | **手绑住** | `tools.restrict({ deny: [write, edit] })` | 工具级：连「能改」这个选项都看不见 |
 * | **眼睛蒙上** | 同样用 `restrict` 把 `read` / `read_image` / `glob` / `grep` / `pwsh` / `bash` **整个拿掉**，另给两个只能看「指南针」的只读工具（`read_compass` / `list_compass`） | **能力级**：那些工具在它的模型可见面上**不存在** |
 *
 * 用户的原话（2026-09-19）：
 * > 「**严禁意图层读取原始代码、原始报错日志。意图层只能接收由审计层生成的《结构化验收报告》。**」
 * > 「是需要**能力级的不可看**，只有那些最重要的东西作为意图层的指南针，
 * > 因为意图层就**必须贯彻我的意志，不能自作主张**。」
 *
 * 为什么"路径黑名单 + guard 拦一下"不够：那还是**同一个工具**（`read`）在判路径，
 * 漏一个扩展名就漏一片；而且判据活在措辞上，改个写法就可能绕过。
 * 现在改成：**那个工具根本不在它的工具表里** —— 这是结构性的，
 * 它连"要不要试一下"都不存在。能看的只有一个"指南针"工具，而那个工具的实现里
 * **只有**一条白名单，别的路径它压根不会打开。
 *
 * ## 边界（如实标注，不假装是安全边界）
 *
 * - 这是**工具 schema 级**的约束，不是文件系统级沙箱：理论上仍可**派人**去看
 *   （`subagent` / `dispatch_audit` 是它的合法手段）—— 但那是「它读到报告」，
 *   不是「它自己趴到工地上」。真要连这条路也堵死，得在环境层做只读挂载。
 * - 若某个名字在本组合里不存在（产品改名），那一条会**响亮记下来**（日志 + 工具回执），
 *   并退回 guard 层按路径拦 —— 绝不静默当成"已经蒙上了"。
 *
 * @module @dsh-plugin/intent-guard
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * 把 glob 折成一个正则（只支持 `**`、`*`、`?` 三种，够用且不会过度承诺）。
 *
 * ⚠️ 刻意**不**引入 glob 库：这个插件的依赖面一直是零（只用 node: 内置），
 * 而路径政策要判的东西很简单。宁可自己写 20 行，也不为它多一个依赖。
 */
export function globToRegExp(pattern) {
  const normalized = String(pattern).replaceAll('\\', '/')
  let out = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*' && normalized[index + 1] === '*') {
      // `**/` 匹配"任意层目录（含零层）"，`**` 单独出现匹配任意字符
      if (normalized[index + 2] === '/') {
        out += '(?:.*/)?'
        index += 2
      } else {
        out += '.*'
        index += 1
      }
      continue
    }
    if (char === '*') {
      out += '[^/]*'
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`${out}$`, 'u')
}

/** 一条路径是否命中某个 glob 列表。 */
export function matchesAny(path, patterns) {
  const normalized = String(path ?? '').replaceAll('\\', '/').replace(/^\.\//u, '')
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized))
}

/** 从工具参数里取出"它想读哪个路径"（不同工具字段名不一样）。 */
export function targetPathOf(tool, args) {
  const raw =
    args?.file_path ?? args?.path ?? args?.filePath ?? args?.pattern ?? args?.glob ?? args?.directory ?? args?.dir ?? ''
  return String(raw ?? '')
}

/**
 * **无菌室判据**（纯函数，可离线断言）。
 *
 * @returns `undefined`（放行）或一段**给人看的拒绝理由**
 */
export function judgeCleanRoom(tool, args, policy) {
  const allow = policy?.allow ?? DEFAULT_CLEAN_ROOM.allow
  const deny = policy?.deny ?? DEFAULT_CLEAN_ROOM.deny
  const runDeny = policy?.runDeny ?? DEFAULT_CLEAN_ROOM.runDeny
  const runAllow = policy?.runAllow ?? DEFAULT_CLEAN_ROOM.runAllow
  const onlyAllow = policy?.onlyAllow ?? DEFAULT_CLEAN_ROOM.onlyAllow

  const refuse = (what, target) =>
    `【无菌室】**意图层不读源码、不读原始日志** —— 不给你看：${what}${target.length > 0 ? `（${target}）` : ''}。\n` +
    '     那种活是这么干的：**派一个审计任务**（`dispatch_audit`），让它去跑，' +
    '     你只收《鉴证报告》（`notes/_endstate/audits/`）。\n' +
    '     理由（用户的原话）：整天钻进工地的总架构师，只会满脑子都是"这堵墙的水泥标号不够"，' +
    '     然后忘掉大楼的整体设计。'

  /**
   * `onlyAllow` 模式下**不是源码、也不是日志**的东西被挡住时的那段话。
   * 它必须回答两个问题：**我该看什么**、**人要怎么放宽**。
   */
  const refuseOutside = (target) =>
    `【无菌室】**意图层只看得到那几样东西** —— 不给你看：${target}。\n` +
    '     你能读的只有：人的原话（`notes/**/*.md`、`notes/AGENTS.md`）、判据与终局状态与任务\n' +
    '     （`notes/_endstate/**`）、以及**审计层交回来的《鉴证报告》**（`notes/_endstate/audits/**`）。\n' +
    '     现场数据、跑出来的中间产物、源码、日志 —— **都不是给你看的**：\n' +
    '     你要的"现在差多少"由 `measure_gap` / `next_action` 算给你，' +
    '     "到底行不行"由**审计层**（`dispatch_audit`）跑给你。\n' +
    '     如果你确实需要看别的东西：请人把它写进 `notes/` 的 `.md`，' +
    '     或让他在 preset 配置里把这一个路径加进 `cleanRoom.allow`（**只有人能放宽它**）。\n' +
    '     ⚠️ 通用读工具（read / glob / grep / shell）**已经从你的工具表里拿掉了** ——\n' +
    '     这不是"劝你别用"，是那些工具在你这里不存在。'

  /** 一个词看起来像不像路径（用来判 shell 命令里在读什么）。 */
  const looksLikePath = (word) => /[\\/]/u.test(word) || /\.(?:[a-z0-9]{1,6})$/iu.test(word)

  // `read_image` 与 `read` 走同一套路径判据（它就是"按路径打开一个文件"的另一种形态）。
  if (tool === 'read' || tool === 'read_image') {
    const target = targetPathOf(tool, args)
    if (target.length === 0) return undefined
    if (matchesAny(target, allow)) return undefined
    if (matchesAny(target, deny)) return refuse('这是源码或原始日志', target)
    if (onlyAllow) return refuseOutside(target)
    return undefined
  }

  if (tool === 'glob' || tool === 'grep') {
    // ⚠️ 两个工具的 `pattern` **不是一回事**：
    //   · `glob.pattern` 是**路径**（`notes/**/*.md`）⇒ 拿它判；
    //   · `grep.pattern` 是**正文正则**（`T-001`），它**不是路径**，拿它判会判出笑话。
    //     真正决定"看哪儿"的是 `grep.path`（范围）与 `grep.include`（文件过滤）。
    const scope = String(args?.path ?? args?.file_path ?? args?.directory ?? args?.dir ?? '')
    const spec = tool === 'glob' ? String(args?.pattern ?? args?.glob ?? '') : String(args?.include ?? '')
    const scopes = [scope, spec].filter((value) => value.length > 0)
    if (scopes.length === 0) return onlyAllow ? refuseOutside('（没写范围 = 想全仓扫）') : undefined
    // 一个目录只要它**整个子树**都在放行名单里，就算放行
    // （`notes/_endstate` ⇒ `notes/_endstate/**` 命中名单；而 `notes` 不含 ⇒ 仍然拒）。
    const allowed = (value) => matchesAny(value, allow) || matchesAny(`${value.replace(/\/+$/u, '')}/**`, allow)
    if (scopes.some(allowed)) return undefined
    const touched = scopes.filter((value) => matchesAny(value, deny))
    if (touched.length > 0) return refuse('这是源码或原始日志', touched.slice(0, 3).join('、'))
    if (onlyAllow) return refuseOutside(scopes.slice(0, 2).join('、'))
    return undefined
  }

  if (tool === 'pwsh' || tool === 'bash') {
    const command = String(args?.command ?? args?.script ?? args?.cmd ?? '')
    // ① 用 shell 读被禁的路径（不然 read 那条闸门绕过去了）
    const words = command.split(/[\s'"|;()]+/u).filter((word) => word.length > 0)
    const touched = words.filter((word) => matchesAny(word, deny) && !matchesAny(word, allow))
    if (touched.length > 0) return refuse('命令里在读源码或原始日志', touched.slice(0, 3).join('、'))
    // ①′ `onlyAllow`：命令里出现"像路径、却不在放行名单里"的词 ⇒ 一样拒
    //     （`Get-Content notes/交接文件.md` 放行；`Get-Content _pair_v6.json` 拒）
    if (onlyAllow) {
      const outside = words.filter((word) => looksLikePath(word) && !matchesAny(word, allow) && !matchesAny(word, deny))
      if (outside.length > 0) return refuseOutside(outside.slice(0, 3).join('、'))
    }
    // ② 跑项目代码（验收是审计层的活；看一眼环境的命令放行）
    if (runAllow.some((allowed) => command.includes(allowed))) return undefined
    // 按**命令里的词**判程序名（不是按前缀猜 —— 第一版用 `py ` 前缀，结果 `pytest` 被报成 `py`）
    const tokens = command
      .split(/[\s'"|;&()]+/u)
      .map((token) => token.replace(/\.(?:exe|cmd|bat|ps1)$/iu, '').toLowerCase())
      .filter(Boolean)
    const running = tokens.find((token) => runDeny.includes(token))
    if (running !== undefined) {
      return (
        `【无菌室】**验收不是你的活** —— 不许跑项目代码（${running}）。\n` +
        '     你是**裁判长，不是验尸官**：你下发验收标准，**审计层**去跑，你只看它交的《鉴证报告》。\n' +
        '     这样你的注意力才不会被报错堆栈劫持 —— 那正是"变蠢、搞发明"的起点。'
      )
    }
    return undefined
  }

  return undefined
}

/** 稳定的 Cordis 插件名。 */
export const name = 'intent-guard'

/**
 * 需要 `ctx.agents` 给每个会话装掩码；需要 `ctx.tools` 注册**指南针**那两个只读工具
 * （并且用同一个服务下发掩码）。
 */
export const inject = ['agents', 'tools']

/**
 * 默认拒绝的**变更类**工具（手绑住）。
 *
 * ⚠️ 只放**已核实存在于本组合**的全局工具名：`tools.restrict()` 对未知名字是响亮失败的。
 * 但这里**不再靠"名字全对"来保证安全** —— `guard` 里是**逐个名字**下发掩码的，
 * 哪一个不存在就只跳过哪一个，并且响亮记下来（见 `applyMask`）。
 * 刻意不写：`str_replace_editor`（本机组合里没有）、`run_code`（restrict 明确拒绝的保留名）。
 * 刻意不拒绝：jobs、web_search、web_fetch、subagent、dispatch_audit、send_message、
 * list_agents、todo_write、goal 系列。其中 `subagent` / `dispatch_audit` 是关键 ——
 * 那是意图层干活（派活 / 派审计）的唯一手段。
 */
export const DEFAULT_DENY = ['write', 'edit']

/**
 * **意图层不许有的"眼睛"**（2026-09-19 用户要求"能力级的不可看"）。
 *
 * 这些工具一拿掉，它就**没有工具**能打开源码、日志、或者名单外的现场数据了 ——
 * 不是"拦一下"，是那个工具在它的工具表里**不存在**。
 *
 * | 工具 | 为什么必须拿掉 |
 * |---|---|
 * | `read` | 通用读文件：路径判不完（漏一个扩展名就漏一片） |
 * | `read_image` | 同样是按路径打开文件（截图里就是代码和报错） |
 * | `glob` | 能枚举全仓文件（"看一眼有什么"就会看到 `_r*_work/`） |
 * | `grep` | 能在全仓里搜正文（等于把源码读进来） |
 * | `pwsh` / `bash` | 万能后门：`Get-Content`、`findstr`、`python -c` 都能读 |
 *
 * 拿掉之后它靠什么活：`read_compass` / `list_compass`（只能看 `cleanRoom.allow` 里那几样），
 * 加上 `read_terminal` / `measure_gap` / `tasks` 那套闭环工具与《鉴证报告》。
 */
export const DEFAULT_EYES = ['read', 'read_image', 'glob', 'grep', 'pwsh', 'bash']

/**
 * **无菌室**的默认路径政策（2026-09-19 加，见 `guard` 里那段注释）。
 *
 * `allow` 比 `deny` **优先**（人写的东西、判据、鉴证报告，永远读得到）；
 * `deny` 里是两类东西：**源码**与**原始日志**。
 *
 * ⚠️ `onlyAllow`（2026-09-19 晚加）：**只放行 `allow` 里那一类东西，其余一律不看**。
 *
 * 为什么要有它 —— 用户下的是一条**硬性约束**，不是一句建议：
 *   「**严禁意图层读取原始代码、原始报错日志。意图层只能接收由审计层生成的《结构化验收报告》。**」
 *
 * 而"列一份黑名单"永远做不到"只能"：漏掉一个扩展名（`.json` / `.csv` / `.txt` / `.npy`…），
 * 意图层就能接着读现场的泥浆 —— 那正是它"变蠢、搞发明"的入口。
 * 所以判据要**反过来**：能读的只有 `allow` 里那几样（人的原话、判据、任务、鉴证报告），
 * 其余一律拒，并在拒绝理由里告诉它该派 `dispatch_audit`、以及告诉人**怎么放宽**
 * （把东西放进 `notes/` 写成 `.md`，或在 preset 配置里加 `cleanRoom.allow`）。
 *
 * ⚠️ **这份 `allow` 同时就是「指南针」的定义**（`read_compass` / `list_compass` 用它）：
 * 一处定义，两处使用 —— 免得"guard 放行的"和"指南针能打开的"悄悄漂移成两套。
 */
export const DEFAULT_CLEAN_ROOM = {
  enabled: true,
  /** 只放行 `allow`（默认**开**）。关掉它就退回"黑名单"模式。 */
  onlyAllow: true,
  /** 放行：判据 / 原话 / 终局状态 / 鉴证报告 —— 意图层**只该**看这些。 */
  allow: ['notes/AGENTS.md', 'notes/_user_requirements.json', 'notes/_endstate/**', 'notes/**/*.md', '**/*.md'],
  /** 禁读：源码与原始日志（这两类就是"工地的泥浆"）。 */
  deny: [
    '**/*.py',
    '**/*.js',
    '**/*.mjs',
    '**/*.cjs',
    '**/*.ts',
    '**/*.ps1',
    '**/*.bat',
    '**/*.cmd',
    '**/*.ipynb',
    '**/*.log',
    '**/stdout*',
    '**/stderr*',
    '**/*.out',
    '**/*.out.txt',
    '_*_work/**',
    '_r*_work/**',
    '_f*_work/**',
    '**/__pycache__/**',
  ],
  /** 跑项目代码（验收是审计层的活）时拒掉的命令形状。 */
  runDeny: ['python', 'python3', 'py', 'node', 'npm', 'pnpm', 'pnpx', 'npx', 'pytest', 'pwsh', 'powershell', 'bash', 'sh', 'make'],
  /** 但命令里出现这些"看一眼环境"的词时放行（它们不碰源码）。 */
  runAllow: ['git status', 'git log', 'git diff --stat'],
}

export const DEFAULTS = {
  enabled: true,
  deny: DEFAULT_DENY,
  /** 意图层**不许有**的眼睛（能力级拿掉，见 `DEFAULT_EYES`）。 */
  eyes: DEFAULT_EYES,
  allow: [],
  logDenied: true,
  cleanRoom: DEFAULT_CLEAN_ROOM,
  /** 指南针工具名（`read_compass` / `list_compass`）—— 换名字要连 persona 一起换。 */
  compassReadTool: 'read_compass',
  compassListTool: 'list_compass',
  /** 一次最多读多少行 / 多少字节（防止"顺手把整个文件灌进上下文"）。 */
  compassMaxLines: 2000,
  compassMaxBytes: 512 * 1024,
  /**
   * 身份判定的重试次数与间隔。`agent/created` 触发时子会话的身份还没登记完，
   * 所以要等一拍再判。超过次数仍不在 `roots()` 里 → 按「被派出去的手」处理（不锁）。
   */
  identityRetries: 20,
  identityRetryMs: 50,
  /**
   * 本挂载的 preset id。**显式传入**（build-presets 会写进来）。
   * 不靠猜 `composedPreset(自己的 ctx)` 的语义 —— 猜错的后果要么是筛不掉别的会话
   * （又去锁别人），要么是筛掉全部（守卫静默失效），两种都不该赌。
   * 留空则回落到 `composedPreset(ctx)`。
   */
  presetId: '',
}

export function normalize(config) {
  const out = {
    enabled: DEFAULTS.enabled,
    deny: [...DEFAULTS.deny],
    eyes: [...DEFAULTS.eyes],
    allow: [...DEFAULTS.allow],
    logDenied: DEFAULTS.logDenied,
    compassReadTool: DEFAULTS.compassReadTool,
    compassListTool: DEFAULTS.compassListTool,
    compassMaxLines: DEFAULTS.compassMaxLines,
    compassMaxBytes: DEFAULTS.compassMaxBytes,
    identityRetries: DEFAULTS.identityRetries,
    identityRetryMs: DEFAULTS.identityRetryMs,
    cleanRoom: { ...DEFAULTS.cleanRoom, allow: [...DEFAULTS.cleanRoom.allow], deny: [...DEFAULTS.cleanRoom.deny], runDeny: [...DEFAULTS.cleanRoom.runDeny], runAllow: [...DEFAULTS.cleanRoom.runAllow] },
  }
  if (config === null || typeof config !== 'object') return out
  if (typeof config.enabled === 'boolean') out.enabled = config.enabled
  if (typeof config.logDenied === 'boolean') out.logDenied = config.logDenied
  for (const key of ['compassReadTool', 'compassListTool']) {
    if (typeof config[key] === 'string' && config[key].length > 0) out[key] = config[key]
  }
  for (const key of ['deny', 'allow']) {
    const value = config[key]
    if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)) {
      out[key] = [...value]
    }
  }
  // `eyes: []` 是**合法**的（人显式要求"别拿走任何工具"）—— 空数组也要认，
  // 所以这里单独处理，不走上面那条"必须非空"的通用规则。
  if (Array.isArray(config.eyes) && config.eyes.every((item) => typeof item === 'string' && item.length > 0)) {
    out.eyes = [...config.eyes]
  }
  if (config.cleanRoom !== null && typeof config.cleanRoom === 'object') {
    const room = config.cleanRoom
    if (typeof room.enabled === 'boolean') out.cleanRoom.enabled = room.enabled
    if (typeof room.onlyAllow === 'boolean') out.cleanRoom.onlyAllow = room.onlyAllow
    for (const key of ['allow', 'deny', 'runDeny', 'runAllow']) {
      const value = room[key]
      if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)) out.cleanRoom[key] = [...value]
    }
  }
  for (const key of ['identityRetries', 'identityRetryMs', 'compassMaxLines', 'compassMaxBytes']) {
    const value = config[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }
  if (typeof config.presetId === 'string') out.presetId = config.presetId
  return out
}

/**
 * 某 agent 是不是本 preset 的成员。纯函数，便于离线断言。
 *
 * 为什么必须筛：`ctx.agents.list()` / `roots()` 都是**进程级**的，
 * 不过滤就会去锁别的 preset（乃至 standard）的会话 —— 那是实锤发生过的生产事故。
 *
 * @param ownPresetId - 本挂载的 preset id；undefined 表示拿不到服务。
 * @param agentPresetId - 该 agent 加入的 preset id。
 * @returns 该不该继续处理这个 agent。
 */
export function belongsToPreset(ownPresetId, agentPresetId) {
  // 拿不到本挂载 id 就一个都不锁：锁错人的代价远大于少锁一次。
  if (ownPresetId === undefined || ownPresetId === null) return false
  return agentPresetId === ownPresetId
}

/**
 * 某 agent 是不是**顶层** agent（不是被派出去的手）。
 * 纯函数：判据由调用方从 `ctx.agents.roots()` 取好传进来。
 *
 * @param rootAgents - `ctx.agents.roots()` 的返回值。
 * @param agent - 待判定的 agent。
 */
export function isRootAgent(rootAgents, agent) {
  if (!Array.isArray(rootAgents) || agent === null || agent === undefined) return false
  return rootAgents.includes(agent)
}

//#region 指南针：意图层**唯一**能自己打开的东西

/**
 * 把一个"意图层想看的路径"判成放行 / 拒绝。**纯函数**（不碰磁盘，可离线断言）。
 *
 * 判据只有两条，都是**结构性**的：
 *   ① **路径必须是相对的**，而且**任何一段都不许是 `..`** ——
 *      这样就不存在"解析之后再判"那套把戏（软链接、`..` 拼接、盘符绕过）。
 *      指南针不需要 `..`：它的世界就是工作区里的那几个位置。
 *   ② 规范化之后必须命中 `allow`（那份名单**就是** `cleanRoom.allow`，一处定义两处用）。
 *
 * @returns `undefined`（放行）或一段给人看的拒绝理由
 */
export function judgeCompassPath(raw, { allow = DEFAULT_CLEAN_ROOM.allow } = {}) {
  const asked = String(raw ?? '').trim()
  const refuse = (why) =>
    `【指南针】**这个路径不在指南针里** —— ${why}\n` +
    `     你能看的只有：人的原话与判据（\`notes/**/*.md\`、\`notes/_user_requirements.json\`）、\n` +
    '     终局定义与任务与台账（`notes/_endstate/**`）、以及审计层交回来的《鉴证报告》。\n' +
    '     源码、日志、以及"跑出来的现场数据"**不在其中** —— 要"现在差多少"用 `measure_gap`，\n' +
    '     要"到底行不行"派 `dispatch_audit`（你只看它交回来的报告）。'

  if (asked.length === 0) return refuse('路径是空的。')
  const slashed = asked.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/u.test(slashed) || slashed.startsWith('//')) {
    return refuse(`给了绝对路径（${asked}）。指南针里的路径一律**相对工作区**。`)
  }
  const segments = slashed.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) return refuse(`路径里有 \`..\`（${asked}）。`)
  const normalized = segments.join('/')
  if (normalized.length === 0) return refuse('路径是空的。')
  if (!matchesAny(normalized, allow)) return refuse(`不在放行名单里（${normalized}）。`)
  return undefined
}

/**
 * 把路径钉在**工作区里**并读出来。
 *
 * ⚠️ 两道防线是**分开**的，缺一不可：
 *   ① `judgeCompassPath` 判"这个相对路径准不准看"（纯函数，先判）；
 *   ② 解析成绝对路径之后，再确认它**真的落在 cwd 里面** ——
 *      万一 `resolve()` 因为平台语义（盘符、UNC）跑到了别处，这一步会拦住。
 */
export function resolveCompassPath(raw, cwd) {
  const root = resolve(String(cwd ?? '.'))
  const absolute = resolve(root, String(raw ?? '').replaceAll('\\', '/'))
  if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined
  return absolute
}

/** 把一个文件读成"行号 + 正文"（意图层要能引用 `:432-493` 那样的行号）。 */
export function readCompassFile({ cwd, path: rawPath, offset, limit, allow = DEFAULT_CLEAN_ROOM.allow, maxLines = 2000, maxBytes = 512 * 1024 }) {
  const verdict = judgeCompassPath(rawPath, { allow })
  if (verdict !== undefined) return { ok: false, text: verdict }
  const absolute = resolveCompassPath(rawPath, cwd)
  if (absolute === undefined) return { ok: false, text: '【指南针】路径解析之后跑出了工作区 —— 拒。' }
  if (!existsSync(absolute)) return { ok: false, text: `【指南针】没有这个文件：${String(rawPath)}` }
  let info
  try {
    info = statSync(absolute)
  } catch (error) {
    return { ok: false, text: `【指南针】读不了它：${String(error).slice(0, 160)}` }
  }
  if (info.isDirectory()) return { ok: false, text: `【指南针】${String(rawPath)} 是个目录 —— 列目录请用 list_compass。` }
  if (info.size > maxBytes) return { ok: false, text: `【指南针】这个文件 ${info.size} 字节，超过上限（${maxBytes}）—— 指南针只给你看人写的那几样，不搬大文件。` }
  let text
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    return { ok: false, text: `【指南针】读不了它：${String(error).slice(0, 160)}` }
  }
  if (text.includes('\u0000')) return { ok: false, text: '【指南针】这是二进制文件 —— 指南针只读文本。' }
  const all = text.split(/\r?\n/u)
  const from = Math.max(1, Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1)
  const count = Math.min(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : maxLines, maxLines)
  const slice = all.slice(from - 1, from - 1 + count)
  const width = String(from + slice.length - 1).length
  const body = slice.map((line, index) => `${String(from + index).padStart(width, ' ')}: ${line}`).join('\n')
  return {
    ok: true,
    text:
      `<path>${String(rawPath).replaceAll('\\', '/')}</path>\n` +
      `<lines>${from}-${from + slice.length - 1} / ${all.length}</lines>\n` +
      '<content>\n' +
      body +
      '\n</content>',
  }
}

/** 列出指南针里有哪些文件（只走放行名单，**不**列全仓）。 */
export function listCompassFiles({ cwd, pattern = '', allow = DEFAULT_CLEAN_ROOM.allow, maxEntries = 400, maxDepth = 6 }) {
  const root = resolve(String(cwd ?? '.'))
  const filter = String(pattern ?? '').trim()
  // `pattern` 是 glob（`notes/**/*.md`），不是真路径 —— 所以只判两件**结构**上的事：
  // 绝对路径 / `..`。它不是名单判据（名单判据在下面逐个文件上，那才是判据所在）。
  if (filter.length > 0) {
    const slashed = filter.replaceAll('\\', '/')
    if (slashed.startsWith('/') || /^[A-Za-z]:/u.test(slashed) || slashed.split('/').includes('..')) {
      return { ok: false, text: `【指南针】pattern 必须是**相对工作区**的 glob（收到 ${filter}）。` }
    }
  }
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxEntries) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return
      const name = entry.name
      if (name === 'node_modules' || name === '.git' || name === '__pycache__') continue
      const absolute = resolve(dir, name)
      const relative = absolute.slice(root.length + 1).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        // 剪枝：名单里全是 `notes/**` 这类路径，别去翻整个仓
        if (!matchesAny(`${relative}/**`, allow) && !matchesAny(`${relative}/**/*.md`, allow) && relative !== 'notes') continue
        walk(absolute, depth + 1)
        continue
      }
      if (!matchesAny(relative, allow)) continue
      if (filter.length > 0 && !matchesAny(relative, [filter])) continue
      out.push(relative)
    }
  }
  walk(root, 0)
  if (out.length === 0) {
    return { ok: true, text: `【指南针】没找到${filter.length > 0 ? `匹配 ${filter} 的` : ''}可看的文件。\n     （指南针只看得到：notes 里人写的 Markdown、_user_requirements.json、notes/_endstate/**。）` }
  }
  return { ok: true, text: `<files>${out.length}</files>\n${[...out].sort().join('\n')}` }
}

/** 工具定义的形状与 `dsh-endstate-loop` 一致（真 `register()` 收这种形状）。 */
function defineCompassTool({ toolName, description, parameters, execute }) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...rest } = raw
    properties[key] = { ...rest }
    if (isRequired === true) required.push(key)
  }
  return {
    name: toolName,
    description,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      try {
        return await execute(args ?? {}, exec)
      } catch (error) {
        return `【指南针】读的时候抛了：${String(error?.message ?? error).slice(0, 200)}`
      }
    },
  }
}

//#endregion

/**
 * 安装意图层闸门：给**本 preset 的顶层会话**套上「不得修改」+「不得自己看现场」，
 * 跳过它派出的执行层与审计层（那两层要能读写、能跑）。
 */
export function apply(ctx, config = {}) {
  const settings = normalize(config)
  if (!settings.enabled) {
    ctx.logger.info('intent-guard: disabled by config - this session may modify files directly')
    return
  }

  const allow = new Set(settings.allow)
  const denied = settings.deny.filter((tool) => !allow.has(tool))
  const eyes = settings.eyes.filter((tool) => !allow.has(tool) && !denied.includes(tool))
  if (denied.length === 0 && eyes.length === 0) {
    ctx.logger.warn('intent-guard: nothing to deny - the mutation gate is not doing anything')
    return
  }

  // ── 指南针：把「意图层能自己打开的东西」做成两个**只读**工具 ──
  //
  // 这是"能力级不可看"的另一半：拿掉通用读工具之后，它要读原话/判据/报告，
  // 唯一的入口就是这两个 —— 而它们的实现里**只有一条白名单**，别的路径压根不会打开。
  // 注册失败（重名 / 服务不可用）**只告警不抛**：宁可这一层缺席，也不能让 preset 起不来。
  const compassDescription =
    '读**指南针**里的东西（意图层唯一能自己打开的文件）：人的原话与判据（notes/**/*.md）、' +
    'notes/_user_requirements.json、终局定义与任务与台账与《鉴证报告》（notes/_endstate/**）。' +
    '**别的路径一律读不到** —— 源码、日志、跑出来的现场数据都不在里面。' +
    '要"现在差多少"用 measure_gap；要"到底行不行"派 dispatch_audit，你只看它交回来的报告。'
  try {
    if (typeof ctx.tools?.register !== 'function') {
      ctx.logger.warn('intent-guard: tools service unavailable - the compass tools are NOT registered (the intent layer will have no way to read its own notes)')
    } else {
      ctx.tools.register(
        defineCompassTool({
          toolName: settings.compassReadTool,
          description: compassDescription,
          parameters: {
            path: { type: 'string', description: '相对工作区的路径（例如 notes/AGENTS.md、notes/_endstate/spec.json）', required: true },
            offset: { type: 'number', description: '从第几行开始（1 起，默认 1）' },
            limit: { type: 'number', description: `最多读多少行（默认 ${settings.compassMaxLines}）` },
          },
          execute: (args, exec) =>
            readCompassFile({
              cwd: exec?.agent?.session?.header?.cwd ?? process.cwd(),
              path: args.path,
              offset: args.offset,
              limit: args.limit,
              allow: settings.cleanRoom.allow,
              maxLines: settings.compassMaxLines,
              maxBytes: settings.compassMaxBytes,
            }).text,
        }),
      )
      ctx.tools.register(
        defineCompassTool({
          toolName: settings.compassListTool,
          description:
            '列出**指南针**里有哪些文件（只走放行名单，不会列全仓）。' +
            'pattern 可选，是相对工作区的 glob（例如 notes/**/*.md）。',
          parameters: { pattern: { type: 'string', description: '可选：相对工作区的 glob（例如 notes/**/*.md）' } },
          execute: (args, exec) =>
            listCompassFiles({
              cwd: exec?.agent?.session?.header?.cwd ?? process.cwd(),
              pattern: args.pattern ?? '',
              allow: settings.cleanRoom.allow,
            }).text,
        }),
      )
    }
  } catch (error) {
    ctx.logger.warn('intent-guard: could not register the compass tools: ' + String(error))
  }

  const agents = ctx.agents
  const presets = ctx.get('agentPresets')
  const ownPresetId =
    typeof settings.presetId === 'string' && settings.presetId.length > 0
      ? settings.presetId
      : presets?.composedPreset?.(ctx)
  if (ownPresetId === undefined) {
    // fail-open 并告警：不知道自己是哪个 preset，就不能安全地挑出「自己人」。
    ctx.logger.warn(
      'intent-guard: cannot determine this mount\'s preset id (agentPresets unavailable) - ' +
        'refusing to restrict ANY session, because guessing would lock unrelated conversations',
    )
    return
  }
  ctx.logger.info('intent-guard: mounted for preset "' + ownPresetId + '"')

  // 退化模式必须**可见**。拿不到名册服务就分不清「谁加入了本 preset」，
  // 于是 `belongsToPreset` 会对每个 agent 都回 false —— 结果是一个都不锁。
  // 那是安全的（绝不误伤别人），但**绝不能让它静默发生**：
  // 否则守卫悄悄失效，而用户以为「不能修改」还在生效。
  if (presets === undefined) {
    ctx.logger.warn(
      'intent-guard: degraded — agentPresets service unavailable, so no session can be identified ' +
        'as a member of this preset; NOTHING will be restricted (fail-open by design, but visible).',
    )
    return
  }

  /**
   * 已经被蒙上眼睛的 agent ⇒ 它那些掩码的**解除器**。
   *
   * ⚠️ 2026-09-21 从 `WeakSet` 改成这个表，修的是一条真实的现场故障：
   *   用户的会话 `session-c0d18796` 创建时是**标准**，9/20 被切成**双区**跑了一天，
   *   9/21 19:49 又切回**标准** —— 可它手里**还是没有文件/bash 工具**，
   *   模型如实回了一句「我这边没有任何文件/bash 工具」，用户以为是"双区插件污染了标准模式"。
   *
   * 根因就在这一层：`tools.restrict()` 是**能力级**掩码，而且它**返回解除器**
   * （产品原文：`@returns the exact disposer that lifts this restriction`）——
   * 第一版把返回值丢掉了，于是**会话切走之后眼睛也睁不回来**（掩码粘在 agent 身上）。
   * 现在：留着解除器，每轮扫一遍"它还在不在本 preset 里"，**不在就当场还回去**。
   */
  const restricted = new Map()
  /** 装了无菌室守卫的 agent（一个 agent 只装一次）。 */
  const cleanGuarded = new WeakSet()

  const presetOf = (agent) => {
    const scopedCtx = agent?.ctx ?? agent?.session?.ctx
    if (scopedCtx === undefined) return undefined
    return presets.composedPreset?.(scopedCtx)
  }

  /**
   * 给一个顶层 agent 套掩码。
   * 身份可能还没登记完，所以带重试 —— 这正是上一版坏掉的地方。
   */
  const guard = (agent, attempt = 0) => {
    if (agent === undefined || agent === null) return

    // ── **离开本 preset ⇒ 把眼睛还回去**（2026-09-21 现场故障的修法）──────────
    //
    // 现场：会话从双区切回**标准**之后，工具表**没有**恢复 —— 模型只能说"我没有文件工具"。
    // 掩码是能力级的、而且粘在 agent 上，所以"切走"这件事必须由我们自己收尾。
    const already = restricted.get(agent)
    if (already !== undefined) {
      const stillMine = belongsToPreset(ownPresetId, presetOf(agent))
      if (stillMine) return
      restricted.delete(agent)
      let lifted = 0
      for (const dispose of already.disposers) {
        try {
          dispose()
          lifted += 1
        } catch {
          // 解除失败不抛：下一轮还会再试（它已经不在表里了，所以这里补一次记录）
          ctx.logger.warn('intent-guard: 解除掩码失败（session ' + String(agent?.id) + '）—— 它的工具可能还缺着')
        }
      }
      ctx.logger.info(
        'intent-guard: session ' + String(agent?.id) + ' 已离开 preset "' + String(ownPresetId) +
          '"（现在 ' + String(presetOf(agent) ?? '(未知)') + '）⇒ 已解除 ' + String(lifted) + ' 条掩码，把工具还给该会话',
      )
      return
    }

    const agentPresetId = presetOf(agent)
    if (!belongsToPreset(ownPresetId, agentPresetId)) {
      // 不是本 preset 的会话（例如另一个 standard 对话框）：一个手指都不许碰。
      return
    }

    if (!isRootAgent(agents.roots(), agent)) {
      if (attempt < settings.identityRetries) {
        setTimeout(() => guard(agent, attempt + 1), settings.identityRetryMs)
        return
      }
      if (settings.logDenied) {
        ctx.logger.info(
          'intent-guard: session ' + String(agent?.id) +
            ' is not a top-level agent - left writable so it can act as the executor layer',
        )
      }
      return
    }

    const scopedCtx = agent.ctx ?? agent.session?.ctx
    if (scopedCtx === undefined || typeof scopedCtx?.tools?.restrict !== 'function') return

    // ── 掩码：**逐个名字**下发 ──
    //
    // ⚠️ 为什么不是一次 `restrict({ deny: denied })`：真 `restrict()` 对**未知名字是响亮失败的**
    // （`names unknown global tool "x"; known global tools: …`）。产品改名一次，
    // 整条掩码就会**一条都没装上**，而意图层照旧手握 read/pwsh —— 那是"以为蒙上了其实没蒙"。
    // 逐个下发之后，改名的那个只跳过它自己，其余照样生效，而且**跳过的会响亮记下来**。
    //
    // 跳过还要分两种（2026-09-19 分清的，来自一次噪音教训）：
    //   · **本组合里本来就没有这个名字**（例如 Windows 上没有 `bash`）⇒ 记 info：
    //     没什么可拿的，这不是问题；
    //   · **有这个名字却没拿掉**（真产品里 restrict 失败）⇒ 记 **warn**：它的眼睛还睁着，
    //     这是必须被人看见的那种。
    const maskNames = [...denied, ...eyes.filter((tool) => !allow.has(tool))]
    const masked = []
    const absent = []
    const stuck = []
    const disposers = []
    for (const tool of maskNames) {
      try {
        // ⚠️ **一定要接住返回值**：它是"解除这条掩码"的解除器。
        //    丢掉它 = 会话切走之后眼睛再也睁不回来（2026-09-21 现场故障的根因）。
        const dispose = scopedCtx.tools.restrict({ deny: [tool] })
        masked.push(tool)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch {
        let present = false
        try {
          present = typeof scopedCtx.tools.get === 'function' && scopedCtx.tools.get(tool, agent) !== undefined
        } catch {
          // `get` 本身炸了就按"存在"处理 —— 宁可多喊一声，也不要静默当成"本来就没有"。
          present = true
        }
        if (present) stuck.push(tool)
        else absent.push(tool)
      }
    }
    restricted.set(agent, { disposers, at: Date.now(), masked })
    if (settings.logDenied) {
      ctx.logger.info(
        'intent-guard: session ' + String(agent.id) + ' is read-only for tools [' + masked.join(', ') + '] ' +
          '(intent layer: may read the compass and run nothing, may not modify)',
      )
      if (absent.length > 0) {
        ctx.logger.info(
          'intent-guard: [' + absent.join(', ') + '] 在本组合里本来就没有（平台/组合差异），无需拿掉',
        )
      }
    }
    if (stuck.length > 0) {
      // **绝不静默**：这些工具**存在**、却没能从它手里拿走 —— 那就是"以为蒙上了其实没蒙"。
      ctx.logger.warn(
        'intent-guard: **这些工具存在、却没能拿掉** [' + stuck.join(', ') + ']（session ' + String(agent.id) +
          '）—— 它们的路径守卫还在，但能力级那一层没生效，请查 restrict 为什么拒绝',
      )
    }

    /**
     * ## **无菌室**（第一层已经是掩码，这里是**第二层**）
     *
     * 用户的原话（2026-09-19，这是一次架构级修正）：
     *
     * > 「'意图层本来也需要重新跑一遍执行层的代码，用来检测执行层有没有搞出来问题'
     * > —— **这就是它越界了，也是它被污染、变蠢、最后搞发明的根本原因。**」
     * > 「他不仅查不出真正的结构问题，还会被工地的灰尘呛死，最后满脑子都是
     * > '这堵墙的水泥标号不够'，完全忘了大楼的整体设计。」
     * > 「把它的眼睛蒙上，只允许它看报表。把它的手绑住，只允许它写任务。」
     * > 「是需要**能力级的不可看**，只有那些最重要的东西作为意图层的指南针，
     * > 因为意图层就**必须贯彻我的意志，不能自作主张**。」
     *
     * 第一层（上面的掩码）把 `read` / `read_image` / `glob` / `grep` / `pwsh` / `bash`
     * **从它的工具表里整个拿掉** —— 那些工具在它的模型可见面上不存在。
     * 这一层（guard）只管两件事：
     *   · 万一某个名字在本组合里不存在、掩码没装上（`skipped`），按路径兜住它；
     *   · 万一还有别的工具带着路径参数碰现场，一样按路径兜住。
     *
     * | 它想干什么 | 结果 |
     * |---|---|
     * | 读 `notes/AGENTS.md`、`notes/**\*.md`、`notes/_endstate/**`（原话、判据、任务、报告） | 放行 |
     * | 读 `private_app/**`、`scripts/**`、`**\*.py`、`**\*.js` …（源码） | **拒**，并告诉它该去派审计 |
     * | 读 `*.log`、`_r\*_work/**`、stdout/stderr 转储（原始日志） | **拒**，同上 |
     * | **读名单外的任何东西**（`_pair_v6.json`、`*.csv`、`*.npy`…"跑出来的现场"） | **拒**（`onlyAllow`），并告诉它"派人放宽" |
     * | 用 pwsh 读上面那些路径（`Get-Content`、`cat`、`type` …） | **拒**（这一档正常情况连工具都没有了） |
     * | 用 pwsh 跑项目代码（`python scripts/...`、`.\*.ps1`） | **拒** —— 验收是审计层的活 |
     *
     * ⚠️ **这一层是启发式**（第一层不是）：它拦的是"顺手就看"，不是"恶意绕过"。
     * 但即便有人铁了心要绕，它也只能**派人**去看 —— 那是「它读到报告」，
     * 不是「它自己趴到工地上」，两件事的后果差很远。
     */
    const cleanRoom = settings.cleanRoom
    if (cleanRoom.enabled && typeof scopedCtx?.tools?.guard === 'function' && !cleanGuarded.has(agent)) {
      cleanGuarded.add(agent)
      try {
        scopedCtx.tools.guard((exec) => {
          const tool = String(exec?.name ?? '')
          const args = exec?.arguments ?? {}
          const verdict = judgeCleanRoom(tool, args, cleanRoom)
          if (verdict !== undefined && settings.logDenied) {
            ctx.logger.warn(
              'intent-guard: clean-room denied ' + tool + ' for session ' + String(agent?.id) + ' — ' + verdict.slice(0, 120),
            )
          }
          return verdict
        })
      } catch (error) {
        ctx.logger.warn('intent-guard: could not install the clean-room guard for session ' + String(agent?.id) + ': ' + String(error))
      }
    }
  }

  ctx.effect(
    () => {
      const disposers = []
      for (const agent of agents.roots()) guard(agent)
      disposers.push(
        ctx.on('agent/created', ({ agent }) => {
          guard(agent)
        }),
      )
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 释放期失败不打断其余释放。
          }
        }
      }
    },
    'intent-guard: read-only tool mask for the intent layer',
  )
}