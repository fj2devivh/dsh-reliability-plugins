/**
 * 用**真 `@deepseek-ai/dsh-tools`** 验证本插件的两件事 —— 这两件事都**只有真依赖才验得出来**：
 *
 * ## 1. 手写的四个工具定义，真 `ToolRuntime.register()` 收不收
 *
 * 本插件的四个工具是**手写 definition**（不像产品那样走 `defineTool()` 的 author DSL）。
 * 风险是：真 `register()` 拒收 → 抛错 → 而"插件在加载/应用阶段抛错会让整个窗口或会话
 * 起不来"是本项目付过学费的事故（`dsh-executor-loop` 那次手写 `Config` 直接把 DSH 打得打不开）。
 *
 * ## 2. `tools.guard()` 到不到得了真执行上
 *
 * 整个权限门的设计**全部压在一条前提上**：从 `agent.ctx` 注册的守卫只对该 agent 生效。
 * 如果它其实是全局的，那么**冻结一个执行层就等于冻结所有人** ——
 * 那正是 `dsh-intent-guard` 记录过的生产事故（误锁全部子 agent）。
 *
 * ## 为什么不能用替身
 *
 * 本项目的 `smoke.mjs` 里 `tools` 是**替身**。替身的 `register()` 不去重、不抛错，
 * 替身的 `guardReason()` 是我自己写的规则 —— 所以"真实现会抛、替身不抛"这类差异
 * **在 smoke 里永远看不到**。事实上本文件就是这么抓到一个**会让主路径整体失效**的缺陷：
 * 第一版"给每个 agent 各注册一遍工具"，在真实现里**第二个 agent 就抛
 * `already registered`**（工具名在同一个层里只能注册一次）——生产表现是
 * 「意图层拿得到 request_permission，而每个执行层都拿不到」。
 *
 * 所以：**每一节都用全新 `Context` 做隔离**，不把上一节的注册/守卫状态带进来
 *（第一版没隔离，残留的全局守卫让第二节误报"守卫误伤了 B"，白查了一轮）。
 *
 * 跑法：
 *   node "D:\<dsh-plugin-root>\插件\dsh-executor-gate\_verify-tool-register.mjs"
 * 退出码：0 = 全绿；1 = 有断言失败（**生产会炸**）；2 = 缺依赖（不是插件坏了）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGINS_ROOT = dirname(PLUGIN_DIR)
const STAGE = join(PLUGINS_ROOT, '_stage', 'probe')

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

const cordisPath = join(STAGE, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
const toolsPath = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
const scopePath = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-scope', 'lib', 'index.js')

for (const [label, path] of [['真 cordis', cordisPath], ['真 dsh-tools', toolsPath], ['真 dsh-scope', scopePath]]) {
  if (!existsSync(path)) {
    console.error(`缺依赖，不是插件坏了：找不到${label}：${path}`)
    console.error('前置：把真 @deepseek-ai 依赖树从 app.asar 解到 _stage/probe/node_modules（见本文件头部说明）。')
    process.exit(2)
  }
}
console.log(`cordis   ：${cordisPath}`)
console.log(`dsh-tools：${toolsPath}`)
console.log(`dsh-scope：${scopePath}\n`)

const { Context } = await import(pathToFileURL(cordisPath).href)
const toolsModule = await import(pathToFileURL(toolsPath).href)
const { createScope, scopeOf } = await import(pathToFileURL(scopePath).href)

/**
 * 搭一个**干净**的真环境：真 `Context` + 真 `ToolRuntime` + 真 scoped agent ctx。
 *
 * @param options.agents - 要在 `inject: ['tools']` 的 fiber 下铸造几个 scoped agent。
 */
