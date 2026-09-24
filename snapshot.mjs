/**
 * snapshot.mjs —— 把「现在这套**已验证能跑**的东西」打包成一个可回退的基线。
 *
 * ## 为什么先做这个
 *
 * 2026-09-15 那场事故的教训是：改补丁层 = 可能起不来。所以**在动任何结构之前**，
 * 先把当前状态冻成一个能解包、能校验、能照着还原的包。这样后面无论怎么改坏，
 * 都有个已知良好的落点。
 *
 * ## 打包什么（以及**刻意不打包**什么）
 *
 * 打包：
 *   · 工作区里的插件源码与运维脚本（不含 `_asar`，那是 22MB 的调试解包，能重建）
 *   · 兜底 home 的配置与我的文件（不含 `profiles/`，那是可重建的 junction 树）
 *   · 主 home 的**补丁层 + 预设**（这是「到底装了什么」的唯一真源）
 *   · 桌面端 `app.asar` 的 sha256（只存指纹，不存 169MB 文件）
 *   · 一份中文清单 `快照说明.md`，写清怎么还原
 *
 * 不打包：
 *   · `node_modules` / `_asar` / `_diag` 之类可重建或纯调试的东西
 *   · 会话、凭据（**隐私**：快照可能被拷走，不该带这些）
 *
 * ## 用法
 *
 *   node snapshot.mjs                     # 生成快照到 _snapshots\
 *   node snapshot.mjs --verify <包路径>    # 只校验一个已存在的快照
 *   node snapshot.mjs --list              # 列出已有快照
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const FALLBACK_HOME = 'D:/<dsh-plugin-root>/DSH 兜底'
const DESKTOP_ASAR = 'D:/<dsh-plugin-root>/DSH Desktop/resources/app.asar'
const SNAPSHOT_ROOT = join(HERE, '_snapshots')

/** 工作区里要带走的（相对路径）。显式白名单 —— 比黑名单安全，不会把隐私顺手打进去。 */
const WORKSPACE_INCLUDE = [
  'dsh-executor-loop',
  'dsh-executor-view',
  'dsh-intent-guard',
  'build-presets.mjs',
  'patch-yml-normalize.mjs',
  'repair-profiles.mjs',
  'verify-all.mjs',
  'verify-home.mjs',
  'verify-patch-yml.mjs',
  'verify-presets.mjs',
  'verify-profile.mjs',
  'install.mjs',
  'install-executor-view.mjs',
  'install-fallback-home.mjs',
  'install-profile-plugins.mjs',
  'install-web-profile-plugins.mjs',
  'start-web-host.mjs',
  'start-web-fallback.cmd',
  'restart-dsh.cmd',
  'restart-dsh.ps1',
  'rollback-executor-view.cmd',
  'rollback-executor-view.ps1',
  'restore-app-asar.cmd',
  'DUAL-MODE.md',
  'README-操作.md',
  '重要-先看这个.md',
  'critical-tools', // 下面会把 _tools 里非调试的部分拷进来
]

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function hashFile(path) {
  return sha256(await readFile(path))
}

/** 递归列出文件（相对 root），跳过黑名单目录。 */
async function listFiles(root, skipDirs = new Set(['node_modules', '.git', '_snapshots'])) {
  const out = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out
}

// ─────────────────────────────────────────────────────────────
// --list / --verify：不生成，只读
// ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)

