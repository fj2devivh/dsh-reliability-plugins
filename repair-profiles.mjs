/**
 * repair-profiles.mjs —— 一键把两个 profile 的补丁层修好并**当场验证**。
 *
 * ## 什么时候用
 *
 * DSH 起不来（桌面端进恢复模式 / Web UI 起不来），而日志里只有
 * `DSH Host exited (1)`、宿主日志一个字都没写的时候 —— 先跑这个。
 * 它只碰补丁层与插件副本，**不动会话、凭据、设置**。
 *
 * ## 它做什么
 *
 * 对 `desktop` 与 `web` 各跑一遍：
 *   1. 用**存量修复**（`patch-yml-normalize.mjs`）把所有游离的 `[]` 占位标量清掉，
 *      保证 `cordis.patch.yml` 是**唯一一份**顶层 YAML 数组 ——
 *      这是 2026-09-15「桌面端怎么也打不开」的机制：模板占位 `[]` 被留在两个
 *      insert 段之间，成了第二个顶层文档，YAML 解析直接抛错。
 *   2. 确保两个插件的可加载副本在位（`<profile>/node_modules/@dsh-plugin/...`）。
 *   3. 跑两道闸门：真 js-yaml 解析 + 真 dsh-app-boot 组合。
 *
 * ## 为什么「先修再验」而不是直接重写
 *
 * 直接重写补丁文件会**丢掉你在里面的手写条目**。存量修复只动坏掉的那部分，
 * 其余一字不改 —— 修不动的（例如根本不是 `[]` 而是别的问题）会被闸门拦下，
 * 那时再决定要不要重装。
 *
 * 用法：
 *   node repair-profiles.mjs            # 修 desktop + web
 *   node repair-profiles.mjs desktop    # 只修一个
 *   node repair-profiles.mjs --check    # 只报告，不写
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const check = args.includes('--check')
const requested = args.filter((arg) => !arg.startsWith('-'))
const profiles = requested.length > 0 ? requested : ['desktop', 'web']

for (const profile of profiles) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile)) {
    console.error(`repair: profile 名不合法：${JSON.stringify(profile)}`)
    process.exit(2)
  }
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
console.log(`repair: DSH_HOME = ${dshHome}`)
console.log(`repair: profiles = ${profiles.join(', ')}${check ? '  (--check：只报告不写)' : ''}`)

const runScript = (file, argv, { optional = false } = {}) => {
  const script = join(HERE, file)
  if (!existsSync(script)) {
    if (optional) return { skipped: true }
    console.error(`repair: 缺少脚本 ${file} —— 拒绝在没有闸门的情况下收工。`)
    process.exit(1)
  }
  try {
    const out = execFileSync(process.execPath, [script, ...argv], { encoding: 'utf8', timeout: 300_000 })
    return { out, code: 0 }
  } catch (error) {
    return { out: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.status ?? 1 }
  }
}

let failed = false

for (const profile of profiles) {
  const profileDir = join(dshHome, 'profiles', profile)
  console.log(`\n${'='.repeat(64)}`)
  console.log(`repair: ${profile}`)
  console.log('='.repeat(64))

  if (!existsSync(profileDir)) {
    console.log(`repair: 跳过 —— profile 目录不存在（${profileDir}）`)
    continue
  }

  // ── 1) 存量修复补丁层 ──
  const normalizeArgs = check ? [profile, '--check'] : [profile]
  const normalized = runScript('patch-yml-normalize.mjs', normalizeArgs, { optional: true })
  if (normalized.skipped) {
    console.log('repair: （没有 patch-yml-normalize.mjs，跳过存量修复）')
  } else {
    process.stdout.write(normalized.out ?? '')
    // --check 下退出码 1 表示「需要修复」，不是失败。
    if (normalized.code !== 0 && !check) {
      console.error(`repair: ${profile} 的补丁层存量修复失败。`)
      failed = true
    }
  }

  // ── 2) 插件副本是否在位 ──
  const vendored = []
  for (const pkg of ['@dsh-plugin/executor-loop', '@dsh-plugin/executor-view']) {
    const index = join(profileDir, 'node_modules', ...pkg.split('/'), 'index.js')
    const present = existsSync(index)
    if (!present) vendored.push(pkg)
    console.log(`repair: ${present ? 'ok  ' : 'MISS'} ${pkg}`)
  }
  if (vendored.length > 0) {
    console.log(
      `repair: 缺 ${vendored.join(', ')} —— 用安装器补：\n` +
        (profile === 'web'
          ? '        node install-web-profile-plugins.mjs web'
          : '        node install-profile-plugins.mjs desktop --force 然后依次跑两个安装器'),
    )
  }

  // ── 3) 两道闸门 ──
  for (const [file, label] of [
    ['verify-patch-yml.mjs', '真 js-yaml 解析'],
    ['verify-profile.mjs', '真 dsh-app-boot 组合'],
  ]) {
    const result = runScript(file, [profile], { optional: true })
    if (result.skipped) {
      console.log(`repair: （缺 ${file}，跳过「${label}」）`)
      failed = true
      continue
    }
    process.stdout.write(result.out ?? '')
    if (result.code !== 0) {
      console.error(`repair: 闸门「${label}」未通过 —— ${profile} 仍然是不安全的。`)
      failed = true
    }
  }
}

console.log(`\n${'='.repeat(64)}`)
if (failed) {
  console.error('repair: 有未通过的项目（见上）。**不要**在这种情况下启动 DSH —— 先把上面的失败项解决。')
  process.exit(1)
}
if (check) {
  console.log('repair: --check 完成（未写入）。若上面报告「需要修复」，去掉 --check 再跑一次。')
  process.exit(0)
}
console.log('repair: 全部通过。两个 profile 的补丁层都是合法的单文档 YAML，插件行都在有效 entry 列表里。')
console.log('repair: 生效 —— 桌面端重启 DSH Desktop；Web UI 会热更新补丁层，浏览器刷新一次页面。')