async function freshRuntime({ agents: agentIds = [] } = {}) {
  const root = new Context()
  await root.plugin({
    name: 'system-prompt-stand-in',
    apply(ctx) {
      // `ToolRuntime` 声明 `inject: ["systemPrompt"]`，缺它连构造函数都进不去。
      // 它只用三个方法，所以最小替身足够 —— 本节要验的不是提示词组装。
      ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
    },
  })
  await root.plugin({
    name: '@deepseek-ai/dsh-tools',
    // ⚠️ `inject` 必须照抄真行的声明：Cordis 对「没声明就取服务属性」是**抛错**的。
    inject: [...(toolsModule.ToolRuntime.inject ?? [])],
    apply: toolsModule.default ?? toolsModule.ToolRuntime,
  })

  const agents = []
  if (agentIds.length > 0) {
    await root.plugin({
      name: 'agents-stand-in',
      // agent 的 scoped ctx 必须由**已注入 tools 的 fiber** 派生，否则 `scopedCtx.tools`
      // 取不到（`cannot get property "tools" without inject`）。这条纪律来自
      // `dsh-intent-guard/smoke.mjs` 的既有结论，这里照做而不是绕开。
      inject: ['tools'],
      apply(ctx) {
        for (const id of agentIds) {
          const agent = { id, session: { header: { id, cwd: 'D:/proj' }, log: [] } }
          const handle = createScope(ctx, agent)
          agent.ctx = handle.ctx
          agents.push(agent)
        }
      },
    })
  }
  return { root, agents, tools: root.tools }
}

// 本插件的四个工具定义（与 index.js 里 `gateToolDefinitions` 产出的形状**逐字一致**）。
const gate = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href)
const definitions = gate.__gateToolDefinitionsForTest

//#region 第 1 节：真 register() 收不收手写定义

console.log('== 第 1 节：真 ToolRuntime.register() 收不收手写的工具定义 ==')
ok('index.js 暴露了用于校验的工具定义', Array.isArray(definitions) && definitions.length === 4, `拿到 ${String(definitions?.length)} 个`)

if (Array.isArray(definitions) && definitions.length > 0) {
  const { tools } = await freshRuntime()
  ok('真 ToolRuntime 挂上了（ctx.tools 是真服务，不是替身）', typeof tools?.register === 'function')

  const rejected = []
  for (const definition of definitions) {
    try {
      tools.register(definition)
    } catch (error) {
      rejected.push(`${definition.name}: ${String(error).slice(0, 160)}`)
    }
  }
  for (const definition of definitions) {
    ok(`真 register() 收下 ${definition.name}`, !rejected.some((r) => r.startsWith(`${definition.name}:`)), rejected.find((r) => r.startsWith(`${definition.name}:`)))
  }

  const visible = (tools.schemas?.() ?? []).map((s) => s.name)
  ok(
    '真 schemas() 里能看到这四个工具（说明定义真的进了模型可见面）',
    definitions.every((d) => visible.includes(d.name)),
    `可见：${visible.join(', ') || '(空)'}`,
  )

  // ⚠️ **最关键的一组断言**：真 `schemas()` 是**要发给模型 provider 的东西**。
  //
  // 生产里真出过 400（2026-09-18，双区第一次跑就撞上）：
  //   `Invalid schema for function 'grant_permission':
  //    schema must be a JSON Schema of 'type: "object"', got 'type: null'`
  // 根因：手写 definition 时只给了 `properties`，**漏了 `type: 'object'`** ——
  // 而真 `defineTool()` 内部会把参数 DSL 编译成 `{ type:'object', properties, required }`。
  //
  // 更阴的一点：真 `register()` **根本不看 `parameters`**（它只 `assertSupportedJsonSchema(output.schema)`），
  // 所以「register 收下了」「schemas() 里有这个名字」**都不代表能发给模型**。
  // 这一组断言才真正覆盖那次故障。
  for (const schema of tools.schemas?.() ?? []) {
    if (!definitions.some((d) => d.name === schema.name)) continue
    ok(
      `真 schemas() 里 ${schema.name}.parameters.type === 'object'（provider 就校验这个字段）`,
      schema.parameters?.type === 'object',
      `实际：${JSON.stringify(schema.parameters)?.slice(0, 300)}`,
    )
    ok(
      `真 schemas() 里 ${schema.name} 的 properties 挂在 object 根下`,
      schema.parameters?.properties !== undefined && typeof schema.parameters.properties === 'object',
      `实际：${JSON.stringify(schema.parameters)?.slice(0, 300)}`,
    )
  }
  for (const definition of definitions) {
    ok(`真 get(${definition.name}) 解析到可执行定义`, typeof tools.get?.(definition.name)?.execute === 'function')
  }

  ok(
    '**重复注册同名工具会抛错** —— 这就是第一版的真实故障：同名工具在同一层只能注册一次，' +
      '于是"给每个 agent 各注册一遍"在生产里从第二个 agent 起全部失败',
    (() => {
      try {
        tools.register({ ...definitions[0] })
        return false
      } catch {
        return true
      }
    })(),
  )
}

