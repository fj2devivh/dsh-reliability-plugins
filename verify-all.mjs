/**
 * verify-all.mjs —— **一条命令跑完所有检查**。
 *
 * ## 为什么需要它
 *
 * 到这一步，验证已经散在 6 个地方了：
 *   · 两个 profile 的补丁 YAML 解析 + 组合          （verify-patch-yml / verify-profile）
 *   · 兜底 home 的 home 层补丁 + 组合               （verify-home）
 *   · 四个 `.cmd` 真的能跑、中文不乱码、换行是 CRLF （test-cmd）
 *   · 快照是否完好                                  （snapshot --verify）
 *   · 补丁里有没有残留的 `file://` 绝对路径          （本脚本内置）
 *   · 三个插件是不是「链接到工作区源码」            （本脚本内置）
 *
 * 散着跑的结果就是**人会漏**。这里合成一条：任何一项红就整体红，退出码非 0。
 *
 * ## 设计上刻意的两点
 *
 * 1. **每项独立、互不短路**：前一项红了也继续跑后面的 —— 一次拿到全貌，
 *    比「修一个再跑一次发现下一个」省太多时间。
 * 2. **只读**：本脚本**不修改任何东西**（`install-linked` 与 `snapshot` 生成快照
 *    除外）。要改东西请跑对应的安装器/修复器。
 *
 * 用法：
 *   node verify-all.mjs              # 全部检查
 *   node verify-all.mjs --quick      # 跳过较慢的：真宿主探测、快照校验
 *   node verify-all.mjs --json       # 末尾输出机器可读汇总
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = HERE
const DSH_HOME = join(homedir(), '.dsh')
const FALLBACK_HOME = 'D:/<dsh-plugin-root>/DSH 兜底'
const DESKTOP_ASAR = 'D:/<dsh-plugin-root>/DSH Desktop/resources/app.asar'
const PRISTINE_ASAR_SHA = 'F0BB5E285039ADF18819C1026D9DABD6A6F604CA4F0D40CEF45654AFF684B0D1'

const argv = process.argv.slice(2)
const quick = argv.includes('--quick')
const asJson = argv.includes('--json')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail })
  const mark = ok ? '\u001b[32mok  \u001b[0m' : '\u001b[31mFAIL\u001b[0m'
  console.log(`  ${mark} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
}

/** 跑一个子脚本，把它自己的 ok/FAIL 行转述出来，并返回是否全绿。 */
function runChild(label, script, args = [], timeout = 600_000) {
  const path = join(HERE, script)
  console.log(`\n${'─'.repeat(70)}\n${label}  (${script})\n${'─'.repeat(70)}`)
  if (!existsSync(path)) {
    record(`${label}：脚本存在`, false, path)
    return false
  }
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout })
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    code = error.status ?? 1
  }
  // 只转述断言行与结论行，避免刷屏
  for (const line of out.split('\n')) {
    if (/^\s*(ok|FAIL)\s/u.test(line) || /passed,|通过：|未通过|失败/.test(line)) {
      process.stdout.write(`${line}\n`)
    }
  }
  const ok = code === 0
  record(label, ok, ok ? undefined : `退出码 ${code}`)
  return ok
}

console.log(`DSH 总闸门  ${new Date().toLocaleString('zh-CN')}`)
console.log(`工作区：${HERE}`)
console.log(`主 home：${DSH_HOME}`)
console.log(`兜底 home：${FALLBACK_HOME}${quick ? '\n（--quick：跳过真宿主探测与快照校验）' : ''}`)

// ─────────────────────────────────────────────────────────────
// 1. 两个 profile 的补丁 YAML + 组合
// ─────────────────────────────────────────────────────────────
for (const profile of ['desktop', 'web']) {
  if (!existsSync(join(DSH_HOME, 'profiles', profile))) {
    record(`profile ${profile} 存在`, false, join(DSH_HOME, 'profiles', profile))
    continue
  }
  runChild(`profile ${profile}：补丁 YAML 解析`, 'verify-patch-yml.mjs', [profile])
  runChild(`profile ${profile}：真组合`, 'verify-profile.mjs', [profile])
}

