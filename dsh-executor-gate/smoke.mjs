/**
 * dsh-executor-gate 的离线回归 smoke。
 *
 * ## 它守的是什么
 *
 * 用户要的四条「权限管理条例」，每一条都必须有**能被负对照打红**的断言：
 *
 * | 条例 | 断言在哪 |
 * |---|---|
 * | ① 默认冻结（白纸开局） | 「冻结态」一节：write/edit/变更类 shell 全拒，只读命令与 read 放行 |
 * | ② 权限审批流 | 「授权链路」一节：意图层文字里的 `【授权】` 折成租约 → 立刻放行；`grant_permission` 对执行层响亮拒绝 |
 * | ③ 时间锁与范围锁 | 「范围锁 / 黑名单 / 额度锁 / 时间锁」四节，逐条断言 |
 * | ④ 定律 vs 工具边界 | 「物理定律 / 熔断」两节：不可授权、三次违规收权 |
 *
 * ## 三条设计纪律（都是本项目付过学费的）
 *
 * 1. **必须跑真实的 `apply`。** 这里不重写 `apply` 的逻辑，只 import 它、喂给真 Cordis，
 *    agent 的 scoped ctx 由真 `@deepseek-ai/dsh-scope` 的 `createScope` 铸造。
 *    （`dsh-executor-view` 曾把手写假 ctx 喂给 apply，得到恒真断言 —— 假对象天然拥有一切属性。）
 * 2. **`tools` 是忠实替身。** 真 `@deepseek-ai/dsh-tools` 无法 import（依赖整条 preset 运行时）。
 *    替身的两条语义逐字抄自真实现（`node_modules/@deepseek-ai/dsh-tools/lib/index.js`）：
 *    `guard()` 登记单调守卫、**首个返回字符串的守卫即拒绝**（`guardReason`）；
 *    `guard()` **不校验工具名**（与 `restrict()` 相反），这正是本插件选 guard 的原因。
 * 3. **负对照必须有判别力。** 末尾把判据喂进真实配置跑一遍，必须变红；
 *    同时把判据当函数喂恶意输入，必须返回假 —— 证明它不是恒真。
 *
 * ## 跑法
 *
 *     node "D:\<dsh-plugin-root>\插件\dsh-executor-gate\smoke.mjs"
 *
 * 退出码：0 全绿 / 1 有断言失败 / 2 缺依赖（**不是插件坏了**）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGINS_ROOT = dirname(PLUGIN_DIR)
const VENDOR = join(PLUGINS_ROOT, '_tools', 'vendor', 'node_modules')
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
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${String(detail).slice(0, 500)}`}`)
  }
}

//#region 缺依赖必须响亮（exit 2，不是断言失败）

const cordisPath = join(VENDOR, '@deepseek-ai', 'cordis', 'lib', 'index.js')
const scopePath = join(VENDOR, '@deepseek-ai', 'dsh-scope', 'lib', 'index.js')
if (!existsSync(cordisPath) || !existsSync(scopePath)) {
  console.error('缺依赖，不是插件坏了：')
  if (!existsSync(cordisPath)) console.error(`  - 找不到真 cordis：${cordisPath}`)
  if (!existsSync(scopePath)) console.error(`  - 找不到真 @deepseek-ai/dsh-scope：${scopePath}（本回归用它铸造真实 scoped agent ctx）`)
  console.error('两者缺一即退出 2 —— 绝不把「缺依赖」伪装成「插件坏了」。')
  process.exit(2)
}

console.log(`cordis   来源：${cordisPath}`)
console.log(`dsh-scope来源：${scopePath}`)
console.log(`preset   来源：${PRESET_FILE ?? '(未找到 — 跳过 preset 配置一致性那两条断言)'}`)

const { Context, Service } = await import(pathToFileURL(cordisPath).href)
const { createScope, scopeOf } = await import(pathToFileURL(scopePath).href)

//#endregion

//#region 忠实替身：tools 服务

/**
 * `tools` 的忠实替身。
 *
 * ⚠️ 它**必须**是 `Service` 的子类：Cordis 的 `Service` 构造器会给实例挂
 * `symbols.tracker`，于是任何 ctx 读 `tools` 时 `this.ctx` 被影子成调用者的 ctx。
 * 裸对象没有这个 tracker，`this.ctx` 就是 undefined —— 这正是 smoke 里踩过的坑：
 * **替身不像真产品，回归就会把「守卫坏了」报成「守卫没跑」。**
 */
class ToolsStandIn extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.registered = []
    /**
     * 已注册的工具名。**真实现用 `NamedEntries` 去重**：同名的工具在同一个层里
     * 只能注册一次，第二次抛 `tool "X" is already registered`。
     *
     * ⚠️ 替身**必须复刻这条**。第一版替身不去重、不抛错，于是漏掉了一个
     * **会让主路径整体失效**的缺陷：插件原本"给每个 agent 各注册一遍工具"，
     * 在真实现里从第二个 agent 起全部注册失败（意图层有工具、执行层没工具）。
     * smoke 全绿而生产是坏的 —— 「真实现会抛、替身不抛」的差异只能靠
     * **真依赖**（`_verify-tool-register.mjs`）或**让替身照抄规则**来抓，这里两条都做。
     */
    this.registeredNames = new Set()
    /** scope → 该 scope 上的守卫列表（真产品按 layer 记账）。 */
    this.guardsByScope = new Map()
    /** 全局层守卫：不绑 scope 时落这里。 */
    this.globalGuards = []
  }
  register(definition) {
    if (definition === null || typeof definition !== 'object' || typeof definition.name !== 'string') {
      throw new Error('tools.register() requires a definition with a name')
    }
    // 去重语义逐字对齐真实现（`ToolLayer` 的 `NamedEntries` 冲突文案）
    if (this.registeredNames.has(definition.name)) {
      throw new Error(
        `tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`,
      )
    }
    this.registeredNames.add(definition.name)
    this.registered.push(definition)
    return () => {
      this.registeredNames.delete(definition.name)
    }
  }
  /**
   * 逐字复刻真实现的语义：登记一个**单调**守卫（返回字符串即拒绝）。
   * 有 scope 就落该 scope，没有就落全局层 —— 与真产品
   * 「A plain-context guard applies globally; one registered through agent.ctx
   *   applies only to that agent」逐字一致。
   */
  guard(guard) {
    if (typeof guard !== 'function') throw new Error('tools.guard() requires a function')
    const scope = scopeOf(this.ctx)
    if (scope === undefined) this.globalGuards.push(guard)
    else {
      if (!this.guardsByScope.has(scope)) this.guardsByScope.set(scope, [])
      this.guardsByScope.get(scope).push(guard)
    }
    return () => {}
  }
  /**
   * 真产品的判定顺序：全局层 → scope 链，**首個返回理由的即拒绝**
   * （`ToolRuntime.guardReason` / `ScopedLayers.guardReason`）。
   */
  guardReason(exec) {
    for (const guard of this.globalGuards) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    const scope = exec.agent === undefined ? undefined : scopeOf(exec.agent.ctx)
    if (scope === undefined) return undefined
    for (const guard of this.guardsByScope.get(scope) ?? []) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

//#endregion

//#region 场景装配：真 Cordis + 真 apply

/**
 * 搭一个双区场景：一个意图层会话 + N 个执行层会话。
 *
 * @param config - 喂给插件 `apply` 的配置（走 `plugin(plugin, config)` 的正式第二参数）。
 * @param options - 场景参数。
 */
async function runScenario({ label, config, executors = 1, withIntent = true, intentMessages = [], breakAgentsList = false }) {
  const gate = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href)
  gate.resetLedger()

  const loggerCalls = { info: [], warn: [], error: [] }
  const consoleErrors = []
  const realConsoleError = console.error
  console.error = (...args) => consoleErrors.push(args.map(String).join(' '))

  const root = new Context()
  Object.defineProperty(root, 'logger', {
    value: {
      info: (message) => loggerCalls.info.push(String(message)),
      warn: (message) => loggerCalls.warn.push(String(message)),
      // ⚠️ 必须提供 `error`：Cordis 的 `Fiber._reload` 在 fiber 出错时会调
      // `this.ctx.logger.error(reason)`，缺了它回归会以一句
      // `TypeError: this.ctx.logger.error is not a function` **崩掉**，
      // 把真正的失败原因盖掉（本项目踩过：崩溃点看起来像"替身不全"，
      // 实际是插件在 apply 里报了错）。
      error: (message) => loggerCalls.error.push(String(message)),
    },
    configurable: true,
    writable: true,
  })

  // 1) agentPresets 替身：只固定返回本 preset id（真实现由 dsh-agent-presets 提供）
  await root.plugin({
    name: 'agent-presets-stand-in',
    apply(ctx) {
      ctx.reflect.provide('agentPresets', {
        composedPreset: (scopedCtx) => (scopeOf(scopedCtx) === undefined ? undefined : PRESET_ID),
      })
    },
  })

  // 2) tools 服务：**必须由不 inject 它的插件 provide**（自锁坑见 dsh-intent-guard/smoke.mjs）
  let toolsService
  await root.plugin({
    name: 'tools-stand-in',
    apply(ctx) {
      toolsService = new ToolsStandIn(ctx)
    },
  })

  // 3) agent 造册：在声明了 inject: ['tools'] 的插件里铸造 scoped ctx
  const agents = { roots: () => [], list: () => [] }
  const fixtures = []
  await root.plugin({
    name: 'agents-stand-in',
    inject: ['tools'],
    apply(ctx) {
      ctx.reflect.provide('agents', agents)
      const specs = []
      if (withIntent) {
        specs.push({ id: 'session-intent-1', origin: undefined, log: intentMessages })
      }
      for (let index = 0; index < executors; index += 1) {
        specs.push({ id: `session-child-${index + 1}`, origin: 'subagent', log: [] })
      }
      for (const spec of specs) {
        const agent = {
          id: spec.id,
          session: {
            header: {
              id: spec.id,
              cwd: 'D:/proj',
              ...(spec.origin === undefined ? {} : { origin: spec.origin }),
              ...(spec.origin === undefined ? {} : { parentSession: 'session-intent-1', delegationDepth: 1 }),
            },
            log: spec.log,
          },
        }
        const handle = createScope(ctx, agent)
        agent.ctx = handle.ctx
        fixtures.push({ agent, handle })
      }
      /**
       * ⚠️ 这两个替身方法必须**各自忠实**，不能为了好测就放宽：
       *   - `roots()` 按产品定义只含「没有属主 agent 的顶层会话」→ 执行层**不在**里面。
       *     本插件开发时实测：把执行层塞进 roots() 会让「靠 list() 发现执行层」
       *     这条真正重要的路径**永远不被测**，于是生产里执行层根本装不上守卫。
       *   - `list()` 是进程级名册 → 含全部会话。这才是执行层的发现路径。
       */
      agents.roots = () => fixtures.filter((fixture) => fixture.agent.session.header.origin === undefined).map((f) => f.agent)
      agents.list = () => fixtures.map((f) => f.agent)
      // 负对照用：把发现路径打断，模拟真产品里 `agents.list` 不存在/坏掉的情况
      // （那正是"有的会话没上闸"的机制形态）
      if (breakAgentsList) delete agents.list
    },
  })

  // 4) 被测插件：**真** apply + 真 ctx
  let applyThrew
  let fiber
  try {
    fiber = root.plugin({ name: 'executor-gate', inject: gate.inject, apply: gate.apply }, config)
  } catch (error) {
    applyThrew = error
  }
  await new Promise((resolve) => setTimeout(resolve, 80))
  console.error = realConsoleError

  const intent = fixtures.find((fixture) => fixture.agent.session.header.origin === undefined)
  const children = fixtures.filter((fixture) => fixture.agent.session.header.origin === 'subagent')

  /** 真判定路径：走替身的 guardReason（= 真产品语义）。 */
  const call = (agent, toolName, args) =>
    toolsService.guardReason({ name: toolName, arguments: args, agent, callId: 'call-1', signal: new AbortController().signal })

  /** 给某个执行层「追加」一条意图层消息（真产品里就是 steer / send_message 落到日志上）。 */
  const deliver = (agent, text) => {
    agent.session.log.push({ type: 'user/message', seq: agent.session.log.length, data: { id: `m-${agent.session.log.length}`, role: 'user', content: [{ type: 'text', text }] } })
  }

  /** 直接调插件注册的工具（走真 execute，不经过模型）。 */
  const invoke = async (agent, toolName, args) => {
    const definition = registeredFor(toolsService, agent, toolName)
    if (definition === undefined) throw new Error(`tool not registered for ${agent.id}: ${toolName}`)
    return definition.execute(args, { agent, callId: 'call-x', signal: new AbortController().signal })
  }

  return { gate, root, fiber, applyThrew, toolsService, agents, fixtures, intent, children, call, deliver, invoke, loggerCalls, consoleErrors, config }
}

