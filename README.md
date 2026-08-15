# dsh-autoresearch

DeepSeek Harness 的可选插件：将 **Karpathy-style autoresearch** 实现为在隔离 Git worktree 中运行的有界、指标驱动、可审计自动优化循环。

## 核心特性

- 先跑 baseline，再开始实验；只接受严格更优结果（平局拒绝）
- Agent 负责提出和实现改动；宿主负责评估、决策、Git 与持久化
- 每个 run 使用独立 branch/worktree，不修改调用者工作区
- evaluator 使用无 shell 的 `command + args`，只读取最后一行 JSON 标量指标
- SQLite 保存完整状态与证据；支持后台任务、取消和按 `run_id` 恢复
- 通过 `mutable_globs` 限制可修改范围，实验数、超时和输出均有上限

## 安装

要求 Node.js `^22.19.0 || >=24.0.0`，以及已配置的 DeepSeek Harness。

```bash
pnpm add dsh-autoresearch
```

在 DSH profile 中启用 bundle：

```json
{
  "dependencies": {
    "dsh-autoresearch": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-autoresearch"]
    }
  }
}
```

插件会注册 `autoresearch` 工具。仅在用户明确要求自主指标优化时使用。

## 最小调用

```json
{
  "objective": "降低基准耗时，同时保持测试通过",
  "run_tag": "benchmark",
  "mutable_globs": ["src/**/*.ts"],
  "evaluation": {
    "command": "node",
    "args": ["scripts/benchmark.mjs"]
  },
  "metric_name": "duration_ms",
  "metric_direction": "minimize",
  "max_experiments": 20
}
```

Evaluator 必须以一行 JSON 结束：

```json
{"duration_ms": 123.4}
```

默认后台运行；使用 DSH 通用 job 工具查看或停止。恢复运行时传入 `resume_run_id`，不要同时传 `run_tag`。

## 安全边界

- evaluator、数据集、依赖、submodule 和 Git 配置默认不可修改
- 需要例外时显式配置 `exceptional_allowlists`
- baseline 失败会终止为 `baseline-blocked`
- 达到目标、实验预算、阻塞、轮次失败或取消时停止

## 开发

```bash
pnpm install
pnpm check
pnpm release:smoke
```

License: MIT
