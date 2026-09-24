# @dsh-plugin/intent-guard

意图层的两道闸门，一条比一条狠：

1. **手绑住**：给**本 preset 的每个顶层会话**套上 `ctx.tools.restrict({ deny: [write, edit] })`
   —— 意图层不能动手改文件（实现只能交给它派出去的执行层；子 agent 不锁，照旧可写）。
2. **眼睛蒙上 —— 能力级的**（2026-09-19）：把 `read` / `read_image` / `glob` / `grep` / `pwsh` / `bash`
   从它的工具表里**整个拿掉**，另给两个只能看「指南针」的只读工具（`read_compass` / `list_compass`）。
   于是它**没有工具**能打开源码、日志、或者名单外的现场数据 —— 不是"拦一下"，是那些工具在它的
   模型可见面上**不存在**。

`package.json` 里那份白名单（`files: ["index.js", "README.md"]`）从本文件起不再点空文件。

## 一、两道闸门各是什么强度（别把两件事混起来）

| 闸门 | 手段 | 强度 | 拦得住什么 |
|---|---|---|---|
| **手绑住** | `tools.restrict({ deny: [write, edit] })` | 工具级 | 它连"能改"这个选项都看不见 |
| **眼睛蒙上** | 同样用 `restrict`，**逐个名字**把"眼睛"拿掉 + 只留指南针 | **能力级** | 它**没有** read/glob/grep/pwsh 这些工具可用 |

⚠️ 说清边界（不吹）：这两条都是**工具 schema 级**的，不是文件系统级沙箱。
理论上它仍可以**派人**去看（`subagent` / `dispatch_audit` 是它合法的干活手段）——
但那是「它读到报告」，不是「它自己趴到工地上」，两件事的后果差很远。
真要连这条路也堵死，得在环境层做只读挂载。

## 二、眼睛蒙上：意图层只准看报表

用户的原话（2026-09-19，架构级修正）：

> 「'意图层本来也需要重新跑一遍执行层的代码，用来检测执行层有没有搞出来问题'
> —— **这就是它越界了，也是它被污染、变蠢、最后搞发明的根本原因。**」
> 「他不仅查不出真正的结构问题，还会被工地的灰尘呛死，最后满脑子都是'这堵墙的水泥标号不够'，
> 完全忘了大楼的整体设计。」
> 「**把它的眼睛蒙上，只允许它看报表。把它的手绑住，只允许它写任务。**」
> 「**严禁意图层读取原始代码、原始报错日志。意图层只能接收由审计层生成的《结构化验收报告》。**」
> 「是需要**能力级的不可看**，只有那些最重要的东西作为意图层的指南针，
> 因为意图层就**必须贯彻我的意志，不能自作主张**。」

### ① 能力级那一层：那些工具**不在它手里**

`config.eyes`（默认 `['read','read_image','glob','grep','pwsh','bash']`）里的名字会被
**逐个** `tools.restrict({ deny: [名字] })` 拿掉。真 `ToolRuntime` 上的实测结果：

```
意图层看得见的工具（4）：subagent, dispatch_audit, read_compass, list_compass
执行层看得见的工具（11）：read, read_image, glob, grep, pwsh, write, edit, subagent, dispatch_audit, read_compass, list_compass
```

（这是 `dsh-executor-gate\_verify-tool-register.mjs` 第 4 节的真实输出 —— 它用**真**
`ToolRuntime` + **真** scoped agent ctx 验的，不是替身。）

三个必须知道的细节：

- **逐个名字下发**，而不是一次交一张名单。真 `restrict()` 对未知名字是**响亮失败**的：
  一次交整张名单，产品改一个名字就会让**整条掩码一条都装不上**，而意图层照旧握着 `read`。
  逐个下发之后，改名的那个只跳过它自己，其余照常生效。
- 跳过还分两种：**本组合里本来就没有**（例如 Windows 上没有 `bash`）⇒ 记 info；
  **存在却没拿掉** ⇒ 记 **warn**（"它的眼睛还睁着"）。这是唯一能发现"以为蒙上了其实没蒙"的报警器。