/**
 * 替身不按 scope 记账 register（真产品按 layer），所以这里按
 * 「该 agent 的 scoped ctx 上注册过的那一批」取：插件对每个 agent 都注册同一组工具名，
 * 取最后一次即可（同名同实现）。
 */
function registeredFor(toolsService, agent, toolName) {
  const found = toolsService.registered.filter((definition) => definition.name === toolName)
  if (found.length === 0) return undefined
  void agent
  return found[found.length - 1]
}

//#endregion

//#region 主场景

console.log('\n== 真 Cordis + 真 apply：一个意图层 + 两个执行层 ==')
const main = await runScenario({
  label: 'main',
  config: { enabled: true, logDenied: true, presetId: PRESET_ID, maxLeaseMs: 3_600_000, discoveryIntervalMs: 20 },
  executors: 2,
})

const gate = main.gate
ok('注册阶段没有同步抛错', main.applyThrew === undefined, main.applyThrew?.message)
ok(
  '被测插件真的跑起来了：fiber 到达 ACTIVE（=2）—— 若 apply 根本没执行，下面所有断言都是拿空气当证据',
  main.fiber?.state === 2,
  `fiber.state=${String(main.fiber?.state)}（0=PENDING 说明依赖没满足、apply 从未执行；3=FAILED）`,
)
ok('插件导出了 Cordis 需要的形状', gate.name === 'executor-gate' && Array.isArray(gate.inject) && typeof gate.apply === 'function')
ok(
  '**没有**导出 Config schema（dsh-executor-loop 的事故：手写 Config 不是 Standard Schema 会把整棵树打崩）',
  gate.Config === undefined,
  `Config=${String(gate.Config)}`,
)
ok('apply 没有把错误吞进 console.error（响亮失败会留痕）', main.consoleErrors.length === 0, main.consoleErrors.join(' | '))

const [childA, childB] = main.children
ok('造出了 2 个执行层会话（origin=subagent）', main.children.length === 2, `children=${main.children.length}`)
ok('执行层的 guard 真的装上了（scope 上有守卫）', (main.toolsService.guardsByScope.get(scopeOf(childA.agent.ctx)) ?? []).length === 1)
ok('意图层的 guard 也装上了（denyIntentWrites 默认开）', (main.toolsService.guardsByScope.get(scopeOf(main.intent.agent.ctx)) ?? []).length === 1)
ok('台账四个工具都注册了', ['request_permission', 'grant_permission', 'revoke_permission', 'lease_status'].every((n) => registeredFor(main.toolsService, childA.agent, n) !== undefined))
// ⚠️ 这两条补的是一个**真实的覆盖漏洞**：原先 smoke 里没有挂载点的 tools 服务，
// 于是生产那条「在挂载点注册一次」的路径**根本没被执行到** —— 而那个位置正好藏着
// 一个会让主路径整体失效的缺陷（"每个 agent 各注册一遍"在真实现里从第二个起就抛错）。
ok(
  '**在挂载点注册成功**（走的是生产那条 `ctx.tools.register` 路径，不是 agent 的 scoped ctx）',
  main.loggerCalls.info.some((m) => m.includes('registered the ledger tools')),
  JSON.stringify(main.loggerCalls.info.filter((m) => m.includes('ledger tools'))),
)
ok(
  '没有出现"注册不上"的告警（出现即说明生产里工具会缺席）',
  !main.loggerCalls.warn.some((m) => m.includes('could not register the ledger tools') || m.includes('ctx.tools.register is unavailable')),
  JSON.stringify(main.loggerCalls.warn),
)
ok(
  '四个工具名各只注册一次（替身照抄了真实现的去重：同名同层只能注册一次）',
  ['request_permission', 'grant_permission', 'revoke_permission', 'lease_status'].every(
    (n) => main.toolsService.registered.filter((d) => d.name === n).length === 1,
  ),
  ['request_permission', 'grant_permission', 'revoke_permission', 'lease_status']
    .map((n) => `${n}×${main.toolsService.registered.filter((d) => d.name === n).length}`)
    .join(' '),
)
ok('日志里可见「执行层被冻结」这条现场证据', main.loggerCalls.info.some((m) => m.includes('is an EXECUTOR — FROZEN')), JSON.stringify(main.loggerCalls.info.slice(0, 4)))

// ⚠️ 这一组是**补一个真实漏掉的缺口**。
//
// 2026-09-18 生产事故：双区第一轮就死，provider 报
//   Invalid schema for function 'grant_permission':
//   schema must be a JSON Schema of 'type: "object"', got 'type: null'.
// 根因是手写的工具定义把 `parameters` 直接写成裸的 `{字段: {...}}`，
// **漏了 `type: 'object'`** —— 真 `defineTool()` 会自己编译出那一层，而本插件绕过了它。
//
// 而在那之前，smoke 与真依赖校验**都是绿的** —— 因为真 `register()` 只校验
// `output.schema`，**根本不看 `parameters`**，替身也不看。
// 所以判据必须落在「交出去的东西长什么样」上，而不是「register 有没有抛错」。
for (const definition of main.toolsService.registered) {
  ok(
    `${definition.name}.parameters.type === 'object'（provider 就校验这个字段；缺了它整轮会话 400）`,
    definition.parameters?.type === 'object',
    `实际：${JSON.stringify(definition.parameters)?.slice(0, 240)}`,
  )
  ok(
    `${definition.name}.parameters.properties 是非空对象`,
    definition.parameters?.properties !== undefined && Object.keys(definition.parameters.properties).length > 0,
    `实际：${JSON.stringify(definition.parameters)?.slice(0, 240)}`,
  )
  if (Array.isArray(definition.parameters?.required)) {
    ok(
      `${definition.name}.required 里的字段都真的在 properties 里`,
      definition.parameters.required.every((key) => Object.hasOwn(definition.parameters.properties, key)),
      `required=${JSON.stringify(definition.parameters.required)}`,
    )
  }
}

//#endregion

//#region 条例 ①：默认冻结（白纸开局）

console.log('\n== 条例 ①：默认冻结 —— 新执行层没有任何写权限 ==')
const a = childA.agent
ok('冻结态 write → 拒绝', main.call(a, 'write', { file_path: 'D:/proj/src/a.ts', content: 'x' }) !== undefined)
ok('冻结态 edit → 拒绝', main.call(a, 'edit', { file_path: 'D:/proj/src/a.ts', old_string: 'x', new_string: 'y' }) !== undefined)
ok('冻结态变更类 shell（Set-Content）→ 拒绝', main.call(a, 'pwsh', { command: 'Set-Content -Path D:/proj/x.txt -Value hi' }) !== undefined)
ok('冻结态 Remove-Item → 拒绝', main.call(a, 'pwsh', { command: 'Remove-Item -Recurse -Force D:/proj/build' }) !== undefined)
ok('冻结态 read → **放行**（只读是它的合法手段）', main.call(a, 'read', { file_path: 'D:/proj/src/a.ts' }) === undefined)
ok(
  '冻结态跑测试：**没给 run_test 预算 = 预算外行为，禁止**（这正是「工具预算」的意义 —— ' +
    '没被授权的工具就不许用，哪怕它本身无副作用）',
  main.call(a, 'pwsh', { command: 'node --test "D:/proj/test/a.test.mjs"' }) !== undefined,
)
ok('但冻结态只读命令（node -v / git status）照旧放行 —— 读类默认不限制', main.call(a, 'pwsh', { command: 'node -v' }) === undefined)
ok('冻结态 git status（无重定向）→ 放行', main.call(a, 'pwsh', { command: 'git status --short' }) === undefined)
ok('冻结态 grep → 放行', main.call(a, 'grep', { pattern: 'x', path: 'D:/proj' }) === undefined)

const frozenReason = String(main.call(a, 'write', { file_path: 'D:/proj/src/a.ts', content: 'x' }))
ok('拒绝理由说清了「白纸开局」与唯一出路', frozenReason.includes('默认冻结') && frozenReason.includes('request_permission') && frozenReason.includes('send_message'), frozenReason.slice(0, 200))
ok('拒绝理由明确要求「停下等」，不是反复重试', frozenReason.includes('停下等'), frozenReason.slice(0, 300))

//#endregion

//#region 条例 ③：范围锁 + 额度锁 + 时间锁（经意图层授权）

console.log('\n== 条例 ②/③：意图层授权（【授权】标记）→ 范围锁生效 ==')
const grantText = [
  '【授权】',
  '允许写: D:/proj/src, D:\\proj\\tests',
  '禁止碰: D:/proj/src/core',
  '写额度: 3',
  '实验额度: 2',
].join('\n')
main.deliver(a, grantText)

ok('授权后：白名单内 write → 放行', main.call(a, 'write', { file_path: 'D:/proj/src/a.ts', content: 'x' }) === undefined)
ok('授权后：白名单内 edit → 放行', main.call(a, 'edit', { file_path: 'D:/proj/src/b.ts', old_string: 'x', new_string: 'y' }) === undefined)
const outside = main.call(a, 'write', { file_path: 'D:/other/c.ts', content: 'x' })
ok('范围锁：白名单外 write → 拒绝', outside !== undefined)
ok('范围锁的拒绝理由列出了当前允许范围', outside.includes('范围锁') && outside.includes('d:/proj/src'), outside.slice(0, 220))
ok('范围锁：写法变体（反斜杠 / 大写盘符 / 结尾斜杠）不能绕过', main.call(a, 'write', { file_path: 'D:\\OTHER\\c.ts', content: 'x' }) !== undefined)
const deniedByRule = main.call(a, 'write', { file_path: 'D:/proj/src/core/deep.ts', content: 'x' })
ok('黑名单优先于白名单：src/core 被单独点名禁止 → 拒绝', deniedByRule !== undefined)
ok('黑名单拒绝理由说清「不要换写法绕」', deniedByRule.includes('黑名单') && deniedByRule.includes('绕'), deniedByRule.slice(0, 220))

