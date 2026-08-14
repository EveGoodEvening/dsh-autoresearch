# dsh-autoresearch

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的指标驱动自主研究插件。它把 Karpathy `autoresearch` 的实验循环实现为普通 Cordis Plugin，不修改 `agent-loop`：

- `ctx.workflowEngine` 运行固定编排脚本；
- `ctx.subagents` 为每次实验启动一个全新 agent；
- 共享 Git 工作区和未提交的 TSV 结果表承担跨实验长期记忆；
- `ctx.jobs` 默认把整轮研究作为后台任务运行；
- `job_list`、`job_output`、`job_kill` 继续负责通用后台任务观察和停止。

## 原理

Karpathy `autoresearch` 的核心不是某个训练脚本，而是一个受控的自动优化协议：

1. **缩小可变面**：只允许修改明确列出的文件；数据、评估和约束保持固定。
2. **固定评估预算**：每个候选运行同一条命令，并受同一个墙钟超时限制。
3. **单一可比较指标**：每次实验都产出一个标量，明确 `minimize` 或 `maximize`。
4. **先跑基线**：第一轮不改代码，只建立当前提交的可复现实测值。
5. **Git 作为事务边界**：候选先提交再评估；严格改善才保留，否则回退到最佳提交。
6. **结果表作为研究记忆**：每轮把实验号、提交、指标、状态和说明写入未提交 TSV。
7. **持续迭代**：在目标指标、实验上限或真实阻塞条件出现前，不向人类请求逐轮确认。

本插件保留这些约束，同时采用 dsh 已有的工作流、subagent 和 jobs 插件完成编排。

## 与原版的差异

原版让同一个 agent 长时间循环。本插件每个实验使用新的 child agent，只传递有界结构化报告；Git 工作区和 TSV 才是权威状态。这样可避免长会话上下文持续膨胀，并迫使每轮重新核对实际分支、HEAD、结果表和允许修改的文件。

插件仍然是提示词约束的研究执行器，不是文件系统安全边界。真正的不可信代码需要另外组合容器、远程 sandbox 或更严格的 `fs`/`shell` provider。

## 安装

当前实现面向 `deepseek-harness` 源码中的 `0.1.0-rc.5` API。安装到已有 profile：

```bash
dsh plugin --profile web add /path/to/dsh-autoresearch
dsh --profile web --dump-config
```

源码开发时，先构建：

```bash
pnpm install
pnpm run build
```

从 Git 地址安装会执行 `prepare` 构建脚本；pnpm 10+ 需要用户显式允许该包的安装时构建。发布 npm 包或 tarball 时应预先包含 `lib/`，避免安装时构建权限。

## 使用

先保证项目本身满足以下条件：

- 位于 Git 仓库中；
- 当前工作不会与新研究分支冲突；
- 评估命令能稳定打印指定标量指标；
- 评估命令自己不改变受控输入或提交研究日志；
- `mutable_files` 足够窄，且包含完成实验所需的全部可写源码。

然后直接明确要求 dsh 启动 autoresearch，例如：

```text
请启动 autoresearch：
- objective: 在固定 5 分钟训练预算下降低 val_bpb
- run_tag: aug14-h100
- mutable_files: [train.py]
- evaluation_command: uv run train.py
- metric_name: val_bpb
- metric_direction: minimize
- experiment_timeout_minutes: 10
- max_experiments: 100
- constraints:
  - 不修改 prepare.py
  - 不增加依赖
  - results TSV 不提交
```

模型会调用 `autoresearch` 工具。默认立即返回 `autoresearch-N` job id；随后可使用：

```text
列出后台任务
读取 autoresearch-N 输出并等待完成
停止 autoresearch-N，原因是人工中止
```

需要同步等待时，令工具参数 `run_in_background: false`。

## Tool 参数

