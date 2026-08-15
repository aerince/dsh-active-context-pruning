# dsh-active-context-pruning

把 OpenCode ACP（Active Context Pruning）的原理接到 DeepSeek Harness：模型自己选范围、自己写摘要，真正从下次请求里藏掉历史。

**不是**官方 `@deepseek-ai/dsh-acp`（那是 Agent Client Protocol）。

## 和官方 compaction 的关系

DSH 已有 `ctx.compaction.compactRegion`：用一条带 `surfaceOp: replace` 的 user 检查点替换一段表层。本插件不重做这套事务。

差异只有谁写摘要：

- 官方 `dsh-compaction-basic`：到阈值后另开一次 `llm.stream()` 摘要
- 本插件：模型调用 `acp_compress`，摘要走 `summarize()` 钩子，再调用同一个 `compactRegion`

官方自动压缩默认保留，作为溢出兜底。只要模型驱动、不要自动摘要，在 profile 里把 `@deepseek-ai/dsh-compaction-basic` 的 `auto` 设为 `false`。

## 模型工具

| 工具 | 作用 |
|---|---|
| `acp_status` | 用量、表层 seq 表、检查点 |
| `acp_compress` | `start`/`end` 表层 seq + `summary`，替换该范围 |
| `acp_decompress` | 读出被藏原文；**不**恢复表层 |
| `acp_search` | 搜表层和已压缩原文 |

人类命令：`/acp` 只看状态。

ID 用 DSH 表层 seq（`compactRegion` 的原生单位），不是 OpenCode 的 `m00001`。

## 限制

- 解压不能撤销 `replace`。原文仍在 `session.events`，只作为工具结果返回。
- 不能压最新 `preserveRecent` 条表层（默认 2，含当前未闭合工具调用）。
- 范围必须工具配对平衡，摘要必须比被藏内容短，否则官方引擎会拒绝。

## Config

```yaml
- id: active-context-pruning
  config:
    enabled: true
    minContextLimit: "60%"
    maxContextLimit: "70%"
    preserveRecent: 2
    minTokens: 200
    nudge: true
```

行级 `config` 是整行替换，不是深合并。以后改这一行要把全部键写全。

## Install

`github:aerince/dsh-active-context-pruning` 这条 spec 对所有人一样。前面的命令不是。

官方安装器是 `dsh plugin --profile <profile> add`，在该 profile 目录里转发给 pnpm。前提：`dsh` CLI、`pnpm`、`git`。本包无 `prepare`，不用改 `allowBuilds`。

Desktop 默认 profile 是 `web`：

```sh
dsh plugin --profile web add github:aerince/dsh-active-context-pruning
```

其他 profile 把 `web` 换成你的名字。没有 CLI 时，在 Desktop 插件面板粘贴同一条 `github:aerince/dsh-active-context-pruning`。

钉到 v0.1.0：

```sh
dsh plugin --profile web add github:aerince/dsh-active-context-pruning#5ecc5eb
```

`dsh` 写的是 `$DSH_HOME/profiles/<profile>`。Desktop 和独立 CLI 的 home 可能不是同一处；装进看不见的 profile 等于没装。然后重启 DSH。需要已加载的 `tools`、`compaction`、`tokenMeter`（Desktop 默认都有）。

## Verify

```sh
dsh --profile web --dump-config
node check.js
```

配置树里应有 `active-context-pruning`。新会话里应能看到 `acp_*` 工具和 `/acp`。

## Remove

```sh
dsh plugin --profile web remove dsh-active-context-pruning
```