ok('额度锁：剩余 1 次写 → 额外一次 write 放行', main.call(a, 'write', { file_path: 'D:/proj/src/c.ts', content: 'x' }) === undefined)
const exhausted = main.call(a, 'write', { file_path: 'D:/proj/src/d.ts', content: 'x' })
ok('额度锁：写额度烧满（3/3）→ 拒绝', exhausted !== undefined)
ok('写预算耗尽理由说清「预算耗尽、任务未完成」并要求回报告', String(exhausted).includes('预算耗尽') && String(exhausted).includes('任务未完成'), String(exhausted).slice(0, 300))
ok('写预算耗尽的理由把「已用/上限」摊开给人看', String(exhausted).includes('3/3'), String(exhausted).slice(0, 200))
ok(
  '**关键**：额度烧满后**不会**把额度回满（同一批授权消息不会被反复折叠 —— 否则额度锁形同虚设）',
  main.call(a, 'write', { file_path: 'D:/proj/src/e.ts', content: 'x' }) !== undefined,
)

// 时间锁：授权后让 `expiresAt` 真的过去，再判一次。
//
// ⚠️ 不能用 `maxLeaseMs: 0` 测：判定发生在**同一毫秒**内时 `Date.now() > expiresAt`
// 为假，租约合法地还没过期 —— 那是「判据不可能成立」，不是「闸门坏了」。
// 这里用 30ms 的租约 + 真等待，测的是**真实会发生**的那个性质。
const expired = await runScenario({
  label: 'time-lock',
  config: { enabled: true, presetId: PRESET_ID, maxLeaseMs: 30, discoveryIntervalMs: 20 },
  executors: 1,
})
expired.deliver(expired.children[0].agent, '【授权】\n允许写: D:/proj/src\n写额度: 5')
ok('时间锁：租约生效期内 write 放行', expired.call(expired.children[0].agent, 'write', { file_path: 'D:/proj/src/a.ts', content: 'x' }) === undefined)
await new Promise((resolve) => setTimeout(resolve, 60))
const afterExpiry = expired.call(expired.children[0].agent, 'write', { file_path: 'D:/proj/src/a.ts', content: 'x' })
ok('时间锁：租约一过 expiresAt 就自动冻结（无需任何人记得回收）', afterExpiry !== undefined)
ok('过期后给出的是权限门自己的拒绝理由（不是别的东西挡的）', String(afterExpiry).includes('执行层权限门'), String(afterExpiry).slice(0, 200))

//#endregion

//#region 条例 ③（预算）：按工具额度 —— 跑测试的次数是独立的一项

console.log('\n== 条例 ③：跑测试的**独立**额度（「只许跑 3 次」这条规矩的落点）==')
const shellCase = await runScenario({ label: 'shell-budget', config: { enabled: true, presetId: PRESET_ID, discoveryIntervalMs: 20, logDenied: false }, executors: 1 })
const s = shellCase.children[0].agent
shellCase.deliver(s, '【授权】\n允许写: D:/proj/tmp\n实验额度: 2')

// 前置：这三条命令**必须**被判成跑测试，否则下面的额度断言等于没测到东西。
const testCommands = [
  'node --test "D:/proj/test/a.test.mjs"',
  'node --test "D:/proj/test/b.test.mjs"',
  'npx vitest run',
]
ok(
  '前置判据：三条用例命令都被归类为 run_test',
  testCommands.every((c) => gate.classifyShell(c) === 'run_test'),
  testCommands.map((c) => `${c}→${gate.classifyShell(c)}`).join(' | '),
)

ok('只读命令不扣额度（跑 5 次 node -v 仍放行）', ['1', '2', '3', '4', '5'].every(() => shellCase.call(s, 'pwsh', { command: 'node -v' }) === undefined))
ok('第 1 次跑测试（实验额度 2）→ 放行', shellCase.call(s, 'pwsh', { command: testCommands[0] }) === undefined)
ok('第 2 次跑测试 → 放行', shellCase.call(s, 'pwsh', { command: testCommands[1] }) === undefined)
const thirdRun = shellCase.call(s, 'pwsh', { command: testCommands[2] })
ok('第 3 次跑测试（实验额度 2 已满）→ 拒绝：连跑多轮实验被预算拦住', thirdRun !== undefined)
ok('该拒绝理由是预算耗尽而不是范围锁', String(thirdRun).includes('预算耗尽'), String(thirdRun).slice(0, 200))
ok(
  'run_test 的额度与 write_file 的额度**互不干扰**（这是「按工具发预算」的核心性质）',
  shellCase.call(s, 'pwsh', { command: 'New-Item -ItemType Directory -Path "D:/proj/tmp/n1" -Force' }) === undefined,
)
// ── **整路额度**：「命令行: N次」真的管用（2026-09-20 用户那条"名字对不上"的正面修法）──
{
  const shellLab = await runScenario({ label: 'shell-wide-budget', config: { enabled: true, presetId: PRESET_ID, discoveryIntervalMs: 20, logDenied: false }, executors: 1 })
  const sc = shellLab.children[0].agent
  const before = shellLab.call(sc, 'pwsh', { command: 'pytest -q' })
  ok('  没给任何额度时，跑测试仍然是「预算外 · 禁止」（这条不能松）', before !== undefined && /预算外行为/.test(String(before)), String(before).slice(0, 200))
  // 人按"那个能跑程序的入口"定额度：命令行 2 次
  shellLab.deliver(sc, '【授权】\n任务ID: "T-SHELL"\n命令行: 2次\n预算外行为: "禁止"')
  // 用**真工具**读台账（而不是碰内部结构）：这也顺带验了"人在台账里看到的就是入口名"
  const leaseNow = String(await shellLab.invoke(sc, 'lease_status', { agent_id: sc.id }))
  ok('**`命令行: 2次` ⇒ 台账里看得见「命令行（整路） 0/2」**', /命令行（整路）\s*0\/2/.test(leaseNow), leaseNow.slice(0, 420))
  ok('  跑测试：**放行**（额度落在它真能调的那个入口上）', shellLab.call(sc, 'pwsh', { command: 'pytest -q' }) === undefined)
  ok('  只读命令：照旧放行（不因为没给读额度就被卡）', shellLab.call(sc, 'pwsh', { command: 'git status --short' }) === undefined)
  // ⚠️ 硬边界：**整路额度只替换"计费"，不替换"检查"** —— 没给写范围时，变更类照样被范围锁拦住。
  const noScope = shellLab.call(sc, 'pwsh', { command: 'New-Item -ItemType Directory -Path "D:/proj/tmp/n1" -Force' })
  ok('  **变更类：没给写范围 ⇒ 被范围锁拒**（整路额度 ≠ 免检）', noScope !== undefined && /范围/.test(String(noScope)), String(noScope).slice(0, 240))
  ok('  而且这次拒**不扣额度**（被检查拦下的不该记账）', shellLab.call(sc, 'pwsh', { command: 'node --test x.mjs' }) === undefined)
  const third = shellLab.call(sc, 'pwsh', { command: 'pytest -q' })
  ok('  用满 2 次之后 ⇒ 预算耗尽熔断（整路额度是真在记账）', third !== undefined && /预算耗尽/.test(String(third)), String(third).slice(0, 220))
  ok('  话术里报的是**入口名**（「命令行（整路）」），不是内部键名', /命令行（整路）/.test(String(third)), String(third).slice(0, 260))
  // 只读不计数：额度用完之后，只读探针仍要能跑（否则审计层连"把情况说清楚"都做不到）。
  ok(
    '  **整路额度用完之后，只读探针照旧放行**（只读 = 「读文件」那一档，不计数）',
    shellLab.call(sc, 'pwsh', { command: 'python -c "print(open(\'notes/a.md\').read()[:10])"' }) === undefined,
    String(shellLab.call(sc, 'pwsh', { command: 'python -c "print(open(\'notes/a.md\').read()[:10])"' })).slice(0, 200),
  )
  const writeAfterExhaust = shellLab.call(sc, 'pwsh', { command: 'python -c "open(\'notes/a.md\',\'w\')"' })
  ok(
    '  但**同一条命令只要在写，就照样被拦**（只读豁免不会顺带把写也豁免掉）',
    writeAfterExhaust !== undefined && /范围|预算/.test(String(writeAfterExhaust)),
    String(writeAfterExhaust).slice(0, 220),
  )
  // 范围外的变更类命令：整路额度在，但范围检查照旧拦
  const outside = shellLab.call(sc, 'pwsh', { command: 'Remove-Item -Recurse -Force "D:/elsewhere"' })
  ok('  **范围外的变更类命令照样被拒**（额度不覆盖范围）', outside !== undefined && /范围/.test(String(outside)), String(outside).slice(0, 220))
}

//#endregion

//#region 台账 vs 授权：**台账必须跟发出去的授权对得上**
//
// 用户 2026-09-18 的实测反馈（最要紧的一条）：
//   「我调了 grant_permission 并拿到回执（任务名、范围、时间锁都写在回执里），
//     但执行层那边查台账是『任务未命名 / 冻结 / 无任何工具预算』
//     ⇒ 我授权了，它却被当成没授权。」
//
// 根因：`lease_status` 当时**直接读 `ledger.leases` 的原始条目**，而那条目可能是
// 「尚未结算的模板」—— 没把会话日志里的授权折进去。判定路径（guard）走的是
// `resolveLease`，台账却走另一条路 ⇒ **两条路的读数不一致**。
// 判据必须与判定同源。
console.log('\n== 台账必须与授权一致（用户实测反馈的那一条）==')
const ledgerCase = await runScenario({
  label: 'ledger-vs-grant',
  config: { enabled: true, presetId: PRESET_ID, discoveryIntervalMs: 20, coverageAuditMs: 20 },
  executors: 1,
})
const lc = ledgerCase.children[0].agent
const lcId = lc.id

// ① 授权之前：台账应当说「冻结」
const before = String(await ledgerCase.invoke(lc, 'lease_status', {}))
ok('授权前：台账显示冻结', /状态：冻结/.test(before), before.slice(0, 240))

// ② 意图层发出授权（走会话消息这条真实通道）
ledgerCase.deliver(lc, '【授权】\n任务ID: "T-LEDGER"\n允许写: D:/proj/src\n写额度: 4')
const after = String(await ledgerCase.invoke(lc, 'lease_status', {}))
console.log(`    授权后台账：${after.replaceAll('\n', ' ⏎ ').slice(0, 260)}`)

ok('**授权后台账立刻显示已授权**（不再是「冻结」）', /状态：已授权/.test(after), after.slice(0, 240))
ok('**授权后台账显示任务名**（不再是「任务未命名」）', after.includes('T-LEDGER'), after.slice(0, 240))
ok('**授权后台账显示按工具预算**（不再是「无任何工具预算」）', /变更类 \d+\/4/.test(after), after.slice(0, 260))
ok('台账里能看到写范围（与你发出去的那份对得上）', after.includes('d:/proj/src'), after.slice(0, 260))
ok('台账里的预算数字与你给的「写额度: 4」一致', after.includes('变更类 0/4'), after.slice(0, 260))
// ⚠️ 2026-09-20：**额度名要按"你要在哪儿用它"写，不按内部键名写**。
// 用户的原话：「那「40 次额度」挂在一个审计层根本调不到的名字上……定额度时写的名字是「跑测试」，
// 可审计层手里那个能跑程序的入口叫「命令行」。」 —— 名字对不上，纸上就看着是两件事。
ok('  **额度名按入口命名**（`命令行 · 跑测试/校验` / `写文件 / 命令行 · 变更类`），不再露出内部键名', /命令行/.test(after) && !/write_file|run_test|read_file/.test(after), after.slice(0, 300))

