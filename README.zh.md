# dsh-autoresearch

[English](README.md) | 简体中文

用于在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中进行有界、指标驱动优化的非官方第三方插件，灵感来自 [Karpathy 的 autoresearch](https://github.com/karpathy/autoresearch)。

**独立项目：** `dsh-autoresearch` 由 [EveGoodEvening](https://github.com/EveGoodEvening) 维护，与 DeepSeek 或 Andrej Karpathy 无隶属关系，也未获得其背书或赞助。

`autoresearch` 工具先测量基线，再让智能体在隔离的 Git worktree 中编辑获准修改的文件，并且只保留严格改进的结果。评估由宿主（Host）控制；SQLite 记录结果，供检查和恢复使用。

## 支持的版本

| 组件 | 支持版本 | 已测试版本 |
| --- | --- | --- |
| DSH CLI（`@deepseek-ai/dsh`）及 DSH 服务对等依赖 | **`0.2.1-rc.2`**（精确版本，整套组件同步） | `0.2.1-rc.2` |
| Cordis（`@deepseek-ai/cordis`） | **`~4.0.5`** | `4.0.5` |
| Node.js | `^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1` | `24.22.1` |

上述支持组合已于 **2026-10-26** 验证，并通过了打包后独立安装及 Web profile 的冒烟测试。请使用**带作用域的 Cordis 分支**，而不是无作用域的 `cordis`。此 DSH 组合使用预发布版本；未声明支持其他 DSH 版本。每日的[上游兼容性检查](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/.github/workflows/compatibility.yml)不会自动扩大上述支持范围。

Node.js 的最低安全版本要求涵盖了 2026 年 10 月的 TLS/Brotli 修复和 [eMudhra CA 修复措施](https://emudhra.we-have-a-problem.com/)。请及时为宿主运行时及其操作系统的 CA 证书库安装补丁；插件的锁文件无法更新这两者。依赖审计包括开发依赖和可选依赖，并在发现 **low（低危）** 及以上级别问题时失败，而不是隐藏低危问题。

## 安装

```sh
dsh plugin --profile <name> add dsh-autoresearch
dsh --profile <name> --dump-config
```

配置输出应包含 `id: autoresearch` 和 `name: dsh-autoresearch`。请使用 `dsh plugin` 激活插件包，而不是仅运行 `pnpm add`。

宿主需要 `agents`、`jobs`、`subprocess`、`systemPrompt` 和 `tools` 服务。后台运行还要求调用工具的智能体具备 `dsh-tool-jobs`；Web 的 `standard` 预设及 base/headless 组合均提供它。

## 使用

**先注册评估器。** 由宿主管理的 `evaluatorRegistrations` 注册表默认刻意保持为空：智能体不能任意选择评估命令。下面给出一个完整的简单示例；宿主评估器计算数值与 3 的距离，而不信任模型自报的分数。它仅演示协议，不代表科学有效性。

在工作区干净且可信的 Git 仓库中，于仓库根目录创建并提交以下两个文件：

### `judge.mjs`

```js
import { readFileSync } from 'node:fs'

const { value } = JSON.parse(readFileSync('candidate.json', 'utf8'))
if (typeof value !== 'number' || !Number.isFinite(value)) {
  throw new TypeError('value must be a finite number')
}
const distance = Math.abs(value - 3)
if (!Number.isFinite(distance)) throw new RangeError('distance must be finite')
console.log(JSON.stringify({ distance }))
```

### `candidate.json`

```json
{ "value": 10 }
```

### `cordis.patch.yml`

安装插件后，将以下覆盖配置放入所选 profile 的 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（合并到已有的补丁列表中）：

```yaml
- id: autoresearch
  name: dsh-autoresearch
  config:
    defaultMaxExperiments: 20
    defaultTimeoutMs: 900000
    evaluatorRegistrations:
      - id: toy-distance
        command: node
        args: [judge.mjs]
        metricName: distance
        metricDirection: minimize
        metricParserVersion: final-line-json-v1
        evaluatorFiles: [judge.mjs]
        dataset: { kind: none }
```

profile 覆盖会替换**该行的整个 config**，而非进行深度合并。这份最小配置保留了必需的运行默认值；[Config schema](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/src/config.ts) 会为省略的部署配置填入[随包附带的补丁](cordis.patch.yml)中的默认值。替换该行时，请保留已有的部署覆盖配置、模型路由设置和评估器注册项。使用前重启该 profile，并检查 `dsh --profile <name> --dump-config` 的输出。

`node` 必须可供宿主使用。评估器以固定 argv 执行，不经过 shell；省略 `cwd` 时，工作目录为隔离评估 worktree 的根目录。它必须成功退出，且 stdout 的最后一行必须是一个**恰好只有一个键**的 JSON 对象：键为注册的指标名称，值为有限数值。本例基线的末行是 `{"distance":7}`。之前的 stdout 可以包含日志；末尾不要追加空行。`judge.mjs` 受保护，不允许候选方案修改。本例明确不使用数据集；schema 也支持受保护的本地数据集文件或通过外部标识指定的数据集。

### 调用 `autoresearch`

在该仓库中，让智能体调用：

```json
{
  "objective": "Reduce the Host-measured distance to 3 by editing candidate.json",
  "run_tag": "toy-distance-1",
  "evaluator_id": "toy-distance",
  "mutable_globs": ["candidate.json"],
  "max_experiments": 5
}
```

- `repository` 默认为智能体的工作目录。每次新运行都应使用新的、符合 Git 命名要求的 `run_tag`。
- 默认以后台任务运行。使用 `job_list`、`job_output` 和 `job_kill` 查看或停止任务；设置 `"mode": "foreground"` 可等待运行完成。
- 取消时会等待评估器清理，并协调恢复到已接受的 Git 状态；只有在终态持久化完成后才释放运行锁。
- 插件卸载或热重载会取消正在进行的运行，并等待负责提案的子智能体和任务结束。
- 可选输入：`target`（停止阈值）、`timeout_ms`（每次尝试的看门狗超时）和 `constraints`（建议性指导，不是接受规则）。
- 恢复运行时，将 `run_tag` 和 `evaluator_id` 替换为 `resume_run_id`，并保留原始运行策略。执行前会重新验证已存储的评估器注册信息。

默认值：**20 个候选方案**，部署上限 **100 个**；**每次评估尝试的看门狗超时为 15 分钟**（宿主上限 **60 分钟**）；**每个仓库最多一个活跃运行**。基线不占用候选方案名额。Git 使用独立且仅由宿主控制的限制：`gitTimeoutMs` 默认为 **900000**（整数范围 **1–2147483647**）；`gitMaxStdoutBytes` 和 `gitMaxStderrBytes` 各默认为 **1048576**，不受评估器输出上限影响。部署限制和保留策略请参阅 [Config](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/src/config.ts)。

## 行为与安全

- **有界标量搜索。** 先测量基线；仅最小化或最大化一个标量，并且只接受严格改进。`constraints` 和审批指导仅具建议性，不是接受规则，也不授予权限。强制人工审批必须由宿主策略实施。这并不能证明科学有效性或资源分配的公平性。
- **有限的修改范围与溯源信息。** 只允许修改 `mutable_globs` 匹配的文件；声明的评估器文件和本地数据集文件对候选方案只读。SQLite 记录决策以及有界的评估器、数据集和策略证据；恢复时会重新验证，发现不匹配或旧版注册信息时拒绝继续。这些信息并不能完整标识运行时镜像。
- **受管执行，不等于安全隔离。** 评估通过 `ctx.subprocess` 使用固定的 argv 和环境，不经过 shell，并限制 stdout/stderr 采集量、为每次尝试设置看门狗、支持取消与终止，以及在继续前确认进程树已停止运行。只有受管清理完成后才会结束；看门狗并不等于算力预算。Git worktree 和上述生命周期**不能**限制文件系统访问、其他进程、网络、权限或同 UID 的恶意干扰。请使用可信代码；要支持恶意代码，必须引入外部隔离提供方，并由宿主或产品层明确决定，不能只依赖本插件。
- **存在不确定性时拒绝继续。** 提案、报告或策略错误会终止运行；候选方案的评估器失败若已确认相关进程安全停止，则消耗一个候选名额，但运行可以继续。基线失败会停止运行；进程状态不确定时会阻止恢复或继续。宿主异常退出后的崩溃接管需要 Linux `/proc` 证据；其他平台仍会保守地阻止接管。
- **公开元数据不是秘密。** 指标名称、方向、解析器，评估器 ID，以及生成的工作区、分支和提交标识会有意提供给负责提案的子智能体；切勿把凭据放入这些字段。不会转发评估器的原始 argv 或环境变量映射。对允许处理的不可信展示或历史数据，只能按已知值进行有限的精确脱敏，并不提供普遍的保密保证。

## 开发

使用 **pnpm 11.7.0**。先构建再测试：集成测试会加载 `lib/`。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run release:smoke
```

`release:smoke` 会在源码检出目录之外检查打包安装和真实 DSH Web profile。请在测试结束后运行，不要并发执行：打包会重新构建 `lib/`。

本地安装时，先构建，再运行 `dsh plugin --profile <name> add .`。发布使用[发布工作流](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/.github/workflows/publish.yml)，通过 npm Trusted Publishing 和匹配的 `v<package-version>` 标签完成。

发布历史请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE) © 2026 EveGoodEvening

源码归属和上游许可证声明保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。