- 掩码按 **scope** 生效 ⇒ 只作用于意图层自己；它派出去的执行层与审计层照旧有全套工具。

### ② 指南针：它**唯一**能自己打开的东西

`read_compass({ path, offset?, limit? })` 与 `list_compass({ pattern? })`。
它们的实现里**只有一条白名单**（就是 `cleanRoom.allow`，一处定义两处用）：

| 它想打开 | 结果 |
|---|---|
| 人的原话与判据（`notes/**/*.md`、`notes/_user_requirements.json`） | 放行（带行号，方便引用 `:432-493`） |
| 终局定义 / 任务 / 台账 / 历史 / **《鉴证报告》**（`notes/_endstate/**`） | 放行 |
| 源码（`private_app/**`、`**/*.py`…）、原始日志、现场数据（`_state.json`、`_pair_v6.json`、`*.csv`） | **打不开**（不在名单里） |
| 绝对路径（`C:\…`、`/etc/…`、UNC）、任何带 `..` 的路径 | **打不开**（结构性拒，不做"解析之后再判"） |
| 目录、二进制、超大文件 | **打不开**（并说清该用哪个工具） |

## 三、第二层（guard）：给"拿不掉的名字"兜底

`judgeCleanRoom(tool, args, policy)` 是**纯函数**，按路径/命令判：

| 它想干什么 | 结果 |
|---|---|
| 读 `notes/AGENTS.md`、`notes/**/*.md`、`notes/_endstate/**`（原话、判据、任务、**鉴证报告**） | 放行 |
| 读 `private_app/**`、`scripts/**`、`**/*.py`、`**/*.js` …（**源码**） | **拒**，并告诉它该去派审计 |
| 读 `*.log`、`_r*_work/**`、stdout/stderr 转储（**原始日志**） | **拒**，同上 |
| **读名单外的任何东西**（`_pair_v6.json`、`*.csv`、`*.npy`…"跑出来的现场"） | **拒**（`onlyAllow`），并告诉它"要人放宽" |
| 用 shell 读上面那些路径 / 跑项目代码 | **拒**（这一档正常情况连工具都没有了） |

⚠️ **这一层才是启发式**（第一层不是）。它存在的意义只有两个：
某个名字在本组合里不存在、掩码没装上时兜住它；以及万一还有别的工具带着路径参数碰现场。

### 为什么是 `onlyAllow`（"只能"）而不是一张黑名单

黑名单**永远做不到"只能"**：漏掉一个扩展名（`.json` / `.csv` / `.txt` / `.npy`…），
意图层就能接着读现场的泥浆 —— 那正是它"变蠢、搞发明"的入口。
所以默认 `cleanRoom.onlyAllow: true`：**能读的只有 `allow` 里那几样，其余一律拒**。

拒绝理由必须回答两个问题（不然它就是一句"不行"）：

- **我该看什么**：`measure_gap` / `next_action` 把"现在差多少"算给你；`dispatch_audit` 把"到底行不行"跑给你；
- **人要怎么放宽**：把东西写进 `notes/` 的 `.md`，或让人在 preset 配置里把这一个路径加进 `cleanRoom.allow`
  —— **只有人能放宽它**（与"终局只能由人写"同一条原则）。

```yaml
# 想放宽（人改，AI 改不了这个文件）：
config:
  cleanRoom:
    onlyAllow: true            # 关掉它就退回黑名单模式（不推荐）
    allow: ['notes/**/*.md', 'notes/_endstate/**', '判据/**/*.md']
    deny:  ['**/*.py', '**/*.log', '_r*_work/**']   # 这一栏只影响"拒绝时说的话"
```

### 如实标注的边界

**这一层是启发式**，拦的是"顺手就看"，不是"铁了心要绕"。
但**能力级那一层不是**：`read`/`glob`/`grep`/`pwsh` 这些工具**不在它手里**（上面第 ① 节，
真 `ToolRuntime` 上验过）。所以"绕过"这件事的代价被抬到了"必须派人去看"——
那是「它读到报告」，不是「它自己趴到工地上」。

## 三、`runDeny` 那串解释器（"不许跑项目代码"）