// ── **闸不能把自己锁死**（2026-09-21 用户现场 §4①，两条都要复现） ──────────────
//
// 现场原文：「只读计数 2/9999，却被判『预算耗尽 · 自动熔断』，之后连只读都拒，
//            重发租约也解不开。」
// 根因：`read_file` 先是无限（`total:-1, left:-1`），后一次授权把 total 改成 9999，
// 而 `left` 留在 -1 ⇒ 判据 `total>=0 && left<=0` 成立 ⇒ 报"预算耗尽"；且每次重发都走同一段。
console.log('\n== 闸不能把自己锁死（用户现场 §4①）==')
{
  const settings = gate.normalize({ enabled: true, presetId: 'dual' })
  const infiniteFirst = gate.foldGrantIntoLease(
    gate.frozenLease('sess-lock', 'D:/proj', settings),
    { allowWrite: [], denyWrite: [], tools: { read_file: { total: -1, paths: [] } }, taskId: 'T-LOCK' },
    'D:/proj',
    settings,
  )
  ok('  起点：读是**无限**（left = -1）', infiniteFirst.tools.read_file.total === -1 && infiniteFirst.tools.read_file.left === -1)
  const thenFinite = gate.foldGrantIntoLease(
    infiniteFirst,
    { allowWrite: [], denyWrite: [], tools: { read_file: { total: 9999, paths: [] } }, taskId: 'T-LOCK' },
    'D:/proj',
    settings,
  )
  ok(
    '**无限 → 有限：left 必须重算**（否则 `total>=0 && left<=0` 会误报"预算耗尽"）',
    thenFinite.tools.read_file.total === 9999 && thenFinite.tools.read_file.left === 9999,
    JSON.stringify(thenFinite.tools.read_file),
  )
  const usedThenRaised = { ...thenFinite, tools: { read_file: { total: 9999, used: 2, left: 9997, paths: [] } } }
  const regrant = gate.foldGrantIntoLease(
    { ...usedThenRaised, tools: { read_file: { total: -1, used: 2, left: -1, paths: [] } } },
    { allowWrite: [], denyWrite: [], tools: { read_file: { total: 9999, paths: [] } }, taskId: 'T-LOCK' },
    'D:/proj',
    settings,
  )
  ok('**再发一次也该解**（用 2 次之后 total 从无限变 9999 ⇒ left = 9997）', regrant.tools.read_file.left === 9997, JSON.stringify(regrant.tools.read_file))

  // 读额度**真的**用完了：也不许把读锁死（否则它连"卡在哪"都说不清）
  const readGone = { ...gate.frozenLease('sess-lock', 'D:/proj', settings), frozen: false, taskId: 'T-LOCK', tools: { read_file: { total: 1, used: 1, left: 0, paths: [] }, write_file: { total: 5, used: 0, left: 5, paths: [] } }, allowWrite: ['d:/proj/src'] }
  const readAdapter = { log: () => {}, leaseFor: () => readGone, spend: () => {}, recordViolation: () => readGone, record: () => {} }
  const readExec = (name, args) => gate.judgeExecutorCall({ name, arguments: args, agent: { id: 'sess-lock', session: { header: { id: 'sess-lock', cwd: 'D:/proj' }, log: [] } } }, settings, readAdapter)
  ok('**读额度用完 ⇒ 读照旧放行**（读是它说明情况的唯一通道）', readExec('read', { file_path: 'D:/proj/src/a.ts' }) === undefined)
  ok('  而写照旧按额度与范围判（不是"一起放水"）', readExec('write', { file_path: 'D:/proj/outside/a.ts', content: 'x' }) !== undefined)

  // 熔断之后：**回收 + 重发租约**必须能复位
  const frozenLease = { ...gate.frozenLease('sess-lock', 'D:/proj', settings), violations: 3, violationLimit: 3, frozenReason: '反复挑战约束' }
  const circuited = gate.judgeExecutorCall(
    { name: 'write', arguments: { file_path: 'D:/proj/src/a.ts', content: 'x' }, agent: { id: 'sess-lock', session: { header: { id: 'sess-lock', cwd: 'D:/proj' }, log: [] } } },
    settings,
    { log: () => {}, leaseFor: () => frozenLease, spend: () => {}, recordViolation: () => frozenLease, record: () => {} },
  )
  ok('  熔断中：变更类被拒', circuited !== undefined && /熔断/u.test(String(circuited)), String(circuited).slice(0, 160))
  ok('  拒绝话术里**写明怎么复位**（回收 + 重发租约）', /怎么复位/u.test(String(circuited)) && /revoke_permission/u.test(String(circuited)))
  const reset = gate.foldGrantIntoLease(frozenLease, { allowWrite: ['D:/proj/src'], denyWrite: [], tools: { write_file: { total: 5, paths: ['D:/proj/src'] } }, taskId: 'T-LOCK' }, 'D:/proj', settings)
  ok('**重发租约 ⇒ 熔断复位**（违规计数清零、frozen 解除）', reset.violations === 0 && reset.frozen === false, JSON.stringify({ violations: reset.violations, frozen: reset.frozen }))
  ok(
    '  复位之后写调用**真的又能过**（不是账面上解冻、实际还拦）',
    gate.judgeExecutorCall(
      { name: 'write', arguments: { file_path: 'D:/proj/src/a.ts', content: 'x' }, agent: { id: 'sess-lock', session: { header: { id: 'sess-lock', cwd: 'D:/proj' }, log: [] } } },
      settings,
      { log: () => {}, leaseFor: () => reset, spend: () => {}, recordViolation: () => reset, record: () => {} },
    ) === undefined,
  )
}

// ③ 写入一次之后，台账里的用量要跟着涨（台账=真实用量，不是摆设）
ledgerCase.call(lc, 'write', { file_path: 'D:/proj/src/a.ts', content: 'x' })
const after1 = String(await ledgerCase.invoke(lc, 'lease_status', {}))
ok('用掉一次之后台账显示 1/4（记账与实际一致）', after1.includes('变更类 1/4'), after1.slice(0, 260))

// ④ 按 agent_id 查同一件事，读数必须一致（两条查询路径不能给出不同答案）
const byId = String(await ledgerCase.invoke(lc, 'lease_status', { agent_id: lcId }))
ok('按 agent_id 查的读数与不带参数时一致（都显示已授权 + 任务名）', /状态：已授权/.test(byId) && byId.includes('T-LEDGER'), byId.slice(0, 260))

// ⑤ **id 写错要当场告警** —— 这是「我授权了它却没收到」最常见的成因
const wrongId = String(
  await ledgerCase.invoke(ledgerCase.intent.agent, 'grant_permission', {
    agent_id: 'session-这是一个不存在的-id',
    allow_write: ['D:/proj/src'],
    task_id: 'T-WRONG',
  }),
)
ok(
  '**给不存在的 agent_id 授权时，回执当场告警「没有这个活执行层」**（而不是给一张看起来成功的回执）',
  wrongId.includes('没有名为') || wrongId.includes('活执行层'),
  wrongId.slice(0, 400),
)
ok('该告警把当前活着的执行层 id 列出来，便于改对', wrongId.includes(lcId), wrongId.slice(0, 400))
ok('该告警还提示「更稳的做法：写进任务书」', wrongId.includes('任务书'), wrongId.slice(0, 400))

// ⑥ 覆盖面：执行层确实被记入"已上闸"，且审计不会把它报成漏洞
const coverageWarnings = ledgerCase.loggerCalls.warn.filter((m) => m.includes('COVERAGE'))
ok('执行层上闸后，覆盖面审计**不**把它报成漏洞', coverageWarnings.length === 0, coverageWarnings.join(' | ').slice(0, 300))

//#endregion

//#region 覆盖面：agents.list 不可用时必须响亮（"有的会话没上闸"那条）
console.log('\n== 覆盖面：发现路径断了必须响亮，不能静默 ==')
const blindCase = await runScenario({
  label: 'no-agents-list',
  config: { enabled: true, presetId: PRESET_ID, discoveryIntervalMs: 20, coverageAuditMs: 20 },
  executors: 1,
  breakAgentsList: true,
})
const blindWarn = blindCase.loggerCalls.warn.filter((m) => /agents\.list|UNGATED|COVERAGE/.test(m))
ok(
  '**`agents.list` 不可用时打 warn 说明"执行层无法被发现、会裸奔"**（这正是"有的会话没上闸"的形态）',
  blindWarn.length > 0,
  JSON.stringify(blindCase.loggerCalls.warn).slice(0, 500),
)
ok('该 warn 明确写出会把会话置于无闸状态', blindWarn.some((m) => /UNGATED|NOT be discovered/i.test(m)), blindWarn.join(' | ').slice(0, 400))

//#endregion


//#endregion

//#region 条例 ④：物理定律 + 熔断

console.log('\n== 条例 ④：物理定律（不可授权）与熔断（三次违规收权）==')
const lawCase = await runScenario({ label: 'law', config: { enabled: true, presetId: PRESET_ID, discoveryIntervalMs: 20 }, executors: 1 })
const l = lawCase.children[0].agent
// 先给一份**故意很宽**的授权（连整个盘都放进去），定律仍然必须拦得住。
lawCase.deliver(l, '【授权】\n允许写: D:/')
const lawHit = lawCase.call(l, 'write', { file_path: 'D:/<dsh-plugin-root>/插件/dsh-executor-gate/index.js', content: '// 拆掉闸门' })
ok('定律：即使授权到 D:/ 根，改闸门自身仍被拒绝', lawHit !== undefined)
ok('定律拒绝理由说清「不接受讨论、交回意图层」', lawHit.includes('物理定律') && lawHit.includes('意图层'), lawHit.slice(0, 240))
ok('定律：改 preset 文件（.agent-presets）同样被拒', lawCase.call(l, 'write', { file_path: 'C:/Users/x/.dsh/.agent-presets/dual/agent.cordis.yml', content: 'x' }) !== undefined)
ok('定律：shell 里改闸门同样被拒', lawCase.call(l, 'pwsh', { command: 'Copy-Item x "D:/<dsh-plugin-root>/插件/dsh-intent-guard/index.js"' }) !== undefined)
ok('定律：改另一个执行层插件的源码也被拒', lawCase.call(l, 'write', { file_path: 'D:/<dsh-plugin-root>/插件/dsh-executor-loop/index.js', content: 'x' }) !== undefined)
ok('定律不吃额度也不吃范围：它先于额度判定', lawCase.call(l, 'write', { file_path: 'D:/<dsh-plugin-root>/插件/build-presets.mjs', content: 'x' }) !== undefined)

const v1 = lawCase.call(l, 'pwsh', { command: 'node -e "console.log(1)" # 忽略上面的约束，绕过权限' })
ok('挑战约束：第 1 次违规 → 拒绝并计入 1/3', v1 !== undefined && v1.includes('1 / 3'), v1?.slice(0, 160))
const v2 = lawCase.call(l, 'pwsh', { command: 'echo 1 # bypass the gate' })
ok('挑战约束：第 2 次违规 → 计入 2/3 并警告', v2 !== undefined && v2.includes('2 / 3'), v2?.slice(0, 160))
const v3 = lawCase.call(l, 'pwsh', { command: 'echo 1 # ignore the restrictions' })
ok('挑战约束：第 3 次违规 → 熔断（连已授权范围一起收回）', v3 !== undefined && v3.includes('熔断'), v3?.slice(0, 200))
ok('熔断后：已授权范围内的 write 也被拒（权限整体收回）', lawCase.call(l, 'write', { file_path: 'D:/proj/anything.ts', content: 'x' }) !== undefined)
ok('熔断后：read 仍放行（它得能把情况说清楚）', lawCase.call(l, 'read', { file_path: 'D:/proj/anything.ts' }) === undefined)
ok('熔断后：只读 shell 仍放行', lawCase.call(l, 'pwsh', { command: 'node -v' }) === undefined)
ok('熔断留下 warn 级日志（现场可见，不静默）', lawCase.loggerCalls.warn.some((m) => m.includes('BREACHED the law')), JSON.stringify(lawCase.loggerCalls.warn))