// ─────────────────────────────────────────────────────────────
// 2. 兜底 home
// ─────────────────────────────────────────────────────────────
if (existsSync(FALLBACK_HOME)) {
  runChild('兜底 home：home 层 + 组合', 'verify-home.mjs', [FALLBACK_HOME, 'web'])
} else {
  record('兜底 home 存在', false, FALLBACK_HOME)
}

// ─────────────────────────────────────────────────────────────
// 3. 四个 .cmd：真跑一遍，断言不乱码 + CRLF
// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}\n.cmd 脚本真跑（中文 + CRLF）\n${'─'.repeat(70)}`)
for (const cmd of ['restart-dsh.cmd', 'rollback-executor-view.cmd', 'restore-app-asar.cmd', 'start-web-fallback.cmd']) {
  const path = join(HERE, cmd)
  if (!existsSync(path)) {
    record(`${cmd} 存在`, false, path)
    continue
  }
  // CRLF 检查先做（快，且这是最隐蔽的一类失败）
  const bytes = readFileSync(path)
  let bareLf = 0
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) bareLf += 1
  }
  record(`${cmd}：换行是 CRLF`, bareLf === 0, bareLf > 0 ? `${bareLf} 个裸 LF` : undefined)

  // 真跑：只有 test-cmd.mjs 覆盖得到「中文被当命令」这类问题。
  // `restart-dsh.cmd` / `rollback-executor-view.cmd` 会真的去重启桌面端，
  // 所以它们只做 CRLF + 内容检查，**不**真跑 —— 那是有副作用的动作。
  if (cmd === 'restart-dsh.cmd' || cmd === 'rollback-executor-view.cmd') {
    const text = readFileSync(path, 'utf8')
    record(`${cmd}：带 chcp 65001（中文不乱码）`, text.includes('chcp 65001'))
    record(`${cmd}：调用了配套的 .ps1`, /-File\s+"%~dp0[\w.-]+\.ps1"/u.test(text))
    continue
  }
  runChild(`${cmd} 真跑`, '_tools/test-cmd.mjs', [cmd], 180_000)
}

