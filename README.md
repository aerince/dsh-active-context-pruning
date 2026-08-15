# dsh-active-context-pruning

让 DeepSeek Harness 的模型自己决定哪些历史值得压缩、自己写检查点摘要，再通过官方 `ctx.compaction.compactRegion` 从下一次请求的表层中隐藏这段历史。

这不是官方 `@deepseek-ai/dsh-acp`；后者指 Agent Client Protocol。本插件只复用 DSH 已有的 compaction 事务，不修改原始 `session.events`。

## 功能

| 工具 | 作用 |
|---|---|
| `acp_status` | 用量、表层 seq 表、检查点 |
| `acp_compress` | 用模型提供的 `summary` 替换一个表层 seq 范围 |
| `acp_decompress` | 读取被隐藏的原文；不撤销表层替换 |
| `acp_search` | 搜表层和已压缩原文 |

`/acp` 是给人看的状态命令。工具使用 DSH 的表层 seq，不是 OpenCode 的 `m00001`。

官方 `dsh-compaction-basic` 自动压缩仍可作为兜底。若只想让模型主动压缩，可在 profile 中将其 `auto` 设为 `false`。

## 配置与限制

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

`config` 是 profile patch 行的完整替换，不是深合并；修改时请保留所有需要的键。

## 安装

官方 CLI 的正确格式是 `dsh plugin --profile <profile> add <source>`。Desktop 默认使用 `web` profile；如果使用其他 profile，请替换 `web`。

```sh
# 最新 main
dsh plugin --profile web add github:aerince/dsh-active-context-pruning

# 可复现安装：v0.1.0 release
dsh plugin --profile web add github:aerince/dsh-active-context-pruning#v0.1.0

# 不可变 commit pin
dsh plugin --profile web add github:aerince/dsh-active-context-pruning#5ecc5eb1c0380fd6d0b3be1354f1ba3b1405b37f
```

本包是零构建 JavaScript，没有 `prepare`，不需要为它添加 pnpm `allowBuilds`。安装前提是可用的 `dsh`、`pnpm` 和 `git`。没有 CLI 时，可在 Desktop 插件面板粘贴同一个 `github:` source spec。

DSH 会把插件写入 `$DSH_HOME/profiles/<profile>`；请确认 CLI 与 Desktop 使用的是同一个 DSH home。安装后重启 DSH。

## 验证与卸载

```sh
dsh --profile web --dump-config
# 在源码目录运行纯函数自检（可选）
node check.js
```

配置树中应出现 `active-context-pruning`；新会话中应出现 `acp_*` 工具和 `/acp`。实际调用 `acp_compress` 前，还需要加载提供 `ctx.compaction.compactRegion` 的 `@deepseek-ai/dsh-compaction-basic`。

## 卸载

```sh
dsh plugin --profile web remove dsh-active-context-pruning
```

## DSH 官方安装对照

本仓库按 DSH 当前官方基线（`deepseek-ai/deepseek-harness` commit `47f943859bef60e4160492346772ded9b24f765a`）核对：

| 官方要求 | 本项目 |
|---|---|
| 普通 package entry | `package.json` → `index.js` |
| `dsh.bundle.patch` | 已配置 `./cordis.patch.yml` |
| YAML patch 的 `name` 可解析 | `dsh-active-context-pruning` 与 package name 一致 |
| Git source 可直接安装 | 零构建 JS，无 `prepare` |
| profile 安装命令 | 使用 `dsh plugin --profile web add github:...` |
| 安装后验证 | 使用 `dsh --profile web --dump-config` |

官方参考：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md>、<https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/plugin.ts>。

## 安全与权限

插件是 host plugin，需要 `tools`；自身不发起网络请求，也没有 `prepare` 安装脚本。它通过 DSH compaction API 替换表层范围，原始事件仍保存在 session log 中。

## License

MIT