//#endregion

//#region 第 2 节：真 guard 是否按 agent 生效（**全新 Context**，不带第 1 节的任何状态）

console.log('\n== 第 2 节：真 guard 按 agent 生效吗（隔离环境 + 真 execute 端到端）==')
{
  const { root, agents, tools } = await freshRuntime({ agents: ['agent-A', 'agent-B'] })
  const [agentA, agentB] = agents

  const probeName = 'gate_probe'
  tools.register({
    name: probeName,
    description: 'probe tool for the guard-scoping verification',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      return 'PROBE_RAN'
    },
  })
  ok('探针工具在挂载点注册成功（与生产注册 ledger 工具的方式一致）', typeof tools.get(probeName)?.execute === 'function')
  ok('两个 agent 的 scope 身份互不相同', scopeOf(agentA.ctx) !== scopeOf(agentB.ctx))

  const DENY = 'DENIED_BY_PER_AGENT_GUARD'
  let installed = true
  try {
    // 生产里每个执行层各装自己的守卫，就是这一步
    agentA.ctx.tools.guard((exec) => (exec.name === probeName ? DENY : undefined))
  } catch (error) {
    installed = false
    console.log(`    （装守卫失败：${String(error).slice(0, 200)}）`)
  }
  ok('能在 agentA 的 scoped ctx 上装守卫（真 tools.guard() 不要求额外条件）', installed)

  const reasonA = tools.guardReason({ name: probeName, arguments: {}, agent: agentA })
  const reasonB = tools.guardReason({ name: probeName, arguments: {}, agent: agentB })
  ok('真 guardReason：A 被拒', reasonA === DENY, String(reasonA))
  ok('**真 guardReason：B 不受影响**（不误伤别的 agent）', reasonB === undefined, String(reasonB))

  const runProbe = async (agent) => {
    try {
      const result = await tools.execute({
        callId: 'call-probe-1',
        name: probeName,
        arguments: {},
        agent,
        signal: new AbortController().signal,
      })
      const text = (result?.content ?? []).map((block) => block?.text ?? '').join('\n')
      return { text, isError: result?.isError === true }
    } catch (error) {
      return { text: `THREW: ${String(error).slice(0, 200)}`, isError: true }
    }
  }
  const resultA = await runProbe(agentA)
  const resultB = await runProbe(agentB)
  console.log(`    A（装了守卫）→ isError=${resultA.isError} text=${JSON.stringify(resultA.text.slice(0, 80))}`)
  console.log(`    B（没装守卫）→ isError=${resultB.isError} text=${JSON.stringify(resultB.text.slice(0, 80))}`)
  ok(
    '**真 execute 端到端：A 的调用被守卫拒**（理由原样变成 Error 结果，工具体没跑）',
    resultA.isError && resultA.text.includes(DENY) && !resultA.text.includes('PROBE_RAN'),
    resultA.text.slice(0, 200),
  )
  ok(
    '**真 execute 端到端：B 的调用照常执行**（守卫没有误伤 —— 这正是 intent-guard 踩过的事故）',
    resultB.isError === false && resultB.text.includes('PROBE_RAN'),
    resultB.text.slice(0, 200),
  )
}

//#endregion

//#region 第 3 节：生产的注册路径（`ctx.get('tools')` + 挂载点注册一次）

console.log('\n== 第 3 节：生产走的那条注册路径 ==')
{
  const { root, tools } = await freshRuntime()
  const resolve = (ctx) => (typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools)
  ok('`ctx.get("tools")` 能取到真 ToolRuntime（生产的取法成立，且不需要 inject）', typeof resolve(root)?.register === 'function')

  const before = new Context()
  ok('取不到时返回 undefined（不抛错、不会阻止插件挂载 —— 这是选 ctx.get 而不是 inject 的理由）', resolve(before) === undefined)

  const rejected = []
  for (const definition of definitions) {
    try {
      tools.register(definition)
    } catch (error) {
      rejected.push(`${definition.name}: ${String(error).slice(0, 160)}`)
    }
  }
  ok('从挂载点注册四个工具全部成功（生产路径可用）', rejected.length === 0, rejected.join(' ｜ '))
}