if (argv.includes('--list')) {
  if (!existsSync(SNAPSHOT_ROOT)) {
    console.log('还没有任何快照。')
    process.exit(0)
  }
  const items = (await readdir(SNAPSHOT_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory())
  if (items.length === 0) {
    console.log('还没有任何快照。')
    process.exit(0)
  }
  console.log(`快照目录：${SNAPSHOT_ROOT}\n`)
  for (const item of items) {
    const dir = join(SNAPSHOT_ROOT, item.name)
    const manifestPath = join(dir, 'manifest.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      console.log(`  ${item.name}   ${manifest.fileCount} 个文件  ${(manifest.bytes / 1024 / 1024).toFixed(2)} MB`)
    } else {
      console.log(`  ${item.name}   （无 manifest.json）`)
    }
  }
  process.exit(0)
}

if (argv.includes('--verify')) {
  const target = resolve(argv[argv.indexOf('--verify') + 1] ?? SNAPSHOT_ROOT)
  const manifestPath = join(target, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(`找不到 ${manifestPath}`)
    process.exit(1)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  // ⚠️ manifest 里的相对路径是相对 **payload/**（生成时就是那么算的），
  // 而不是相对快照根。第一版按快照根拼，于是**104 个文件全报「缺失」**——
  // 正对照立刻抓到了这个 bug（未改动的快照都过不了校验）。
  const payloadDir = join(target, 'payload')
  console.log(`校验快照：${target}`)
  console.log(`payload ：${payloadDir}`)
  console.log(`创建时间：${manifest.createdAt}`)
  console.log(`文件数  ：${manifest.fileCount}\n`)

  let bad = 0
  let checked = 0
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const full = join(payloadDir, rel)
    if (!existsSync(full)) {
      console.log(`  缺失 ${rel}`)
      bad += 1
      continue
    }
    const actual = await hashFile(full)
    checked += 1
    if (actual !== expected.sha256) {
      console.log(`  哈希不符 ${rel}\n    期望 ${expected.sha256}\n    实际 ${actual}`)
      bad += 1
    }
  }
  console.log(`\n已校验 ${checked}/${manifest.fileCount}，不符或缺失 ${bad} 个`)
  if (bad > 0) {
    console.error('快照已损坏 —— 别用它还原。')
    process.exit(1)
  }
  console.log('快照完好：每个文件的 sha256 都对得上。')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────
// 生成快照
// ─────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
const outDir = join(SNAPSHOT_ROOT, `snapshot-${stamp}`)
await mkdir(outDir, { recursive: true })

console.log(`生成快照 → ${outDir}\n`)

const copied = [] // { rel, from }

/** 把一份文件/目录拷进快照的 payload 下，保持相对结构。 */
async function addToPayload(rel, from) {
  if (!existsSync(from)) {
    console.log(`  跳过（不存在）${rel}`)
    return
  }
  const to = join(outDir, 'payload', rel)
  await mkdir(dirname(to), { recursive: true })
  const info = await stat(from)
  if (info.isDirectory()) await cp(from, to, { recursive: true, force: true })
  else await cp(from, to, { force: true })
  console.log(`  收 ${rel}`)
}

// ① 工作区（白名单）
for (const rel of WORKSPACE_INCLUDE) {
  if (rel === 'critical-tools') continue
  await addToPayload(join('workspace', rel), join(HERE, rel))
}

// ② _tools 里真正有用的部分（排除纯调试 dump 与 vendor 体积）：
//    vendor/js-yaml 是闸门的**依赖**，必须带（否则还原后闸门报「缺依赖」）。
await addToPayload(join('workspace', '_tools', 'vendor', 'js-yaml'), join(HERE, '_tools', 'vendor', 'js-yaml'))
for (const name of [
  'probe-live-panel.mjs',
  'probe-live-session.mjs',
  'probe-presets.mjs',
  'read-session.mjs',
  'scan-token.mjs',
  'test-cmd.mjs',
  'asar-read.mjs',
  'asar-extract.mjs',
]) {
  await addToPayload(join('workspace', '_tools', name), join(HERE, '_tools', name))
}

// ③ 两个证据截图
for (const name of ['_session-proof.png', '_panel-proof.png']) {
  await addToPayload(join('workspace', name), join(HERE, name))
}

// ④ 主 home 的「到底装了什么」（只带补丁层与预设，不带会话/凭据）
await addToPayload(join('dsh-home', 'profiles', 'desktop', 'cordis.patch.yml'), join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'))
await addToPayload(join('dsh-home', 'profiles', 'desktop', 'package.json'), join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
await addToPayload(join('dsh-home', 'profiles', 'web', 'cordis.patch.yml'), join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'))
await addToPayload(join('dsh-home', 'profiles', 'web', 'package.json'), join(DSH_HOME, 'profiles', 'web', 'package.json'))
await addToPayload(join('dsh-home', 'settings.yaml'), join(DSH_HOME, 'settings.yaml'))

// 自定义 preset（dual）
const presetRoot = join(DSH_HOME, '.agent-presets')
if (existsSync(presetRoot)) {
  for (const entry of await readdir(presetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await addToPayload(
      join('dsh-home', '.agent-presets', entry.name),
      join(presetRoot, entry.name),
    )
  }
}

// ⑤ 桌面端 profile 里那两个 vendored 插件副本（证明「profile 里到底有哪些字节」）
for (const pkg of ['@dsh-plugin/executor-loop', '@dsh-plugin/executor-view']) {
  const from = join(DSH_HOME, 'profiles', 'desktop', 'node_modules', ...pkg.split('/'))
  await addToPayload(join('dsh-home', 'profiles', 'desktop', 'node_modules', ...pkg.split('/')), from)
}

// ⑥ 兜底 home 的配置与我的文件（不带 profiles/）
for (const rel of ['cordis.patch.yml', 'settings.yaml']) {
  await addToPayload(join('fallback-home', rel), join(FALLBACK_HOME, rel))
}
await addToPayload(join('fallback-home', 'storages', 'workspace.json'), join(FALLBACK_HOME, 'storages', 'workspace.json'))
const fbPresets = join(FALLBACK_HOME, '.agent-presets')
if (existsSync(fbPresets)) {
  for (const entry of await readdir(fbPresets, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await addToPayload(join('fallback-home', '.agent-presets', entry.name), join(fbPresets, entry.name))
  }
}
await addToPayload(
  join('fallback-home', 'profiles', 'web', 'package.json'),
  join(FALLBACK_HOME, 'profiles', 'web', 'package.json'),
)

// ⑦ 关键外部文件的指纹（**只存 sha256，不存文件本体**）
//
// 这里刻意不存 app.asar 的副本：它 161MB，而「原厂」这件事用 sha256 就能钉死。
// 曾经存过一份 `.bak-20260915-101447`，后来确认它与当前文件**逐字节相同**
// （纯重复）就删了 —— 省下 161MB。核对方法在生成的《快照说明.md》里。
const fingerprints = {}
if (existsSync(DESKTOP_ASAR)) {
  fingerprints['desktop-app.asar'] = {
    path: DESKTOP_ASAR,
    bytes: (await stat(DESKTOP_ASAR)).size,
    sha256: await hashFile(DESKTOP_ASAR),
    note: '必须是原厂版本（sha256 应为 F0BB5E28…）；改动它等于改核心程序',
  }
}

// ⑧ manifest：逐文件 sha256
console.log('\n计算 sha256 …')
const payloadRoot = join(outDir, 'payload')
const files = await listFiles(payloadRoot)
const manifestFiles = {}
let totalBytes = 0
for (const full of files) {
  const rel = relative(payloadRoot, full).replaceAll('\\', '/')
  const info = await stat(full)
  manifestFiles[rel] = { sha256: await hashFile(full), bytes: info.size }
  totalBytes += info.size
}

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  host: { platform: process.platform, node: process.version },
  paths: { workspace: HERE, dshHome: DSH_HOME, fallbackHome: FALLBACK_HOME, desktopAsar: DESKTOP_ASAR },
  fileCount: files.length,
  bytes: totalBytes,
  fingerprints,
  files: manifestFiles,
}
await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

// ⑨ 中文还原说明
const restoreDoc = `# 快照说明

**创建时间**：${manifest.createdAt}
**文件数**：${manifest.fileCount}　**总大小**：${(totalBytes / 1024 / 1024).toFixed(2)} MB

这个快照冻的是「**已验证能跑**」的那套状态。出现问题时，它是已知良好的落点。

---

## 一、目录里有什么

\`\`\`
payload/workspace/            插件源码 + 运维脚本 + 探针 + 证据截图
payload/workspace/_tools/     有用的探针，以及 vendor/js-yaml（闸门的依赖）
payload/dsh-home/             主 home 里「到底装了什么」：
                                profiles/*/cordis.patch.yml   ← 补丁层（唯一真源）
                                profiles/*/package.json
                                .agent-presets/dual/          ← 双区预设
                                profiles/desktop/node_modules/@dsh-plugin/  ← vendored 插件副本
payload/fallback-home/        兜底 home 的补丁层 / 工作区 / 预设
manifest.json                 逐文件 sha256 + 关键外部文件指纹
\`\`\`

**刻意没打包**：会话、凭据（隐私）、\`node_modules\` 与 \`_asar\`（可重建）。

---

## 二、先校验再还原（别跳）

\`\`\`powershell
node "D:\\<dsh-plugin-root>\\插件\\snapshot.mjs" --verify "${outDir}"
\`\`\`

每个文件的 sha256 都要对上。**不符就别用这个包还原。**

---

## 三、怎么还原

### 只还原插件源码与脚本（最常见）

把 \`payload/workspace/\` 覆盖回 \`D:\\<dsh-plugin-root>\\插件\\\` 即可 ——
补丁层里那些 \`file://\` 路径指向的就是这里。覆盖后跑一次总闸门：

\`\`\`powershell
node "D:\\<dsh-plugin-root>\\插件\\verify-all.mjs"
\`\`\`

### 还原补丁层（DSH 起不来时）

\`\`\`powershell
copy "${join(outDir, 'payload', 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml')}" ^
     "%USERPROFILE%\\.dsh\\profiles\\desktop\\cordis.patch.yml"
\`\`\`

然后**先跑闸门再启动**：

\`\`\`powershell
node "D:\\<dsh-plugin-root>\\插件\\repair-profiles.mjs"
\`\`\`

### 还原双区预设

\`\`\`powershell
xcopy /E /I /Y "${join(outDir, 'payload', 'dsh-home', '.agent-presets', 'dual')}" ^
             "%USERPROFILE%\\.dsh\\.agent-presets\\dual"
\`\`\`

### 还原兜底 home

先重启安装器（它会重建 junction 与工作区）：

\`\`\`powershell
node "D:\\<dsh-plugin-root>\\插件\\install-fallback-home.mjs"
\`\`\`

再把 \`payload/fallback-home/cordis.patch.yml\` 覆盖回去。

---

## 四、外部依赖的指纹（快照里没有它们，只有 sha256）

${Object.entries(fingerprints)
  .map(([name, info]) => `- **${name}**\n  - 路径：\`${info.path}\`\n  - ${info.bytes} 字节　sha256 \`${info.sha256}\`\n  - ${info.note}`)
  .join('\n')}

核对方法：

\`\`\`powershell
Get-FileHash "D:\\<dsh-plugin-root>\\DSH Desktop\\resources\\app.asar" -Algorithm SHA256
\`\`\`

---

## 五、这个快照**不**保证什么

- **不保证插件能装进一个全新环境的 DSH** —— 依赖里含绝对路径，
  快照是「同一台机器上的回退点」，不是可分发的发布包。
- **不包含 DSH 本体** —— 桌面端是安装程序装的，不在这个包里。
- **不包含会话** —— 会话在 \`~/.dsh/sessions\`，不在快照里（也**不该**在里面）。
`
await writeFile(join(outDir, '快照说明.md'), restoreDoc, 'utf8')

console.log(`\n${'='.repeat(64)}`)
console.log(`快照完成：${outDir}`)
console.log(`  文件数：${manifest.fileCount}   大小：${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  说明：${join(outDir, '快照说明.md')}`)
console.log(`\n校验：node snapshot.mjs --verify "${outDir}"`)
console.log('='.repeat(64))