// ─────────────────────────────────────────────────────────────
// 4. 补丁里**不能**再残留绝对路径（迁移目标）
//
// ⚠️ 这条规则**只对 profile 补丁层成立**，不能套到 agent preset 上：
//   · profile 补丁（cordis.patch.yml）用**包名**引插件，因为 profile 的
//     node_modules 里有指向工作区源码的目录链接 —— 那才是「源码唯一真源」。
//   · agent preset（.agent-presets/*/agent.cordis.yml）**必须**用 `file://` 绝对 URL：
//     它的插件不由 profile 提供（例如 `dsh-intent-guard` 只被 dual 这一个 preset 引用），
//     写包名反而找不到。这是 `dsh-agent-presets` 的加载语义，不是漏改。
// 2026-09-15 修：原先这条规则把 preset 也当补丁查，于是**每次重建 dual preset 都必然红**，
// 而这与「补丁层已迁移到包名」那件事无关 —— 判据套错了对象，红得没有信息量。
// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}\n路径卫生：profile 补丁里不该再有 file:// 绝对路径\n${'─'.repeat(70)}`)
const patchFiles = [
  join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'),
  join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'),
  join(FALLBACK_HOME, 'profiles', 'web', 'cordis.patch.yml'),
]
for (const file of patchFiles) {
  if (!existsSync(file)) {
    record(`存在 ${file.replaceAll('\\', '/').split('/').slice(-3).join('/')}`, false, file)
    continue
  }
  const text = readFileSync(file, 'utf8')
  const urls = [...text.matchAll(/'file:\/\/\/[^']*'/gu)].map((m) => m[0])
  const label = file.replaceAll('\\', '/').split('/').slice(-3).join('/')
  record(`${label}：没有 file:// 绝对路径`, urls.length === 0, urls.length > 0 ? urls[0].slice(0, 90) : undefined)
}

// preset 走**相反**的判据：它必须引到**工作区源码**（源码唯一真源）。
//
// ⚠️ 2026-09-19 改过一次判据，因为它原来**照着文本长相判**：
//      const urls = [...text.matchAll(/'file:\/\/\/[^']*'/gu)]
//   —— 只认**带单引号**的 URL。而生成器换成真 js-yaml 渲染之后，URL 不再带引号，
//   于是"找到 0 个"直接判红。**东西没坏，是判据长在措辞上。**
//   现在：真 js-yaml 解析 + 两种合法引用形式都认（file:// URL / 裸包名 → 链接目标），
//   并且对裸包名**真的去查链接指向哪** —— 名字本身说明不了它连的是源码还是副本。
{
  const presetFile = join(DSH_HOME, '.agent-presets', 'dual', 'agent.cordis.yml')
  const label = '.agent-presets/dual/agent.cordis.yml'
  if (!existsSync(presetFile)) {
    record(`存在 ${label}`, false, presetFile)
  } else {
    const presetRead = await import(pathToFileURL(join(HERE, '_tools', 'preset-read.mjs')).href)
    const read = await presetRead.readPresetRows(presetFile)
    if (!read.ok) {
      record(`${label}：能被真 js-yaml 解析`, false, read.reason)
    } else {
      record(`${label}：能被真 js-yaml 解析`, true)
      const own = read.rows.filter((row) => /dsh-(?:intent-guard|executor-gate|criteria-gate|executor-loop|endstate-loop|endstate-view|executor-view|human-voice|knowledge-gate)/u.test(row.name))
      const linkTargetOf = (pkg) => {
        const link = join(DSH_HOME, 'profiles', 'desktop', 'node_modules', ...pkg.split('/'))
        try {
          return realpathSync(link)
        } catch {
          return undefined
        }
      }
      const judged = own.map((row) => ({ row, verdict: presetRead.pointsAtWorkspaceSource(row.name, WORKSPACE, linkTargetOf) }))
      const bad = judged.filter((item) => item.verdict.ok !== true)
      record(
        `${label}：本项目的插件行都指向工作区源码`,
        own.length >= 2 && bad.length === 0,
        bad.length > 0
          ? bad.map((item) => `${item.row.id}: ${item.row.name}（${item.verdict.how}｜${item.verdict.resolved}）`).join(' ; ').slice(0, 200)
          : `${own.length} 行：${judged.map((item) => `${item.row.id}=${item.verdict.how}`).join('、')}`,
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 5. 三个插件用的是「链接到工作区源码」（单一真源）
// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}\n插件是链接而非副本（源码唯一真源）\n${'─'.repeat(70)}`)
const pluginPkgs = ['@dsh-plugin/executor-loop', '@dsh-plugin/executor-view', '@dsh-plugin/intent-guard']
const profileRoots = [
  { label: 'desktop', dir: join(DSH_HOME, 'profiles', 'desktop') },
  { label: 'web', dir: join(DSH_HOME, 'profiles', 'web') },
  { label: '兜底 web', dir: join(FALLBACK_HOME, 'profiles', 'web') },
]
for (const { label, dir } of profileRoots) {
  if (!existsSync(dir)) {
    record(`${label} profile 存在`, false, dir)
    continue
  }
  for (const pkg of pluginPkgs) {
    const dest = join(dir, 'node_modules', ...pkg.split('/'))
    let linked = false
    try {
      linked = lstatSync(dest).isSymbolicLink()
    } catch {
      linked = false
    }
    record(`${label}：${pkg} 是链接`, linked, linked ? undefined : '是实体副本（源码会有两份）')
  }
}

// ─────────────────────────────────────────────────────────────
// 6. 插件自己的回归（每个插件一条，跑真 Cordis / 真 dsh-tools / 真 python）
//
// ⚠️ 这一段是**补上的缺口**：总闸门原先只查 profile 补丁、组合、.cmd、快照、asar ——
// 也就是只回答"装得对不对"，**一个字都没验过插件的行为**。
// 于是会出现最坏的那种情况：总闸门 30/0 全绿，而插件本身早就坏了。
// （文档里写着总闸门"一条命令跑完下面全部"，下面那张回归表却从来没人跑 ——
//  文档与实现不一致，正是这套东西要防的那类毛病。）
//
// 这些子脚本会**起真 Cordis 组合**，但不起真宿主，串行跑没有端口/store 冲突。
// 缺依赖时它们以 exit 2 退出并打印「缺依赖，不是插件坏了」——
// 这里照实记为失败（总闸门必须能红），但把原因原样转述出来，免得被当成插件坏了。
// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}\n插件回归：行为断言（真 Cordis / 真 dsh-tools / 真 python）\n${'─'.repeat(70)}`)
const pluginGates = [
  ['意图层掩码 + 能力级不可看 + 指南针', 'dsh-intent-guard\\smoke.mjs'],
  ['执行层权限门', 'dsh-executor-gate\\smoke.mjs'],
  ['执行层权限门：真依赖校验', 'dsh-executor-gate\\_verify-tool-register.mjs'],
  ['判据登记闸 + 任务书闸', 'dsh-criteria-gate\\smoke.mjs'],
  ['执行体（goal 续行）', 'dsh-executor-loop\\smoke.mjs'],
  ['终局闭环（缺口器 + 累积台账）', 'dsh-endstate-loop\\smoke.mjs'],
  ['终局面板（投影 + 浏览器半渲染）', 'dsh-endstate-view\\smoke.mjs'],
  // 面板也是插件，改了就该被总闸门跑到 —— 加进来之前它**只被检测器跑**，
  // 而检测器不进总闸门（这是"总闸门全绿"名不副实的另一半）。
  ['执行层面板（右栏可视化：24 小时分桶）', 'dsh-executor-view\\smoke.mjs'],
  // 人话闸：管的是"意图层对用户说话的形状"（只准中文 / 人话在前 / 细节在后 / 场合不同骨架不同）。
  // 它的负样本是**我当晚真实发出去的原话** —— 那种话以后不许再出现。
  ['人话闸（只准中文 + 人话在前）', 'dsh-human-voice\\smoke.mjs'],
  // 知识准入闸（2026-09-19 用户要求）：「把「知道」变成权限，而不是自觉」。
  // 它管的是"没确认读过那段规则就不许改状态"，以及"我的世界里哪些东西是自动到场的"。
  ['知识准入闸（不知道就做不了事）', 'dsh-knowledge-gate\\smoke.mjs'],
]
for (const [label, script] of pluginGates) {
  runChild(`插件回归 · ${label}`, script, [], 900_000)
}

// ─────────────────────────────────────────────────────────────
// 7. 桌面端 app.asar 必须是原厂
// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}\nDSH 本体：app.asar 必须是原厂\n${'─'.repeat(70)}`)
if (existsSync(DESKTOP_ASAR)) {
  const { createHash } = await import('node:crypto')
  const sha = createHash('sha256').update(readFileSync(DESKTOP_ASAR)).digest('hex').toUpperCase()
  record('app.asar 与原厂备份一致', sha === PRISTINE_ASAR_SHA, sha === PRISTINE_ASAR_SHA ? undefined : `实际 ${sha.slice(0, 16)}…（原厂 ${PRISTINE_ASAR_SHA.slice(0, 16)}…）`)
} else {
  record('app.asar 存在', false, DESKTOP_ASAR)
}

// ─────────────────────────────────────────────────────────────
// 8. 快照完好（慢；--quick 跳过）
// ─────────────────────────────────────────────────────────────
if (!quick) {
  const snapshotRoot = join(HERE, '_snapshots')
  if (existsSync(snapshotRoot)) {
    const dirs = readdirSync(snapshotRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    if (dirs.length === 0) {
      record('快照存在', false, '没有找到任何快照')
    } else {
      const latest = join(snapshotRoot, dirs[dirs.length - 1])
      runChild(`快照完好（${dirs[dirs.length - 1]}）`, 'snapshot.mjs', ['--verify', latest], 300_000)
    }
  } else {
    record('快照存在', false, snapshotRoot)
  }
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n${'='.repeat(70)}`)
console.log(`总闸门：${results.length - failed.length} 通过，${failed.length} 失败`)
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const item of failed) console.log(`  · ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
  console.log('\n起不来先跑：node repair-profiles.mjs')
}
if (asJson) {
  console.log(`\n${JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2)}`)
}
console.log('='.repeat(70))
process.exit(failed.length > 0 ? 1 : 0)