//#endregion

//#region 第 4 节：能不能被**真加载器**挂上（会不会把桌面端搞坏的那一步）
//
// 这一节直接对着本项目最惨的那次事故：
// `dsh-executor-loop` 导出了一个手写的 `Config` 描述对象，而 Cordis 的
// `resolveConfig()` 会读 `runtime.Config['~standard'].validate(config)` ——
// 手写对象没有 `~standard`，于是 `undefined.validate` 抛 TypeError，
// **整棵插件树加载失败、DSH Desktop 直接打不开**。
//
// `resolveConfig` 只有几行，这里**逐字复刻**它（出处：
// `@deepseek-ai/cordis` 的 `lib/index.js`，第 955-961 行）。
// 复刻而不是 import：它不在 cordis 的公开导出面上，而这几行短到不值得为它去改依赖树。
console.log('\n== 第 4 节：真加载器那一步（resolveConfig + 真 import + 真挂载）==')
{
  const resolveConfig = (runtime, config) => {
    if (!runtime.Config) return config
    const result = runtime.Config['~standard'].validate(config)
    if ('then' in result) throw new TypeError('Async config validation is not supported')
    if (result.issues) throw new Error(`ValidationError: ${JSON.stringify(result.issues)}`)
    return result.value
  }

  // 真 `file://` URL —— 与 preset 里写的那一行同源
  const gateUrl = pathToFileURL(join(PLUGIN_DIR, 'index.js')).href
  const intentGuardUrl = pathToFileURL(join(PLUGINS_ROOT, 'dsh-intent-guard', 'index.js')).href
  // 判据登记闸：它有自己的 AST 引擎与三个工具，加载路径必须一起验（同一类事故：起不来 / 挂不上）
  const criteriaUrl = pathToFileURL(join(PLUGINS_ROOT, 'dsh-criteria-gate', 'index.js')).href

  const loaded = {}
  for (const [label, url] of [
    ['executor-gate', gateUrl],
    ['intent-guard', intentGuardUrl],
    ['criteria-gate', criteriaUrl],
  ]) {
    let mod
    try {
      mod = await import(url)
      loaded[label] = mod
    } catch (error) {
      ok(`加载器能 import ${label}（preset 里的 file:// URL）`, false, String(error).slice(0, 200))
      continue
    }
    ok(`加载器能 import ${label}（preset 里的 file:// URL）`, true)
    ok(`${label} 导出了稳定的 name / inject / apply`, typeof mod.name === 'string' && Array.isArray(mod.inject) && typeof mod.apply === 'function', `${String(mod.name)} / ${JSON.stringify(mod.inject)}`)

    // 就是这一步把 DSH 打崩过
    let configThrew
    try {
      resolveConfig(mod, { enabled: true })
    } catch (error) {
      configThrew = error
    }
    ok(
      `**resolveConfig() 不抛**（${label} 没有导出非 Standard Schema 的 Config —— 这是打不开桌面端的那一步）`,
      configThrew === undefined,
      String(configThrew).slice(0, 220),
    )
  }

  // 真挂载两个插件（服务用最小替身；positional 关系与真实一致）
  const { Context: Ctx } = await import(pathToFileURL(cordisPath).href)
  const mountRoot = new Ctx()
  const mountLog = { info: [], warn: [], error: [] }
  Object.defineProperty(mountRoot, 'logger', {
    value: {
      info: (m) => mountLog.info.push(String(m)),
      warn: (m) => mountLog.warn.push(String(m)),
      error: (m) => mountLog.error.push(String(m)),
    },
    configurable: true,
    writable: true,
  })
  // ⚠️ 2026-09-19：这里**必须**把真 `dsh-tools` 也挂上。
  // 原因是 intent-guard 的 `inject` 里多了 `tools`（它要用这个服务注册**指南针**工具、
  // 并逐个名字下发掩码）。缺了它，那条 fiber 会永远停在 PENDING(0) ——
  // 而"apply 根本没跑"和"apply 跑得很好"在断言上长得一模一样，正是这套校验要防的那种假绿。
  await mountRoot.plugin({
    name: 'system-prompt-stand-in-1',
    apply(ctx) {
      ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
    },
  })
  await mountRoot.plugin({
    name: '@deepseek-ai/dsh-tools',
    inject: [...(toolsModule.ToolRuntime.inject ?? [])],
    apply: toolsModule.default ?? toolsModule.ToolRuntime,
  })
  await mountRoot.plugin({
    name: 'services-stand-in',
    apply(ctx) {
      ctx.reflect.provide('agents', { roots: () => [], list: () => [] })
      ctx.reflect.provide('agentPresets', { composedPreset: (scopedCtx) => (scopeOf(scopedCtx) === undefined ? undefined : 'dual') })
    },
  })

  const fibers = {}
  for (const [label, mod] of Object.entries(loaded)) {
    try {
      fibers[label] = mountRoot.plugin(
        { name: mod.name, inject: mod.inject, apply: mod.apply },
        { enabled: true, presetId: 'dual', deny: mod.name === 'intent-guard' ? ['write', 'edit'] : undefined, eyes: mod.name === 'intent-guard' ? ['read', 'read_image', 'glob', 'grep', 'pwsh', 'bash'] : undefined },
      )
    } catch (error) {
      ok(`${label} 挂载时没有同步抛错`, false, String(error).slice(0, 220))
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const [label, fiber] of Object.entries(fibers)) {
    ok(
      `**${label} 的 fiber 到达 ACTIVE（=2）** —— 不是 PENDING(依赖没满足) 也不是 FAILED(apply 抛错把窗口带下去)`,
      fiber?.state === 2,
      `fiber.state=${String(fiber?.state)}${mountLog.error.length > 0 ? ` | logger.error: ${mountLog.error.join(' | ').slice(0, 200)}` : ''}`,
    )
  }
  ok('两个插件都没有往 logger.error 里写东西（响亮失败会留痕）', mountLog.error.length === 0, mountLog.error.join(' | ').slice(0, 300))
}

//#endregion

//#region 第 4 节：**能力级不可看** —— 在真 ToolRuntime 上验"意图层的工具表里没有 read"

/**
 * 用户 2026-09-19 的要求：
 *   「是需要**能力级的不可看**，只有那些最重要的东西作为意图层的指南针，
 *    因为意图层就**必须贯彻我的意志，不能自作主张**。」
 *
 * 这一节是那句话的**唯一硬证据**：不是"守卫会拦"，而是
 * **`tools.schemas(intentAgent)` 里根本没有 `read`** —— 那是真的要发给 provider 的东西。
 * 同时验证反面：执行层（子会话）**照旧有**那些工具（不然谁去干活）。
 *
 * 全部用**真** `ToolRuntime` + **真** scoped agent ctx（不是替身）——
 * 因为"掩码按 scope 生效"这件事正是真实现的语义，替身验不出它。
 */
console.log('\n== 第 4 节：能力级不可看（真 ToolRuntime + 真 scoped ctx） ==')
{
  const { Context: Ctx } = await import(pathToFileURL(cordisPath).href)
  const { createScope, scopeOf: scopeOfReal } = await import(pathToFileURL(scopePath).href)
  const root = new Ctx()
  const log = { info: [], warn: [], error: [] }
  Object.defineProperty(root, 'logger', {
    value: { info: (m) => log.info.push(String(m)), warn: (m) => log.warn.push(String(m)), error: (m) => log.error.push(String(m)) },
    configurable: true,
    writable: true,
  })
  await root.plugin({
    name: 'system-prompt-stand-in-2',
    apply(ctx) {
      ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
    },
  })
  await root.plugin({
    name: '@deepseek-ai/dsh-tools',
    inject: [...(toolsModule.ToolRuntime.inject ?? [])],
    apply: toolsModule.default ?? toolsModule.ToolRuntime,
  })

  // 真工具表里先摆上"那些眼睛 + 写工具"（真产品由 tool-fs / tool-pwsh 挂载它们）。
  // 形状必须能过 `register()`：`output.schema` 是它唯一校验的东西。
  const toolOf = (toolName) => ({ name: toolName, description: `${toolName} stand-in`, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] }, execute: () => '' })
  for (const toolName of ['read', 'read_image', 'glob', 'grep', 'pwsh', 'write', 'edit', 'subagent', 'dispatch_audit']) root.tools.register(toolOf(toolName))

  const intentAgent = { id: 'sess-intent', session: { header: { id: 'sess-intent', cwd: 'D:/proj', origin: 'root' } } }
  const kidAgent = { id: 'sess-kid', session: { header: { id: 'sess-kid', cwd: 'D:/proj', origin: 'subagent' } } }
  await root.plugin({
    name: 'agents-stand-in-2',
    inject: ['tools'],
    apply(ctx) {
      for (const agent of [intentAgent, kidAgent]) agent.ctx = createScope(ctx, agent).ctx
      ctx.reflect.provide('agents', { roots: () => [intentAgent], list: () => [intentAgent, kidAgent] })
      ctx.reflect.provide('agentPresets', { composedPreset: (scopedCtx) => (scopeOfReal(scopedCtx) === undefined ? undefined : 'dual') })
    },
  })

  const guardModule = await import(pathToFileURL(join(PLUGINS_ROOT, 'dsh-intent-guard', 'index.js')).href)
  const fiber = root.plugin(
    { name: 'intent-guard', inject: guardModule.inject, apply: guardModule.apply },
    { enabled: true, deny: ['write', 'edit'], eyes: ['read', 'read_image', 'glob', 'grep', 'pwsh', 'bash'], logDenied: true, presetId: 'dual' },
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  ok('intent-guard 的 fiber 到达 ACTIVE（否则下面验的是"什么都没发生"）', fiber?.state === 2, `state=${String(fiber?.state)} warn=${log.warn.join(' | ').slice(0, 200)}`)

  const visibleTo = (agent) => (root.tools.schemas?.(agent) ?? []).map((schema) => schema.name)
  const intentVisible = visibleTo(intentAgent)
  const kidVisible = visibleTo(kidAgent)
  console.log(`  意图层看得见的工具（${intentVisible.length}）：${intentVisible.join(', ')}`)
  console.log(`  执行层看得见的工具（${kidVisible.length}）：${kidVisible.join(', ')}`)

  ok(
    '**意图层的工具表里没有那些"眼睛"**（read / read_image / glob / grep / pwsh）—— 这才是"能力级"',
    ['read', 'read_image', 'glob', 'grep', 'pwsh'].every((toolName) => !intentVisible.includes(toolName)),
    `仍然可见：${['read', 'read_image', 'glob', 'grep', 'pwsh'].filter((toolName) => intentVisible.includes(toolName)).join(', ')}`,
  )
  ok('**也没有写工具**（write / edit）', !intentVisible.includes('write') && !intentVisible.includes('edit'))
  ok('**但干活要用的还在**（subagent / dispatch_audit）', intentVisible.includes('subagent') && intentVisible.includes('dispatch_audit'))
  ok(
    '**指南针在**（read_compass / list_compass）—— 拿掉眼睛之后它靠这个活',
    intentVisible.includes('read_compass') && intentVisible.includes('list_compass'),
    JSON.stringify(intentVisible),
  )
  ok(
    '**执行层照旧有那些工具**（不能把干活的人一起蒙上）',
    ['read', 'glob', 'grep', 'pwsh', 'write', 'edit'].every((toolName) => kidVisible.includes(toolName)),
    `执行层缺：${['read', 'glob', 'grep', 'pwsh', 'write', 'edit'].filter((toolName) => !kidVisible.includes(toolName)).join(', ')}`,
  )
  ok(
    '`tools.get("read", 意图层)` 解析不到（连查都查不到 —— 不是"能查但会被拒"）',
    root.tools.get('read', intentAgent) === undefined && typeof root.tools.get('read_compass', intentAgent)?.execute === 'function',
  )
  ok('  执行层那边 `tools.get("read", …)` 解析得到', typeof root.tools.get('read', kidAgent)?.execute === 'function')
}

//#endregion

console.log(`\n${'='.repeat(64)}`)
console.log(`tool-register 校验: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('通过：手写定义能被真 register() 接受并进入模型可见面；')
  console.log('      从 agent.ctx 装的 guard 只对该 agent 生效（不误伤别人），且真 execute 端到端成立。')
}