| 参数 | 必需 | 含义 |
|---|---:|---|
| `objective` | 是 | 整轮研究不可变的优化目标。 |
| `run_tag` | 是 | 新分支标签；最终分支为 `<branchPrefix><run_tag>`。只接受小写 Git-safe 文本。 |
| `mutable_files` | 是 | 实验允许修改的相对文件或 glob；至少一个。 |
| `evaluation_command` | 是 | 每个基线和候选都必须执行的单行命令。 |
| `metric_name` | 是 | 从评估输出读取的标量名称。 |
| `metric_direction` | 是 | `minimize` 或 `maximize`。 |
| `experiment_timeout_minutes` | 是 | 每次评估的正整数墙钟上限。 |
| `constraints` | 否 | 额外不可变限制。 |
| `max_experiments` | 否 | 本次实验数；不得超过部署上限。 |
| `target_metric` | 否 | 达到后提前结束的指标阈值。 |
| `run_in_background` | 否 | 默认 `true`；设为 `false` 同步等待。 |

## Plugin 配置

`cordis.patch.yml` 提供以下默认值：

| 配置 | 默认值 | 含义 |
|---|---:|---|
| `subagentProvider` | `spawn` | 每轮使用的全新 structured-output provider。 |
| `maxExperiments` | `100` | 默认实验数，也是单次调用上限。 |
| `maxHandoffChars` | `16384` | 单轮结构化报告的最大字符数。 |
| `maxResultChars` | `16384` | 最终模型可见结果的最大字符数。 |
| `resultsFile` | `autoresearch-results.tsv` | 未提交 TSV 结果表的相对路径。 |
| `branchPrefix` | `autoresearch/` | 新研究分支前缀。 |

profile 的 `cordis.patch.yml` 可以按 `id: autoresearch` 覆盖整段配置：

```yaml
- id: autoresearch
  config:
    subagentProvider: spawn
    maxExperiments: 200
    maxHandoffChars: 16384
    maxResultChars: 32768
    resultsFile: research/results.tsv
    branchPrefix: autoresearch/
```

dsh patch 按行替换整个 `config`，不是深度合并；覆盖时需要重述所有希望保留的字段。

## 实验状态

每个 worker 必须返回以下状态之一：

- `baseline`：仅第一轮；指标为数字，候选提交等于最终 HEAD。
- `keep`：指标严格优于之前最佳值，最终 HEAD 保留候选提交。
- `discard`：指标未改善，最终 HEAD 已恢复最佳提交。
- `crash`：评估失败或超时，指标为 `null`，最终 HEAD 已恢复最佳提交。
- `blocked`：无法安全继续的具体条件；指标为 `null`，不允许用困难、不确定或暂时缺少想法冒充阻塞。

工作流会再次校验这些关系。`keep` 与最佳指标方向不一致、`discard` 没有回退、报告过大或结构错误都会使整轮 workflow 明确失败。

## 停止条件

一次 run 只会因为以下原因结束：

- 达到 `target_metric`；
- 达到 `max_experiments`；
- worker 报告并证明具体 blocker；
- child/workflow 基础设施失败；
- 用户通过 job 或父请求取消。

这是有界的“持续研究”，不是无限、不可管理的宿主循环。需要通宵运行时，把 `maxExperiments` 配成符合机器预算的明确上限。

## 已知限制

- 文件范围、超时命令执行和 Git 操作由 child agent 按固定协议执行；插件会校验结构化结果，但不会独立重跑命令或审计文件 diff。
- fresh child 的完成、指标和 Git 证据仍是 worker 报告；下一轮会重新检查工作区，但没有独立 evaluator agent。
- 结果表是进程外长期记忆，但 workflow 本身没有断点恢复；进程退出后应以现有分支和 TSV 启动新的、显式设计的续跑，而不是复用同一 `run_tag`。
- `workflow-worker-thread` 的 worker/vm 是 API 隔离，不是安全 sandbox。
- 默认 bundle 依赖 dsh base 已提供 `jobs`、`tool-jobs`、`subagents` 和 `workflowEngine`；裁剪过的自定义 profile 必须自行组合这些服务。

## 开发验证

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

测试包含真实 `workflow-worker-thread` 和真实 `SubagentRuntime` 的固定三轮实验：baseline、严格改善并保留、回退非改善候选。