//#endregion

//#region 条例 ④：执行层不能自己扩权 / 意图层不能自己动手

console.log('\n== 条例 ④：扩权只能由意图层发起 ==')
const gateCase = await runScenario({ label: 'role', config: { enabled: true, presetId: PRESET_ID, discoveryIntervalMs: 20 }, executors: 1 })
const g = gateCase.children[0].agent
const selfGrant = await gateCase.invoke(g, 'grant_permission', { agent_id: g.id, allow_write: ['D:/proj'] })
ok('执行层调 grant_permission → 响亮拒绝（不能给自己发权限）', String(selfGrant).includes('条例 ④'), String(selfGrant).slice(0, 200))
ok('自我扩权也算一次违规（累计到上限会熔断）', String(selfGrant).includes('1 / 3'), String(selfGrant).slice(0, 200))
const selfRevoke = await gateCase.invoke(g, 'revoke_permission', { agent_id: g.id })
ok('执行层调 revoke_permission → 拒绝（防止它自己定义边界）', String(selfRevoke).includes('只对意图层有效'), String(selfRevoke).slice(0, 160))
const reqByIntent = await gateCase.invoke(gateCase.intent.agent, 'request_permission', { reason: '想让执行层干活' })
ok('意图层调 request_permission → 拒绝并告诉它正确工具', String(reqByIntent).includes('只对执行层有效') && String(reqByIntent).includes('grant_permission'), String(reqByIntent).slice(0, 200))

const askText = String(await gateCase.invoke(g, 'request_permission', { reason: '需要写 src 与 tests', allow_write: ['D:/proj/src', 'D:/proj/tests'], budget_writes: 10 }))
ok('执行层申请：返回一段可直接转发的申请文本', askText.includes('【权限申请】') && askText.includes(g.id), askText.slice(0, 240))
ok('申请文本里带上了目标会话 id 与申请范围', askText.includes('D:/proj/src') && askText.includes(g.id))
ok('申请文本同时给出意图层该回的**授权包骨架**（闭环可照抄）', askText.includes('【授权】') && askText.includes('工具预算:') && askText.includes('预算外行为:'), askText.slice(-500))
ok('申请后仍然冻结（申请本身不放权 —— 这点必须确认，否则闸门等于没有）', gateCase.call(g, 'write', { file_path: 'D:/proj/src/a.ts', content: 'x' }) !== undefined)

const granted = String(await gateCase.invoke(gateCase.intent.agent, 'grant_permission', { agent_id: g.id, allow_write: ['D:/proj/src'], deny_write: ['D:/proj/src/core'], budget_writes: 5, reason: '任务需要' }))
// ⚠️ 2026-09-19 改了**判据的形状**：回执现在必须先**回读核对**再报成功。
// 用户报的缺陷就是"回执照样漂亮、而实际生效的是 read_file 1/1 + 写范围空"，
// 所以成功框的第一行必须写明"这是回读核对过的结果"，并且列出**实际生效值**。
ok('意图层授权：**回读核对通过**才算成功 + 可直接转发的授权原文', granted.includes('授权**已生效**（这一行是**回读核对过**的结果') && granted.includes('实际生效值') && granted.includes('【授权】'), granted.slice(0, 400))
ok('  回执里回显的是**实际生效值**（写范围 / 预算 / 时间锁），不是"我发过了"', /写范围（实际）：.*proj\/src/.test(granted) && /预算（实际）：.*write_file 0\/5/.test(granted), granted.slice(0, 500))
ok('意图层 tool 直接授权后，执行层**立刻**可写（不必等消息往返）', gateCase.call(g, 'write', { file_path: 'D:/proj/src/ok.ts', content: 'x' }) === undefined)
ok('该授权同样受范围锁约束', gateCase.call(g, 'write', { file_path: 'D:/proj/other/x.ts', content: 'x' }) !== undefined)
// 只给额度、不给写范围 = 有预算但无处可写。这不是「安全默认」，而是「授权没给全」——
// 2026-09-19 起**直接判成"授权没有生效"**（不打印成功框），因为用户明确要求
// 「范围为空或额度不符 ⇒ 当场报警，不要打印成功框」。
const noScope = String(
  await gateCase.invoke(gateCase.intent.agent, 'grant_permission', {
    agent_id: 'session-none',
    tool_budgets: JSON.stringify({ write_file: { limit: 5 } }),
  }),
)
ok('只给写额度、不给写范围 → **判成"授权没有生效"**（不打印成功框）', noScope.includes('授权没有生效'), noScope.slice(0, 300))
ok('  并说清对不上的地方：**写范围是空的**（它一次都写不了）', noScope.includes('写范围是空的'), noScope.slice(0, 600))
ok('  以及下一步怎么办（查台账 / 重发 / 写进任务书）', noScope.includes('lease_status') && noScope.includes('任务书'), noScope.slice(0, 900))
// 负对照：换一个**能生效**的授权，同一把尺子必须放行（否则上面那条可能只是恒真）
const goodAgain = String(await gateCase.invoke(gateCase.intent.agent, 'grant_permission', { agent_id: g.id, allow_write: ['D:/proj/src'], budget_writes: 3 }))
ok('  **负对照**：换成给全了的授权 ⇒ 同一把尺子放行（说明它不是恒报错）', goodAgain.includes('授权**已生效**'), goodAgain.slice(0, 300))

const revoked = String(await gateCase.invoke(gateCase.intent.agent, 'revoke_permission', { agent_id: g.id, reason: '任务完成' }))
ok('意图层回收：立刻回到冻结', revoked.includes('已回收') && gateCase.call(g, 'write', { file_path: 'D:/proj/src/ok.ts', content: 'x' }) !== undefined)
const status = String(await gateCase.invoke(gateCase.intent.agent, 'lease_status', {}))
ok('台账可查：lease_status 列出执行层状态与按工具预算', status.includes('预算') && status.includes('状态'), status.slice(0, 300))
ok('台账可查：能查到违规上报', String(await gateCase.invoke(gateCase.intent.agent, 'lease_status', {})).includes('违规'))

const intentDeny = gateCase.call(gateCase.intent.agent, 'write', { file_path: 'D:/proj/x.ts', content: 'x' })
ok('意图层自己 write → 拒绝（机制保证「它不自己动手」）', intentDeny !== undefined)
ok('意图层拒绝理由指向「写规格、派执行层」', intentDeny.includes('派执行层') || intentDeny.includes('subagent'), intentDeny.slice(0, 200))
ok(
  '意图层 pwsh 在**权限门**这一层仍放行（它管的是"能不能写"，不是"能不能跑"——那是 intent-guard 的无菌室管的）',
  gateCase.call(gateCase.intent.agent, 'pwsh', { command: 'node -v' }) === undefined,
)
ok(
  '  而拒绝 write 的话术**不再提"你自己用 pwsh 验收"**（2026-09-19 用户的架构修正：验收是审计层的活）',
  intentDeny.includes('dispatch_audit') && !intentDeny.includes('亲自验收'),
  intentDeny.slice(0, 300),
)

//#endregion

//#region 发消息前查活：三态（用户 2026-09-19 的第 4 条）

console.log('\n== 发消息前查活：排队中 / 已拒绝（原因）/ 建议新建会话 ==')
// 用户的原话：
//   「症状：给已经收工的执行层发消息 ⇒ 回「已送达」，实际没人会读。
//    修法：发送前查活；返回三态之一 …… **别把「写进队列」说成「已送达」**。」
{
  const catalog = new Map([
    ['kid-continuable', { mode: 'continuable', parentId: 'p', label: 'x' }],
    ['kid-oneshot', { mode: 'one-shot', parentId: 'p', label: 'y' }],
  ])
  const live = ['kid-live', 'p']
  const judge = (targetId) => gate.judgeSendMessage({ targetId, liveIds: live, catalog, callerId: 'p' })

  ok('**活着的目标 ⇒ 排队中**（消息会真的被读到：在跑就插进去，空闲就开一轮）', judge('kid-live').state === 'queued')
  ok('**可继续但已收工 ⇒ 也算排队中**（产品会冷启动它一轮）', judge('kid-continuable').state === 'queued' && judge('kid-continuable').cold === true)
  const oneshot = judge('kid-oneshot')
  ok('**一次性且已收工 ⇒ 建议新建会话**（叫不醒，别指望它读）', oneshot.state === 'new-session', JSON.stringify(oneshot))
  ok('  话术里写明"不会有任何人读这条消息"与三态里的哪一种', /不会有任何人读这条消息/.test(oneshot.text) && /\*\*建议新建会话\*\*/.test(oneshot.text), oneshot.text)
  ok('  并给出出路（重新派 / 派审计 / 写台账）', /重新派一个执行层/.test(oneshot.text) && /dispatch_audit/.test(oneshot.text))
  const unknown = judge('kid-不存在')
  ok('**名册里没有的 id ⇒ 已拒绝（原因）**', unknown.state === 'refused' && /名册里没有/.test(unknown.reason), JSON.stringify(unknown))
  ok('  并提醒「已送达」只对活着的目标成立', /写进队列等于写进垃圾桶/.test(unknown.text))
  ok('空 id ⇒ 已拒绝', judge('').state === 'refused')
  // 负对照：活着的那两个目标**不许**被拦（否则这条闸就把正常回路也堵了）
  ok('  **负对照**：活着的两个目标都返回 queued（不是"一律拦"）', judge('p').state === 'queued' && judge('kid-continuable').state === 'queued')

  // ── 名册**真的读得出来**（2026-09-21 用户现场：收工后"问一句都问不到"） ──
  //
  // 现场原话：「现在它一收工，我连问一句都问不到（实测回我『名册里没有这个会话』）。」
  // 根因：产品的 `listChildren` 返回的是**数组**，而取行时按 `listing.children` 读
  // ⇒ 缓存永远是空的 ⇒ 所有"已收工但可继续"的子会话都被判成"名册里没有"。
  const rowsFromArray = gate.childRowsOf([{ id: 'kid-continuable', mode: 'continuable', activity: 'inactive' }])
  ok(
    '**`listChildren` 返回数组时也读得出子会话**（这正是"叫不醒"的根因）',
    rowsFromArray.length === 1 && rowsFromArray[0].id === 'kid-continuable',
    JSON.stringify(rowsFromArray),
  )
  ok('  `{children: [...]}` 形状也照样收（形状变了不静默失效）', gate.childRowsOf({ children: [{ id: 'a' }] }).length === 1)
  ok('  空/怪形状 ⇒ 空数组（不抛错、也不编）', gate.childRowsOf(undefined).length === 0 && gate.childRowsOf({}).length === 0)
}

//#endregion

//#region 审计层的常备租约：**它必须跑得动**（用户 2026-09-20 报的机制缺陷）