老的、**已被用户否决**的理由是"有些错误不跑就查不出来，所以意图层要亲自跑一遍"。
用户的原话把它推翻了：**那就是越界**。

现在：验收一律走审计层（`dispatch_audit`）—— 它黑盒跑、不能写文件、必须带负对照，
跑完只交一份《鉴证报告》到 `notes/_endstate/audits/`。
而意图层**连 shell 都没有了**（`pwsh`/`bash` 在 `eyes` 里），所以 `runDeny` 这一档
只在"某个名字没拿掉"时才起作用 —— 它是兜底，不是主闸。

## 四、怎么跑回归

```
node "D:\<dsh-plugin-root>\插件\dsh-intent-guard\smoke.mjs"
```

- 全绿 → 退出码 `0`；有断言失败 → `1`；**缺依赖 → `2`**（打印「缺依赖，不是插件坏了」，不伪装成断言失败）。
- 它做六件事：①从 `resources/app.asar` 里各 `@deepseek-ai/dsh-tool-*` 包的 `defineTool({ name })` 字面量读出**真工具名**，
  再与本机 preset/base 组合里**真正挂载**的工具取交集；②用**真 `Context`** 跑**真 `apply`**（不重写 apply 逻辑）；
  ③断言掩码覆盖写类工具**与那些"眼睛"**，且**不误删干活要用的**（`subagent` / `dispatch_audit` / 指南针）；
  ④负对照：少一个写类 / 少一个"眼睛" / 误删干活工具 / `restrict` 拒绝时**都必须变红**；
  ⑤**指南针**：真文件真读 —— 原话/判据/报告读得到，源码/现场数据/`..` 逃逸/绝对路径/目录/二进制/超大文件全都读不到；
  ⑥第二层 guard 的路径判据（源码、原始日志、名单外现场、shell 绕道、跑项目代码）。
- **能力级那一层还有一条独立的硬证据**在
  `dsh-executor-gate\_verify-tool-register.mjs` 第 4 节：真 `ToolRuntime` 上打印
  `tools.schemas(意图层)`，断言里面**没有** `read`，而执行层**有**。
- 依赖两个**共享**自带依赖（不是本目录的副本）：
  `插件\_tools\vendor\node_modules\@deepseek-ai\cordis`（真 Cordis 运行时）
  与 `插件\_tools\vendor\node_modules\@deepseek-ai\dsh-scope`（铸造真实 scoped agent ctx）。
  两者缺一即 `exit 2`。

## 五、它怎么被加载（改完什么时候生效）

由 preset 按**源码绝对路径**直接加载，不走 profile 副本：

```yaml
# C:\Users\<你>\.dsh\.agent-presets\dual\agent.cordis.yml:444
- id: intent-guard
  name: file:///D:/deepseek%20harness/%E6%8F%92%E4%BB%B6/dsh-intent-guard/index.js
```

⚠️ **它是宿主半**：改了 `index.js`（例如这次加的无菌室），**必须重启 DSH Desktop** ——
组合文件一个字没动，`dsh-agent-presets` 的常驻挂载（standing mount，按组合文件的 `{mtimeMs,size}` 判要不要重建）
会**连新对话也照用旧的**。开新对话对它是**无效动作**。详见 `重要-先看这个.md` 第七之二节。

## 六、两条硬要求（都有事故背景）

1. **`apply` 绝不抛错。** 2026-09-15 01:01：客户端/宿主插件在 apply 阶段抛错会让**整个窗口/会话起不来**。
   真要报错就 try/catch 兜住并留 `console.error`/`logger.warn` 痕迹 —— 现状：掩码失败只告警，不断线。
2. **`tools.restrict()` 对未知名字是响亮失败的。** 名单里写一个本组合没挂载的名字（例如本机没挂的
   `str_replace_editor`），那**一个**名字会被拒绝 —— 所以现在是**逐个名字**下发：
   拒绝的只跳过它自己，其余照旧生效，并且跳过的那个会被点名（存在却没拿掉 = warn）。
   这套交集由 `smoke.mjs` 从 app.asar + 组合文件两头取，逐个名字对过。
