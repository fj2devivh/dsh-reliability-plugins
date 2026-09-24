/**
 * dsh-executor-gate —— 执行层的「权限管理条例」（冻结 / 授权 / 范围锁 / 额度锁 / 熔断上报）。
 *
 * ## 它修的是什么
 *
 * 双区模式原先只约束了**意图层**（`dsh-intent-guard` 剥夺它的 write/edit）。
 * 执行层却是**完全没有约束**的：它一被创建就继承 standard 的全套能力，可以随手改任何
 * 文件、搭任何机制、跑任意多轮实验 —— 这正是「意图层很听话、执行层蠢」的机制性根因。
 * 本插件把执行层从「默认全权」改成「**默认冻结、按任务发租约**」。
 *
 * 四条条例 → 本插件的实现：
 *
 * | 条例 | 实现 | 强度 |
 * |---|---|---|
 * | ① 默认冻结（白纸开局） | 执行层 agent 一被创建就套 `ctx.tools.guard()`；**没有租约时一切变更类调用被拒** | **硬约束（工具层）** |
 * | ② 权限审批流 | 执行层 `request_permission` 申请 → 意图层 `grant_permission` 批准，或派活/追加消息里写 `【授权】` 当场生效 | 工具 + 机制 |
 * | ③ 时间锁与范围锁 | 租约 = `allowWrite` 目录白名单 + `denyWrite` 黑名单 + `budgetWrites`/`budgetShell` 额度 + `expiresAt` 时间锁；任务完成即回收 | **硬约束（每次调用都判）** |
 * | ④ 定律 vs 工具的边界 | `FORBIDDEN_TARGETS` 任何租约都不可授权；`grant_permission` 对执行层自己响亮拒绝；挑战约束即记违规，到上限熔断 | **硬约束** |
 *
 * ## 为什么必须是**工具层**约束，而不是提示词
 *
 * 本项目的既有结论（`dsh-intent-guard` 文件头）：提示词只能塑造倾向，工具掩码才能
 * 真正剥夺能力。「执行层既没脑子也没约束」里，**能靠机制解决的那一半就是约束**：
 * 冻结不是请求它别乱写，而是它**写不进去**。
 *
 * ## 与产品既有约定的关系（不是绕开产品，是补上产品有意留白的那一格）
 *
 * 产品给每个子 agent 的运行时常量 `SUBAGENT_DELEGATION_CONTEXT`
 * （`dsh-subagent/lib/types/child-agent.js`）逐字写着：
 *
 * > 你是一个被委派的子 agent：**你的权限范围在启动时就固定了，无法从本会话内部扩大** ——
 * > 需要审批的操作会被自动拒绝。当任务需要超出该范围的访问时，**不要重试被拒的操作**；
 * > 在回复里说明这个限制，让委派你的 agent 来处理。
 *
 * 产品**有意**让子 agent 的范围在启动时固定、且拒绝**响亮地**回到子 agent。但它没规定
 * 「固定成什么」—— 那一格是空的。本插件把「启动时的范围」默认设成**空**（冻结），
 * 并给出唯一一条合法的扩权路径（意图层显式授权）。这比「默认全给」更贴合那句常量。
 *
 * ## 边界（如实标注，不假装是安全边界）
 *
 * 这是**工具 schema 级 + 调用级**约束，不是文件系统级安全边界：执行层仍持有 `pwsh`/`bash`。
 * 三件事把缺口压到最小：
 *   1. 变更类 shell 命令走 `SHELL_WRITE_PATTERN` + 路径提取，命中范围内外一律判；
 *      **`python -c` / `node -e` 这种内联代码按「代码里到底有没有写」判**（见 `isReadOnlyInline`）——
 *      只读探针归只读档放行，真在写的连目标路径一并抓出来查（2026-09-20 用户报的缺陷）；
 *   2. 额度按「**变更类调用**」计数 —— 读、`node -v`、跑只读检查**不计数**；
 *   3. 每个判定都记账（`auditFile` 可选落盘），可事后逐条复核，不靠信任。
 * 要真正的只读，得在环境层做（只读挂载 / 沙箱 write 目录），那不在本插件范围内。
 *
 * ## 两条硬要求（都有事故背景）
 *
 * 1. **`apply` 绝不抛错。** 2026-09-15 01:01 事故：插件在 apply 阶段抛错会让
 *    **整个窗口/会话起不来**。所以这里每一步都 try/catch，失败只告警不断线。
 * 2. **不导出 `Config` schema。** `dsh-executor-loop` 的事故：手写的 `Config` 描述对象
 *    不是 Standard Schema，`resolveConfig()` 读 `~standard` 时抛 TypeError，
 *    **整棵插件树加载失败、DSH 打不开**。这里用 `normalize()` 逐字段校验，零跨包依赖。
 *
 * ## 为什么不导出去重用的 `restrict()`
 *
 * `tools.restrict()` 对**未知工具名是响亮失败的**（会让整个 preset 起不来）。
 * 本插件的冻结走 `ctx.tools.guard()` —— 它对工具名不做校验，因此名单漂移
 * 只影响判定、不影响加载。这是刻意的稳健性取舍。
 *
 * @module @dsh-plugin/executor-gate
 */

import { appendFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 稳定的 Cordis 插件名。 */
export const name = 'executor-gate'

/** 需要 ctx.agents 来找意图层，也需要每个 agent 的 scoped ctx 来装 guard。 */
export const inject = ['agents']

/**
 * 「物理定律」：这些路径片段**任何租约都不可授权**。
 *
 * 判据是「改了它，这套机制本身就失效了」。所以这不是普通黑名单，
 * 而是条例 ④ 里那条「执行层连讨论资格都没有」的边界。
 */
export const FORBIDDEN_TARGETS = [
  'dsh-intent-guard',
  'dsh-executor-gate',
  'dsh-executor-loop',
  'build-presets.mjs',
  'verify-presets.mjs',
  '.agent-presets',
  'cordis.patch.yml',
]

/** 默认冻结时不得触碰的变更类工具。名字均为本机组合已核实的全局工具名。 */
export const DEFAULT_DENY = ['write', 'edit', 'bash', 'pwsh']

/** 意图层在派活/追加消息里写这个标记即当场授权。 */
export const GRANT_MARKER = '【授权】'

/** 执行层申请权限时用的标记（写进它发给意图层的消息里）。 */
export const REQUEST_MARKER = '【权限申请】'

/**
 * 变更类 shell 的判据：命中即视为一次**变更**，既查范围也扣额度。
 *
 * ⚠️ **不能用 `\b` 圈 PowerShell 的 cmdlet 名**：`-` 是非单词字符，所以
 * `\bRemove-Item\b` 在 `Remove-Item` 上**不成立** —— 那会让「删目录」被判成只读命令
 * 直接放行。本插件开发时实测踩过这个坑（`New-Item`/`Remove-Item` 全被漏放）。
 * 这里统一用 `(?<![\w-])…(?![\w-])`，它才真正排除「名字里含连字符」的边界情况。
 *
 * 刻意**不**包含 `Get-Content` / `Select-String` / `Measure-Object` / `Out-String`
 * 这类只读 cmdlet —— 把读也算成变更，就等于把「跑测试验证」也锁掉了，
 * 而验收能力是执行层必须保留的。
 */
export const SHELL_WRITE_PATTERN = new RegExp(
  [
    String.raw`>>?(?![&=])`, // 重定向（`2>&1` 这种 fd 复制不算）
    String.raw`(?<![\w-])Out-File(?![\w-])`,
    String.raw`(?<![\w-])Set-Content(?![\w-])`,
    String.raw`(?<![\w-])Add-Content(?![\w-])`,
    String.raw`(?<![\w-])New-Item(?![\w-])`,
    String.raw`(?<![\w-])Remove-Item(?![\w-])`,
    String.raw`(?<![\w-])Move-Item(?![\w-])`,
    String.raw`(?<![\w-])Copy-Item(?![\w-])`,
    String.raw`(?<![\w-])Rename-Item(?![\w-])`,
    String.raw`(?<![\w-])Set-ItemProperty(?![\w-])`,
    String.raw`(?<![\w-])Clear-Content(?![\w-])`,
    String.raw`(?<![\w-])rm(?![\w-])`,
    String.raw`(?<![\w-])mv(?![\w-])`,
    String.raw`(?<![\w-])cp(?![\w-])`,
    String.raw`(?<![\w-])mkdir(?![\w-])`,
    String.raw`(?<![\w-])touch(?![\w-])`,
    String.raw`(?<![\w-])chmod(?![\w-])`,
    String.raw`(?<![\w-])chown(?![\w-])`,
    String.raw`(?<![\w-])tee(?![\w-])`,
    String.raw`(?<![\w-])node\s+-e(?![\w-])`,
    String.raw`(?<![\w-])python\s+-c(?![\w-])`,
  ].join('|'),
  'u',
)

/**
 * 「定律挑战」指纹：命中即记违规（条例 ④）。
 *
 * 刻意**不**把普通的「规格有歧义」算进来 —— 那是正常的工程判断。
 * 只有「试图绕开/改写约束本身」才算挑战定律。
 */
export const LAW_CHALLENGE_PATTERN = new RegExp(
  [
    String.raw`忽略(上面|上述|前面)?(的)?(规则|约束|条例|规范|授权|范围)`,
    String.raw`无视(上面|上述|前面)?(的)?(规则|约束|条例)`,
    String.raw`绕过(权限|约束|闸门|守卫|限制|门禁)`,
    String.raw`解除(权限|约束|限制|冻结)`,
    String.raw`跳过(审批|授权|权限)`,
    String.raw`授予我自己`,
    String.raw`(改|修)(掉)?.{0,6}(闸门|守卫)`,
    String.raw`disable\s+(the\s+)?(gate|guard)`,
    String.raw`bypass\s+(the\s+)?(gate|guard|restriction|permission)`,
    String.raw`ignore\s+(the\s+)?(rules|constraints|restrictions)`,
  ].join('|'),
  'iu',
)

/** 默认配置。每一项都可以在 preset 里覆盖。 */
export const DEFAULTS = {
  enabled: true,
  /** 执行层（`header.origin === 'subagent'`）是否吃冻结。默认吃。 */
  gateSubagents: true,
  /** 意图层是否也不许自己动手改文件（与 intent-guard 同向，双保险）。 */
  denyIntentWrites: true,
  /** 冻结时被拒的变更类工具名（用于文案与自检，**不**进 restrict 调用）。 */
  deny: DEFAULT_DENY,
  /** 新租约默认额度：写操作次数 / 变更类 shell 次数。 */
  defaultWriteBudget: 200,
  defaultShellBudget: 30,
  /** 违规熔断阈值：达到即把租约标为冻结（连已授权范围一起收回）。 */
  violationLimit: 3,
  /** 租约时间锁上限（毫秒）。到点自动冻结，不依赖任何人记得回收。 */
  maxLeaseMs: 4 * 60 * 60 * 1000,
  /** 身份判定重试：子会话身份在 `agent/created` 那一刻还没登记完。 */
  identityRetries: 20,
  identityRetryMs: 50,
  /**
   * 执行层的发现周期（毫秒）。
   *
   * **为什么必须轮询，而不是靠 `agent/created` 事件**：那条事件是用
   * `scopeTarget(agent, agent)` 派发的（见 `dsh-agent` 的 `AgentRegistry.announce`），
   * 也就是**按 scope 过滤**的 —— 装在挂载点（根 ctx）或意图层 ctx 上的监听器
   * 收到的条数是 **0**（本插件开发时实测：两种监听器都收到 0 条）。
   * 而 `agents.roots()` 按定义只含顶层会话，执行层在那里也不可见。
   * 所以执行层只能靠 `agents.list()` 主动发现 —— 这条路已用真替身实测可见。
   * 设为 0 则关掉轮询（此时只能发现意图层，执行层不会被冻结 —— 不推荐）。
   */
  discoveryIntervalMs: 1000,
  /**
   * 覆盖面审计周期（毫秒）：把「活着的执行层里，谁还没上闸」喊出来。
   *
   * **为什么必须有它**：本插件的守护是"发现即冻结"，而发现靠轮询，
   * 所以子会话从**被创建**到**被冻结**之间有一段窗口，那期间它是裸的。
   * 用户 2026-09-18 的反馈正是这一条：「有的会话根本没上闸，在我任何授权之前就写进去了」。
   * 这段窗口没法从根上消掉（守卫只能装到已存在的 agent 的 scoped ctx 上），
   * 但**绝不能让它静默** —— 所以单独一条慢节拍审计，把漏洞点名到具体会话 id。
   * 设为 0 可关掉（不推荐）。
   */
  coverageAuditMs: 5000,
  /**
   * **审计层常备租约**（用户 2026-09-20 报的机制缺陷）。
   *
   * 允许关掉（`auditLease: false`）—— 那时审计层与执行层一样"白纸开局"，
   * 必须由意图层在派审计时带上授权包。默认**开**：审计的本来工作就是跑验收，
   * 让它"没有权限跑任何程序"等于让这道闸门自己把审计堵死。
   */
  auditLease: true,
  /** 审计层能跑多少次测试/校验类命令。 */
  auditShellBudget: 40,
  /** 审计层能写多少次（抓输出、放临时夹具）—— 范围只给下面那个目录。 */
  auditWriteBudget: 10,
  /** 审计层唯一的可写目录（相对工作区；产品树与 notes/_endstate 都不在范围内）。 */
  auditScratchDir: '_audit_scratch',
  /**
   * 子会话名册的刷新周期（"发消息前查活"用）。
   *
   * 名册（`subagents.listChildren`）是**异步**的，而 `tools.guard` 是**同步**判据 ——
   * 所以只能轮询进缓存、guard 读缓存。0 = 关掉这一路（那时 `send_message` 的存活判据
   * 只剩"现在活着吗"这一条，名册查不到 ⇒ 走保守分支）。
   */
  catalogIntervalMs: 5000,
  logDenied: true,
  /**
   * 本挂载的 preset id。**显式传入**（build-presets 会写进来），不靠猜。
   * 拿不到就**一个都不管**（fail-open 并告警）：锁错人的代价远大于少管一次。
   */
  presetId: '',
  /** 审计文件：每个判定一行 JSONL。留空则不落盘（仅内存 + 日志）。 */
  auditFile: '',
}

//#region 配置归一化

/** 把配置归一化成一份**每个字段都可信**的设置对象。 */
export function normalize(config) {
  const out = {
    enabled: DEFAULTS.enabled,
    gateSubagents: DEFAULTS.gateSubagents,
    denyIntentWrites: DEFAULTS.denyIntentWrites,
    deny: [...DEFAULTS.deny],
    defaultWriteBudget: DEFAULTS.defaultWriteBudget,
    defaultShellBudget: DEFAULTS.defaultShellBudget,
    violationLimit: DEFAULTS.violationLimit,
    maxLeaseMs: DEFAULTS.maxLeaseMs,
    identityRetries: DEFAULTS.identityRetries,
    identityRetryMs: DEFAULTS.identityRetryMs,
    discoveryIntervalMs: DEFAULTS.discoveryIntervalMs,
    coverageAuditMs: DEFAULTS.coverageAuditMs,
    catalogIntervalMs: DEFAULTS.catalogIntervalMs,
    auditLease: DEFAULTS.auditLease,
    auditShellBudget: DEFAULTS.auditShellBudget,
    auditWriteBudget: DEFAULTS.auditWriteBudget,
    auditScratchDir: DEFAULTS.auditScratchDir,
    logDenied: DEFAULTS.logDenied,
    presetId: DEFAULTS.presetId,
    auditFile: DEFAULTS.auditFile,
  }
  if (config === null || typeof config !== 'object') return out
  for (const key of ['enabled', 'gateSubagents', 'denyIntentWrites', 'logDenied', 'auditLease']) {
    if (typeof config[key] === 'boolean') out[key] = config[key]
  }
  if (Array.isArray(config.deny) && config.deny.every((item) => typeof item === 'string' && item.length > 0)) {
    out.deny = [...config.deny]
  }
  for (const key of ['defaultWriteBudget', 'defaultShellBudget', 'violationLimit']) {
    const value = config[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.floor(value)
  }
  for (const key of ['maxLeaseMs', 'identityRetries', 'identityRetryMs', 'discoveryIntervalMs', 'coverageAuditMs', 'catalogIntervalMs', 'auditShellBudget', 'auditWriteBudget']) {
    const value = config[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }
  for (const key of ['presetId', 'auditFile', 'auditScratchDir']) {
    if (typeof config[key] === 'string') out[key] = config[key]
  }
  return out
}

//#endregion

//#region 纯函数：路径与判定（全部导出，便于离线负对照）

/**
 * 路径归一化：统一分隔符、去掉结尾分隔符、Windows 盘符统一小写。
 *
 * 为什么必须归一化：`D:\a\b`、`D:/a/b`、`d:\a\b\` 是同一个位置的三种写法。
 * 只做字符串前缀比较会让「禁止碰 B」被 `d:/b` 这种写法绕过去 ——
 * **判据不一致就是闸门漏**，不是排版问题。
 *
 * @param path - 待归一的路径（可为相对路径）。
 * @param cwd - 相对路径的解析基准。
 * @returns 归一化后的绝对路径（正斜杠形式）；空输入返回空串。
 */
export function normalizePath(path, cwd) {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (raw.length === 0) return ''
  const base = cwd ?? process.cwd()
  let absolute
  if (isAbsolute(raw)) {
    // Windows 上 `/x` 是「当前盘符下的 \x」，所以要补上基准的盘符再做比较 ——
    // 否则 `/data/**` 这种 POSIX 写法的范围规则会与 `D:/data/x` 这种目标**永远对不上**，
    // 表现为「授权了却还是写不进去」（本插件开发时实测踩过）。
    const drive = /^([a-zA-Z]:)/u.exec(base.replaceAll('\\', '/'))?.[1]
    absolute = drive !== undefined && /^\//u.test(raw) ? drive + raw : resolve(base, raw)
  } else {
    absolute = resolve(base, raw)
  }
  let normalized = absolute.replaceAll('\\', '/')
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  if (/^[a-zA-Z]:/u.test(normalized)) normalized = normalized[0].toLowerCase() + normalized.slice(1)
  return normalized
}

/**
 * `child` 是否在 `parent` 之内（含相等）。
 *
 * 按**路径段**比较，不做裸字符串前缀：`d:/ab` 不是 `d:/a` 的子路径。
 * 用 `startsWith` 会把这两个判成包含关系 —— 那正是越权写入的入口。
 */
export function isInside(parent, child) {
  if (parent.length === 0 || child.length === 0) return false
  if (parent === child) return true
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}

/**
 * 目标路径是否命中「物理定律」保护名单（任何租约都不可授权）。
 *
 * @param target - 已归一化的目标路径。
 * @param forbidden - 保护名单片段。
 */
export function isForbiddenTarget(target, forbidden = FORBIDDEN_TARGETS) {
  const lowered = String(target).toLowerCase()
  return forbidden.some((fragment) => lowered.includes(String(fragment).toLowerCase()))
}

/**
 * 把一条范围规则编译成正则。支持两种写法，**一条规则里可以混用**：
 *
 * | 写法 | 含义 | 例 |
 * |---|---|---|
 * | 目录前缀 | 以该路径为根的整棵子树 | `/data` 或 `/data/**` |
 * | glob `*` | 匹配**一段**路径里任意字符（不跨 `/`） | `/output/schedule_*.json` |
 * | glob `**` | 跨任意层级 | `/data/**` |
 *
 * 为什么必须支持 glob：意图层要能表达「只许写 `schedule_*.json`，别的都不行」——
 * 那是细粒度预算的典型形态；只支持目录前缀就表达不了它，
 * 执行层就能在这个目录里写任何别的文件名，范围锁等于漏了一半。
 *
 * @param pattern - 范围规则原文（可含 glob）。
 * @param base - 解析相对/无盘符路径的基准（**必须是租约的 cwd**，不是 `process.cwd()`）。
 *   用 `process.cwd()` 会让 `/data/**` 被解析到宿主自己的盘上，
 *   于是它与 `d:/data/x` 永远对不上 —— 表现为「授权了却还是写不进去」。
 */
export function globToRegExp(pattern, base) {
  const normalized = normalizePath(pattern, base)
  const source = normalized
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    // `**/` → 任意层级（含零层）；`**` 收尾 → 任意内容（含文件名）。
    // ⚠️ 第一版把两者都写成 `(?:.*/)?`，于是 `/data/**` 只匹配到目录本身、
    // **匹配不到目录里的文件** —— glob 范围形同虚设（本插件开发时实测）。
    .replace(/\*\*\//gu, '\u0001')
    .replace(/\*\*/gu, '\u0002')
    .replace(/\*/gu, '[^/]*')
    .replaceAll('\u0001', '(?:.*/)?')
    .replaceAll('\u0002', '.*')
  return new RegExp(`^${source}$`, 'u')
}

/** 目标是否命中一条范围规则（目录前缀 或 glob）。 */
export function matchesScope(target, pattern, base) {
  const normalizedPattern = normalizePath(pattern, base)
  if (normalizedPattern.length === 0) return false
  if (isInside(normalizedPattern, target)) return true
  if (!/[*]/u.test(normalizedPattern)) return false
  try {
    return globToRegExp(normalizedPattern, base).test(target)
  } catch {
    return false
  }
}

/**
 * 目标是否被一组范围规则允许。
 *
 * @param scopes - 范围规则列表。
 * @param allowWhenEmpty - 列表为空时是否放行。
 *   **写**用 `false`（白名单为空 = 冻结），**读**用 `true`（没写读范围就照旧能读）。
 *   这个区别是刻意的：写默认禁止、读默认允许，让「只加一条限制」不会意外锁死读能力。
 * @param base - 范围规则的解析基准（租约 cwd）。
 */
export function scopeAllows(target, scopes, allowWhenEmpty = false, base) {
  const list = Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string' && s.length > 0) : []
  if (list.length === 0) return allowWhenEmpty
  return list.some((pattern) => matchesScope(target, pattern, base))
}

/**
 * 判一个写目标是否被租约允许。
 *
 * 判据顺序**就是条例的顺序**：冻结 → 定律 → 黑名单 → 范围 → 额度。
 * 额度用**归一化后的工具键**（`write`/`edit` 归一到 `write_file`）从按工具的预算表里查。
 *
 * @returns `{ verdict, reason }`，verdict ∈
 *   `frozen` | `forbidden` | `denied` | `outside` | `unbudgeted` | `exhausted` | `allow`
 */
export function judgeWrite(target, lease, toolKey = 'write_file') {
  if (lease === undefined || lease === null || lease.frozen === true) return { verdict: 'frozen', reason: 'frozen' }
  if (isForbiddenTarget(target, lease.forbidden)) return { verdict: 'forbidden', reason: 'law' }
  const hitDeny = lease.denyWrite.find((entry) => matchesScope(target, entry, lease.cwd))
  if (hitDeny !== undefined) return { verdict: 'denied', reason: hitDeny }
  // 范围 = 通用写范围 ∪ 该工具自己的范围（两者都是白名单）。
  const scopes = [...(lease.allowWrite ?? []), ...((lease.tools?.[toolKey]?.paths) ?? [])]
  if (!scopeAllows(target, scopes, false, lease.cwd)) return { verdict: 'outside', reason: 'scope' }
  const budget = lease.tools?.[toolKey]
  if (budget === undefined) return { verdict: 'unbudgeted', reason: toolKey }
  if (budget.total >= 0 && budget.left <= 0) return { verdict: 'exhausted', reason: toolKey }
  return { verdict: 'allow', reason: toolKey }
}

/** 按工具的预算判定（读与跑测试用；范围为空表示不限制）。 */
export function judgeScopedCall(target, lease, toolKey) {
  if (lease === undefined || lease === null || lease.frozen === true) return { verdict: 'frozen', reason: 'frozen' }
  if (target !== undefined && target.length > 0) {
    if (isForbiddenTarget(target, lease.forbidden)) return { verdict: 'forbidden', reason: 'law' }
    const hitDeny = lease.denyWrite.find((entry) => matchesScope(target, entry, lease.cwd))
    if (hitDeny !== undefined) return { verdict: 'denied', reason: hitDeny }
    const budget = lease.tools?.[toolKey]
    if (!scopeAllows(target, budget?.paths ?? [], true, lease.cwd)) return { verdict: 'outside', reason: 'scope' }
  }
  const budget = lease.tools?.[toolKey]
  if (budget === undefined) return { verdict: 'unbudgeted', reason: toolKey }
  if (budget.total >= 0 && budget.left <= 0) return { verdict: 'exhausted', reason: toolKey }
  return { verdict: 'allow', reason: toolKey }
}

/** exec 的 `arguments` 是 unknown；只有普通对象才谈得上取字段。 */
function argsRecord(exec) {
  const raw = exec?.arguments
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined
}

/** 从工具调用里抽出「写目标路径」。`write`/`edit` 的参数名是 `file_path`（已核实）。 */
export function writeTargetOf(exec) {
  const args = argsRecord(exec)
  if (args === undefined) return undefined
  for (const key of ['file_path', 'path', 'filePath', 'target']) {
    if (typeof args[key] === 'string' && args[key].trim().length > 0) return args[key]
  }
  return undefined
}

/**
 * 从一段 shell 命令里抽出**可能的**写目标。
 *
 * 这是启发式，策略是「命中即从严」：只要出现变更类模式，就把命令里所有看起来像
 * 路径的 token 都拿出来判 —— 宁可误拦（执行层会去申请），不可漏放。
 *
 * ⚠️ 2026-09-20 补了两个洞（都是给审计层发常备租约时实测出来的）：
 *
 * 1. **重定向/写类 cmdlet 的目标必须点名抓**。
 *    旧版只认「引号里的」「绝对路径」「带 `./` 或 `/` 前缀的」——
 *    于是 `> private_app/out.txt` 这种**裸相对路径**一个候选都抽不到，
 *    范围检查等于没做（实测：审计层能把输出写进产品树）。
 * 2. **候选要像路径才留**（有分隔符，或有扩展名）。
 *    旧版把 `python -c "print(1)"` 里的 `print(1)` 当成写目标，
 *    于是它被判成"范围外" —— **假警会把真警一起淹掉**。
 *
 * ⚠️ 但"像路径才留"**只能用在宽松候选上**：`Remove-Item -Recurse -Force v6_模块自适应`
 * 里那个 `v6_模块自适应` 是**裸目录名**（既没分隔符也没扩展名），
 * 拿它当"不像路径"丢掉，就等于"删掉产品里的一个目录"完全不受范围检查。
 * 所以精确抓到的目标（重定向 / 写类 cmdlet 的直接操作数）**一律进判定**。
 */
export function shellWriteTargets(command) {
  const text = typeof command === 'string' ? command : ''
  if (text.length === 0) return []
  /** 精确目标：不过滤（见上面那两条注释）。 */
  const precise = new Set()
  /** 宽松候选：过滤。 */
  const loose = new Set()
  const stripped = text.replaceAll("'", '"')
  for (const match of stripped.matchAll(/"([^"]+)"/gu)) {
    const token = match[1].trim()
    if (token.length > 0) loose.add(token)
  }
  for (const match of text.matchAll(/([A-Za-z]:[\\/][^\s"'|;&]+)/gu)) loose.add(match[1])
  for (const match of text.matchAll(/(?<![\w:-])((?:\.{0,2}[\\/])[^\s"'|;&]+)/gu)) loose.add(match[1])
  // ①-a 重定向的**直接目标**（`>`、`>>`）—— 精确，不过滤
  for (const match of text.matchAll(/>>?\s*([^\s"'|;&]+)/gu)) {
    const token = match[1].trim()
    if (token.length > 0) precise.add(token)
  }
  // ①-b 写类 cmdlet 自己的参数表 —— 在它那一段里逐词判：
  //   · 路径类 flag 后面的词 = 目标（`Set-Content -Path out.txt`）；
  //   · **开关类** flag（`-Recurse` / `-Force`）后面的词**不是**它的值，仍是位置参数
  //     （`Remove-Item -Recurse -Force v6_模块自适应` —— 这条我第一版判错了，于是那个目录逃过范围检查）；
  //   · 取值类 flag（`-ItemType` / `-Value` / `-Name`）后面的词是参数值，**不是路径**
  //     （`New-Item -ItemType Directory` 里的 `Directory` 不是目标）。
  //
  // ⚠️ 这一段**只对 cmdlet 生效**：不能推广到任意命令 ——
  //    `python x.py > out.txt` 里的 `x.py` 是**被读的脚本**，把它当写目标就会误拦（实测踩过）。
  const PATH_FLAGS = new Set(['-path', '-literalpath', '-destination', '-target', '-outfile', '-filepath'])
  const VALUE_FLAGS = new Set([...PATH_FLAGS, '-itemtype', '-value', '-name', '-filter', '-encoding', '-erroraction', '-stream', '-credential', '-inputobject', '-argumentlist'])
  const CMDLET = /(?:Out-File|Set-Content|Add-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|tee)/giu
  for (const match of text.matchAll(CMDLET)) {
    const cmdlet = match[0].toLowerCase()
    // `Set-Content <路径> <值>` / `Add-Content <路径> <值>`：**第二个位置参数是内容，不是路径**
    // （`Set-Content _audit_scratch/out.txt hello` 里的 `hello` 一度被当成目标 ⇒ 误判成范围外）。
    const contentAfterFirst = cmdlet === 'set-content' || cmdlet === 'add-content'
    const rest = text.slice(match.index + match[0].length)
    const words = rest.split(/\s+/u).filter((word) => word.length > 0)
    let lastFlag
    let positional = 0
    let seen = 0
    for (const word of words) {
      if (/^[|;&]/u.test(word) || seen > 12) break
      seen += 1
      const token = word.replace(/^["']|["']$/gu, '')
      if (token.startsWith('-')) {
        lastFlag = token.toLowerCase()
        continue
      }
      if (/^>>?$/u.test(token)) {
        lastFlag = '>'
        continue
      }
      const isPositional = lastFlag === undefined || (!PATH_FLAGS.has(lastFlag) && !VALUE_FLAGS.has(lastFlag))
      if (isPositional && contentAfterFirst && positional >= 1) {
        positional += 1
        lastFlag = undefined
        continue
      }
      if (lastFlag === '>' || lastFlag === undefined || PATH_FLAGS.has(lastFlag) || !VALUE_FLAGS.has(lastFlag)) {
        if (token.length > 0) precise.add(token)
      }
      if (isPositional) positional += 1
      lastFlag = undefined
    }
  }
  // ② 宽松候选只留"像路径"的（避免把 `print(1)` 这种参数当成写目标）；
  //    精确目标**不过这一关** —— 裸目录名（`v6_模块自适应`）必须照样进判定。
  const looksLikePath = (token) => /[\\/]/u.test(token) || /\.(?:[A-Za-z0-9]{1,6})$/u.test(token)
  return [...new Set([...precise, ...[...loose].filter((token) => looksLikePath(token))])]
}

/** 命令里是否出现变更类模式（决定要不要查范围、要不要扣额度）。 */
export function isShellWrite(command) {
  return SHELL_WRITE_PATTERN.test(typeof command === 'string' ? command : '')
}

/**
 * `python -c "…"` / `node -e "…"` 这类**内联代码**是不是在写东西。
 *
 * ## 为什么需要这段（2026-09-20 用户报的缺陷）
 *
 * `SHELL_WRITE_PATTERN` 里有 `python -c` / `node -e`（本意：防「用内联代码绕过写闸」）。
 * 但那条规则太钝 —— 它把**整条命令**判成变更类，于是接着按「命令里出现过哪个路径」
 * 去查写范围。结果是审计层最需要的那种命令被误杀：
 *
 *     python -c "print(open('notes/_state.json').read())"     # 只是读
 *     ⇒ 变更类 ⇒ 目标 notes/_state.json 不在写范围（_audit_scratch/）⇒ 整条命令被拒
 *     「路径不在允许范围内」
 *
 * 用户的原话：「它现在分不清『只读地打开』和『改写它』。」
 *
 * 修法：**按代码里到底有没有写/执行的动作判**，而不是按命令里出现了哪个路径判。
 * 代码里没有任何写/执行动作 ⇒ 这条命令就是只读的（归 `read_file` 档，和「读文件」同档）。
 *
 * ## 判据（写清楚，不留暗门）
 *
 * 1. 引号**外面**没有任何变更信号（重定向、`Remove-Item`… 照旧由 `SHELL_WRITE_PATTERN` 判）；
 * 2. 解释器只收 `python` / `py` / `node` / `deno` / `perl` / `ruby`
 *    —— **绝不放 `pwsh -Command` / `powershell -Command`**：PowerShell 内联代码的写动作
 *    在命令文本里本来就看得到（`Remove-Item` 会被 `SHELL_WRITE_PATTERN` 直接命中），
 *    放它进来等于开一个真后门；
 * 3. 引号配对（不配对 ⇒ 从严，按变更类判）；
 * 4. 代码里不出现 `INLINE_CODE_WRITE_PATTERN` 的任何一项。
 *
 * ⚠️ 如实标注边界：文本判据**挡不住刻意混淆**（`getattr(os, 'sys'+'tem')`）。
 * 这里要的是「挡掉误杀、且不给出明显的绕法」，不是「证明代码只读」。
 * 真正的只读只能靠环境层（只读挂载 / 沙箱）。
 */
export const INLINE_INTERPRETER = /(?<![\w-])(?:python[23]?(?:\.exe)?|py(?:\.exe)?|node(?:\.exe)?|deno|perl|ruby)(?![\w-])/iu

/** 内联代码的旗标（`-c` / `-e` / `--eval` / `--command`）。 */
export const INLINE_FLAG = /(?:^|\s)(?:-c|-e|--eval|--command)(?=\s|$)/iu

/**
 * 「解释器 + 旗标」这一小段本身（`python -c` / `node -e`）。
 *
 * ⚠️ 必须有它：`SHELL_WRITE_PATTERN` 里 `python -c` 这一项**自己**就命中
 * 「`python -c`」这五个字，所以"引号外还有没有变更信号"不能直接测 ——
 * 得先把这一小段摘掉再测，否则只读内联代码永远进不了只读档。
 * （我第一版就是这么写错的，smoke 当场把 13 条打红。）
 */
export const INLINE_CALL_PATTERN = /(?<![\w-])(?:python[23]?(?:\.exe)?|py(?:\.exe)?|node(?:\.exe)?|deno|perl|ruby)(?:\s+-\S+)*\s+(?:-c|--command|-e|--eval)(?![\w-])/giu

/**
 * 内联代码里的**写 / 执行**动作。命中任意一项 ⇒ 这条命令仍算变更类。
 *
 * ⚠️ 刻意**不**把 `>` / `>>` 算进来：引号里的 `>` 是 Python 的比较/位移，
 * 不是 shell 重定向（`python -c "print(1 if 2>1 else 0)"` 是纯只读）。
 * 重定向只在**引号外**才算数 —— 那一半由 `isShellWrite(outside)` 负责。
 */
export const INLINE_CODE_WRITE_PATTERN = new RegExp(
  [
    // 写文件
    String.raw`(?<!(?:stdout|stderr))\.write\s*\(`, // `sys.stdout.write('x')` 是往屏幕写，不算动文件
    String.raw`writelines\s*\(`,
    String.raw`write_text\s*\(`,
    String.raw`write_bytes\s*\(`,
    String.raw`writeFile`,
    String.raw`appendFile`,
    String.raw`createWriteStream`,
    String.raw`truncate\s*\(`,
    // 打开方式带写位：`open(p, 'w')` / `open(p, 'r+')` / `open(p, mode='a')` / `Path(p).open('w')`
    String.raw`open\s*\([^;\n]{0,200}?,\s*['"][^'"]*[wax+][^'"]*['"]`,
    String.raw`open\s*\([^;\n]{0,200}?mode\s*=\s*['"][^'"]*[wax+][^'"]*['"]`,
    String.raw`\.\s*open\s*\(\s*['"][^'"]*[wax+][^'"]*['"]`,
    // 删 / 建 / 移
    String.raw`os\s*\.\s*(?:remove|unlink|rmdir|removedirs|mkdir|makedirs|rename|replace|chmod|chown|truncate|link|symlink)`,
    String.raw`shutil`,
    // 起进程 / 动态执行
    String.raw`subprocess`,
    String.raw`child_process`,
    String.raw`spawnSync`,
    String.raw`execSync`,
    String.raw`os\s*\.\s*(?:system|popen|exec|spawn|kill)`,
    String.raw`(?<![\w.])eval\s*\(`,
    String.raw`(?<![\w.])exec\s*\(`,
    String.raw`__import__`,
    String.raw`compile\s*\(`,
    // 代码里直接写 PowerShell / 联网
    String.raw`(?<![\w-])(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Clear-Content|Rename-Item)(?![\w-])`,
    String.raw`Invoke-WebRequest`,
    String.raw`Invoke-Expression`,
    String.raw`(?<![\w-])tee(?![\w-])`,
    String.raw`(?<![\w-])pip\s+install(?![\w-])`,
    String.raw`(?<![\w-])npm\s+(?:i|install)(?![\w-])`,
    String.raw`(?<![\w-])(?:curl|wget)(?![\w-])`,
  ].join('|'),
  'u',
)

/**
 * 把命令按引号切成「引号外」和「引号内」两半。
 *
 * 只处理 `"` 和 `'`，并识别双引号里的 `\` 转义 —— 骗过这个切分的写法
 * 只会让 `balanced` 变 false，而 false 是**从严**（按变更类判）。
 *
 * @returns - `outside`：引号外（shell 真正解析的部分）
 *            `code`：所有引号内内容拼起来（内联代码）
 *            `balanced`：引号是否配对
 */
export function splitQuoted(command) {
  const text = typeof command === 'string' ? command : ''
  let outside = ''
  let code = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      outside += ch
      continue
    }
    if (ch === '\\' && quote === '"') {
      code += ch
      i += 1
      if (i < text.length) code += text[i]
      continue
    }
    if (ch === quote) {
      quote = null
      code += '\n'
      continue
    }
    code += ch
  }
  return { outside, code, balanced: quote === null }
}

/**
 * 这条命令是不是**只读的内联代码**（可以当只读命令放行）。
 *
 * 四条同时成立才算（见 `INLINE_CODE_WRITE_PATTERN` 上方：为什么这么判、边界在哪）。
 */
export function isReadOnlyInline(command) {
  const text = typeof command === 'string' ? command : ''
  if (!isShellWrite(text)) return false // 引号外没有变更信号 ⇒ 压根不用走这条通道
  const { outside, code, balanced } = splitQuoted(text)
  if (!balanced) return false
  if (!INLINE_INTERPRETER.test(outside)) return false
  if (!INLINE_FLAG.test(outside)) return false
  // 摘掉「python -c」这一小段再测：它自己在写模式里，但那是"通道"，不是"变更"
  if (isShellWrite(outside.replace(INLINE_CALL_PATTERN, ' '))) return false
  if (code.trim().length === 0) return false
  return !INLINE_CODE_WRITE_PATTERN.test(code)
}

/** 这条命令里有没有内联代码（不看它写不写，只看"是不是 python -c 这种形状"）。 */
export function isInlineCodeCommand(command) {
  // ⚠️ **不要求引号配对**：不配对时 `splitQuoted` 也会把已开引号之后的内容当代码，
  //    而"引号不配对"这条命令**照样要查目标**（否则 `python -c "open('x','w')` 这种
  //    半截写法就成了不检查的通道）。配对与否只影响"算不算只读"，不影响"要不要查"。
  const { outside } = splitQuoted(command)
  return INLINE_INTERPRETER.test(outside) && INLINE_FLAG.test(outside)
}

/** 内联代码里是不是**有写/执行动作**（只读探针 ⇒ false）。 */
export function inlineCodeHasWrite(command) {
  const { code } = splitQuoted(command)
  return code.trim().length > 0 && INLINE_CODE_WRITE_PATTERN.test(code)
}

/**
 * 内联代码里**字面写出来的目标路径**（`open('a.txt','w')` 里的 `a.txt`）。
 *
 * 为什么需要：`python -c "open('private_app/x','w').write('y')"` 既没有重定向、
 * 也没有写类 cmdlet，`shellWriteTargets` 从命令文本里一个目标都抽不出来 ——
 * 于是它被判成变更类、却"没有目标可查"，范围锁形同虚设。
 * 这一段就是把"代码里看得见的写"翻译成可检查的路径。
 *
 * ⚠️ 只取**第一参数是路径**的那些 API：`write_text('内容')` 的第一参数是**内容**，
 * 把它当路径就会把内容误判成越权（所以它不在这张表里）。
 * 取到的路径再过一遍 `looksLikePath`（同 `shellWriteTargets`）—— 过滤只会更松，
 * 而"一个字面路径都解析不出来"的结果是**拒**（见 `judgeShell`），所以过滤不会造成漏放。
 */
export function inlineWriteTargets(command) {
  const { code } = splitQuoted(command)
  const PATH_FIRST = [
    // Python
    String.raw`open`,
    String.raw`Path`,
    String.raw`os\s*\.\s*(?:remove|unlink|rmdir|removedirs|mkdir|makedirs|truncate|chmod|chown)`,
    String.raw`os\s*\.\s*(?:rename|replace|link|symlink)`,
    // Node
    String.raw`writeFileSync`,
    String.raw`writeFile`,
    String.raw`appendFileSync`,
    String.raw`appendFile`,
    String.raw`createWriteStream`,
    // PowerShell 写在代码里的那种（少见，但同一条规矩）
    String.raw`(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Clear-Content|Rename-Item)`,
  ].join('|')
  const pattern = new RegExp(String.raw`(?:${PATH_FIRST})\s*\(\s*(['"])([^'"]{1,300})\1`, 'gu')
  const found = []
  for (const match of code.matchAll(pattern)) found.push(match[2])
  // `os.rename('a','b')` / `os.replace('a','b')`：两个都是路径
  for (const match of code.matchAll(/(?<![\w.])os\s*\.\s*(?:rename|replace|link|symlink)\s*\(\s*(['"])([^'"]{1,300})\1\s*,\s*(['"])([^'"]{1,300})\3/gu)) {
    found.push(match[2], match[4])
  }
  const looksLikePath = (token) => /[\\/]/u.test(token) || /\.(?:[A-Za-z0-9]{1,6})$/u.test(token)
  return [...new Set(found.filter((token) => looksLikePath(token)))]
}

/** 跑测试/校验的指纹：命中即归到 `run_test` 预算，而不是通用写预算。 */
export const TEST_RUN_PATTERN = new RegExp(
  [
    String.raw`(?<![\w-])node\s+--test(?![\w-])`,
    String.raw`(?<![\w-])npm\s+(run\s+)?test(?![\w-])`,
    String.raw`(?<![\w-])pnpm\s+(run\s+)?test(?![\w-])`,
    String.raw`(?<![\w-])yarn\s+test(?![\w-])`,
    String.raw`(?<![\w-])(npx\s+)?(vitest|jest|pytest|mocha|ava)(?![\w-])`,
    String.raw`(?<![\w-])cargo\s+test(?![\w-])`,
    String.raw`(?<![\w-])go\s+test(?![\w-])`,
    String.raw`(?<![\w-])dotnet\s+test(?![\w-])`,
  ].join('|'),
  'u',
)

/**
 * 把一条 shell 命令归类到一个**预算键**。这是「按工具发预算」在命令层的一半 ——
 * 另一半是 `write`/`edit`/`read` 这类有明确工具名的调用。
 *
 * 归一化规则（刻意的取舍，写在明面上）：
 *   - 跑测试 → `run_test`（**独立额度**：用户要的「只许跑 test_01，最多 3 次」）；
 *   - 其余变更类命令 → `write_file`（扣写额度）；
 *   - 只读命令 → `read_file`（默认无限，除非意图层给了读范围/读额度）。
 *     其中包括**只读的内联代码**（`python -c "print(open(p).read())"`、`node -e "…"`）——
 *     按「代码里有没有真的写」判，不按「命令里出现过哪个路径」判。
 *
 * ⚠️ 这里**不**试图猜测试文件路径：命令是一整串文本，猜错就会把
 * 「允许跑 test_01」误判成越权。所以测试的**范围**用文件路径类参数来管（见下），
 * 而「只许跑 test_01」这种收窄建议写进执行目标的文字里，由执行层遵守 ——
 * 机制负责「跑几次」，不假装能可靠地解析「跑哪一个」。
 */
export function classifyShell(command) {
  const text = typeof command === 'string' ? command : ''
  if (TEST_RUN_PATTERN.test(text)) return 'run_test'
  // ⚠️ `python -c "…"` / `node -e "…"` 先看**代码里有没有真的写**（见 `isReadOnlyInline`）：
  //    只读探针 ⇒ 归只读档（同「读文件」，不查写范围、不扣额度）；
  //    代码里有写/执行动作 ⇒ 照旧归变更类，查范围、扣额度，一个都不放过。
  if (isShellWrite(text) && !isReadOnlyInline(text)) return 'write_file'
  return 'read_file'
}

/** 文本里是否出现「挑战定律」的指纹。 */
export function challengesLaw(text) {
  return LAW_CHALLENGE_PATTERN.test(typeof text === 'string' ? text : '')
}

/**
 * agent 的角色判定。判据全部来自产品自己的会话头字段（`childSessionMeta` 逐字设置
 * `origin: 'subagent'`）：
 *   - `executor`：本 preset 的子会话
 *   - `intent`：本 preset 的顶层会话
 *   - `other`：其余（不归本插件管）
 */
export function roleOf(agent, { isRoot }) {
  const origin = agent?.session?.header?.origin
  if (origin === 'subagent') return 'executor'
  if (isRoot === true) return 'intent'
  return 'other'
}

/** 从消息事件的 `content` 里取纯文本。 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/** 内置的三个预算键（`write`/`edit` 都归到 `write_file`）。 */
export const CORE_BUDGET_KEYS = ['read_file', 'write_file', 'run_test']

/**
 * 解析工具调用里的 `tool_budgets` 参数（JSON 字符串），归一成
 * `{ [budgetKey]: { total, paths } }`。
 *
 * 为什么用 JSON 字符串而不是嵌套对象参数：DSH 的参数 DSL 对嵌套支持很窄
 * （只到 `object`/`array`，没有变体），而预算表的键是**动态的**（工具名由意图层决定），
 * 定长 schema 表达不了。一个字符串参数 + 严格解析，比一个装不下的 schema 更诚实。
 *
 * @returns 归一后的预算表；解析失败返回 `{}`（保守：空表 = 什么都不放行）。
 */
export function parseToolBudgetsArg(raw) {
  const out = {}
  if (raw === undefined || raw === null) return out
  let parsed = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text.length === 0) return out
    try {
      parsed = JSON.parse(text)
    } catch {
      return out
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [rawKey, rawSpec] of Object.entries(parsed)) {
    const key = normalizeBudgetKey(rawKey)
    if (key.length === 0) continue
    const spec = rawSpec !== null && typeof rawSpec === 'object' && !Array.isArray(rawSpec) ? rawSpec : {}
    const total = parseQuota(spec.limit ?? spec.quota ?? spec.count ?? '')
    const paths = []
    const rawScopes = spec.scopes ?? spec.paths ?? spec.path
    if (Array.isArray(rawScopes)) {
      for (const item of rawScopes) if (typeof item === 'string' && item.trim().length > 0) paths.push(item.trim())
    } else if (typeof rawScopes === 'string') {
      paths.push(...parseScopeList(rawScopes))
    }
    out[key] = { total: total ?? -1, paths }
  }
  return out
}

/** 把租约渲染成一份**可转发的授权包原文**（执行层看到它才会生效）。 */
export function buildGrantPackageText(lease) {
  const lines = [`${GRANT_MARKER}`, `任务ID: "${lease.taskId || 'TASK'}"`]
  if (lease.law) lines.push(`冻结定律: "${lease.law}"`)
  lines.push('工具预算:')
  const entries = Object.entries(lease.tools ?? {})
  if (entries.length === 0) {
    lines.push('  write_file:', '    额度: 0次')
  } else {
    for (const [key, budget] of entries) {
      lines.push(`  ${key}:`, `    额度: ${budget.total < 0 ? '无限' : `${budget.total}次`}`)
      if (budget.paths.length > 0) lines.push(`    范围: ${budget.paths.join(', ')}`)
    }
  }
  if (lease.allowWrite.length > 0) lines.push(`允许写: ${lease.allowWrite.join(', ')}`)
  if (lease.denyWrite.length > 0) lines.push(`禁止碰: ${lease.denyWrite.join(', ')}`)
  lines.push(`预算外行为: "${lease.outOfBudget || '禁止。如需超出预算，必须向意图层申请。'}"`)
  return lines.join('\n')
}

/** 工具名 / 预算键归一化：模型写 `write`、`pwsh`、`读文件` 都要落到同一个预算上。 */
export function normalizeBudgetKey(raw) {
  const key = String(raw ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  if (key.length === 0) return ''
  if (['read', 'read_file', 'readfile', 'glob', 'grep', 'search', '读', '读文件', '读范围'].includes(key)) return 'read_file'
  if (['write', 'edit', 'write_file', 'writefile', '写', '写文件', '变更'].includes(key)) return 'write_file'
  if (['run_test', 'runtest', 'test', 'tests', '跑测试', '测试', '实验'].includes(key)) return 'run_test'
  // **整路额度**（2026-09-20 加）：用户与人都是按"那个能跑程序的入口"想事情的 ——
  // 它叫「命令行」（工具名 `pwsh`）。这几个写法落到 `shell` = 这一路总共多少次。
  //
  // ⚠️ 刻意**不**把 `shell` / `shells` 收进来：那两个名字在本项目里**历史语义是"跑测试额度"**
  //    （老授权包写「实验额度」就是它），改了等于悄悄放宽既有授权 —— 整路请写「命令行」或 `pwsh`。
  if (['pwsh', 'powershell', 'terminal', '命令行', '命令', '终端', '整路', '整条命令行'].includes(key)) return 'shell'
  return key
}

/** 给人看的额度名 —— **按"你要在哪儿用它"命名，不按内部键名命名**。 */
export const BUDGET_LABELS = {
  shell: '命令行（整路）',
  run_test: '命令行 · 跑测试/校验',
  write_file: '写文件 / 命令行 · 变更类',
  read_file: '读文件 / 命令行 · 只读',
}

/**
 * 解析一条额度：`5` / `5次` / `最多 5 次` / `无限` / `不限` / `unlimited` / `∞`。
 *
 * ⚠️ **2026-09-21 收紧（用户现场 §4③）**：判据从"值里第一个数字"改成
 * **整个值必须像一个额度**。原来的写法会把散文里的数字吸进来：
 * 现场那条 `7. 现状参考（…）：当前交付树 sha256 以 \`0EA7…\` 为准。`
 * 被解析成"额度 256"（sha 里前几位数字），于是预算表里多出一条 0/256 的鬼条目。
 *
 * @returns 次数；`-1` 表示无限；不像额度就返回 `undefined`（**不猜**）。
 */
export function parseQuota(value) {
  const raw = String(value ?? '').trim().replace(/^["'「]|["'」]$/gu, '').trim()
  if (raw.length === 0) return undefined
  if (raw.length > 24) return undefined // 一条额度写不了这么长 —— 长了就是句子
  if (/^(无限|不限|unlimited|inf|∞|\*)$/iu.test(raw)) return -1
  // 允许前后有装饰词（额度 / 最多 / 上限 / 一共 / 至多），但**中间只能有一个数**，
  // 且整串不能含句子标点（逗号、分号、括号…）—— 那些是散文的特征。
  if (/[，。；！？、,;!?]/u.test(raw)) return undefined
  const match = /^[^\d]{0,6}(\d{1,7})\s*(?:次|个|条|回)?$/u.exec(raw)
  if (match === null) return undefined
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * 这个键**像不像一个预算名**（而不是散文里的半句话）。
 *
 * 用户现场的原话（§4③）：
 * > 「预算表只从结构化调用里读，不许再从正文里猜。」
 * 判据：短（≤24 字）、没有句子标点、没有引号括号花括号、不是一长串 snake_case。
 * 现场那三条鬼键（`7._现状参考（你自己复跑确认，别当真值用）` /
 * `报告里要有` / `your_parent_agent_id_is_"session_…"._before_you_finish,…`）
 * 前两条被标点挡住，第三条被长度与下划线挡住。
 */
export function isCleanBudgetKey(raw) {
  const key = String(raw ?? '').trim()
  if (key.length === 0 || key.length > 24) return false
  if (/[，。；！？、,;:!?()（）{}[\]<>「」【】"'`]/u.test(key)) return false
  if (/\s/u.test(key) && key.split(/\s+/u).length > 2) return false
  // ⚠️ 下划线只允许一条（`read_file` / `task_id` 是正常名字）；
  //    现场那条英文附注有好几条下划线 + 引号 + 超长，靠这三条一起挡住。
  if ((key.match(/_/gu) ?? []).length > 1) return false
  return true
}

/**
 * 这一行**是不是结构化的**（授权块只收结构化行）。
 *
 * 现场那条事故的形状：`【授权】` 块后面跟着 1..7 条散文、一段报告要求、一段英文附注，
 * 中间没有下一个 `【标记】` —— 于是整片散文都被当成 YAML 收进了预算表。
 * 现在的规矩：**遇到第一个非空、非缩进、又不像 `键: 值` 的行，块就到此为止。**
 */
export function isStructuredGrantLine(line) {
  const text = String(line ?? '')
  if (text.trim().length === 0) return true
  if (/^\s*【/u.test(text)) return false
  if (/^\s+/u.test(text)) return true // 缩进 = 上一项的值
  const match = /^\s*([^:：]{1,24})\s*[:：]\s*(.*)$/u.exec(text)
  if (match === null) return false
  const key = match[1].trim()
  if (key.length === 0) return false
  if (/[，。；！？、,;!?()（）「」【】]/u.test(key)) return false
  // 值也不能长得像句子（`用 send_message 发给意图层会话 …` 这种一律不算）
  const value = match[2].trim()
  if (value.length > 120) return false
  return true
}

/** 解析一条范围：支持逗号/分号分隔的多条，也支持 `[a, b]` 形式。 */
export function parseScopeList(value) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return []
  if (/^(无限|不限|unlimited|all|全部|\*)$/iu.test(raw)) return []
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  return inner
    .split(/[,，;；]/u)
    .map((item) => item.trim().replace(/^["']|["']$/gu, ''))
    .filter((item) => item.length > 0)
}

/**
 * 极简 YAML 子集解析：**只支持嵌套映射 + 标量**，正好覆盖授权包的结构。
 *
 * 为什么不引 YAML 库：本插件刻意保持零跨包依赖
 * （`dsh-executor-loop` 的事故证明「能 import」与「能挂上」是两件事，少一个依赖就少一个失败点）。
 * 为什么不支持列表/多行标量：授权包用不到；真需要时用逗号写在一行里（`范围: a, b`）。
 *
 * @returns 嵌套对象；解析不出任何键时返回 `undefined`。
 */
export function parseYamlSubset(lines, baseIndent = 0) {
  const out = {}
  let index = 0
  while (index < lines.length) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      index += 1
      continue
    }
    const indent = raw.length - raw.trimStart().length
    if (indent < baseIndent) break
    if (indent > baseIndent) break // 多出来的缩进由递归处理，不该走到这里
    const colon = /^([^:：]+)[:：]\s*(.*)$/u.exec(trimmed)
    if (colon === null) {
      index += 1
      continue
    }
    const key = colon[1].trim()
    // ⚠️ 2026-09-21：**键不像键就跳过**（现场那次散文被当成预算名的形状）。
    //    只对"预算名"这一类严格：任务ID / 冻结定律 这类顶层键本来就短而干净。
    if (!isCleanBudgetKey(key)) {
      index += 1
      continue
    }
    // 授权包里习惯给值加引号（`任务ID: "TASK-001"`）；引号是 YAML 语法、不是值的一部分，
    // 必须剥掉 —— 否则它会被一路带进租约、再被渲染回授权包时变成 `""TASK-001""`。
    const value = colon[2].trim().replace(/^(["'])(.*)\1$/u, '$2')
    if (value.length > 0) {
      out[key] = value
      index += 1
      continue
    }
    // 值为空 → 看后面是否有更深缩进（嵌套映射）。
    let cursor = index + 1
    while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1
    const childIndent = cursor < lines.length ? lines[cursor].length - lines[cursor].trimStart().length : -1
    if (childIndent > indent) {
      const child = parseYamlSubset(lines.slice(cursor), childIndent)
      out[key] = child ?? {}
      index = cursor
      // 跳过整个子树
      while (index < lines.length && (lines[index].trim().length === 0 || lines[index].length - lines[index].trimStart().length > indent)) index += 1
      continue
    }
    out[key] = ''
    index += 1
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 在解析出来的授权包（嵌套映射）里按多个别名找一个键。 */
function pick(mapping, aliases) {
  if (mapping === undefined || mapping === null || typeof mapping !== 'object') return undefined
  for (const [key, value] of Object.entries(mapping)) {
    if (aliases.includes(String(key).trim().toLowerCase())) return value
  }
  return undefined
}

/**
 * 找出**工具预算表**（它可能没被写成 `工具预算:` 这个名字）。
 *
 * 为什么要兜底：人常常写一句带冒号的说明，再缩进列预算 ——
 *   `工具预算按任务书第六节执行：` + 缩进的 `read_file: 无限` …
 * 解析出来就成了 `{ "工具预算按任务书第六节执行": { read_file: …, write_file: … } }`，
 * 按名字找 `工具预算` 会**找不到**，整张授权包就被当成"没有内容"丢掉
 * （那正是用户 2026-09-20 报过的形状）。所以：**名字对不上时，看形状** ——
 * 哪个顶层对象里出现了已知预算名，它就是预算表。
 */
function pickToolBudgetMap(pkg) {
  const direct = pick(pkg, ['工具预算', 'toolbudgets', 'tools', 'budgets', '预算'])
  if (direct !== null && typeof direct === 'object' && !Array.isArray(direct)) return direct
  const known = new Set(['read_file', 'write_file', 'run_test', 'shell'])
  for (const [key, value] of Object.entries(pkg ?? {})) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (!/预算|工具|budget|tools/iu.test(String(key))) continue
    const keys = Object.keys(value).map((item) => normalizeBudgetKey(item))
    if (keys.some((item) => known.has(item))) return value
  }
  for (const value of Object.values(pkg ?? {})) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const keys = Object.keys(value).map((item) => normalizeBudgetKey(item))
    if (keys.some((item) => known.has(item))) return value
  }
  return undefined
}

/** 把解析出来的授权包转成租约要用的形状。 */
function interpretGrantPackage(pkg) {
  const grant = { allowWrite: [], denyWrite: [], tools: {}, taskId: '', law: '', outOfBudget: '' }
  const taskId = pick(pkg, ['任务id', 'taskid', 'task_id', '任务'])
  if (typeof taskId === 'string') grant.taskId = taskId
  const law = pick(pkg, ['冻结定律', 'law', 'laws', '定律'])
  if (typeof law === 'string') grant.law = law
  const outOfBudget = pick(pkg, ['预算外行为', 'outofbudget', '预算外'])
  if (typeof outOfBudget === 'string') grant.outOfBudget = outOfBudget

  const toolBudgets = pickToolBudgetMap(pkg)
  if (toolBudgets !== null && typeof toolBudgets === 'object') {
    for (const [rawKey, rawSpec] of Object.entries(toolBudgets)) {
      const key = normalizeBudgetKey(rawKey)
      if (key.length === 0) continue
      const spec = rawSpec !== null && typeof rawSpec === 'object' ? rawSpec : {}
      const quota = parseQuota(pick(spec, ['额度', 'quota', 'limit', '次数', 'count']) ?? (typeof rawSpec === 'string' ? rawSpec : ''))
      const scopes = parseScopeList(pick(spec, ['范围', 'scope', 'scopes', 'paths', 'path']) ?? '')
      const paths = scopes.length > 0 ? scopes : []
      if (quota !== undefined || paths.length > 0 || spec === undefined) {
        grant.tools[key] = { total: quota ?? -1, paths }
      }
      // 写类工具的预算范围同时并进通用写范围，供 `write`/`edit`/变更类 shell 共用。
      if (key === 'write_file' && paths.length > 0) grant.allowWrite.push(...paths)
    }
  }

  // 简单写法（与结构化授权包等价）：允许写 / 禁止碰 / 写额度 / 实验额度 / 读范围
  const allowWrite = pick(pkg, ['允许写', 'allowwrite', 'write', '可写'])
  if (typeof allowWrite === 'string') grant.allowWrite.push(...parseScopeList(allowWrite))
  const denyWrite = pick(pkg, ['禁止碰', '禁止', 'denywrite', 'deny', '不可写'])
  if (typeof denyWrite === 'string') grant.denyWrite.push(...parseScopeList(denyWrite))
  const readScope = pick(pkg, ['读范围', 'readscope', 'read'])
  if (typeof readScope === 'string') {
    const paths = parseScopeList(readScope)
    grant.tools.read_file = { total: parseQuota(pick(pkg, ['读额度', 'readquota']) ?? '') ?? grant.tools.read_file?.total ?? -1, paths }
  }
  const writeQuota = parseQuota(pick(pkg, ['写额度', 'writes', 'writelimit', 'budgetwrites']) ?? '')
  if (writeQuota !== undefined) grant.tools.write_file = { total: writeQuota, paths: grant.tools.write_file?.paths ?? [] }
  // ⚠️ 「实验额度 / shell」历史语义 = **跑测试额度**（既有授权包都这么写）—— 保持不动。
  const runQuota = parseQuota(pick(pkg, ['实验额度', 'shell', 'shells', 'shelllimit', 'budgetshell', '跑测试', '测试额度']) ?? '')
  if (runQuota !== undefined) grant.tools.run_test = { total: runQuota, paths: grant.tools.run_test?.paths ?? [] }
  // **整路额度**：按"那个能跑程序的入口"给 —— 用户就是这么想的（「命令行」）。
  const channelQuota = parseQuota(pick(pkg, ['命令行', '命令', '终端', '整路', '整条命令行', 'pwsh', 'powershell']) ?? '')
  if (channelQuota !== undefined) grant.tools.shell = { total: channelQuota, paths: [] }

  // ── **不认识的键不许被静默丢掉**（2026-09-20 用户现场换来的） ──────────────
  //
  // 现场：意图层写了「命令行: 2次」，而解析器的别名表里没有「命令行」——
  // 于是这个包**整个被当成"没有内容"扔掉**（返回 undefined），租约停在"冻结 / 未命名 / 无预算"，
  // 而回执那边什么都不会说。用户的原话正是这个味道：
  // 「那「40 次额度」挂在一个审计层根本调不到的名字上。」
  //
  // 现在的做法：**认不出来的键，只要值是个额度，就当"那个名字的预算"收下**
  // （名字先过 `normalizeBudgetKey`，能归一到 `shell` / `write_file` / `run_test` 的会归过去；
  //  归一不了的也照样记进预算表 —— 一个没人查的额度无害，而**悄悄丢掉整张授权包是有害的**）。
  const KNOWN_TOP_LEVEL = new Set([
    '任务id', 'taskid', 'task_id', '任务', '冻结定律', 'law', 'laws', '定律', '预算外行为', 'outofbudget', '预算外',
    '工具预算', 'toolbudgets', 'tools', 'budgets', '预算', '允许写', 'allowwrite', 'write', '可写',
    '禁止碰', '禁止', 'denywrite', 'deny', '不可写', '读范围', 'readscope', 'read', '读额度', 'readquota',
    '写额度', 'writes', 'writelimit', 'budgetwrites', '实验额度', 'shell', 'shells', 'shelllimit', 'budgetshell',
    '命令行', 'pwsh', 'powershell', '命令', '终端', '执行目标', 'goal',
  ])
  // ── **不认识的键：记下来报给人，但绝不悄悄变成预算**（2026-09-21 用户现场 §4③） ──
  //
  // 现场那句「预算表只从结构化调用里读，不许再从正文里猜」，判据就落在这里：
  //   · **认识的额度名**（读文件 / 写文件 / 跑测试 / 命令行 / 实验额度 …）⇒ 收下；
  //   · **认识的名字但写在散文里**（值不像额度）⇒ 不收，也不报（那是句子，不是授权）；
  //   · **不认识的名字** ⇒ 不收，**但原样列进回执**（"这个名字我没生效"）。
  // 以前那版是"只要值里有数字就当预算收下"，于是 sha256 变成了「0/256」、
  // 一段英文附注变成了「0/455」（用户现场那张预算表里就有这两条）。
  const KNOWN_NUMERIC_KEYS = new Set([
    '读', '读文件', '读范围', '读额度', 'read', 'read_file', 'readquota',
    '写', '写文件', '写额度', 'writes', 'writelimit', 'write', 'write_file',
    '跑测试', '测试', '测试额度', '实验额度', 'run_test', 'test',
    '命令行', '命令', '终端', '整路', '整条命令行', 'pwsh', 'powershell', 'shell', 'shells',
  ])
  const ignored = []
  for (const [rawKey, rawValue] of Object.entries(pkg ?? {})) {
    const lowered = String(rawKey).trim().toLowerCase()
    if (KNOWN_TOP_LEVEL.has(lowered)) continue
    if (typeof rawValue !== 'string') continue
    const quota = parseQuota(rawValue)
    if (quota === undefined) continue
    if (!KNOWN_NUMERIC_KEYS.has(lowered)) {
      ignored.push(`${rawKey}: ${rawValue}（不认识的额度名 —— 没生效；请写已知名，或放进「工具预算:」块里）`)
      continue
    }
    const key = normalizeBudgetKey(rawKey)
    if (key.length === 0 || grant.tools[key] !== undefined) continue
    grant.tools[key] = { total: quota, paths: [] }
  }
  if (ignored.length > 0) grant.ignored = ignored

  const hasAnything = grant.allowWrite.length > 0 || grant.denyWrite.length > 0 || Object.keys(grant.tools).length > 0
  // ⚠️ 「有认不出的额度名」也算有内容 —— 否则整包会被当成空的扔掉，
  //    回执与台账就**没机会说出"你写的那几个名字没生效"**（用户最恨的静默失败）。
  if (!hasAnything && (grant.ignored ?? []).length === 0) return undefined
  if (grant.allowWrite.length === 0 && grant.tools.write_file !== undefined) grant.allowWrite.push(...(grant.tools.write_file.paths ?? []))
  return grant
}

/**
 * **回读核对**：把「意图层要的」与「租约里实际生效的」逐项比一遍。
 *
 * 用户 2026-09-19 报的缺陷（原话）：
 * > 「症状：grant_permission 回「已授权」、打印预算、打印写范围 ——
 * >  而实际生效的是 read_file 1/1、写范围空。**六个执行层被拒写**。」
 *
 * 根因不是某一行写错了，而是**回执说的是"我做了什么"，不是"现在是什么"**：
 * 只要下发与生效之间有任何一步没落地（id 对不上、范围没并进去、额度被折叠吞掉、
 * 租约被时间锁/熔断标成冻结），回执照样漂亮 —— 而执行层一个字节都写不了。
 * 所以判据必须是**读回来比**，不是**写完就报**。
 *
 * ⚠️ 这个函数是**纯函数**（只比两个对象），所以它可以被离线断言 ——
 * 而"报警器本身有没有判别力"只能这样验。
 *
 * @param requested - `{ allowWrite, denyWrite, tools, taskId }`（意图层这次要的）
 * @param effective - 结算后的租约（`leaseFor` 读回来的那个）
 * @returns `{ ok, diffs: string[], notes: string[] }`
 */
export function verifyGrant(requested, effective, now = Date.now()) {
  const diffs = []
  const notes = []
  if (effective === undefined || effective === null) {
    return { ok: false, diffs: ['读不回来：结算之后没有这份租约'], notes }
  }
  /**
   * 路径比较**必须宽容大小写与斜杠**：折叠时 `normalizePath` 会把 `D:/proj/src` 折成
   * `d:/proj/src`，拿**原样**去比就会报出"少了 D"这种假警 —— 而假警会把真警一起淹掉。
   * （这条是我自己第一版踩的：`写范围少了这些路径：D`。）
   */
  const samePath = (a, b) => String(a).replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase() === String(b).replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase()
  const want = requested ?? {}
  const wantWritePaths = [...(want.allowWrite ?? [])]
  const wantWriteBudget = want.tools?.write_file?.total
  const askedForWrites = wantWritePaths.length > 0 || (typeof wantWriteBudget === 'number' && wantWriteBudget > 0)

  if (effective.frozen === true) {
    diffs.push(`租约是**冻结**的${effective.frozenReason ? `（${effective.frozenReason}）` : ''} —— 这种状态下**任何变更都会被拒**`)
  }

  // ① 写范围
  if (askedForWrites || wantWritePaths.length > 0) {
    const have = effective.allowWrite ?? []
    const missing = wantWritePaths.filter((item) => !have.some((entry) => samePath(entry, item)))
    if (have.length === 0) {
      diffs.push('**写范围是空的** —— 它写不了任何文件（白名单为空 = 冻结）')
    } else if (missing.length > 0) {
      diffs.push(`写范围少了这些路径：${missing.join('、')}`)
    }
    const effectiveWrite = effective.tools?.write_file
    if (effectiveWrite === undefined) {
      diffs.push('**没有 write_file 预算** —— 写调用会被判「没有这个工具的预算」')
    } else if (effectiveWrite.total === 0) {
      diffs.push('**write_file 额度是 0** —— 一次都写不了')
    } else if (typeof wantWriteBudget === 'number' && wantWriteBudget > 0 && effectiveWrite.total >= 0 && effectiveWrite.total < wantWriteBudget) {
      diffs.push(`write_file 额度比你要的少：要 ${wantWriteBudget} 次，实际 ${effectiveWrite.total} 次`)
    }
  }

  // ② 跑测试 / 读：只在**明确要过**的时候比
  for (const key of ['run_test', 'read_file']) {
    const wantTotal = want.tools?.[key]?.total
    if (typeof wantTotal !== 'number') continue
    const effectiveTotal = effective.tools?.[key]?.total
    if (effectiveTotal === undefined) {
      diffs.push(`没有 ${key} 预算（你要的是 ${wantTotal < 0 ? '无限' : `${wantTotal} 次`}）`)
      continue
    }
    if (wantTotal >= 0 && effectiveTotal >= 0 && effectiveTotal < wantTotal) {
      diffs.push(`${key} 额度比你要的少：要 ${wantTotal} 次，实际 ${effectiveTotal} 次`)
    }
  }

  // ③ 禁止碰：要的黑名单一条都不能丢（丢一条 = 范围锁有个洞）
  const lostDeny = (want.denyWrite ?? []).filter((item) => !(effective.denyWrite ?? []).some((entry) => samePath(entry, item)))
  if (lostDeny.length > 0) diffs.push(`「禁止碰」里少了：${lostDeny.join('、')}`)

  // ④ 任务 id 与时间锁
  if (typeof want.taskId === 'string' && want.taskId.length > 0 && effective.taskId !== want.taskId) {
    diffs.push(`任务 ID 对不上：要 ${want.taskId}，实际 ${effective.taskId || '(未命名)'}`)
  }
  if (!(effective.expiresAt > now)) diffs.push('时间锁已经过期（或没设上）—— 下一次调用就会被冻结')

  // ⑤ 写得了 ≠ 写得对：把"实际能写哪儿"作为**说明**回给意图层（不是错误）
  if (askedForWrites && (effective.allowWrite ?? []).length > 0) {
    notes.push(`实际可写范围：${(effective.allowWrite ?? []).join('、')}`)
  }
  if ((effective.denyWrite ?? []).length > 0) notes.push(`实际禁止碰：${(effective.denyWrite ?? []).join('、')}`)

  return { ok: diffs.length === 0, diffs, notes }
}

/** 把一份租约渲染成"实际生效值"那几行（回执与台账共用同一处渲染，免得两处漂移）。 */
export function describeEffective(lease) {
  const budgets = Object.entries(lease?.tools ?? {})
    .map(([key, budget]) => `${key} ${budget.total < 0 ? `已用 ${budget.used}/无限` : `${budget.used}/${budget.total}`}`)
    .join('、')
  return [
    `  任务：${lease?.taskId || '(未命名)'}`,
    `  状态：${lease?.frozen === true ? `冻结${lease?.frozenReason ? `（${lease.frozenReason}）` : ''}` : '已授权'}`,
    `  预算（实际）：${budgets || '(无任何工具预算)'}`,
    `  写范围（实际）：${(lease?.allowWrite ?? []).length > 0 ? lease.allowWrite.join('、') : '(空 —— 写不了任何文件)'}`,
    `  禁止碰（实际）：${(lease?.denyWrite ?? []).length > 0 ? lease.denyWrite.join('、') : '(无)'}`,
    `  时间锁：${lease?.expiresAt > 0 ? new Date(lease.expiresAt).toISOString() : '(未授权)'}`,
  ].join('\n')
}

/**
 * **发消息前查活**（用户 2026-09-19 的第 4 条要求）。
 *
 * 用户的原话：
 * > 「症状：给已经收工的执行层发消息 ⇒ 回「已送达」，实际没人会读。
 * >  修法：发送前查活；返回三态之一 —— **排队中 ／ 已拒绝（原因）／ 建议新建会话**。
 * >  别把「写进队列」说成「已送达」。」
 *
 * 判据只有一条：**它现在活着吗**。不活着的时候，还要再分一次 ——
 * 产品的 `sendMessage` 对"不在活的"目标会走**冷启动**（cold resume）：
 *   · `mode === 'continuable'` ⇒ 会把它唤醒一轮，消息**读得到** ⇒ 仍算"排队中"；
 *   · `mode === 'one-shot'` ⇒ 产品直接回 `NOT_RESUMABLE`（「叫不醒」）⇒ **建议新建会话**；
 *   · 名册里查不到这个 id ⇒ **已拒绝**（id 写错，或那不是你的直接子会话）。
 *
 * ⚠️ 这是**纯函数**（只吃只读快照），所以三态映射可以被离线断言 ——
 * 而"三态有没有判别力"只能这样验。
 */
export function judgeSendMessage({ targetId, liveIds = [], catalog = new Map(), callerId = '' } = {}) {
  const id = String(targetId ?? '').trim()
  const refuse = (state, chinese, reason, howTo) => ({
    state,
    reason,
    text:
      `【查活 · ${chinese}】send_message → ${id || '(空)'} —— **不会有任何人读这条消息。**\n` +
      `  原因：${reason}\n` +
      `  三态里这是：**${chinese}**\n` +
      `  出路：\n${howTo.map((line) => `    · ${line}`).join('\n')}\n` +
      '  ⚠️ 「已送达」这三个字只对**活着**的目标成立：对已经收工的会话，写进队列等于写进垃圾桶。\n' +
      '  （想知道"发给谁会怎样"，先查 lease_status 里那份名册 —— 它把每个会话的可达性写在明面上。）',
  })
  if (id.length === 0) return refuse('refused', '已拒绝', 'send_message 没给 agent_id。', ['补上 agent_id（用 list_agents 看名册里的 id）。'])
  if (liveIds.includes(id)) return { state: 'queued', reason: '活着：消息进它的队列，它会读到（在跑就插进去，空闲就开一轮）' }
  const entry = catalog.get(id)
  if (entry?.mode === 'continuable') {
    return {
      state: 'queued',
      cold: true,
      reason: '它当前不在活着，但它是**可继续**的子会话：这条消息会冷启动它的一轮，读得到',
      text: '',
    }
  }
  if (entry?.mode === 'one-shot') {
    return refuse('new-session', '建议新建会话', '这个执行层是**一次性**的（`one-shot`，派完就收工），产品叫不醒它（`NOT_RESUMABLE`）。', [
      '重新派一个执行层（subagent）去做这件事；',
      '要验收就派 dispatch_audit（它自己跑完交报告）；',
      '只想留个记录：写进回报或台账，别发给一个已经收工的人。',
    ])
  }
  return refuse(
    'refused',
    '已拒绝',
    `名册里没有 ${id} 这个会话（可能 id 写错了，或者它根本不是你的直接子会话）。`,
    ['用 list_agents / lease_status 核一遍 id；', '确认它是不是你派出去的（只有直接子会话与直接父会话能互发）;', '要新活就新派一个。'],
  )
}

/**
 * 从 `subagents.listChildren()` 的返回值里取出**子会话行**。
 *
 * ⚠️ 这个函数存在的唯一理由是一个实测 bug（2026-09-21）：
 * 产品的 `listChildren` 返回的是**数组**（`resolveCandidateRows(...).filter(...)`），
 * 而第一版按 `listing.children` 读 —— 于是**缓存永远是空的**，
 * 所有"已收工但可继续"的子会话都被判成「名册里没有这个会话」。
 * 用户的现场正是这句话：「现在它一收工，我连问一句都问不到（实测回我『名册里没有这个会话』）」。
 *
 * 两种形状都收下（数组 / `{children}`），免得产品的形状一变就静默失效。
 */
export function childRowsOf(listing) {
  if (Array.isArray(listing)) return listing
  if (Array.isArray(listing?.children)) return listing.children
  if (Array.isArray(listing?.rows)) return listing.rows
  return []
}

/**
 * 从一段「意图层写给执行层的文字」里解析授权。
 *
 * 只认**显式标记**（`【授权】`），**不猜自然语言**。支持两种等价写法：
 *
 * ① 结构化授权包（推荐，正是用户给的形状）：
 * ```
 * 【授权】
 * 任务ID: "TASK-001"
 * 冻结定律: "THE_STRATEGY.md §5"
 * 执行目标: "实现排班逻辑"
 * 工具预算:
 *   read_file:
 *     额度: 无限
 *     范围: "/data/**"
 *   write_file:
 *     额度: 5次
 *     范围: "/output/schedule_*.json"
 *   run_test:
 *     额度: 3次
 * 预算外行为: "禁止。如需超出预算，必须向意图层申请。"
 * ```
 *
 * ② 简单键值（等价、输入更快）：
 * ```
 * 【授权】
 * 允许写: D:\proj\src, D:\proj\tests
 * 禁止碰: D:\proj\src\core
 * 写额度: 40
 * 实验额度: 6
 * ```
 *
 * @returns 解析出的授权；没有任何标记时返回 `undefined`。
 */
export function parseGrantText(text) {
  const source = typeof text === 'string' ? text : ''
  const markerAt = source.indexOf(GRANT_MARKER)
  if (markerAt < 0) return undefined
  const body = source.slice(markerAt + GRANT_MARKER.length)
  // 下一个【标记】开始就不再属于本授权块（避免把后面的申请文本当成授权）。
  // ⚠️ 2026-09-21 再加一道：**遇到散文也停**（现场那次事故就是散文被当成 YAML 收走了）。
  const blockLines = []
  for (const line of body.split(/\r?\n/u)) {
    if (/^\s*【/u.test(line)) break
    if (!isStructuredGrantLine(line)) break
    blockLines.push(line)
  }
  const parsed = parseYamlSubset(blockLines, 0)
  if (parsed === undefined) return undefined
  const grant = interpretGrantPackage(parsed)
  if (grant === undefined) return undefined
  // 如实记下"块停在哪一行" —— 停在散文上是正常的，但让人看得见。
  const stopped = body.split(/\r?\n/u)[blockLines.length]
  if (typeof stopped === 'string' && stopped.trim().length > 0) grant.stoppedAt = stopped.trim().slice(0, 120)
  return grant
}

/**
 * 把一次授权折进租约，返回**新的**租约对象（不改传入的那个）。
 *
 * 额度语义（按工具记账，与「一个全局桶」的关键区别）：
 *   - 该工具**已在预算表里** → 取 `max(旧, 新)`，**只增不减**；
 *     这样意图层「补一句授权」不会把已经烧掉的额度洗回来，也不会意外收窄。
 *   - 该工具**首次出现** → 用新额度。
 *   - 想**收窄**就用 `revoke_permission` 回收后重新授权 —— 收窄必须是显式动作。
 */
export function foldGrantIntoLease(lease, grant, cwd, settings, now = Date.now()) {
  const next = {
    ...lease,
    allowWrite: [...lease.allowWrite],
    denyWrite: [...lease.denyWrite],
    tools: Object.fromEntries(
      Object.entries(lease.tools ?? {}).map(([key, budget]) => [key, { ...budget, paths: [...(budget.paths ?? [])] }]),
    ),
    forbidden: lease.forbidden ?? FORBIDDEN_TARGETS,
    foldedIds: [...(lease.foldedIds ?? [])],
  }
  for (const item of grant.allowWrite ?? []) {
    const normalized = normalizePath(item, cwd)
    if (normalized.length > 0 && !next.allowWrite.includes(normalized)) next.allowWrite.push(normalized)
  }
  for (const item of grant.denyWrite ?? []) {
    const normalized = normalizePath(item, cwd)
    if (normalized.length > 0 && !next.denyWrite.includes(normalized)) next.denyWrite.push(normalized)
  }

  for (const [key, spec] of Object.entries(grant.tools ?? {})) {
    const existing = next.tools[key]
    const paths = (spec.paths ?? []).map((item) => normalizePath(item, cwd)).filter((item) => item.length > 0)
    if (existing === undefined) {
      next.tools[key] = { total: spec.total, used: 0, left: spec.total < 0 ? -1 : spec.total, paths }
      continue
    }
    // 已存在：额度**只增不减**；范围取并集。
    if (spec.total >= 0 && (existing.total < 0 || spec.total > existing.total)) {
      existing.total = spec.total
    }
    // ── ⚠️ `left` **必须按新的 total 重算**（2026-09-21 用户现场 §4①） ──────────
    //
    // 现场原文：
    //   「一个会话只读计数 2/9999，却被判『预算耗尽 · 自动熔断』，之后连只读都拒，
    //     重发租约也解不开。」
    // 根因就在这一行：`read_file` 先是**无限**（`total:-1, left:-1`），后一次授权把
    // `total` 改成 9999，而 `left` 还停在 -1。判据是 `total >= 0 && left <= 0` ⇒
    // **-1 <= 0 成立** ⇒ 报告"已用 2/9999、预算耗尽" ⇒ 只读被拒；
    // 而且每次重发租约都走同一段代码 ⇒ **永远解不开**（这正是用户说的"解不开"）。
    //
    // 现在：只要 total 变了就重算 left（无限 ↔ 有限两个方向都算）。
    existing.left = existing.total < 0 ? -1 : Math.max(0, existing.total - existing.used)
    for (const path of paths) if (!existing.paths.includes(path)) existing.paths.push(path)
  }

  // 首次授权且完全没有工具预算 → 给一份**保底**预算，让执行层有活路，
  // 同时保持「写有上限」这条性质（不是无限放行）。
  //
  // ⚠️ 这里是**补齐**而不是整体覆盖：第一版写成 `next.tools = {...}`，
  // 结果把刚解析出来的 `run_test` 额度直接抹掉（「实验额度: 2」当场失效）。
  // 判据是「按工具发预算」——补默认值绝不能吃掉已明确给出的那一项。
  if (lease.grantCount === 0) {
    next.tools.read_file ??= { total: -1, used: 0, left: -1, paths: [] }
    next.tools.run_test ??= { total: settings.defaultShellBudget, used: 0, left: settings.defaultShellBudget, paths: [] }
  }
  // 给了写范围就必然要给一份写预算：否则「允许写 X」会得到一个**空预算**，
  // 表现为「路径是对的、却写不进去」—— 那不是安全默认，那是把意图层的授权读错了。
  if (next.allowWrite.length > 0 && next.tools.write_file === undefined) {
    next.tools.write_file = { total: settings.defaultWriteBudget, used: 0, left: settings.defaultWriteBudget, paths: [] }
  }
  next.budgetWrites = next.tools.write_file?.total ?? 0
  next.budgetShell = next.tools.run_test?.total ?? 0
  if (typeof grant.taskId === 'string' && grant.taskId.length > 0) next.taskId = grant.taskId
  if (typeof grant.law === 'string' && grant.law.length > 0) next.law = grant.law
  if (typeof grant.outOfBudget === 'string' && grant.outOfBudget.length > 0) next.outOfBudget = grant.outOfBudget
  next.frozen = false
  next.frozenReason = ''
  next.grantedAt = now
  next.expiresAt = now + settings.maxLeaseMs
  next.grantCount += 1
  next.generation += 1
  // ── **熔断要能被复位**（2026-09-21 用户现场 §4① 的另一半） ────────────────
  //
  // 用户的原话：「熔断能被『回收 ＋ 重发租约』复位」。
  // 之前 `violations` 只增不减：一次熔断之后，即便意图层重新授权，
  // 计数仍停在 3/3，下一次调用又被判熔断 —— 从外面看就是"重发租约也解不开"。
  // 现在：**新的一份授权 = 意图层重新做的决定**，违规计数随之清零。
  // （想追究旧账看台账 `ledger.reports` —— 那里一条都不会丢。）
  next.violations = 0
  return next
}

/**
 * 折进一条消息文本。**这是授权的唯一来源** ——
 * 只认「真正到达执行层视野的文字」，不接受任何别的扩权路径。
 */
export function foldMessageIntoLease(lease, text, cwd, settings, now = Date.now()) {
  const grant = parseGrantText(text)
  if (grant === undefined) return lease
  return foldGrantIntoLease(lease, grant, cwd, settings, now)
}

//#endregion

//#region 文案（判定结果的唯一出口：说清「为什么被拒 + 唯一出路」）

function frozenReasonText(tool, settings, lease) {
  const budgetLine = lease === undefined ? '' : `\n当前预算：${describeBudgets(lease)}（任务 ${lease.taskId || '未命名'}）。`
  return (
    `【执行层权限门 · 默认冻结】${tool} 被拒绝：本会话**没有任何写权限**（白纸开局）。${budgetLine}\n` +
    `允许做：读文件、搜代码、跑只读命令（读/glob/grep 与不改状态的 shell）。\n` +
    `被冻结的变更类工具：${settings.deny.join(' / ')}。\n` +
    `要拿到写权限，唯一的路是让意图层授权：\n` +
    `  ① 先调 request_permission 登记申请（你会拿到一段可直接转发的申请文本）；\n` +
    `  ② 用 send_message 把申请发给意图层，然后**停下等**，不要反复重试被拒的调用；\n` +
    `  ③ 意图层会以一条含「${GRANT_MARKER}」的授权包回复你，那条消息一到权限自动生效。\n` +
    `不要因为被拒就自己改道想办法 —— 那不是你的权限范围（条例 ④）。`
  )
}

function outsideReasonText(tool, target, lease) {
  return (
    `【执行层权限门 · 范围锁】${tool} → ${target} 被拒绝：不在授权范围内。\n` +
    `任务：${lease.taskId || '(未命名)'}；当前预算：${describeBudgets(lease)}。\n` +
    `当前允许写：${lease.allowWrite.length > 0 ? lease.allowWrite.join('、') : '(空)'}\n` +
    `禁止碰：${lease.denyWrite.length > 0 ? lease.denyWrite.join('、') : '(无)'}\n` +
    `出路：request_permission 申请扩大范围（说明为什么非要这个路径），然后停下等意图层回复。\n` +
    `范围规则支持 glob（例如 \`/output/schedule_*.json\`）—— 申请时可以照这个形状写。`
  )
}

/**
 * 「命令里看得见在写，但解析不出写到哪」：宁严不松。
 *
 * 这一条是 `python -c "open(p,'w')"` 那类命令的兜底。它必须存在，理由是**判据要自洽**：
 * 既然闸门按"代码里到底有没有写"判，那"写了"就必须落到一个能被检查的路径上；
 * 解析不出来就等于"免检写入"，那比误杀更糟（用户条例要的正是"知道自己在干什么"）。
 *
 * 同时把**怎么改**写清楚 —— 拒绝不能只给一句"不行"。
 */
function inlineWriteUnparsedReasonText(tool, lease) {
  return (
    `【执行层权限门 · 范围锁】${tool} 被拒绝：命令里的内联代码有**写入动作**，但闸门解析不出它写到哪个路径，` +
    `因此无法证明这次写落在授权范围内。\n` +
    `任务：${lease.taskId || '(未命名)'}；当前允许写：${lease.allowWrite.length > 0 ? lease.allowWrite.join('、') : '(空)'}\n` +
    `三种改法（任选）：\n` +
    `  ① 把路径写**字面量**：\`python -c "open('${lease.allowWrite[0] ?? '_audit_scratch'}/out.txt','w').write(s)"\`；\n` +
    `  ② 用写类 cmdlet（它的目标闸门看得见）：\`Set-Content ${lease.allowWrite[0] ?? '_audit_scratch'}/out.txt $s\`；\n` +
    `  ③ 把那段代码写成**夹具脚本**再跑（\`python _audit_scratch/probe.py\`）：脚本是被读的文件，不是命令里的写动作。\n` +
    `注意：**只读**的内联代码（读文件、算指纹、调纯函数）不受这一条影响，照常放行。`
  )
}

function lawReasonText(tool, target) {
  return (
    `【执行层权限门 · 物理定律】${tool} → ${target} 被**永久**拒绝：该路径属于这套机制自身，` +
    `任何租约都不可授权（FORBIDDEN_TARGETS）。\n` +
    `这一条不接受申请、不接受讨论、不接受「只是改一行」。\n` +
    `如果任务真的需要改它，那是意图层的活，不是你的：把这件事写进你的回报，交回意图层。`
  )
}

/**
 * 把按工具的预算渲染成给人看的一行。
 *
 * ⚠️ 2026-09-20 改了**措辞**（用户的原话：「那「40 次额度」挂在一个审计层根本调不到的名字上」）：
 * 内部键名是 `run_test` / `write_file` / `read_file`，而人手里那个能跑程序的入口叫**命令行**。
 * 名字对不上，于是"额度给了"和"它调得到"在纸上看着是两件事。现在一律**按入口命名**：
 *   `命令行（整路） 0/40、命令行 · 跑测试/校验 0/3、写文件 / 命令行 · 变更类 0/20`。
 */
export function describeBudgets(lease) {
  const entries = Object.entries(lease.tools ?? {})
  if (entries.length === 0) return '(无任何工具预算)'
  return entries
    .map(([key, budget]) => `${BUDGET_LABELS[key] ?? key} ${budget.total < 0 ? `${budget.used}/∞` : `${budget.used}/${budget.total}`}`)
    .join('、')
}

function exhaustedReasonText(tool, lease, toolKey) {
  const budget = lease.tools?.[toolKey]
  const label = BUDGET_LABELS[toolKey] ?? toolKey
  const usage = budget === undefined ? `${label} 没有预算` : `${label} 已用 ${budget.used}/${budget.total}`
  return (
    `【执行层权限门 · 预算耗尽 · 自动熔断】${tool} 被拒绝：${usage}。\n` +
    `任务：${lease.taskId || '(未命名)'}；当前预算：${describeBudgets(lease)}。\n` +
    `**按「预算外行为：禁止」的约定，你现在立即停止，并向意图层报告「预算耗尽，任务未完成」。**\n` +
    `报告里必须写清三件事：① 已完成到哪一步（附证据）；② 卡在哪一步、为什么原有预算不够；` +
    `③ 你建议意图层怎么改预算（具体到工具与次数）。\n` +
    `不要为了「做完整」去用预算外的工具或绕路 —— 连跑多轮实验、悄悄扩大范围，正是这条锁要拦的东西。`
  )
}

/** 「预算里根本没有这个工具」：最严格的拒绝 —— 意图层没授权它，就不许用。 */
function unbudgetedReasonText(tool, toolKey, lease, settings) {
  const label = BUDGET_LABELS[toolKey] ?? toolKey
  return (
    `【执行层权限门 · 预算外行为 · 禁止】${tool} 被拒绝：授权包的工具预算里**没有**「${label}」。\n` +
    `任务：${lease.taskId || '(未命名)'}；当前预算：${describeBudgets(lease)}。\n` +
    `（额度是按**命令的类别**记的：跑测试 / 变更类 / 只读；也能整路给 —— 写「命令行: N次」。）\n` +
    `「预算外行为：禁止」—— 你需要这个能力时，先 request_permission 申请，` +
    `说明「用它做什么、大概几次、范围到哪」，然后停下等意图层批。\n` +
    `不要找等价工具绕过去（例如用 shell 重定向代替 write 工具）—— 那会被记成违规。\n` +
    `本会话默认冻结的变更类工具：${settings.deny.join(' / ')}。`
  )
}

function deniedByRuleReasonText(tool, target, lease) {
  return (
    `【执行层权限门 · 黑名单】${tool} → ${target} 被拒绝：命中意图层划定的禁止碰范围。\n` +
    `禁止碰：${lease.denyWrite.join('、')}\n` +
    `不要试图用别的写法绕过去（写同名文件、shell 重定向、改路径拼接）—— 那会记成违规并上报意图层。`
  )
}

/** 只读工具越出读范围。 */
function readOutsideReasonText(toolKey, target, lease) {
  return (
    `【执行层权限门 · 读范围】${toolKey} → ${target} 被拒绝：超出授权包里给它的读范围。\n` +
    `该工具的读范围：${(lease.tools?.[toolKey]?.paths ?? []).join('、') || '(未限制)'}\n` +
    `任务：${lease.taskId || '(未命名)'}。\n` +
    `出路：request_permission 申请这个路径的读权限（说明为什么要读它），然后停下等意图层批复。`
  )
}

function lawChallengeReasonText(tool, lease) {
  return (
    `【执行层权限门 · 条例 ④】${tool} 被拒绝：你在试图改写约束本身，而不是完成任务。\n` +
    `这是第 ${lease.violations} / ${lease.violationLimit} 次违规；达到上限会**连已授权的范围一起收回**（熔断）。\n` +
    `**立刻回到任务轨道**：你要做的是把规格实现出来，不是重新定义「什么允许做」。\n` +
    `如果规格本身有问题，用 send_message 说明哪一条规格与目标冲突，交回意图层改 —— 那是它的职责。`
  )
}

function frozenByViolationReasonText(tool, lease) {
  return (
    `【执行层权限门 · 熔断】${tool} 被拒绝：本会话违规已达上限（${lease.violationLimit} 次），` +
    `权限已全部收回。原因：${lease.frozenReason || '反复挑战约束'}。\n` +
    `停止一切变更动作。用 send_message 把你的现状、已完成的部分、以及被拒的经过如实报回意图层，等它重新裁决。\n` +
    // 用户 2026-09-21：「熔断能被『回收 ＋ 重发租约』复位」—— 把复位办法写在拒绝话术里，
    // 否则现场只会看到"熔断了、发租约也不管用"（那正是他遇到的那一幕）。
    `**怎么复位**：意图层 revoke_permission 回收，再发一份新的授权包 —— 违规计数随新租约清零，`
    + `权限立即恢复（旧账仍在台账里，不会丢）。\n` +
    `只读命令不受熔断影响：你随时可以读，把情况说清楚。`
  )
}

//#endregion

//#region 会话日志折叠

/**
 * 从会话日志里取「意图层写给这个会话的文字」，**并带上每条消息的 id**。
 *
 * 判据照 `dsh-executor-loop` 的既有结论：`user/message` 既承载真实用户提示词、
 * 也承载注入的上下文与 steering。这里只认 `data.content` 的纯文本 ——
 * 因为**授权的凭据只能来自真正到达执行层视野的文字**。
 *
 * ⚠️ **为什么必须返回 id**：折叠授权是有**副作用**的（开锁、扣默认额度、起时间锁）。
 * 第一版只返回拼接后的文本，于是每一次工具调用都把**同一条授权消息重新折一遍** ——
 * 表现在外就是「额度永远用不完」（每次判定都被回满）。
 * 本插件开发时实测踩过：写额度 3 次，写第 4 次仍然放行。
 * 所以折叠必须**按消息 id 记账、每条只折一次**。
 *
 * @returns `{ text, ids }`：拼接文本与参与拼接的消息 id 列表。
 */
export function collectUserTexts(session) {
  const log = session?.log
  if (!Array.isArray(log)) return { text: '', ids: [] }
  const parts = []
  const ids = []
  for (let index = 0; index < log.length; index += 1) {
    const event = log[index]
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const text = textOfContent(event.data?.content)
    if (text.trim().length === 0) continue
    parts.push(text)
    ids.push(typeof event.data?.id === 'string' && event.data.id.length > 0 ? event.data.id : `seq-${String(event.seq ?? index)}`)
  }
  return { text: parts.join('\n'), ids }
}

//#endregion

//#region 台账（模块单例 + 可选审计落盘）

/**
 * 台账必须是**模块单例**，不能挂在某个 plugin 实例上。
 *
 * 原因：本插件在每个 agent 的 ctx 上各挂载一次。意图层授权时写的是**它那一份**
 * 实例，而执行层的 guard 读的是**执行层那一份** —— 两份实例状态不共享的话，
 * 授权永远读不到，闸门会表现为「怎么批都还是被拒」。
 */
export const ledger = {
  /** sessionId → lease */
  leases: new Map(),
  /** askId → 未决的权限申请 */
  asks: new Map(),
  /** 近期违规上报（供 lease_status 呈现，不依赖跨 agent 投递是否成功）。 */
  reports: [],
  askSeq: 0,
}

/** 清空台账。给离线回归用（生产不调用）。 */
export function resetLedger() {
  ledger.leases.clear()
  ledger.asks.clear()
  ledger.reports.length = 0
  ledger.askSeq = 0
}

/** 冻结态租约的模板。每次产出**新对象**，避免实例间串改。 */
export function frozenLease(agentId, cwd, settings) {
  return {
    agentId,
    cwd,
    /** 通用写范围白名单（`write`/`edit`/变更类 shell 都受它约束）。 */
    allowWrite: [],
    /** 黑名单：**永远优先于**白名单与按工具范围。 */
    denyWrite: [],
    /**
     * 按工具的预算表：`toolKey → { total, left, used, paths }`。
     * `total < 0` 表示无限；`paths` 是该工具自己的范围规则（可为空 = 不额外限制）。
     * 这是「工具预算」的主体，也是本插件与「一个全局额度」的根本区别。
     */
    tools: {},
    /** 兼容字段：等价于 `tools.write_file.total`，用于文案与旧断言。 */
    budgetWrites: 0,
    /** 兼容字段：等价于 `tools.run_test.total`。 */
    budgetShell: 0,
    expiresAt: 0,
    grantedAt: 0,
    grantCount: 0,
    generation: 0,
    violations: 0,
    violationLimit: settings.violationLimit,
    frozen: true,
    frozenReason: '',
    /** 任务身份（来自授权包的 `任务ID`），用于报告与审计。 */
    taskId: '',
    /** 冻结定律的出处（来自授权包的 `冻结定律`）。 */
    law: '',
    /** 已经折过的授权消息 id（每条授权只生效一次 —— 否则额度会被反复回满）。 */
    foldedIds: [],
    forbidden: FORBIDDEN_TARGETS,
  }
}

/**
 * 结算一份租约：**先判时间锁与熔断，再把会话日志里的授权折进来**。
 *
 * ⚠️ 顺序是硬要求，不是风格问题。第一版把「折叠」放在前面，结果
 * `foldGrantIntoLease` 每次都会把 `expiresAt` 重置成 `now + maxLeaseMs` ——
 * 于是**时间锁形同虚设**：同一条授权消息会被反复折叠，租约永远不会过期
 * （本插件开发时实测：`maxLeaseMs: 0` 也拦不住，因为判定发生在同一毫秒内）。
 *
 * 正确语义：**过期即冻结，只有新的授权消息才能重新开锁。**
 *
 * 这是 guard 的**唯一数据入口**。同步函数：读内存 + 遍历已经在本进程里的日志。
 */
export function resolveLease(agent, settings) {
  const agentId = String(agent?.id ?? '')
  if (agentId.length === 0) return undefined
  const cwd = agent?.session?.header?.cwd ?? process.cwd()
  const now = Date.now()
  let lease = ledger.leases.get(agentId) ?? frozenLease(agentId, cwd, settings)

  // ① 时间锁：先于折叠判定，否则折叠会把 expiresAt 一路推后（第一版就是这么坏的）。
  if (lease.frozen !== true && lease.expiresAt > 0 && now > lease.expiresAt) {
    lease = {
      ...frozenLease(agentId, cwd, settings),
      violations: lease.violations,
      grantCount: lease.grantCount,
      frozenReason: '租约到期（时间锁）',
      // ⚠️ **必须保留 foldedIds**：冻结时新建租约会把它清空，于是那条**旧授权消息**
      // 下一轮又被当成新消息重新折叠 —— 当场把刚冻结的租约解冻。
      // 实测轨迹：`now>exp? true` 之后紧接着 `frozen=false, expiresAt-now=30`。
      // 保留之后语义才对：**过期即冻结，只有新的授权消息才能重新开锁。**
      foldedIds: lease.foldedIds ?? [],
    }
  }

  // ② 折叠**新**授权消息（每条只折一次 —— 见 collectUserTexts 的说明）。
  //
  //    ⚠️ 折叠**不能**因为「当前已冻结」就跳过：冻结的会话正是靠**新的授权消息**解冻的。
  //    ⚠️ 也**只在真有新消息时**才写回台账。第一版无论有没有新消息都执行
  //    `ledger.leases.set(agentId, lease)`，而 `lease` 是折叠**之前**读出来的旧对象 ——
  //    于是把 `recordViolation` 刚写进去的 `frozen: true` 与时间锁的冻结又覆盖回旧值。
  //    三张脸同一个根因：熔断后还能写、时间锁不过期、授权后解冻生效不了。
  //    （本插件开发时实测：租约 `expiresIn: -33ms` 却仍报 `frozen: false`。）
  try {
    const { text, ids } = collectUserTexts(agent?.session)
    const seen = lease.foldedIds ?? []
    const pending = ids.filter((id) => !seen.includes(id))
    if (pending.length > 0 && text.length > 0) {
      // 只把「还没折过的那些消息」的文本交给解析器：同一段拼接文本里混着已折过的
      // 旧授权时，重复解析会让旧授权反复生效（额度被回满）。
      const pendingText = collectPendingText(agent?.session, pending)
      const folded = foldMessageIntoLease(lease, pendingText, cwd, settings, now)
      // ── **授权包落地情况**：不生效的行要留在台账上（用户 §4③ 的现场教训） ──
      // 现场那张预算表里躺着 `0/256`、`0/455` 两条鬼预算，而台账一个字都没说。
      // 现在：散文被折进预算、认不出的额度名、或"有【授权】标记却什么都没解析出来"，
      // 都会留在这份租约上，`lease_status` 直接显示。
      const warnings = []
      if (pendingText.includes(GRANT_MARKER)) {
        const grant = parseGrantText(pendingText)
        if (grant === undefined) {
          warnings.push('看到【授权】标记，但里面**解析不出任何额度或范围** —— 这份授权没有生效（检查：额度名是不是认识的？值写成像「12次」的样子了吗？）')
        } else {
          for (const line of grant.ignored ?? []) warnings.push(`没生效的行：${line}`)
          if (typeof grant.stoppedAt === 'string') warnings.push(`授权块在「${grant.stoppedAt}」这一行结束（后面按散文处理，不再当授权读）`)
        }
      } else if (/#|\d/u.test(pendingText)) {
        warnings.push('这条消息里没有【授权】标记 —— 它不会改变任何权限（这是刻意的：扩权只认显式标记）。')
      }
      lease = { ...folded, foldedIds: [...seen, ...pending], ...(warnings.length > 0 ? { grantWarnings: warnings } : {}) }
      ledger.leases.set(agentId, lease)
    }
  } catch {
    // 日志读不到就按「没有授权」处理 —— 宁可少放行，不可误放行。
  }

  return lease
}

/** 只取指定 id 的那些 user/message 的文本，供「折新授权」用。 */
function collectPendingText(session, pendingIds) {
  const log = session?.log
  if (!Array.isArray(log)) return ''
  const wanted = new Set(pendingIds)
  const parts = []
  for (let index = 0; index < log.length; index += 1) {
    const event = log[index]
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const id = typeof event.data?.id === 'string' && event.data.id.length > 0 ? event.data.id : `seq-${String(event.seq ?? index)}`
    if (!wanted.has(id)) continue
    const text = textOfContent(event.data?.content)
    if (text.trim().length > 0) parts.push(text)
  }
  return parts.join('\n')
}

/** 记一次判定到审计文件（可选）。绝不因为落盘失败而影响判定。 */
function audit(settings, record) {
  if (settings.auditFile.length === 0) return
  try {
    appendFileSync(settings.auditFile, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8')
  } catch {
    // 审计失败只丢审计，不改判定。
  }
}

/**
 * guard 需要的台账适配器：把「读租约 / 扣额度 / 熔断 / 记账」收敛到一处。
 *
 * 判定逻辑因此完全可离线跑（喂一个假 adapter 即可），
 * 这也是本项目「判据本身必须能被负对照打红」那条纪律的落点。
 */
export function createAdapter(settings, { logger } = {}) {
  return {
    leaseFor: (agent) => {
      try {
        return resolveLease(agent, settings)
      } catch {
        return undefined
      }
    },
    /** 给人看的日志出口（发审计常备租约那件事必须留痕 —— 它是系统给的权限）。 */
    log: (message) => {
      try {
        logger?.info?.(message)
      } catch {
        // 日志失败不影响任何判定。
      }
    },
    /**
     * 扣一次按工具的额度。
     *
     * ⚠️ 必须**按 agent 重新结算**再改，不能改判定的那个参数引用：
     * 折叠一次授权会**换掉租约对象**，而判定开始时抓到的引用可能指向旧对象 ——
     * 那就成了「扣在一个已经被丢弃的对象上」，`used` 永远是 0。
     * （本插件开发时实测：`run_test` 用了两次仍显示 `used: 0`。）
     */
    spend: (agent, toolKey) => {
      try {
        const lease = resolveLease(agent, settings)
        if (lease === undefined) return
        const budget = lease.tools?.[toolKey]
        if (budget !== undefined) {
          budget.used += 1
          if (budget.total >= 0) budget.left = Math.max(0, budget.total - budget.used)
        }
        ledger.leases.set(String(lease.agentId), lease)
        audit(settings, {
          kind: 'spend',
          agent: lease.agentId,
          taskId: lease.taskId,
          tool: toolKey,
          used: budget?.used ?? 0,
          total: budget?.total ?? -1,
        })
      } catch {
        // 记账失败不影响本次放行。
      }
    },
    /** 记一次违规；达到上限即熔断，返回**熔断后**的租约。 */
    recordViolation: (agent, reason) => {
      try {
        const lease = resolveLease(agent, settings)
        if (lease === undefined) return undefined
        lease.violations += 1
        const limit = lease.violationLimit
        if (limit > 0 && lease.violations >= limit) {
          const frozen = {
            ...frozenLease(String(lease.agentId), lease.cwd, settings),
            violations: lease.violations,
            grantCount: lease.grantCount,
            generation: lease.generation + 1,
            frozenReason: reason,
            // 同「时间锁」那条：熔断后也必须保留 foldedIds，
            // 否则旧授权消息会被重新折叠、把刚收回的权限又发回来。
            foldedIds: lease.foldedIds ?? [],
          }
          ledger.leases.set(String(lease.agentId), frozen)
          ledger.reports.push({ at: Date.now(), agentId: String(lease.agentId), reason, action: 'frozen' })
          audit(settings, { kind: 'violation', agent: lease.agentId, reason, action: 'frozen', violations: lease.violations })
          if (logger !== undefined) {
            logger.warn(
              `executor-gate: session ${String(lease.agentId)} BREACHED the law (${reason}) — lease revoked ` +
                `(violations ${lease.violations}/${limit}); reporting to the intent layer`,
            )
          }
          return frozen
        }
        ledger.leases.set(String(lease.agentId), lease)
        ledger.reports.push({ at: Date.now(), agentId: String(lease.agentId), reason, action: 'warned' })
        audit(settings, { kind: 'violation', agent: lease.agentId, reason, action: 'warned', violations: lease.violations })
        return lease
      } catch {
        return undefined
      }
    },
    /** 记账（拒绝原因），只写审计与日志，不改判定。 */
    record: (verdict, target, tool) => {
      try {
        audit(settings, { kind: 'verdict', verdict, target: String(target).slice(0, 300), tool })
        if (settings.logDenied && logger !== undefined) {
          logger.info(`executor-gate: ${verdict} on ${tool} → ${String(target).slice(0, 200)}`)
        }
      } catch {
        // 记录失败不改判定。
      }
    },
  }
}

//#endregion

//#region 判定核心（guard 的主体）

/** 变更类文件工具的真名（已从 app.asar 的 `defineTool({ name })` 核实）。 */
const FILE_MUTATION_TOOLS = ['write', 'edit']
/** 命令执行工具的真名（`dsh-tool-pwsh` / `dsh-tool-bash` 的 `defineTool`）。 */
const SHELL_TOOLS = ['pwsh', 'bash']
/** 读类工具：**默认不判**，只有意图层显式给了读范围/读额度时才生效。 */
const READ_TOOLS = ['read', 'glob', 'grep', 'read_image']

/**
 * 判一次**执行层**调用。返回值就是要给模型的拒绝理由；`undefined` 表示放行。
 *
 * 顺序刻意如此：条例 ④（定律）最高，其次范围/黑名单，最后额度。
 */
export function judgeExecutorCall(exec, settings, adapter) {
  const tool = typeof exec?.name === 'string' ? exec.name : ''
  if (tool.length === 0) return undefined
  const agent = exec?.agent
  const lease = adapter.leaseFor(agent)
  if (lease === undefined) return undefined

  const isFileMutation = FILE_MUTATION_TOOLS.includes(tool)
  const isRead = READ_TOOLS.includes(tool)
  const isShell = SHELL_TOOLS.includes(tool)
  if (!isFileMutation && !isRead && !isShell) return undefined

  // 熔断的判定**下沉到各分类之后**，不在这里提前返回：
  // 判断「只读命令」需要先归类（见 `classifyShell`），而熔断后执行层仍要能跑只读命令，
  // 否则它连「把情况说清楚」都做不到、报告交不回来。
  // （第一版在这里提前返回，实测把熔断后的 `node -v` 也一起拦了。）
  if (isRead) return judgeRead(tool, exec, lease, settings, adapter)
  if (isFileMutation) return judgeFileMutation(tool, exec, lease, settings, adapter)
  return judgeShell(tool, exec, lease, settings, adapter)
}

/**
 * **审计层**：一个**没有写工具**的子会话。
 *
 * 用户 2026-09-20 报的机制缺陷：
 * > 「两次独立鉴证都没能跑起来。不是它们偷懒 —— **审计层在您这台机器上压根没有
 * >  「允许跑程序」的权限**（两次都是它自己用台账查实并原文报回来的）。」
 * > 「**现在的审计层没办法审计**」
 *
 * 根因：审计员也是 `origin === 'subagent'`，所以它**照样吃执行层的默认冻结** ——
 * 而冻结态只放行"只读类命令"（`python x.py --flag` 这种），
 * `pytest` / `node --test`（`run_test`）与 `python -c`、任何重定向（`write_file`）
 * 都会被判「没有这个工具的预算」。**审计的本来工作就是跑验收** —— 于是它一步都动不了。
 *
 * 判据刻意**按能力认，不按名字/人格猜**：审计员的工具面具里 `write`/`edit` 被拿掉了
 * （预设那一行的 `toolFilter.deny`），所以「**它写不了东西**」这件事是结构性的、
 * 可观测的。执行层与意图层都不是这个形状。
 *
 * @returns 它像不像审计层；`undefined` 表示**判不出来**（拿不到工具视图 ⇒ 按普通执行层处理）
 */
export function looksLikeAuditLayer(canWrite) {
  if (canWrite === undefined) return undefined
  return canWrite === false
}

/**
 * **把"命令行起不来"翻译成人话**（纯函数）。
 *
 * 用户 2026-09-20 的现场：审计层七次调用、跨三条互不相同的路，全部只拿到
 * `(no output)` + `[exit code: 3221225794]` —— **一个字都不说为什么**。
 * 于是它只能写「我没有权限跑程序」，而人看到的是"插件又坏了"。
 *
 * 实测查清的事实链（写在这里，免得下次再查一遍）：
 *   · `3221225794` = `0xC0000142` = **STATUS_DLL_INIT_FAILED** —— Windows 在**进程初始化**阶段就失败了；
 *   · 产品在非 `danger-full-access` 档位下会**套一层沙箱**跑命令
 *     （`dsh-pwsh-sandbox` → `ctx.sandbox` → Windows 的 ACL restricted-token runner）；
 *   · 这台机器上**沙箱里的 pwsh 起不来**（同一个码，连 `Get-Date` 这种纯 cmdlet 都起不来）；
 *   · 而**不受限**的会话（文件策略 = `danger-full-access`）跑同样的命令一切正常
 *     （实测：子会话 `Get-Date` / `python -V` / `cmd /c echo` 三条全通）。
 *
 * ⇒ 这不是"权限拒绝"，也不是"命令写错了"：**是那条通道本身没起来**，
 * 而它属于**会话的文件策略**这一层（人能一键切换），不属于任何插件。
 */
export function diagnoseShellFailure({ toolName, text, hasPwsh7 } = {}) {
  const tool = String(toolName ?? '')
  if (!SHELL_TOOLS.includes(tool)) return undefined
  const body = String(text ?? '')
  if (body.length === 0) return undefined
  const dllInit = /3221225794|0xC0000142|-1073741502|STATUS_DLL_INIT_FAILED/iu.test(body)
  const runner = /SANDBOX_UNAVAILABLE|runnerFailed|sandbox runner/iu.test(body)
  if (!dllInit && !runner) return undefined
  // 本机此刻用的是哪个 PowerShell —— **看现场说话**，不写死结论。
  const actuallyHasPwsh7 =
    hasPwsh7 === undefined
      ? existsSync(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'))
      : hasPwsh7 === true
  const engineLine = actuallyHasPwsh7
    ? '     ② 环境侧：这台机器上已经装了 PowerShell 7（工具会优先用它）—— 若它仍然起不来，\n' +
      '        说明沙箱这一层的问题比"用哪个 PowerShell"更深，请人先按 ① 把文件策略切到 danger-full-access。\n'
    : '     ② 装一个 PowerShell 7（本机现在没装，工具因此退回 Windows PowerShell 5.1 ——\n' +
      '        5.1 是 .NET Framework 程序，在受限令牌下最容易死在 DLL 初始化上；装完工具会自动改用它）。\n'
  return {
    kind: dllInit ? 'dll-init' : 'sandbox-runner',
    code: dllInit ? '3221225794 (0xC0000142)' : 'SANDBOX_UNAVAILABLE',
    advice:
      `【诊断 · **命令行没起来**】${dllInit ? '退出码 3221225794 = 0xC0000142 = Windows 的 STATUS_DLL_INIT_FAILED' : '沙箱 runner 报 SANDBOX_UNAVAILABLE'}` +
      ' —— **是要执行的程序（这里是 PowerShell）在初始化阶段就失败了**，\n' +
      '  不是权限拒绝、不是路径错、也不是你把命令写错了。**重复重试或换个写法都不会有用。**\n' +
      '  已知原因链（实测）：会话的文件策略不是 danger-full-access 时，命令会被**套一层沙箱**跑；\n' +
      '  这台机器上**沙箱里的命令行起不来**（连 Get-Date 这种纯 cmdlet 都是这个码），\n' +
      '  而不受限的会话跑同样的命令一切正常。\n' +
      '  ⇒ **请把这句话原样写进你的回报/报告，让「人」去做下面任一件事**：\n' +
      '     ① 把这个会话的文件策略切到 danger-full-access（一键，立刻可用）；或\n' +
      engineLine +
      '  ⇒ ⚠️ 别把它写成"我没有权限"或"命令跑不了" —— 那是另一回事，会把人引到错的地方去。',
  }
}

/**
 * 审计层的**常备租约**：能读、能跑，**写不了产品**。
 *
 * 与执行层那张租约的区别只有一处，但那一处就是审计的全部意义：
 *   · `read_file` 无限、`run_test` 有额度 ⇒ **跑得动验收**；
 *   · `allowWrite` 只覆盖一个**临时目录**（`_audit_scratch/`）⇒ 抓输出、放夹具够用；
 *   · `denyWrite` 里显式钉上 `notes/_endstate`（台账 / 终局定义 / 鉴证报告）⇒ **改不了卷子**；
 *   · 产品树不在写范围内 ⇒ 它**改不了被鉴定的东西**。
 */
export function auditLeaseFor(agentId, cwd, settings, now = Date.now()) {
  const scratch = normalizePath(settings.auditScratchDir ?? '_audit_scratch', cwd)
  const stateDir = normalizePath('notes/_endstate', cwd)
  return {
    ...frozenLease(agentId, cwd, settings),
    allowWrite: [scratch],
    denyWrite: [stateDir],
    tools: {
      read_file: { total: -1, used: 0, left: -1, paths: [] },
      run_test: { total: settings.auditShellBudget, used: 0, left: settings.auditShellBudget, paths: [] },
      write_file: { total: settings.auditWriteBudget, used: 0, left: settings.auditWriteBudget, paths: [scratch] },
    },
    budgetWrites: settings.auditWriteBudget,
    budgetShell: settings.auditShellBudget,
    frozen: false,
    frozenReason: '',
    grantedAt: now,
    expiresAt: now + settings.maxLeaseMs,
    grantCount: 1,
    generation: 1,
    taskId: 'AUDIT（审计层常备租约）',
    law: '',
    outOfBudget: '禁止。审计层只读产品、只写临时目录；超出预算就判"测不出来"并把缺什么写进报告。',
    /** 标记它是**系统给的**，不是意图层发的 —— 于是它可以被显式授权覆盖，而不会被误当成"人写的"租约。 */
    __audit: true,
  }
}

/**
 * 该不该给这个会话发审计租约。
 *
 * ⚠️ 判据在**每次调用时**重算，而不是装守卫那一刻定死：
 * 子会话的工具面具是在**创建窗口**里装上的，我们轮询到它的时候可能还没装完 ——
 * 定死就会把审计层误判成普通执行层（那正是这次事故的形状）。
 */
function ensureAuditLease(agent, settings, adapter) {
  if (settings.auditLease !== true) return undefined
  const scopedCtx = agent?.ctx ?? agent?.session?.ctx
  if (scopedCtx === undefined) return undefined
  const agentId = String(agent?.id ?? agent?.session?.header?.id ?? '')
  if (agentId.length === 0) return undefined
  const existing = ledger.leases.get(agentId)
  // 已经有人（人/意图层）显式授权过：**不动它** —— 显式授权永远优先于系统默认。
  if (existing !== undefined && existing.__audit !== true && existing.grantCount > 0) return undefined
  if (existing?.__audit === true) return existing

  let canWrite
  try {
    const view = scopedCtx.tools
    if (typeof view?.get !== 'function') return undefined
    canWrite = view.get('write', agent) !== undefined || view.get('edit', agent) !== undefined
  } catch {
    return undefined
  }
  if (looksLikeAuditLayer(canWrite) !== true) return undefined

  const lease = auditLeaseFor(agentId, agent?.session?.header?.cwd ?? process.cwd(), settings)
  ledger.leases.set(agentId, lease)
  audit(settings, {
    kind: 'audit-lease',
    target: agentId,
    note: '没有写工具的子会话 ⇒ 判定为审计层，发常备租约（读 ∞ / 跑测试有额度 / 只写临时目录）',
    tools: lease.tools,
    allowWrite: lease.allowWrite,
    denyWrite: lease.denyWrite,
  })
  adapter?.log?.(
    `executor-gate: session ${agentId} is the **AUDIT LAYER**（它的工具面具里没有 write/edit）` +
      ` ⇒ 发常备租约：读 ∞、run_test ${settings.auditShellBudget} 次、写只许 ${settings.auditScratchDir}/` +
      `（改不了产品、也改不了 notes/_endstate）`,
  )
  return lease
}

/** `write` 与 `edit` 共用一份写预算（对意图层而言它们是同一件事：改文件）。 */
function budgetKeyOf(tool) {
  if (tool === 'write' || tool === 'edit') return 'write_file'
  if (tool === 'pwsh' || tool === 'bash') return null
  return tool
}

function judgeFileMutation(tool, exec, lease, settings, adapter) {
  const rawTarget = writeTargetOf(exec)
  if (rawTarget === undefined) return undefined
  const target = normalizePath(rawTarget, lease.cwd)
  if (target.length === 0) return undefined

  const verdict = judgeWrite(target, lease, budgetKeyOf(tool))
  switch (verdict.verdict) {
    case 'frozen':
      // ⚠️ 2026-09-21：**熔断要说自己是熔断**（原来这里一律报「默认冻结」，
      //    现场看到的是"我没有写权限"，而真实原因是违规达上限 —— 两句话指向完全不同的修法）。
      return lease.frozen === true && lease.violationLimit > 0 && lease.violations >= lease.violationLimit
        ? frozenByViolationReasonText(tool, lease)
        : frozenReasonText(tool, settings, lease)
    case 'forbidden': {
      adapter.record('law-forbidden', target, tool)
      return lawReasonText(tool, target)
    }
    case 'denied': {
      adapter.record('denied-by-rule', target, tool)
      return deniedByRuleReasonText(tool, target, lease)
    }
    case 'outside': {
      adapter.record('out-of-scope', target, tool)
      return outsideReasonText(tool, target, lease)
    }
    case 'unbudgeted': {
      adapter.record('unbudgeted', target, tool)
      return unbudgetedReasonText(tool, budgetKeyOf(tool), lease, settings)
    }
    case 'exhausted': {
      adapter.record('budget-exhausted', target, tool)
      return exhaustedReasonText(tool, lease, budgetKeyOf(tool))
    }
    default: {
      adapter.spend(exec?.agent, budgetKeyOf(tool))
      adapter.record('allowed', target, tool)
      return undefined
    }
  }
}

/** 读类工具（read/glob/grep/read_image）：只在意图层**真的给了读范围/读额度**时才判。 */
function judgeRead(tool, exec, lease, settings, adapter) {
  const rawTarget = writeTargetOf(exec)
  const target = rawTarget === undefined ? undefined : normalizePath(rawTarget, lease.cwd)
  const verdict = judgeScopedCall(target, lease, 'read_file')
  switch (verdict.verdict) {
    case 'unbudgeted':
      // 没给读预算 = 不限制读（读是执行层的合法手段，不该因为「没写」而被锁）。
      return undefined
    case 'forbidden': {
      adapter.record('law-forbidden', target, tool)
      return lawReasonText(tool, target)
    }
    case 'denied': {
      adapter.record('denied-by-rule', target, tool)
      return deniedByRuleReasonText(tool, target, lease)
    }
    case 'outside': {
      adapter.record('read-out-of-scope', target, tool)
      return readOutsideReasonText('read_file', target, lease)
    }
    case 'exhausted': {
      // ── ⚠️ **读额度用完也不许把读锁死**（2026-09-21 用户现场 §4①） ──────────
      //
      // 用户的原话：「之后连只读都拒」—— 那是"闸把自己锁死"：
      // 执行层连"我现在卡在哪"都说不清，报告交不回来，人只能看到一个死会话。
      // 读是执行层的**唯一出路**（说明情况的通道），所以额度用完只**记账 + 报警**，
      // 不放行成"变更类"，也不拦。要真的让它停，意图层有 revoke_permission。
      adapter.record('read-budget-exhausted', target, tool)
      adapter.spend(exec?.agent, 'read_file')
      return undefined
    }
    default: {
      adapter.spend(exec?.agent, 'read_file')
      return undefined
    }
  }
}

function judgeShell(tool, exec, lease, settings, adapter) {
  const args = argsRecord(exec)
  const command = typeof args?.command === 'string' ? args.command : ''

  // 条例 ④：挑战约束本身 —— 高于一切，命中即记违规。
  if (challengesLaw(command)) {
    const after = adapter.recordViolation(exec?.agent, 'law-challenge')
    if (after === undefined) return undefined
    return after.frozen === true && after.violations >= after.violationLimit
      ? frozenByViolationReasonText(tool, after)
      : lawChallengeReasonText(tool, after)
  }

  const classKey = classifyShell(command)

  // 只读命令：只有在意图层**显式**给了读范围/读额度时才判，否则放行且不扣额度。
  // ⚠️ 这一条必须**先于**熔断与冻结判定：熔断后执行层仍要能读、能跑只读命令，
  // 否则它连「把情况说清楚」都做不到，报告交不回来。
  if (classKey === 'read_file') return judgeRead(tool, exec, lease, settings, adapter)

  // ── **整路额度**（`shell` / 「命令行」）──────────────────────────────────
  //
  // 用户 2026-09-20 的原话：「那「40 次额度」挂在一个审计层根本调不到的名字上……
  // 定额度时写的名字是「跑测试」，可审计层手里那个能跑程序的入口叫「命令行」。」
  //
  // 说明白：额度本来就是按**命令的类别**记的（同一个「命令行」既能跑测试、也能改文件、
  // 也能只读），所以三个类别各有各的额度是对的。但人（和意图层）确实是**按入口**想事情的，
  // 所以现在**两种写法都收**：
  //   · 写 `命令行: 40次`（或 `pwsh` / `shell`）⇒ 落到 `shell`，**整路共用这一份**；
  //   · 写 `跑测试: 3次` / `写额度: 20` ⇒ 仍旧按类别记。
  // 两者同时存在时**以整路为准**（人写的整路是更明确的意图）。
  //
  // ⚠️ 一条硬边界：**整路额度只替换"计费"，绝不替换"检查"** ——
  //    路径范围、禁止碰、物理定律照旧按类别（`write_file`）判，一个都不放过。
  const shellBudget = lease.tools?.shell
  const quotaKey = shellBudget !== undefined ? 'shell' : classKey

  // 熔断（违规到上限）：变更类与跑测试一律收回。理由要区别于「普通冻结」——
  // 它说的是「你违规了」，而不是「你还没被授权」。
  if (lease.frozen === true && lease.violationLimit > 0 && lease.violations >= lease.violationLimit) {
    return frozenByViolationReasonText(tool, lease)
  }

  // ⚠️ 判据顺序：**先看预算表里有没有这个工具，再看是否冻结**。
  //    第一版把冻结放在前面，于是「跑测试没给预算」被报成「默认冻结」——
  //    那会把意图层引到错误的修法上（去解冻，而真正该做的是补 run_test 预算）。
  //    「预算外行为：禁止」本来就是最严格的那一档，它比冻结更准确地描述现场。
  const budget = lease.tools?.[quotaKey]
  if (budget === undefined) {
    adapter.record('unbudgeted', command.slice(0, 200), tool)
    return unbudgetedReasonText(tool, classKey, lease, settings)
  }
  if (lease.frozen === true) return frozenReasonText(tool, settings, lease)

  // 变更类：先查路径范围（写预算的范围 + 通用写范围）。
  if (classKey === 'write_file') {
    const scopesForCheck = [...(lease.allowWrite ?? []), ...(lease.tools?.write_file?.paths ?? [])]
    const targets = shellWriteTargets(command)
    // ── 内联代码里的写（`python -c "open(p,'w')…"`）：把代码里的**字面路径**也算进来 ──
    //
    // ⚠️ 这一段是必须的，不是锦上添花：那种命令没有重定向、也不是写类 cmdlet，
    //    `shellWriteTargets` 一个目标都抽不出来 ⇒ 它会"被判成变更类、却没有目标可查"
    //    ⇒ 范围锁形同虚设（`python -c` 里想写哪儿就写哪儿）。
    //    反过来，如果代码里明明有写动作、却一个**字面路径**都解析不出来，
    //    闸门就**没法证明**它落在授权范围内 —— 那就拒，并说清怎么改（宁严不松）。
    if (isInlineCodeCommand(command)) {
      const parsed = inlineWriteTargets(command)
      if (parsed.length === 0 && inlineCodeHasWrite(command)) {
        adapter.record('unparsed-write', command.slice(0, 200), tool)
        return inlineWriteUnparsedReasonText(tool, lease)
      }
      targets.push(...parsed)
    }
    for (const candidate of targets) {
      const target = normalizePath(candidate, lease.cwd)
      if (target.length === 0) continue
      if (isForbiddenTarget(target, lease.forbidden)) {
        adapter.record('law-forbidden', target, tool)
        return lawReasonText(tool, target)
      }
      const hitDeny = lease.denyWrite.find((entry) => matchesScope(target, entry, lease.cwd))
      if (hitDeny !== undefined) {
        adapter.record('denied-by-rule', target, tool)
        return deniedByRuleReasonText(tool, target, lease)
      }
      if (!scopeAllows(target, scopesForCheck, false, lease.cwd)) {
        adapter.record('out-of-scope', target, tool)
        return outsideReasonText(tool, target, lease)
      }
    }
  }

  if (budget.total >= 0 && budget.left <= 0) {
    adapter.record('budget-exhausted', command.slice(0, 200), tool)
    return exhaustedReasonText(tool, lease, quotaKey)
  }
  adapter.spend(exec?.agent, quotaKey)
  adapter.record('allowed', command.slice(0, 200), tool)
  return undefined
}

/**
 * 判一次**意图层**的调用。
 *
 * 条例 ④ 的另一半：意图层自己也不许绕开机制改文件 —— 要改东西只有一条路：
 * 写规格、派执行层。这正是「意图层很听话」那条性质的机制保证。
 *
 * ⚠️ 2026-09-19 改过一句话：原来这里写着「你要亲自验收就用 pwsh 跑只读命令」——
 * 那条已被用户否决（「那就是它越界了」）。现在意图层**连 pwsh 都没有**
 * （`intent-guard` 的 `eyes` 把它能力级拿掉了），验收一律派 `dispatch_audit`。
 */
export function judgeIntentCall(exec) {
  const tool = typeof exec?.name === 'string' ? exec.name : ''
  if (!FILE_MUTATION_TOOLS.includes(tool)) return undefined
  return (
    `【意图层 · 不许自己动手】${tool} 被拒绝：你是意图层，改文件必须派执行层。\n` +
    `把改动写成规格（目标 / 范围 / 验收标准 / 证据要求），用 subagent 派出去。\n` +
    `要验收就派 dispatch_audit —— **你自己没有 read / pwsh**（那不是"不让你用"，是那些工具不在你手里）。`
  )
}

//#endregion

//#region 插件装配

/**
 * 把「每字段一条」的参数 DSL 编译成 **provider 会接受的 JSON Schema**。
 *
 * ⚠️ 这里出过一次**生产级故障**，务必看清楚：
 *
 * 第一版是手写 definition，把 `parameters` 直接写成 `{ 字段名: {type, description} }` ——
 * 也就是**裸的 properties 映射，没有 `type: 'object'`**。
 * 真 `defineTool()` 内部会调 `parameterSchemaSpecToJsonSchema()` 把它编译成
 * `{ type: 'object', properties, required }`；而我绕过了 `defineTool`，于是漏了那一层。
 *
 * 后果不是「工具不好用」，是**整个双区第一轮就死**：模型 provider 直接 400 ——
 *   Invalid schema for function 'grant_permission':
 *   schema must be a JSON Schema of 'type: "object"', got 'type: null'.
 * 会话日志实测（2026-09-18）：意图层收到用户消息后**第一个 step 就 turn/end error**，
 * 连一句话都没说出来，自然也从没派活给执行层 —— 表现就是「双区不工作」。
 *
 * 为什么离线回归没抓到：真 `register()` **不校验 `parameters`**
 * （它只 `assertSupportedJsonSchema(output.schema)`），所以「register 收下了」
 * 完全不代表「能发给模型」。现在 `_verify-tool-register.mjs` 里加了一组断言，
 * 直接查真 `schemas()[].parameters.type === 'object'` —— 那才是覆盖这次故障的判据。
 *
 * @param spec - `{ 字段名: { type, required?, description?, items? } }`
 */
export function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec ?? {})) {
    if (raw === null || typeof raw !== 'object') continue
    const { required: isRequired, ...rest } = raw
    properties[key] = { ...rest }
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** 装一个最小可用的工具定义（形状照 dsh-tools 的 register 契约，零跨包依赖）。 */
function defineGateTool({ toolName, description, parameters, execute }) {
  return {
    name: toolName,
    description,
    // ⚠️ 必须编译成 `{type:'object',...}`，不能把裸 properties 交出去（见上面那段故障说明）
    parameters: compileParameters(parameters),
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      return execute(args ?? {}, exec)
    },
  }
}

/**
 * 三个台账工具。**注册在每个 agent 的 scoped ctx 上**，并一律以 `exec.agent` 判角色 ——
 * 身份取自运行时给的调用者，模型无法在参数里冒用（没有任何参数能改变角色）。
 *
 * 生产调用点是 `apply` 里的 `gateToolDefinitions(settings, hooks)`；
 * 下面的 `__gateToolDefinitionsForTest` 让独立校验脚本能拿到**同一批定义**，
 * 去喂**真 `ToolRuntime.register()`** —— 手写 definition 最大的风险就是被真 register 拒收。
 */
function gateToolDefinitions(settings, hooks) {
  return [
    defineGateTool({
      toolName: 'request_permission',
      description:
        '执行层专用：登记一次权限申请。默认冻结状态下你没有任何写权限；' +
        '需要写入时先调本工具登记，再把返回的申请文本用 send_message 发给意图层，然后停下等它授权。' +
        '不要反复重试被拒绝的写入调用。',
      parameters: {
        reason: { type: 'string', required: true, description: '为什么需要权限：要达成什么、缺了它做不了什么' },
        tool_budgets: {
          type: 'string',
          description:
            '申请的工具预算，写成 JSON，例如 ' +
            '{"write_file":{"limit":5,"scopes":["/output/schedule_*.json"]},"run_test":{"limit":3}}。' +
            'limit 用 -1 表示无限；scopes 支持目录前缀与 glob（* 不跨目录，** 跨目录）。',
        },
        allow_write: {
          type: 'array',
          description: '（简写）申请可写的目录/文件路径，等价于 write_file 的 scopes',
          items: { type: 'string' },
        },
        budget_writes: { type: 'number', description: '（简写）申请的写操作次数上限' },
        budget_shell: { type: 'number', description: '（简写）申请的跑测试次数上限（例如允许跑几轮实验）' },
      },
      execute: (args, exec) => hooks.requestPermission(args, exec),
    }),
    defineGateTool({
      toolName: 'grant_permission',
      description:
        '意图层专用：给某个执行层会话发一份**结构化授权包**（按工具的范围 + 额度 + 时间锁）。' +
        '这是「派活时给预算」的正式入口：执行层只在预算内自由行动，预算外一律禁止并立即熔断上报。' +
        '执行层自己调用本工具会被拒绝 —— 扩权只能由意图层发起。',
      parameters: {
        agent_id: { type: 'string', required: true, description: '目标执行层会话 id（它在权限申请里会报给你）' },
        tool_budgets: {
          type: 'string',
          description:
            '工具预算表，写成 JSON，例如 ' +
            '{"read_file":{"limit":-1,"scopes":["/data/**"]},' +
            '"write_file":{"limit":5,"scopes":["/output/schedule_*.json"]},' +
            '"run_test":{"limit":3}}。' +
            'limit 用 -1 表示无限；scopes 省略 = 该工具不额外限制范围（写类仍受 allow_write 约束）。' +
            '预算里**没有列出的工具 = 禁止使用**（预算外行为：禁止）。',
        },
        task_id: { type: 'string', description: '任务 ID（写进授权包与审计，便于对账）' },
        law: { type: 'string', description: '冻结定律的出处，例如 "THE_STRATEGY.md §5"' },
        allow_write: {
          type: 'array',
          description: '（简写）通用写范围白名单，等价于 write_file 的 scopes；支持 glob',
          items: { type: 'string' },
        },
        deny_write: {
          type: 'array',
          description: '明确禁止触碰的路径黑名单（优先于一切白名单）',
          items: { type: 'string' },
        },
        budget_writes: { type: 'number', description: '（简写）write_file 额度（默认 200）' },
        budget_shell: { type: 'number', description: '（简写）run_test 额度（默认 30）' },
        reason: { type: 'string', description: '批准理由（写进审计）' },
      },
      execute: (args, exec) => hooks.grantPermission(args, exec),
    }),
    defineGateTool({
      toolName: 'revoke_permission',
      description:
        '意图层专用：立刻回收某个执行层会话的全部权限（任务完成 / 发现跑偏 / 要它停下时用）。' +
        '回收后该会话回到默认冻结状态，只能读。',
      parameters: {
        agent_id: { type: 'string', required: true, description: '目标执行层会话 id' },
        reason: { type: 'string', description: '回收理由（写进审计）' },
      },
      execute: (args, exec) => hooks.revokePermission(args, exec),
    }),
    defineGateTool({
      toolName: 'lease_status',
      description:
        '查权限台账：不传 agent_id 则列出当前所有执行层的租约状态与近期违规上报；' +
        '传 agent_id 则返回那一个执行层的详细租约（范围 / 额度 / 违规 / 是否熔断）。' +
        '意图层在委派前和验收前都该看一眼 —— 这是「凭什么算授权过」的证据。',
      parameters: {
        agent_id: { type: 'string', description: '可选：只看这一个执行层会话' },
      },
      execute: (args, exec) => hooks.leaseStatus(args, exec),
    }),
  ]
}

/**
 * 供**独立校验脚本**取用的同一批工具定义（`_verify-tool-register.mjs` 用它喂真 `register()`）。
 *
 * 用真配置 + 空实现生成，因此形状与生产里注册的**逐字一致**；
 * 这不是"测试专用定义"，而是"生产定义的一个实例"。
 */
export const __gateToolDefinitionsForTest = gateToolDefinitions(DEFAULTS, {
  requestPermission: () => '',
  grantPermission: () => '',
  revokePermission: () => '',
  leaseStatus: () => '',
})

/**
 * 安装执行层权限门。
 *
 * 装配步骤（**每一步失败都只告警，绝不让 preset 起不来**）：
 *   1. 解析本挂载的 preset id（拿不到就 fail-open 并告警，绝不猜）；
 *   2. 给每个 agent 的 scoped ctx 注册台账工具（按 `exec.agent` 判角色）；
 *   3. 监视 `agent/created`：执行层装冻结 guard，意图层装「不许自己动手」。
 */
export function apply(ctx, config = {}) {
  const settings = normalize(config)
  if (!settings.enabled) {
    ctx.logger.info('executor-gate: disabled by config — executors start with full file access (no permission lease)')
    return
  }

  const agents = ctx.agents
  const presets = ctx.get('agentPresets')
  const ownPresetId =
    typeof settings.presetId === 'string' && settings.presetId.length > 0
      ? settings.presetId
      : presets?.composedPreset?.(ctx)

  if (ownPresetId === undefined || ownPresetId === null || ownPresetId === '') {
    ctx.logger.warn(
      "executor-gate: cannot determine this mount's preset id (agentPresets unavailable) — " +
        'NOT gating ANY session, because guessing would freeze unrelated conversations',
    )
    return
  }
  if (presets === undefined) {
    ctx.logger.warn(
      'executor-gate: degraded — agentPresets service unavailable, so no session can be identified as a member ' +
        'of this preset; executors will NOT be frozen (fail-open by design, but visible).',
    )
    return
  }
  ctx.logger.info('executor-gate: mounted for preset "' + ownPresetId + '" (executors start frozen; lease required)')

  const adapter = createAdapter(settings, { logger: ctx.logger })
  const presetOf = (agent) => {
    const scopedCtx = agent?.ctx ?? agent?.session?.ctx
    if (scopedCtx === undefined) return undefined
    return presets.composedPreset?.(scopedCtx)
  }
  const agentIdOf = (agent) => String(agent?.id ?? agent?.session?.header?.id ?? '')

  const hooks = {
    requestPermission: (args, exec) => {
      const caller = exec?.agent
      const role = roleOf(caller, { isRoot: agents.roots().includes(caller) })
      if (role !== 'executor') {
        return (
          `【执行层权限门】request_permission 只对执行层有效（当前角色：${role}）。\n` +
          (role === 'intent'
            ? '你是意图层：授权用 grant_permission（或直接在派活的任务书里写「【授权】允许写: <目录>」）。'
            : '本会话不在双区 preset 内，不受权限门管。')
        )
      }
      const agentId = agentIdOf(caller)
      const lease = adapter.leaseFor(caller) ?? frozenLease(agentId, process.cwd(), settings)
      ledger.askSeq += 1
      const askId = `ask-${ledger.askSeq}`
      const allowWrite = Array.isArray(args.allow_write) ? args.allow_write.filter((v) => typeof v === 'string') : []
      const requested = parseToolBudgetsArg(args.tool_budgets)
      const ask = {
        askId,
        at: Date.now(),
        agentId,
        reason: typeof args.reason === 'string' ? args.reason : '',
        allowWrite,
        toolBudgets: requested,
        budgetWrites: typeof args.budget_writes === 'number' ? args.budget_writes : undefined,
        budgetShell: typeof args.budget_shell === 'number' ? args.budget_shell : undefined,
      }
      ledger.asks.set(askId, ask)
      audit(settings, { kind: 'ask', ...ask })

      // 给意图层一段**可直接照抄的授权包骨架**：它要么原样批准，要么改数字。
      // 「不用自己想格式」是把审批流跑通的关键 —— 格式靠猜就一定会漂。
      const budgetLines = Object.entries(requested).map(([key, spec]) => {
        const lines = [`  ${key}:`, `    额度: ${spec.total < 0 ? '无限' : `${spec.total}次`}`]
        if (spec.paths.length > 0) lines.push(`    范围: ${spec.paths.join(', ')}`)
        return lines.join('\n')
      })
      if (allowWrite.length > 0 && requested.write_file === undefined) {
        budgetLines.unshift(`  write_file:\n    额度: ${ask.budgetWrites ?? settings.defaultWriteBudget}次\n    范围: ${allowWrite.join(', ')}`)
      }
      const skeleton = [
        `${GRANT_MARKER}`,
        `任务ID: "${askId}"`,
        `执行目标: "${ask.reason.replaceAll('"', "'")}"`,
        '工具预算:',
        ...(budgetLines.length > 0 ? budgetLines : ['  write_file:', `    额度: ${settings.defaultWriteBudget}次`, '    范围: "(请意图层填写)"']),
        '预算外行为: "禁止。如需超出预算，必须向意图层申请。"',
      ].join('\n')

      return (
        `已登记权限申请 ${askId}（本会话 ${agentId}，当前状态：${lease.frozen ? '冻结' : '已授权'}）。\n` +
        `当前预算：${describeBudgets(lease)}。\n` +
        `请把下面这段**原文**用 send_message 发给意图层，然后**停下等**它回复：\n` +
        `────────\n${REQUEST_MARKER} ${askId}\n执行层会话: ${agentId}\n需要: ${ask.reason}\n` +
        `申请预算:\n${budgetLines.length > 0 ? budgetLines.join('\n') : '  (未指定，请意图层裁定)'}\n────────\n` +
        `意图层若批准，会回给你一份**授权包**，形状大致是（它可能会改路径与次数）：\n────────\n${skeleton}\n────────\n` +
        `那条消息一到，权限自动生效，你会看到范围与额度。\n` +
        `**不要在被拒后自行改道或换工具绕（条例 ④）**；也不要反复重试被拒的调用 —— 等授权。`
      )
    },

    grantPermission: (args, exec) => {
      const caller = exec?.agent
      const role = roleOf(caller, { isRoot: agents.roots().includes(caller) })
      if (role === 'executor') {
        const after =
          adapter.recordViolation(caller, 'executor-attempted-self-grant') ??
          adapter.leaseFor(caller) ??
          frozenLease(agentIdOf(caller), process.cwd(), settings)
        return (
          `【执行层权限门 · 条例 ④】grant_permission 被拒绝：扩权只能由意图层发起，执行层给自己授权是越权。\n` +
          `这是第 ${after.violations} / ${after.violationLimit} 次违规。\n` +
          `正确做法：把需求写清楚，用 send_message 发给意图层，由它决定。`
        )
      }
      if (role !== 'intent') {
        return '【执行层权限门】grant_permission 只对意图层有效：本会话不在双区 preset 内，不受权限门管。'
      }
      const targetId = String(args.agent_id ?? '').trim()
      if (targetId.length === 0) return '【执行层权限门】grant_permission 需要 agent_id（执行层会话 id）。'
      const target = ledger.leases.get(targetId) ?? frozenLease(targetId, process.cwd(), settings)
      const cwd = target.cwd
      const grant = {
        allowWrite: Array.isArray(args.allow_write) ? args.allow_write : [],
        denyWrite: Array.isArray(args.deny_write) ? args.deny_write : [],
        tools: parseToolBudgetsArg(args.tool_budgets),
      }
      // 简写参数折进预算表（让「只给次数」也能用）。
      if (typeof args.budget_writes === 'number') {
        grant.tools.write_file = { total: args.budget_writes, paths: grant.tools.write_file?.paths ?? grant.allowWrite }
      }
      if (typeof args.budget_shell === 'number') {
        grant.tools.run_test = { total: args.budget_shell, paths: grant.tools.run_test?.paths ?? [] }
      }
      if (typeof args.task_id === 'string' && args.task_id.length > 0) grant.taskId = args.task_id
      if (typeof args.law === 'string' && args.law.length > 0) grant.law = args.law
      const next = foldGrantIntoLease(target, grant, cwd, settings)
      ledger.leases.set(targetId, next)
      audit(settings, {
        kind: 'grant',
        by: agentIdOf(caller),
        target: targetId,
        taskId: next.taskId,
        allowWrite: next.allowWrite,
        denyWrite: next.denyWrite,
        tools: next.tools,
        reason: typeof args.reason === 'string' ? args.reason : '',
      })

      // ── **回读核对**（2026-09-19 用户报的那个缺陷的修法） ──────────────────
      //
      // 用户的原话：「grant_permission 回「已授权」、打印预算、打印写范围 ——
      // 而实际生效的是 read_file 1/1、写范围空。**六个执行层被拒写**。」
      //
      // 所以现在**不信"我刚写了什么"，只信"读回来是什么"**：
      // 判据与执行层的守卫**同源**（`adapter.leaseFor`，也就是 `resolveLease`），
      // 逐项比「你要的」与「实际生效的」。不一致就**不打印成功框**。
      const effective = (() => {
        try {
          const known = (typeof agents.list === 'function' ? agents.list() : []).find((a) => agentIdOf(a) === targetId)
          return adapter.leaseFor(known ?? { id: targetId, session: { header: { id: targetId, cwd }, log: [] } })
        } catch (error) {
          return { __error: String(error).slice(0, 160) }
        }
      })()
      const verification = effective?.__error !== undefined
        ? { ok: false, diffs: [`回读租约时抛了：${effective.__error}`], notes: [] }
        : // 比较的两边都要是**归一化之后**的路径（折叠时会归一，拿原样比会报假警）。
          verifyGrant(
            {
              allowWrite: (grant.allowWrite ?? []).map((item) => normalizePath(item, cwd)).filter((item) => item.length > 0),
              denyWrite: (grant.denyWrite ?? []).map((item) => normalizePath(item, cwd)).filter((item) => item.length > 0),
              tools: grant.tools ?? {},
              taskId: grant.taskId ?? '',
            },
            effective,
          )
      // 把核对结果也记进审计（事后可追：这一次是真的生效了，还是只有回执漂亮）
      audit(settings, { kind: 'grant_verify', by: agentIdOf(caller), target: targetId, ok: verification.ok, diffs: verification.diffs })

      // 把授权**原文**回给意图层，它可以直接转发给执行层（执行层需要看到含标记的原文才生效）。
      const grantText = buildGrantPackageText(effective?.tools !== undefined ? effective : next)

      // ⚠️ **id 写错的当场告警** —— 这是「我授权了，它却被当成没授权」最常见的成因。
      //
      // 用户的实测反馈（2026-09-18）：拿到"任务名/范围/时间锁都写了"的回执，
      // 但执行层那边查台账仍是「冻结 / 未命名 / 无预算」。
      // 租约是按 `agent_id` 存的；id 错一个字符，真执行层就永远读不到它，
      // 而回执照样漂亮 —— 那是最坏的一种失败：**看起来成功了**。
      const liveExecutors = (() => {
        try {
          return (typeof agents.list === 'function' ? agents.list() : [])
            .filter((a) => presetOf(a) === ownPresetId)
            .map((a) => ({ id: agentIdOf(a), role: roleOf(a, { isRoot: agents.roots().includes(a) }) }))
            .filter((entry) => entry.role === 'executor')
        } catch {
          return []
        }
      })()
      const targetIsLive = liveExecutors.some((entry) => entry.id === targetId)
      const idWarning = targetIsLive
        ? ''
        : `\n⚠️ **注意：没有名为 ${targetId} 的活执行层。** 这张租约已记在台账上，但**不会有任何会话读到它**。\n` +
          (liveExecutors.length > 0
            ? `   当前活着的执行层，请核准 id（授权要发给真正在干活的那一个）：\n${liveExecutors.map((e) => `     · ${e.id}`).join('\n')}\n`
            : '   当前没有活着的执行层 —— 先把任务派出去，再按它申请里报的 id 授权。\n') +
          '   （更稳的做法：把下面这段授权原文**直接写进派活的任务书**，就不存在 id 对不上的问题。）\n'

      // **不一致 ⇒ 不打印成功框**。这几行是给人看的"现场"，不是道歉。
      if (!verification.ok) {
        return (
          `❌ **授权没有生效** —— 回读核对不一致，**不要以为它能干活了**。\n` +
          `  目标会话：${targetId}\n` +
          `  你要的：写范围 ${grant.allowWrite.length > 0 ? grant.allowWrite.join('、') : '(空)'}｜` +
          `预算 ${Object.entries(grant.tools ?? {}).map(([key, spec]) => `${key} ${spec.total < 0 ? '无限' : spec.total}`).join('、') || '(空)'}\n` +
          `**实际生效（回读出来的）：**\n${describeEffective(effective)}\n` +
          `**对不上的地方：**\n${verification.diffs.map((line) => `  · ${line}`).join('\n')}\n` +
          idWarning +
          '\n下一步（按顺序，别跳）：\n' +
          '  ① `lease_status` 查这个会话，确认它到底握着什么；\n' +
          '  ② 若目标 id 不对 ⇒ 重新授权给**活着的那个**执行层；\n' +
          '  ③ 若范围/额度还是空 ⇒ 用 `revoke_permission` 回收后重发（收窄是显式动作）；\n' +
          '  ④ 最稳的一条：把授权包**原文写进派活的任务书**，让它随任务一起到场。\n' +
          '  ⚠️ 在核对通过之前，**不要**把这段授权原文转发给执行层 —— 转发它只会让"看着授权了、实际写不了"更难查。'
        )
      }

      return (
        `✅ 授权**已生效**（这一行是**回读核对过**的结果，不是"我发过了"）：\n` +
        `  目标会话：${targetId}\n` +
        `**实际生效值：**\n${describeEffective(effective)}` +
        (verification.notes.length > 0 ? `${verification.notes.map((line) => `  ${line}`).join('\n')}\n` : '') +
        idWarning +
        `\n请把下面这段**原文**发它（它需要看到含「${GRANT_MARKER}」标记的原文才会生效）：\n` +
        `────────\n${grantText}\n────────\n` +
        `执行层只在预算内自由行动，**预算外一律禁止并立即熔断上报**。任务完成时用 revoke_permission 回收。`
      )
    },

    revokePermission: (args, exec) => {
      const caller = exec?.agent
      const role = roleOf(caller, { isRoot: agents.roots().includes(caller) })
      if (role !== 'intent') {
        return '【执行层权限门】revoke_permission 只对意图层有效（执行层不能自己解冻，那正是条例 ④ 要防的）。'
      }
      const targetId = String(args.agent_id ?? '').trim()
      if (targetId.length === 0) return '【执行层权限门】revoke_permission 需要 agent_id。'
      const before = ledger.leases.get(targetId)
      const frozen = frozenLease(targetId, before?.cwd ?? process.cwd(), settings)
      frozen.violations = before?.violations ?? 0
      frozen.grantCount = before?.grantCount ?? 0
      frozen.generation = (before?.generation ?? 0) + 1
      frozen.frozenReason = typeof args.reason === 'string' && args.reason.length > 0 ? args.reason : '意图层回收'
      // 同样要保留 foldedIds：回收之后只有**新的**授权消息能重新开锁。
      frozen.foldedIds = before?.foldedIds ?? []
      frozen.taskId = before?.taskId ?? ''
      ledger.leases.set(targetId, frozen)
      audit(settings, { kind: 'revoke', by: agentIdOf(caller), target: targetId, reason: frozen.frozenReason })
      return (
        `已回收执行层 ${targetId} 的全部权限，它回到默认冻结状态（只能读）。\n` +
        `理由：${frozen.frozenReason}。要再放行就重新 grant_permission。`
      )
    },

    leaseStatus: (args, exec) => {
      const caller = exec?.agent
      const role = roleOf(caller, { isRoot: agents.roots().includes(caller) })
      const targetId = typeof args.agent_id === 'string' ? args.agent_id.trim() : ''

      // ⚠️ **必须走 `adapter.leaseFor()`（= `resolveLease`），不能直接读 `ledger.leases`。**
      //
      // 这是一个真实故障的根因（2026-09-18，用户原话：
      // 「我调了 grant_permission 并拿到回执，但执行层那边查台账是
      //   任务未命名 / 冻结 / 无任何工具预算 —— 我授权了，它却被当成没授权」）：
      // 台账里的条目可能是**尚未结算的模板**（刚建出来、还没把会话日志里的授权折进去），
      // 直接读它，就会把「已授权」显示成「冻结、未命名、无预算」。
      // 判据必须与**判定路径同源**：guard 用 `resolveLease`，台账也必须用同一个。
      const describe = (lease) => {
        const state = lease.frozen
          ? `冻结${lease.frozenReason ? `（${lease.frozenReason}）` : ''}`
          : `已授权，剩余时间 ${Math.max(0, Math.round((lease.expiresAt - Date.now()) / 1000))}s`
        return [
          `会话 ${lease.agentId}`,
          `  任务：${lease.taskId || '(未命名)'}`,
          `  状态：${state}`,
          `  预算：${describeBudgets(lease)}`,
          `  通用写范围：${lease.allowWrite.join('、') || '(空)'}`,
          `  禁止碰：${lease.denyWrite.join('、') || '(无)'}`,
          `  违规：${lease.violations}/${lease.violationLimit}`,
          `  时间锁：${lease.expiresAt > 0 ? new Date(lease.expiresAt).toISOString() : '(未授权)'}`,
          // **授权包落地情况**：哪些行没生效、块停在哪 —— 用户 §4③ 的现场就是
          // 一堆散文被折成预算（`0/256`、`0/455`），而台账上一个字都不说。
          ...(Array.isArray(lease.grantWarnings) && lease.grantWarnings.length > 0
            ? [`  ⚠️ 授权包落地情况：\n${lease.grantWarnings.map((line) => `     · ${line}`).join('\n')}`]
            : []),
        ].join('\n')
      }

      // 当前活着的、属于本 preset 的会话 —— 台账只报这些，避免报一堆已经死掉的会话
      const live = (() => {
        try {
          return (typeof agents.list === 'function' ? agents.list() : []).filter((a) => presetOf(a) === ownPresetId)
        } catch {
          return []
        }
      })()

      if (targetId.length > 0) {
        const known = live.find((a) => agentIdOf(a) === targetId)
        const lease = adapter.leaseFor(known ?? { id: targetId, session: { header: { id: targetId, cwd: process.cwd() }, log: [] } })
        if (lease === undefined) return `【权限台账】查不到会话 ${targetId} 的租约。`
        // 目标 id 不在活着的名册里 → 极可能是个写错的 id。这正是「我授权了它却没收到」的典型成因。
        if (known === undefined && lease.grantCount === 0) {
          return (
            `【权限台账】**没有名为 ${targetId} 的活会话**，而且它的租约是空白冻结的。\n` +
            `${describe(lease)}\n\n` +
            `⚠️ 这通常意味着 **id 写错了**：授权发给了 ${targetId}，而真正在干活的是另一个会话。\n` +
            (live.length > 0
              ? `当前活着的本 preset 会话（把授权发给其中真正那一个）：\n${live.map((a) => `  · ${agentIdOf(a)}${roleOf(a, { isRoot: agents.roots().includes(a) }) === 'executor' ? '（执行层）' : '（意图层）'}`).join('\n')}`
              : '当前没有活着的本 preset 会话。')
          )
        }
        return `【权限台账】调用者角色：${role}\n${describe(lease)}`
      }

      // 不带 agent_id：把所有活着的本 preset 会话都**结算一遍**再列出来。
      //
      // ⚠️ 意图层**本来就没有租约**——那不是「冻结」，是「这个角色不需要租约」
      // （它的 write/edit 被 intent-guard 直接剥夺）。第一版照模板把它显示成
      // 「冻结 / 无任何工具预算」，会让人误以为闸门坏了。台账要如实说明状态。
      const rows = []
      for (const a of live) {
        const aRole = roleOf(a, { isRoot: agents.roots().includes(a) })
        if (aRole === 'intent') {
          rows.push({ role: aRole, text: `会话 ${agentIdOf(a)}\n  角色：意图层（不持有租约；write/edit 被 intent-guard 直接剥夺）` })
          continue
        }
        const lease = adapter.leaseFor(a)
        if (lease === undefined) continue
        rows.push({ role: aRole, text: describe(lease) })
      }
      if (rows.length === 0) {
        const own = caller === undefined ? undefined : adapter.leaseFor(caller)
        return `【权限台账】调用者角色：${role}\n当前没有活着的本 preset 会话。${own === undefined ? '' : `\n（调用者自己的租约）\n${describe(own)}`}`
      }
      const reports = ledger.reports.slice(-10)
      // 「发给谁会怎样」——**发消息之前**就该看得见（用户第 4 条：别把"写进队列"说成"已送达"）。
      const reachability = (() => {
        const lines = []
        for (const id of liveIdsOf()) {
          lines.push(`  · ${id}　**排队中**（活着：在跑就插进去，空闲就开一轮）`)
        }
        for (const [id, entry] of childCatalog.entries()) {
          if (liveIdsOf().includes(id)) continue
          lines.push(
            entry.mode === 'continuable'
              ? `  · ${id}　**排队中（会冷启动一轮）** —— 它收工了，但可继续`
              : `  · ${id}　**建议新建会话** —— 它是一次性的（one-shot），叫不醒`,
          )
        }
        return lines.length > 0 ? lines.join('\n') : '  （名册里还没有可发的目标）'
      })()
      return (
        `【权限台账】调用者角色：${role}，当前活着 ${rows.length} 个本 preset 会话：\n\n` +
        rows.map((r) => `[${r.role === 'executor' ? '执行层' : '意图层'}] ${r.text}`).join('\n\n') +
        `\n\n**发消息可达性（send_message 之前先看这个）**\n${reachability}` +
        (reports.length > 0
          ? `\n\n近期违规上报（最近 ${reports.length} 条）：\n` +
            reports.map((r) => `  ${new Date(r.at).toISOString()} ${r.agentId} ${r.reason} → ${r.action === 'frozen' ? '已熔断' : '已警告'}`).join('\n')
          : '')
      )
    },
  }

  const tools = gateToolDefinitions(settings, hooks)
  const guarded = new WeakSet()
  /** 已经挂过 `tools/post-execute` 诊断钩子的 agent（一个只挂一次）。 */
  const postHooked = new WeakSet()
  /** 见过、且**守卫真的装上了**的执行层 id（覆盖面审计用）。 */
  const guardedIds = new Set()
  /** 见过的执行层 id → 首次见到的时间（覆盖面审计用）。 */
  const seenExecutors = new Map()
  /**
   * **子会话名册**：`agentId → { mode: 'one-shot' | 'continuable', parentId, label }`。
   *
   * 用户第 4 条要求（"发消息前校验存活"）需要知道"它还能不能被唤醒"，
   * 而这个信息只有产品的 `subagents` 名册有（`mode` 是**耐久**的，会话收工之后依然查得到）。
   * ⚠️ 名册是**异步**接口（`listChildren` 返回 Promise），而 `tools.guard` 是**同步**判据
   * （真实现里 `guard(exec)` 直接取返回值，返回 Promise 会被当成"拒绝"）——
   * 所以这里用**轮询缓存**，guard 只读缓存。缓存晚一拍没关系：活着与否那一条是实时判的。
   */
  const childCatalog = new Map()
  const liveIdsOf = () => {
    try {
      return (typeof agents.list === 'function' ? agents.list() : []).map((a) => agentIdOf(a)).filter((id) => id.length > 0)
    } catch {
      return []
    }
  }
  const refreshCatalog = async () => {
    const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
    if (typeof subagents?.listChildren !== 'function') return
    for (const root of agents.roots?.() ?? []) {
      const parentId = agentIdOf(root)
      if (parentId.length === 0) continue
      try {
        const listing = await subagents.listChildren(parentId, new AbortController().signal)
        const rows = childRowsOf(listing)
        for (const entry of rows) {
          const id = String(entry?.id ?? '')
          if (id.length === 0) continue
          childCatalog.set(id, {
            mode: String(entry?.mode ?? ''),
            parentId,
            label: String(entry?.label ?? ''),
            activity: String(entry?.activity ?? ''),
          })
        }
      } catch {
        // 名册查不到（服务没挂 / 还没建立归属）⇒ 不写缓存：guard 那边会走"名册里没有"的保守分支。
      }
    }
  }

  /**
   * 台账工具**在挂载点注册一次**（不是每个 agent 各注册一遍）。
   *
   * ⚠️ 这条是**实测改出来的**，不是设计偏好。真 `ToolRuntime.register()` 用
   * `NamedEntries` 去重：**同名的工具在同一个层里只能注册一次**，第二次报
   * `tool "X" is already registered (for a per-agent variant, register through that
   * agent's `agent.ctx` instead)`。
   * 第一版是"给每个 agent 各注册一遍"，于是**第一个 agent 之后的每一个都注册失败** ——
   * 在生产里的表现是：意图层拿得到 request_permission，而**每个执行层都拿不到**，
   * 于是"执行层申请权限"这条主路径整体失效。
   *
   * 为什么不改成按 agent 注册：没必要。这四个工具对**所有 agent 都要可见**，
   * 而角色是靠 `exec.agent` 在调用时判的（没有任何参数能改变角色），
   * 所以全局注册一次既正确又更简单。
   *
   * 顺便记一条纪律：本项目的 smoke 里 `tools` 是**替身**，替身的 `register()`
   * 不去重、不抛错 —— 所以这类"真实现会抛、替身不抛"的差异**只有靠真依赖才验得出来**。
   * 这就是 `_verify-tool-register.mjs` 存在的理由。
   */
  /**
   * 取 `tools` 服务：**必须用 `ctx.get('tools')`，不能写 `ctx.tools`**。
   *
   * ⚠️ Cordis 对「没在 `inject` 里声明就取服务**属性**」是**抛错**的
   * （`cannot get property "tools" without inject`）—— 而 apply 阶段抛错会让
   * **整个 fiber FAILED**，也就是整套权限门静默失效。
   * 本插件开发时实测踩过：加了挂载点注册之后 fiber 直接变 3(FAILED)，
   * smoke 里"冻结态 write 被拒"那一整片全红。
   *
   * 为什么不干脆 `inject: ['tools']`：那样在服务不可用时插件会**永不挂载**
   * （连冻结都没有），比"少一批工具"严重得多。`ctx.get()` 取不到只是 `undefined`，
   * 能 warning 出来而不影响挂载 —— 与 `dsh-intent-guard` 取 `agentPresets` 的取舍一致。
   */
  const toolsService = typeof ctx.get === 'function' ? ctx.get('tools') : undefined

  if (typeof toolsService?.register === 'function') {
    try {
      for (const definition of tools) toolsService.register(definition)
      ctx.logger.info(
        'executor-gate: registered the ledger tools (request_permission / grant_permission / ' +
          'revoke_permission / lease_status) at the mount point',
      )
    } catch (error) {
      ctx.logger.warn(`executor-gate: could not register the ledger tools: ${String(error)}`)
    }
  } else {
    ctx.logger.warn(
      'executor-gate: the tools service is unavailable — the permission-request path will not work ' +
        '(the gate itself still freezes executors)',
    )
  }

  /**
   * 给一个 agent 的 scoped ctx 装 guard。
   * 身份可能还没登记完，所以由调用方（`watch`）负责重试。
   */
  /**
   * `send_message` 那一闸（第 4 条要求）。**任何角色**都要过：意图层发给执行层、
   * 执行层发给主会话 —— 两边都可能发给一个已经收工的会话。
   */
  const judgeSendMessageCall = (exec) => {
    if (String(exec?.name ?? '') !== 'send_message') return undefined
    const args = argsRecord(exec)
    const targetId = typeof args?.agent_id === 'string' ? args.agent_id : ''
    const verdict = judgeSendMessage({
      targetId,
      liveIds: liveIdsOf(),
      catalog: childCatalog,
      callerId: agentIdOf(exec?.agent),
    })
    if (verdict.state === 'queued') {
      if (settings.logDenied && verdict.cold === true) {
        ctx.logger.info(`executor-gate: send_message → ${targetId}：**排队中**（它不在活着，但可继续 —— 会冷启动一轮读它）`)
      }
      return undefined
    }
    audit(settings, { kind: 'send-blocked', target: targetId, state: verdict.state, reason: verdict.reason })
    ctx.logger.warn(`executor-gate: send_message → ${targetId} 被拦（${verdict.state}）：${verdict.reason}`)
    return verdict.text
  }

  const guard = (agent) => {
    const scopedCtx = agent?.ctx ?? agent?.session?.ctx
    const isRoot = agents.roots().includes(agent)
    const role = roleOf(agent, { isRoot })

    if (typeof scopedCtx?.tools?.guard !== 'function') return

    // ── **把"命令行起不来"翻成人话**（2026-09-20） ─────────────────────────
    //
    // 失败发生在**结果**里（`(no output)` + `[exit code: 3221225794]`），所以要用
    // `tools/post-execute` —— 那是产品让插件在事后改写/补充结果内容的唯一通道。
    // 监听器按**会话自己的 scope** 注册：产品是用 `scopeTarget(exec.agent)` 派发这条事件的，
    // 挂在根 ctx 上收不到子会话的（这一条本项目在 `agent/created` 上实测过）。
    if (typeof scopedCtx.on === 'function' && !postHooked.has(agent)) {
      postHooked.add(agent)
      try {
        scopedCtx.on('tools/post-execute', async (exec, result, next) => {
          const decision = await next()
          try {
            if (decision?.kind === 'block') return decision
            const tool = String(exec?.name ?? '')
            const blocks = Array.isArray(result?.content) ? result.content : []
            const text = blocks.map((block) => String(block?.text ?? '')).join('\n')
            const diagnosis = diagnoseShellFailure({ toolName: tool, text })
            if (diagnosis === undefined) return decision
            // 会话此刻的文件策略：一并写进去（人一眼就知道该切什么）
            let policy = ''
            try {
              const sandboxPolicy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
              const resolved = sandboxPolicy?.resolve?.({ session: exec?.agent?.session })
              if (resolved?.mode !== undefined) policy = `\n  本会话此刻的文件策略：**${resolved.mode}**。`
            } catch {
              /* 拿不到就不写这一行 */
            }
            ctx.logger.warn(`executor-gate: shell channel failed with ${diagnosis.code} for session ${agentIdOf(agent)} — attaching the diagnosis`)
            audit(settings, { kind: 'shell-channel-failure', agent: agentIdOf(agent), code: diagnosis.code, tool })
            const extra = { type: 'text', text: `${diagnosis.advice}${policy}` }
            const content = Object.hasOwn(decision, 'content') && Array.isArray(decision.content) ? [...decision.content, extra] : [...blocks, extra]
            return { ...decision, kind: 'accept', content }
          } catch (error) {
            ctx.logger.warn(`executor-gate: post-execute diagnosis threw (result unchanged): ${String(error).slice(0, 140)}`)
            return decision
          }
        })
      } catch (error) {
        ctx.logger.warn(`executor-gate: could not hook tools/post-execute for ${agentIdOf(agent)}: ${String(error)}`)
      }
    }

    if (role === 'executor' && settings.gateSubagents) {
      if (guarded.has(agent)) return
      try {
        scopedCtx.tools.guard((exec) => {
          // 每次调用都重新判一次"它是不是审计层" —— 工具面具是在创建窗口里装的，
          // 装守卫那一刻可能还没装完（定死就会把审计层误判成普通执行层，那正是这次事故的形状）。
          ensureAuditLease(exec?.agent ?? agent, settings, adapter)
          return judgeExecutorCall(exec, settings, adapter) ?? judgeSendMessageCall(exec)
        })
        guarded.add(agent)
        guardedIds.add(agentIdOf(agent))
        // ⚠️ **只在没被授权时才写冻结模板**：无条件覆盖会把已经折好的租约抹掉。
        // 这正是"我授权了它却没收到"的另一种成因（守卫晚装 → 覆盖掉先到的授权）。
        const existing = ledger.leases.get(agentIdOf(agent))
        if (existing === undefined || existing.grantCount === 0) {
          ledger.leases.set(
            agentIdOf(agent),
            existing ?? frozenLease(agentIdOf(agent), agent?.session?.header?.cwd ?? process.cwd(), settings),
          )
        }
        // 从"见过的"待办里摘掉 —— 它已经上闸了
        seenExecutors.delete(agentIdOf(agent))
        ctx.logger.info(
          `executor-gate: session ${agentIdOf(agent)} is an EXECUTOR — FROZEN (no write lease). ` +
            'It must call request_permission and wait for a grant. ' +
            '（如果它是**没有写工具**的子会话，第一次调用时会自动认出它是审计层并发常备租约）',
        )
      } catch (error) {
        ctx.logger.warn(`executor-gate: could not install the executor guard for ${agentIdOf(agent)}: ${String(error)}`)
      }
      return
    }

    if (role === 'intent' && settings.denyIntentWrites) {
      if (guarded.has(agent)) return
      try {
        scopedCtx.tools.guard((exec) => judgeIntentCall(exec) ?? judgeSendMessageCall(exec))
        guarded.add(agent)
        ctx.logger.info(
          `executor-gate: session ${agentIdOf(agent)} is the INTENT LAYER — it may read/run/delegate, ` +
            'not edit files itself (denyIntentWrites)',
        )
      } catch (error) {
        ctx.logger.warn(`executor-gate: could not restrict the intent layer (${agentIdOf(agent)}): ${String(error)}`)
      }
    }
  }

  /**
   * 身份可能还没登记完（`agent/created` 触发时 `roots()` 还没算上它），所以要等一拍再判。
   * 这条重试是 `dsh-intent-guard` 生产事故（误锁全部子 agent）的直接教训。
   *
   * 但**重试耗尽后不能直接放弃**：执行层（子会话）按定义**永远不在 `roots()` 里**，
   * 所以「不在 roots 就跳过」会把执行层整体漏掉 —— 本插件开发时实测踩过这个坑
   * （执行层一个守卫都没装上，冻结静默失效）。正确做法是：
   * 重试耗尽后**照常判角色**，角色判定本身用 `header.origin`（不依赖 roots）。
   */
  const watch = (agent, attempt = 0) => {
    if (agent === undefined || agent === null) return
    // ⚠️ **不能"一次判不是本 preset 就永久放弃"。**
    //
    // 子会话的 preset 归属是在**创建窗口内**才建立起来的（产品在
    // `prepareChildInsideCreationWindow` 里先 join 父的 preset、再装它自己的
    // persona 与工具限制）。轮询若早了一拍，`composedPreset(childCtx)` 会返回
    // undefined —— 一次性判定就会把这个执行层**永久漏掉**，表现正是
    // 用户报的「有的会话根本没上闸」。
    // 这与 `dsh-intent-guard` 当年的生产事故是**同一个形状**（它靠重试修好）。
    // 所以这里：本 preset 判定失败时，先记入待重试，而不是直接 return。
    if (presetOf(agent) !== ownPresetId) {
      if (attempt < settings.identityRetries) {
        pendingIdentity.set(agentIdOf(agent), { agent, attempt: attempt + 1 })
      }
      return
    }
    if (roleOf(agent, { isRoot: true }) === 'other' && attempt < settings.identityRetries) {
      setTimeout(() => {
        try {
          watch(agent, attempt + 1)
        } catch (error) {
          ctx.logger.warn('executor-gate: identity retry failed: ' + String(error))
        }
      }, settings.identityRetryMs)
      return
    }
    guard(agent)
  }

  /**
   * 待重试的 agent：`presetOf` 早了一拍时先放这里，下一轮发现再判。
   *
   * 为什么必须是**独立结构**而不是 `setTimeout`：`discover()` 每一轮都会遍历完整名册，
   * 天然就是重试器；用定时器会造出一堆并发的一拍等待，反而更难看清。
   * 每个 agent 最多重试 `identityRetries` 次，之后放弃并**在日志里留痕**
   * （绝不静默 —— 静默漏掉一个执行层就是"没上闸"）。
   */
  const pendingIdentity = new Map()

  /** 处理待重试队列：重判 preset 归属，成功者直接上闸。 */
  const retryPendingIdentity = () => {
    for (const [id, entry] of [...pendingIdentity]) {
      if (presetOf(entry.agent) === ownPresetId) {
        pendingIdentity.delete(id)
        guard(entry.agent)
        continue
      }
      if (entry.attempt >= settings.identityRetries) {
        pendingIdentity.delete(id)
        ctx.logger.warn(
          `executor-gate: COVERAGE — session ${id} never resolved to preset "${ownPresetId}" after ` +
            `${settings.identityRetries} retries; it is NOT gated by this plugin`,
        )
      } else {
        entry.attempt += 1
      }
    }
  }

  /** 扫一遍当前进程里的 agent 名册：不认识的、属于本 preset 的，都过一遍 watch。 */
  const discover = () => {
    let roster
    try {
      roster = typeof agents.list === 'function' ? agents.list() : []
    } catch (error) {
      ctx.logger.warn('executor-gate: agents.list() failed: ' + String(error))
      return
    }
    // ⚠️ `agents.list` 不存在时**必须响亮**：它是执行层唯一的发现路径，
    //    悄悄返回空数组 = 闸门静默失效、所有执行层裸奔（那正是"有的会话没上闸"）。
    if (typeof agents.list !== 'function') {
      ctx.logger.warn(
        'executor-gate: agents.list() is unavailable — executors CANNOT be discovered, so they will run UNGATED. ' +
          'This is the "some sessions have no gate" failure; report it.',
      )
      return
    }
    if (!Array.isArray(roster)) return
    // 先把上一轮"preset 归属还没建立起来"的补判一遍
    try {
      retryPendingIdentity()
    } catch (error) {
      ctx.logger.warn('executor-gate: identity retry sweep failed: ' + String(error))
    }
    for (const agent of roster) {
      try {
        // ⚠️ 这里**不要**自己先判 `presetOf !== ownPresetId → continue`。
        //    第一版就是那么写的，结果把 `watch` 里那条"归属还没建立起来 → 待重试"
        //    的逻辑**整条短路**掉了：早一拍看到的子会话被永久漏掉（= 没上闸）。
        //    判定与重试都交给 `watch` 一处负责。
        watch(agent)
      } catch (error) {
        ctx.logger.warn('executor-gate: discovery of one agent failed: ' + String(error))
      }
    }
    // 名册里已经没有的待重试条目：直接丢弃，别让 map 无限增长
    for (const [id, entry] of [...pendingIdentity]) {
      if (!roster.includes(entry.agent)) pendingIdentity.delete(id)
    }
  }

  /**
   * 覆盖面审计：**"哪些执行层没上闸"必须永远可见**。
   *
   * 这是用户 2026-09-18 反馈里更危险的那一条：
   * 「我以为是闸的东西，有的会话根本没上闸 —— 它在我任何授权之前就把文件写进去了」。
   *
   * 本插件的守护是"**发现即冻结**"，而发现靠轮询（`agents.list()`），
   * 所以子会话从**被创建**到**被冻结**之间有一段窗口，那期间它是裸的。
   * 这段窗口没法从根上消掉（守卫只能装在已经存在的 agent 的 scoped ctx 上），
   * 但**绝不能让它静默**：
   *   · 见过的执行层先记下来；
   *   · 下一轮审计时，凡是"进过名册、但守卫没装上"的，打 **error 级**日志点名。
   * 这样日志里就能直接看出"闸没覆盖到谁"，而不是靠事后猜。
   */
  const auditCoverage = () => {
    let roster
    try {
      roster = typeof agents.list === 'function' ? agents.list() : []
    } catch {
      return
    }
    if (!Array.isArray(roster)) return
    const stillLive = new Set()
    for (const agent of roster) {
      // ⚠️ **这里不能用 preset 过滤** —— 这是同一个 bug 的第三层。
      //
      // 审计的职责恰恰是抓「preset 归属还没建立起来 → 于是没被守卫」的执行层；
      // 如果先用 preset 过滤，那类漏网者对审计**也是隐形的**，审计就成了摆设。
      // 所以按 `origin === 'subagent'`（产品自己设的会话头字段）认执行层，
      // 再用"它在不在本 preset 里"来分类：
      //   · 在本 preset 且已上闸 → 正常；
      //   · 在本 preset 但没上闸   → 覆盖漏洞（点名 + 给补救建议）；
      //   · 不在本 preset         → 别的 preset 的执行层，本插件**按设计不管**，只说一次。
      if (roleOf(agent, { isRoot: agents.roots().includes(agent) }) !== 'executor') continue
      const id = agentIdOf(agent)
      stillLive.add(id)
      if (!seenExecutors.has(id)) seenExecutors.set(id, { at: Date.now(), ownPreset: presetOf(agent) === ownPresetId })
      else seenExecutors.get(id).ownPreset = presetOf(agent) === ownPresetId
    }
    const now = Date.now()
    for (const [id, info] of [...seenExecutors]) {
      const ageSeconds = Math.round((now - info.at) / 1000)
      if (!stillLive.has(id)) {
        // 会话已经结束 —— 它已经不是风险了，从待办里去掉。
        // 但若它**从头上到尾都没上过闸**，那必须留一条记录：它在那段时间里是裸的。
        if (!guardedIds.has(id) && info.ownPreset) {
          ctx.logger.warn(
            `executor-gate: COVERAGE — executor ${id} ended WITHOUT ever being gated ` +
              `(seen ${ageSeconds}s, now gone). Any write it did in that window was UNGATED.`,
          )
        }
        seenExecutors.delete(id)
        continue
      }
      if (guardedIds.has(id)) continue
      if (!info.ownPreset) {
        // 别的 preset 的执行层：本插件按设计不管它，只说一次（避免每轮刷屏）
        if (!info.reportedForeign) {
          info.reportedForeign = true
          ctx.logger.info(
            `executor-gate: executor ${id} belongs to a DIFFERENT preset — not this plugin's jurisdiction ` +
              '(it is gated by whatever preset mounted it, or by nothing)',
          )
        }
        continue
      }
      // 本 preset 的、活着但没上闸 —— 这是真正的覆盖漏洞，每轮点名，不静默。
      ctx.logger.warn(
        `executor-gate: COVERAGE GAP — live executor ${id} is in preset "${ownPresetId}" but has NO gate ` +
          `(first seen ${ageSeconds}s ago). It can write WITHOUT any lease until this is fixed.`,
      )
    }
  }

  ctx.effect(
    () => {
      const disposers = []
      const timers = []
      // ① 顶层会话（意图层）：`roots()` 可见。
      for (const agent of agents.roots()) {
        try {
          watch(agent)
        } catch (error) {
          ctx.logger.warn('executor-gate: initial scan failed: ' + String(error))
        }
      }
      // ② 事件通道：留着 —— 它在**真实的 DSH 运行时**里可能出现（本插件的替身实测为 0 条，
      //    但那不足以断言生产里也没有）。装不上也只是收不到，不影响正确性。
      disposers.push(
        ctx.on('agent/created', ({ agent }) => {
          try {
            watch(agent)
          } catch (error) {
            ctx.logger.warn('executor-gate: agent/created handler failed: ' + String(error))
          }
        }),
      )
      // ③ 轮询通道：**执行层唯一的可靠发现路径**（理由见 DEFAULTS.discoveryIntervalMs）。
      //
      //    ⚠️ 第一次扫描必须**推到本 tick 之后**：`apply` 期间 Cordis 还没把本插件的
      //    作用域与相邻行挂完，此时子 agent 的 `scopedCtx.tools` 还不存在 ——
      //    本插件开发时实测：立刻扫描会让执行层的守卫静默装不上（`tools` 为 undefined）。
      if (settings.discoveryIntervalMs > 0) {
        const kickoff = setTimeout(() => {
          try {
            discover()
          } catch (error) {
            ctx.logger.warn('executor-gate: kickoff discovery failed: ' + String(error))
          }
        }, 0)
        if (typeof kickoff?.unref === 'function') kickoff.unref()
        timers.push(kickoff)
        const timer = setInterval(discover, settings.discoveryIntervalMs)
        if (typeof timer?.unref === 'function') timer.unref()
        timers.push(timer)
      }
      // ④ 覆盖面审计（较慢的节拍，只负责把"谁没上闸"喊出来）
      if (settings.coverageAuditMs > 0) {
        const audit = setInterval(auditCoverage, settings.coverageAuditMs)
        if (typeof audit?.unref === 'function') audit.unref()
        timers.push(audit)
      }
      // ⑤ 子会话名册轮询（给"发消息前查活"用：`mode` 决定"叫不叫得醒"）。
      //    它必须**异步轮询 + 同步读缓存** —— `tools.guard` 是同步判据，见 `childCatalog` 的注释。
      if (settings.catalogIntervalMs > 0) {
        const refresh = () => {
          void refreshCatalog().catch(() => {})
        }
        const kickoff = setTimeout(refresh, 0)
        if (typeof kickoff?.unref === 'function') kickoff.unref()
        timers.push(kickoff)
        const catalogTimer = setInterval(refresh, settings.catalogIntervalMs)
        if (typeof catalogTimer?.unref === 'function') catalogTimer.unref()
        timers.push(catalogTimer)
      }
      return () => {
        for (const timer of timers) {
          try {
            clearInterval(timer)
          } catch {
            // 清理失败不打断其余释放。
          }
        }
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 释放期失败不打断其余释放。
          }
        }
      }
    },
    'executor-gate: permission gate for the executor layer',
  )
}

//#endregion