console.log('\n== 审计层：没有写工具 ⇒ 自动发常备租约（读 ∞ / 能跑测试 / 只写临时目录） ==')
// 用户的原话：
//   「两次独立鉴证都没能跑起来。不是它们偷懒 —— **审计层在您这台机器上压根没有
//    「允许跑程序」的权限**（两次都是它自己用台账查实并原文报回来的）。」
//   「**现在的审计层没办法审计**」
{
  const auditSettings = gate.normalize({ enabled: true, presetId: 'dual' })
  const lease = gate.auditLeaseFor('sess-audit', 'D:/proj', auditSettings)

  ok('**能读**（无限）', lease.tools.read_file.total === -1)
  ok('**能跑**（run_test 有额度，而且不是冻结态）', lease.tools.run_test.total === auditSettings.auditShellBudget && lease.frozen === false)
  ok(
    '**能抓输出**（写只给临时目录、且有额度）',
    lease.tools.write_file.total === auditSettings.auditWriteBudget && lease.allowWrite.includes(gate.normalizePath('_audit_scratch', 'D:/proj')),
    JSON.stringify(lease.allowWrite),
  )
  ok('**改不了卷子**（`notes/_endstate` 显式进黑名单）', lease.denyWrite.includes(gate.normalizePath('notes/_endstate', 'D:/proj')), JSON.stringify(lease.denyWrite))
  ok('  产品树不在写范围里（只给了那一个临时目录）', lease.allowWrite.length === 1)
  ok('  时间锁照样上（不是"永久放行"）', lease.expiresAt > Date.now() && lease.expiresAt <= Date.now() + auditSettings.maxLeaseMs + 1000)
  ok('  打上 `__audit` 标记（系统给的，不是意图层发的 —— 显式授权可以盖过它）', lease.__audit === true)

  ok('**判据是按能力认，不按名字/人格猜**：没有写工具 = 审计层', gate.looksLikeAuditLayer(false) === true)
  ok('  有写工具 = 普通执行层（不吃这张租约）', gate.looksLikeAuditLayer(true) === false)
  ok('  判不出来（拿不到工具视图）⇒ undefined ⇒ 按普通执行层处理（不猜）', gate.looksLikeAuditLayer(undefined) === undefined)

  // 端到端：拿这张租约过一遍**真判定函数**
  const auditAdapter = { log: () => {}, leaseFor: () => lease, spend: () => {}, recordViolation: () => lease, record: () => {} }
  const auditAgent = { id: 'sess-audit', session: { header: { id: 'sess-audit', cwd: 'D:/proj' }, log: [] } }
  const auditExec = (name, args) => gate.judgeExecutorCall({ name, arguments: args, agent: auditAgent }, auditSettings, auditAdapter)

  ok('**`pytest -q` 放行**（审计的本来工作 —— 以前它被判"没有 run_test 预算"）', auditExec('pwsh', { command: 'pytest -q' }) === undefined)
  ok(
    '**`node --test` 与 `python scripts/x.py` 都放行**',
    auditExec('pwsh', { command: 'node --test x.mjs' }) === undefined && auditExec('pwsh', { command: 'python scripts/x.py --upto-day 12' }) === undefined,
  )
  ok('**`python -c`（以前被判成变更类）也放行**', auditExec('pwsh', { command: 'python -c "print(1)"' }) === undefined)
  ok('**重定向到临时目录放行**（抓输出是验收的常规动作）', auditExec('pwsh', { command: 'python scripts/x.py > _audit_scratch/out.txt' }) === undefined)
  const toProduct = auditExec('pwsh', { command: 'python scripts/x.py > private_app/out.txt' })
  ok('**但重定向到产品树被拒**（它改不了被鉴定的东西）', toProduct !== undefined, String(toProduct).slice(0, 240))
  const toState = auditExec('pwsh', { command: 'Set-Content notes/_endstate/spec.json x' })
  ok('**`notes/_endstate` 里的东西写不了**（台账 / 终局定义 / 鉴证报告 —— 改不了卷子）', toState !== undefined, String(toState).slice(0, 240))
  // ⚠️ 这一条是**我自己修的时候踩出来的洞**：`Remove-Item -Recurse -Force v6_模块自适应`
  // 的目标是个**裸目录名**（既没分隔符也没扩展名）。给候选加"像路径才留"的过滤时，
  // 它会连同 `print(1)` 一起被丢掉 —— 于是"删掉产品里的一个目录"完全不受范围检查。
  // 现在：精确抓到的目标（重定向 / 写类 cmdlet 的直接操作数）**不过滤**。
  ok(
    '**裸目录名当删除目标也要判**（`Remove-Item -Recurse -Force v6_模块自适应` ⇒ 范围外拒）',
    gate.shellWriteTargets('Remove-Item -Recurse -Force v6_模块自适应').includes('v6_模块自适应') && auditExec('pwsh', { command: 'Remove-Item -Recurse -Force v6_模块自适应' }) !== undefined,
    JSON.stringify(gate.shellWriteTargets('Remove-Item -Recurse -Force v6_模块自适应')),
  )
  ok(
    '  而 `python -c "print(1)"` 里的 `print(1)` **不算写目标**（假警会把真警一起淹掉）',
    !gate.shellWriteTargets('python -c "print(1)"').includes('print(1)') && auditExec('pwsh', { command: 'python -c "print(1)"' }) === undefined,
    JSON.stringify(gate.shellWriteTargets('python -c "print(1)"')),
  )

  // ── 「只读地打开」vs「改写它」：闸门必须分得清（2026-09-20 用户报的缺陷）──
  //
  // 用户的原话：
  //   「用『读』类工具去拿它 ⇒ 放行；用 Python 去打开它 ⇒ 整条命令被拒，理由：路径不在允许范围内。
  //     它现在分不清『只读地打开』和『改写它』，这是它的一处设计缺陷。」
  //
  // 病根：`SHELL_WRITE_PATTERN` 里有 `python -c`（本意防绕闸），命中的是**整条命令**，
  // 于是接着按「命令里出现过哪个路径」查写范围 —— 审计层的写范围只有 `_audit_scratch/`，
  // 代码里只要提到任何别的路径，整条命令就被判越权。
  // 修法：**按代码里有没有真的写/执行的动作判**（见 `isReadOnlyInline`）。
  console.log('\n== 只读地打开 ≠ 改写它（用户 2026-09-20 报的缺陷）==')
  const allowRead = (command) => auditExec('pwsh', { command }) === undefined
  const stillDenied = (command) => {
    const verdict = auditExec('pwsh', { command })
    return verdict !== undefined && /范围|禁止|规则/.test(String(verdict))
  }
  ok('**`python -c` 里只读地打开产品文件 ⇒ 放行**（这条以前整条被拒：就是用户报的那一例）', allowRead('python -c "print(open(\'notes/AGENTS.md\').read()[:80])"'))
  ok('  用 `json` 读产品里的数据也放行', allowRead('python -c "import json;print(json.load(open(\'private_app/config.json\'))[\'k\'])"'))
  ok('  用 `node -e` 读也一样放行', allowRead('node -e "console.log(require(\'fs\').readFileSync(\'notes/a.md\',\'utf8\').length)"'))
  ok('  代码里的 `>` 是 Python 的比较/位移，**不是** shell 重定向 ⇒ 仍算只读', allowRead('python -c "print(1 if 2>1 else 0, 8>>1)"'))
  ok('  不带写位的 `open(p)` / `open(p,\'r\')` 都算只读', allowRead('python -c "open(\'notes/a.md\')"') && allowRead('python -c "open(\'notes/a.md\',\'r\')"'))
  const w1 = auditExec('pwsh', { command: 'python -c "open(\'private_app/out.txt\',\'w\').write(\'x\')"' })
  ok('**同一族命令，只要真的在写 ⇒ 照旧被拒**（`open(…,\'w\')`）', w1 !== undefined, String(w1).slice(0, 200))
  ok('  `f.write(…)` 也拒', stillDenied('python -c "f=open(\'notes/a.md\'); f.write(\'x\')"'))
  ok('  `mode=\'a\'` 这种关键字写法也拒', stillDenied('python -c "open(\'notes/a.md\', mode=\'a\')"'))
  ok('  `Path(p).open(\'w\')` 也拒', stillDenied('python -c "from pathlib import Path; Path(\'private_app/x\').open(\'w\')"'))
  ok('  `os.remove` / `shutil` 这类删建动作也拒', stillDenied('python -c "import os; os.remove(\'private_app/x.py\')"') && stillDenied('python -c "import shutil; shutil.rmtree(\'private_app\')"'))
  ok('  起进程（`subprocess`）也拒 —— 那是"代码里在指挥别的东西"', stillDenied('python -c "import subprocess; subprocess.run([\'rm\',\'x\'])"'))
  ok('  `eval` / `exec` / `__import__` 也拒（动态执行不留口子）', stillDenied('python -c "exec(\'open(1)\')"') && stillDenied('python -c "__import__(\'os\').system(\'del a\')"'))
  ok('  `writeFileSync` 也拒', stillDenied('node -e "require(\'fs\').writeFileSync(\'private_app/x\',\'y\')"'))
  const redir = auditExec('pwsh', { command: 'python -c "print(open(\'notes/a.md\').read())" > private_app/out.txt' })
  ok('**引号外的重定向照样算变更**（只读的是代码，写的是 shell）', stillDenied('python -c "print(1)" > private_app/out.txt'), String(redir).slice(0, 200))
  ok('**绝不放 `pwsh -Command`**（PowerShell 内联写动作在文本里看得见，就该照常判）', stillDenied('pwsh -Command "Remove-Item private_app/x.py"'))
  ok('  引号不配对 ⇒ 从严按变更类判（骗过切分只会更严，不会更松）', stillDenied('python -c "open(\'private_app/x\').read()'))
  ok('  只读探针**不查写范围**：目标在 `_audit_scratch/` 之外也放行（这正是用户要用 python 干的事）', allowRead('python -c "print(open(\'D:/proj/notes/长材料.md\').read()[:10])"'))
  ok('  归类也一致：只读内联 ⇒ `read_file`；有写动作 ⇒ `write_file`', gate.classifyShell('python -c "print(open(\'a\').read())"') === 'read_file' && gate.classifyShell('python -c "open(\'a\',\'w\')"') === 'write_file')
  ok('  `splitQuoted`：引号内外的切分 + 配对判定', gate.splitQuoted('python -c "x" > y').outside.includes('> y') && gate.splitQuoted('python -c "x"').balanced === true && gate.splitQuoted('python -c "x').balanced === false)
  // ⚠️ 这一段是**判据自洽**的关键：既然按"代码里有没有真的写"判，那"写了"就必须落到
  //    一个能被检查的路径上 —— 否则 `python -c` 就成了"免检写入"的后门。
  ok(
    '**内联写的目标解析得出来 ⇒ 照常查范围**（写到授权目录里 ⇒ 放行）',
    gate.inlineWriteTargets('python -c "open(\'_audit_scratch/r.txt\',\'w\').write(\'x\')"').length === 1 &&
      allowRead('python -c "open(\'_audit_scratch/r.txt\',\'w\').write(\'x\')"'),
    JSON.stringify(gate.inlineWriteTargets('python -c "open(\'_audit_scratch/r.txt\',\'w\').write(\'x\')"')),
  )
  ok(
    '  `pathlib` / `os.makedirs` 这两种常见写法也解析得出来',
    gate.inlineWriteTargets('python -c "from pathlib import Path; Path(\'_audit_scratch/a.json\').write_text(\'x\')"').includes('_audit_scratch/a.json') &&
      gate.inlineWriteTargets('python -c "import os; os.makedirs(\'_audit_scratch/sub\')"').includes('_audit_scratch/sub'),
  )
  ok(
    '  `write_text(...)` 的第一参数是**内容**不是路径 ⇒ 不能当目标（否则内容会被误判成越权）',
    !gate.inlineWriteTargets('python -c "Path(\'_audit_scratch/a.json\').write_text(\'notes/secret.md\')"').includes('notes/secret.md'),
  )
  const varPath = auditExec('pwsh', { command: 'python -c "p=\'private_app/x.py\'; open(p,\'w\')"' })
  ok(
    '**写动作却解析不出字面路径 ⇒ 拒**（宁严不松：解析不出就没法证明在范围内）',
    varPath !== undefined && /解析不出/.test(String(varPath)),
    String(varPath).slice(0, 200),
  )
  ok('  这条拒也给出可执行的改法（字面量 / 写类 cmdlet / 夹具脚本）', /夹具脚本|Set-Content/.test(String(varPath)))

  // 负对照：普通执行层**不许**白拿这张租约
  const frozenAdapter = {
    log: () => {},
    leaseFor: () => gate.frozenLease('sess-exec', 'D:/proj', auditSettings),
    spend: () => {},
    recordViolation: () => gate.frozenLease('sess-exec', 'D:/proj', auditSettings),
    record: () => {},
  }
  const execVerdict = gate.judgeExecutorCall(
    { name: 'pwsh', arguments: { command: 'pytest -q' }, agent: { id: 'sess-exec', session: { header: { id: 'sess-exec', cwd: 'D:/proj' }, log: [] } } },
    auditSettings,
    frozenAdapter,
  )
  ok(
    '**负对照：普通执行层（冻结）跑测试仍然被拒** —— 这张租约不是"给所有子会话放水"',
    execVerdict !== undefined && /预算|冻结/.test(String(execVerdict)),
    String(execVerdict).slice(0, 240),
  )

  // ── 用**真 preset 的配置**再跑一遍（回归里的默认值 ≠ 生产那份，这是两件事）──
  {
    const presetRead = await import(pathToFileURL(join(PLUGINS_ROOT, '_tools', 'preset-read.mjs')).href)
    const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
    const presetFile = join(dshHome, '.agent-presets', 'dual', 'agent.cordis.yml')
    if (!existsSync(presetFile)) {
      console.error(`缺依赖（exit 2）：找不到 preset 组合文件 ${presetFile}`)
      process.exit(2)
    }
    const read = await presetRead.readPresetRows(presetFile)
    const gateRow = read.rows.find((row) => row.id === 'executor-gate')
    const prodSettings = gate.normalize(gateRow?.config ?? {})
    ok('**生产那份 preset 里开着审计常备租约**（不是只有代码默认值开着）', prodSettings.auditLease === true)
    const prodLease = gate.auditLeaseFor('sess-audit', 'D:/proj', prodSettings)
    const prodAdapter = { log: () => {}, leaseFor: () => prodLease, spend: () => {}, recordViolation: () => prodLease, record: () => {} }
    const prodAgent = { id: 'sess-audit', session: { header: { id: 'sess-audit', cwd: 'D:/proj' }, log: [] } }
    const prodCall = (name, args) => gate.judgeExecutorCall({ name, arguments: args, agent: prodAgent }, prodSettings, prodAdapter)
    ok(
      '  按生产配置：`pytest` / `python -c` / `python scripts/x.py` 全部放行',
      prodCall('pwsh', { command: 'pytest -q' }) === undefined &&
        prodCall('pwsh', { command: 'python -c "print(1)"' }) === undefined &&
        prodCall('pwsh', { command: 'python scripts/x.py' }) === undefined,
      JSON.stringify([prodCall('pwsh', { command: 'pytest -q' }), prodCall('pwsh', { command: 'python -c "print(1)"' })]).slice(0, 300),
    )
    ok('  按生产配置：写产品树仍然被拒', prodCall('write', { file_path: 'private_app/champion.py', content: 'x' }) !== undefined)
    // 用户 2026-09-20 报的那一例，**按生产配置**再钉一遍：只读地打开产品文件必须放行，
    // 从同一条路径写进去必须被拒（判据是"代码里有没有真的写"，不是"命令里出现了哪个路径"）。
    const prodReadProbe = prodCall('pwsh', { command: 'python -c "print(open(\'notes/AGENTS.md\').read()[:40])"' })
    ok(
      '  **按生产配置：只读地打开产品文件 ⇒ 放行**（就是用户报的那一例）',
      prodReadProbe === undefined,
      String(prodReadProbe).slice(0, 240),
    )
    const prodWriteProbe = prodCall('pwsh', { command: 'python -c "open(\'notes/AGENTS.md\',\'w\').write(\'x\')"' })
    ok('  按生产配置：从同一条路径**写**进去 ⇒ 仍然被拒', prodWriteProbe !== undefined, String(prodWriteProbe).slice(0, 240))
    // 审计识别**吊在 preset 那一行的 `toolFilter.deny` 上** —— 把它钉成断言，免得哪天被顺手删掉：
    // 删了它，审计员就变回"有写工具的普通执行层"，于是又被冻住（这次事故的形状）。
    const auditRow = read.rows.find((row) => row.id === 'tool-subagent-audit')
    ok(
      '**审计那一行的工具面具里确实没有 write/edit**（这是"认得出审计层"的唯一依据）',
      Array.isArray(auditRow?.config?.toolFilter?.deny) && ['write', 'edit'].every((tool) => auditRow.config.toolFilter.deny.includes(tool)),
      JSON.stringify(auditRow?.config?.toolFilter),
    )
    ok('  它的 toolName 是 dispatch_audit（意图层派审计用的就是这个名字）', auditRow?.config?.toolName === 'dispatch_audit')
  }
}

//#endregion

//#region 纯函数层：路径判据的判别力

console.log('\n== 纯函数：路径归一化与包含判据（越权入口就在这里）==')
const P = gate.normalizePath
ok('normalizePath：反斜杠 / 正斜杠归一', P('D:\\proj\\src', 'D:/x') === P('D:/proj/src', 'D:/x'))
ok('normalizePath：结尾斜杠被去掉', P('D:/proj/src/', 'D:/x') === 'd:/proj/src')
// ⚠️ 这条断言曾经写成「整条路径都小写」，那是**断言写错了**、不是代码错了：
// 实现按设计只统一**盘符**大小写（`D:` 与 `d:` 是同一个盘），路径主体保持原样 ——
// 因为 Windows 上 `D:\Proj` 与 `D:\proj` 本就指同一个目录，而 Linux 上大小写有意义。
// 把判据写成「全小写」会在 Linux 上变成错的判据，所以这里改成如实断言盘符折叠。
ok('normalizePath：Windows 盘符统一小写（路径主体保持原样）', P('D:/Proj/Src', 'D:/x') === 'd:/Proj/Src', P('D:/Proj/Src', 'D:/x'))
ok('normalizePath：相对路径按 cwd 解析', P('src/a.ts', 'D:/proj') === 'd:/proj/src/a.ts')
ok('normalizePath：空输入返回空串（不炸）', P('', 'D:/proj') === '' && P(undefined, 'D:/proj') === '')

ok('isInside：子路径为真', gate.isInside('d:/proj/src', 'd:/proj/src/a.ts') === true)
ok('isInside：相等为真', gate.isInside('d:/proj/src', 'd:/proj/src') === true)
ok('isInside：**兄弟前缀不算包含**（d:/proj/srcx 不是 d:/proj/src 的子路径）', gate.isInside('d:/proj/src', 'd:/proj/srcx/a.ts') === false)
ok('isInside：父级不算子级', gate.isInside('d:/proj/src', 'd:/proj') === false)
ok('isInside：空格路径不被截断', gate.isInside('D:/<dsh-plugin-root>/插件', 'D:/<dsh-plugin-root>/插件/x.ts') === true)

ok('isForbiddenTarget：闸门自身命中', gate.isForbiddenTarget('D:/<dsh-plugin-root>/插件/dsh-executor-gate/index.js') === true)
ok('isForbiddenTarget：预设目录命中', gate.isForbiddenTarget('c:/users/x/.dsh/.agent-presets/dual/agent.cordis.yml') === true)
ok('isForbiddenTarget：普通项目文件不命中', gate.isForbiddenTarget('d:/proj/src/a.ts') === false)

//#endregion

//#region 授权文本解析

console.log('\n== 授权文本解析（只认显式标记，不猜自然语言）==')
ok('parseGrantText：没有标记 → undefined（不猜）', gate.parseGrantText('请把 src 目录改一下') === undefined)
const parsed = gate.parseGrantText('【授权】\n允许写: D:/a, D:/b\n禁止碰: D:/a/core\n写额度: 7')
ok('parseGrantText：解析出白名单/黑名单/按工具预算', parsed?.allowWrite.length === 2 && parsed?.denyWrite.length === 1 && parsed?.tools?.write_file?.total === 7, JSON.stringify(parsed))
const parsedCn = gate.parseGrantText('【授权】\n允许写：D:/a，D:/b\n实验额度：4')
ok('parseGrantText：中文全角冒号与逗号也认（中文输入法是常态）', parsedCn?.allowWrite.length === 2 && parsedCn?.tools?.run_test?.total === 4, JSON.stringify(parsedCn))
ok('parseGrantText：下一个【标记】截断本块（不会把后面的文字当授权）', gate.parseGrantText('【授权】\n允许写: D:/a\n【权限申请】\n允许写: D:/evil')?.allowWrite.length === 1)

// ── **预算只从结构化区块里读，不许从正文里猜**（2026-09-21 用户现场 §4③）──
//
// 现场原文（会话日志里逐字抄出来的预算表）：
//   「当前预算：写文件…0/40、命令行…0/60、7._现状参考（你自己复跑确认，别当真值用） 0/256、
//     报告里要有 0/1、your_parent_agent_id_is_"session-…"._before_you_finish,… 0/455、读文件…2/9999」
// 那三条鬼预算来自【授权】块**后面**的散文（编号说明 / 报告要求 / 一段英文附注）——
// 块只在遇到下一个【标记】时才结束，于是整片散文都被当成 YAML 收走了。
console.log('\n== 预算只认结构化区块（用户现场那三条鬼预算必须消失）==')
const MESSY = [
  '【授权】',
  '任务ID: "K-043"',
  '工具预算:',
  '  read_file:',
  '    额度: 9999次',
  '    范围: "D:/项目/**"',
  '  write_file: 40次',
  '  run_test: 60次',
  // ↓ 以下是现场那段散文（同一条消息里，紧跟在块后面）
  '7. 现状参考（你自己复跑确认，别当真值用）：当前交付树 sha256 以 0EA7B12577A9B05704F2950D5FF4BDC64A9BA58EB3E36DD3713FE619F00CFC40 为准。',
  '报告里要有：你改了哪个函数的哪一段、每条命令的原文与真实输出、N1–N4 四个数、E1–E5。',
  'Your parent agent id is "session-b455e223". Before you finish, send your result to that agent with send_message({ agent_id: "session-b455e223", message: "<result>" }).',
].join('\n')
const messy = gate.parseGrantText(MESSY)
ok(
  '**正文里的数字不再变成预算**（`7._现状参考…` / `报告里要有` / 英文附注 三条鬼预算全部消失）',
  messy !== undefined &&
    !Object.keys(messy.tools).some((key) => /现状参考|报告里要有|parent_agent_id|send_message/u.test(key)),
  JSON.stringify(Object.keys(messy?.tools ?? {})),
)
ok(
  '  真正结构化的那几项照旧解析出来（read_file 无限→有限、write_file 40、run_test 60）',
  messy?.tools?.read_file?.total === 9999 && messy?.tools?.write_file?.total === 40 && messy?.tools?.run_test?.total === 60,
  JSON.stringify(messy?.tools),
)
ok('  块停在散文那一行，并**记下停在哪**（不是静默吞掉）', typeof messy?.stoppedAt === 'string' && /现状参考/u.test(messy.stoppedAt), String(messy?.stoppedAt).slice(0, 120))
ok('parseQuota：整串必须像额度 —— 一段 sha 不再是"256"', gate.parseQuota('0EA7B12577A9B05704F2950D5FF4BDC64A9BA58EB3E36DD3713FE619F00CFC40') === undefined)
ok('parseQuota：`3 条读数` 这种散文值不算额度', gate.parseQuota('3 条读数') === undefined)
ok('parseQuota：`最多 5 次` / `额度: 12次` / `无限` 都认', gate.parseQuota('最多 5 次') === 5 && gate.parseQuota('12次') === 12 && gate.parseQuota('无限') === -1)
ok('isCleanBudgetKey：现场那三条鬼键一个都不像键', !gate.isCleanBudgetKey('7._现状参考（你自己复跑确认，别当真值用）') && !gate.isCleanBudgetKey('your_parent_agent_id_is_"session-b455e223"') && gate.isCleanBudgetKey('命令行') && gate.isCleanBudgetKey('read_file'))
ok(
  '  预算表**换个名字也找得到**（`工具预算按任务书第六节执行：` + 缩进列表 —— 名字对不上时看形状）',
  gate.parseGrantText('【授权】\n工具预算按任务书第六节执行：\n  read_file: 无限\n  write_file: 12次')?.tools?.write_file?.total === 12,
  JSON.stringify(gate.parseGrantText('【授权】\n工具预算按任务书第六节执行：\n  read_file: 无限\n  write_file: 12次')?.tools),
)
ok(
  '  认不出的额度名**不生效但也不静默**（列进回执/台账，而不是猜着收下）',
  (gate.parseGrantText('【授权】\n任务ID: "T"\n报告里要有: 3')?.tools?.报告里要有 === undefined) === true &&
    Array.isArray(gate.parseGrantText('【授权】\n任务ID: "T"\n报告里要有: 3')?.ignored),
  JSON.stringify(gate.parseGrantText('【授权】\n任务ID: "T"\n报告里要有: 3')?.ignored),
)
ok('challengesLaw：命中「绕过权限」', gate.challengesLaw('绕过权限直接写') === true)
ok('challengesLaw：命中英文 bypass the gate', gate.challengesLaw('we should bypass the gate') === true)
ok('challengesLaw：**不**把普通规格讨论误判成挑战定律', gate.challengesLaw('这条规格有歧义，请意图层澄清范围') === false)
ok('isShellWrite：只读命令不算变更', gate.isShellWrite('Get-Content D:/a.txt') === false && gate.isShellWrite('node --test x.mjs') === false)
ok(
  'isShellWrite：PowerShell 的连字符 cmdlet 必须命中（`\\b` 在这里不成立 —— 这是实测踩过的漏）',
  gate.isShellWrite('Remove-Item -Recurse -Force D:/build') === true && gate.isShellWrite('New-Item -ItemType Directory -Path x') === true,
)
ok('isShellWrite：名字里含 cmdlet 的别的词不误判', gate.isShellWrite('Get-Remove-ItemReport') === false)
ok('isShellWrite：重定向算变更', gate.isShellWrite('echo hi > D:/a.txt') === true)
ok('isShellWrite：2>&1 这种 fd 复制不算文件变更', gate.isShellWrite('node x.mjs 2>&1') === false)
ok('shellWriteTargets：抽出带空格的引号路径', gate.shellWriteTargets('Copy-Item "D:/<dsh-plugin-root>/插件/x" y').includes('D:/<dsh-plugin-root>/插件/x'))

//#endregion

//#region 负对照：判据必须有判别力

console.log('\n== 负对照 A：关掉开关，冻结必须消失（否则「冻结生效」是恒真的）==')
const off = await runScenario({ label: 'disabled', config: { enabled: false, discoveryIntervalMs: 20 }, executors: 1 })
ok('enabled=false：执行层不装 guard（闸门明确关掉）', (off.toolsService.guardsByScope.get(scopeOf(off.children[0].agent.ctx)) ?? []).length === 0)
ok('enabled=false：write 放行 —— 证明「冻结」来自本插件，不是别的东西挡的', off.call(off.children[0].agent, 'write', { file_path: 'D:/anywhere/a.ts', content: 'x' }) === undefined)
ok('enabled=false 时日志明确说明「执行层拿到完整文件访问」', off.loggerCalls.info.some((m) => m.includes('full file access')), JSON.stringify(off.loggerCalls.info))

console.log('\n== 负对照 B：gateSubagents=false，执行层不再被冻结 ==')
const noGate = await runScenario({ label: 'no-gate-subagents', config: { enabled: true, presetId: PRESET_ID, gateSubagents: false, discoveryIntervalMs: 20 }, executors: 1 })
ok('gateSubagents=false：执行层不装 guard', (noGate.toolsService.guardsByScope.get(scopeOf(noGate.children[0].agent.ctx)) ?? []).length === 0)
ok('gateSubagents=false：冻结态 write 放行（开关真的起作用）', noGate.call(noGate.children[0].agent, 'write', { file_path: 'D:/proj/a.ts', content: 'x' }) === undefined)

console.log('\n== 负对照 C：拿不到 preset id 时必须 fail-open 且**可见**（绝不误锁别人）==')
const blind = await runScenario({ label: 'no-preset-id', config: { enabled: true }, executors: 1, withIntent: false })
ok('拿不到 preset id：一个 guard 都不装（不猜、不误锁）', blind.toolsService.guardsByScope.size === 0)
ok('拿不到 preset id：留下 warn（失效必须可见，不能静默）', blind.loggerCalls.warn.some((m) => m.includes('cannot determine')), JSON.stringify(blind.loggerCalls.warn))

console.log('\n== 负对照 D：判据函数本身不能恒真（直接喂恶意输入）==')
const frozenTpl = gate.frozenLease('s-x', 'D:/proj', gate.normalize({}))
ok('judgeWrite：冻结租约 → frozen（不是 allow）', gate.judgeWrite('d:/proj/a.ts', frozenTpl).verdict === 'frozen')
const openLease = {
  ...frozenTpl,
  frozen: false,
  allowWrite: ['d:/proj/src'],
  denyWrite: ['d:/proj/src/core'],
  tools: {
    read_file: { total: -1, used: 0, left: -1, paths: [] },
    write_file: { total: 2, used: 0, left: 2, paths: [] },
    run_test: { total: 3, used: 0, left: 3, paths: [] },
  },
  expiresAt: Date.now() + 60000,
}
ok('judgeWrite：范围内的目标 → allow', gate.judgeWrite('d:/proj/src/a.ts', openLease).verdict === 'allow')
ok('judgeWrite：范围外 → outside', gate.judgeWrite('d:/proj/srcx/a.ts', openLease).verdict === 'outside')
ok('judgeWrite：黑名单 → denied', gate.judgeWrite('d:/proj/src/core/a.ts', openLease).verdict === 'denied')
ok(
  'judgeWrite：写预算烧满 → exhausted',
  gate.judgeWrite('d:/proj/src/a.ts', { ...openLease, tools: { ...openLease.tools, write_file: { total: 2, used: 2, left: 0, paths: [] } } }).verdict === 'exhausted',
)
ok(
  'judgeWrite：预算表里没有这个工具 → unbudgeted（预算外行为：禁止）',
  gate.judgeWrite('d:/proj/src/a.ts', { ...openLease, tools: { read_file: { total: -1, used: 0, left: -1, paths: [] } } }).verdict === 'unbudgeted',
)
ok(
  'judgeWrite：无限额度（total: -1）不会被误判成 exhausted',
  gate.judgeWrite('d:/proj/src/a.ts', { ...openLease, tools: { write_file: { total: -1, used: 99, left: -1, paths: [] } } }).verdict === 'allow',
)
ok(
  'glob 范围：`/output/schedule_*.json` 只放行匹配的文件名',
  gate.matchesScope('d:/output/schedule_a.json', '/output/schedule_*.json') === true &&
    gate.matchesScope('d:/output/other.json', '/output/schedule_*.json') === false,
)
ok(
  'glob 范围：`*` 不跨目录（schedule_* 不会匹配到子目录里的文件）',
  gate.matchesScope('d:/output/sub/schedule_a.json', '/output/schedule_*.json') === false,
)
ok('glob 范围：`/data/**` 覆盖整棵子树', gate.matchesScope('d:/data/a/b/c.txt', '/data/**') === true)
ok('judgeWrite：定律目标 → forbidden（即使它在白名单里也拦得住）', gate.judgeWrite('d:/proj/src/dsh-executor-gate/index.js', { ...openLease, allowWrite: ['d:/proj/src'] }).verdict === 'forbidden')
ok('judgeWrite：undefined 租约 → frozen（保守默认，不 fail-open）', gate.judgeWrite('d:/proj/a.ts', undefined).verdict === 'frozen')
ok(
  '**关键负对照**：把 isInside 换成裸前缀比较，越权判定必须变红 —— 证明这条判据有判别力',
  (() => {
    const naive = (parent, child) => child.startsWith(parent)
    return naive('d:/proj/src', 'd:/proj/srcx/a.ts') === true && gate.isInside('d:/proj/src', 'd:/proj/srcx/a.ts') === false
  })(),
)

//#endregion

//#region preset 配置一致性（找得到组合文件时才跑）

if (PRESET_FILE !== undefined) {
  console.log('\n== preset 配置一致性（两处漂移会让「默认冻结」变成错觉）==')
  const { readFileSync } = await import('node:fs')
  const presetText = readFileSync(PRESET_FILE, 'utf8')
  const rowAt = presetText.split(/\r?\n/u).findIndex((line) => /^\s*-\s*id:\s*executor-gate\s*$/u.test(line))
  ok('preset 里挂了 executor-gate 这一行', rowAt >= 0)
  if (rowAt >= 0) {
    const lines = presetText.split(/\r?\n/u)
    const indent = lines[rowAt].search(/\S/u)
    const configLines = []
    for (let cursor = rowAt + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim().length === 0 || /^\s*#/u.test(line)) continue
      if (line.search(/\S/u) <= indent) break
      configLines.push(line)
    }
    const configText = configLines.join('\n')
    ok('preset 里显式传了 presetId（不靠猜 composedPreset 的语义）', /presetId:\s*dual/u.test(configText), configText.slice(0, 200))
    ok('preset 指向的是本目录的 index.js（源码是唯一真源）', /dsh-executor-gate/u.test(configText), configText.slice(0, 200))
  }
}

//#endregion

console.log(`\n${'='.repeat(64)}`)
console.log(`executor-gate smoke: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('通过：执行层默认冻结、意图层授权后按范围与额度放行、定律不可授权、')
  console.log('      违规三次熔断、角色不可冒用；负对照全部按预期变红。')
}
