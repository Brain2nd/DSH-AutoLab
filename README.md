# dsh-autolab-plugins

DeepSeek Harness (DSH) 的 AutoLab 自动化研究插件组合仓库。

一个仓库、两个插件：

| 目录 | 包名 | 作用 |
|---|---|---|
| [`dsh-autolab/`](./dsh-autolab) | `dsh-autolab` | AutoLab 自治研究控制器：Lab 规范冻结、Method/Preflight/Coder/Postflight/Ops 五角色协奏、Trial/RunSlot/Attempt 全生命周期记账、Controller Goal 驱动 |
| [`dsh-local-session-messaging/`](./dsh-local-session-messaging) | `dsh-local-session-messaging` | DSH 本地会话间通信层：控制器与角色会话之间的 control/ack 消息、会话写入者租约（writer lease）与持久化围栏 |

## 引用 / 上游

两个插件均派生自 [deepseek-ai/deepseek](https://github.com/deepseek-ai/deepseek)（DeepSeek Harness 官方仓库，MIT License）内的同名包，保留原始 LICENSE 与包元数据。

本仓库相对上游的本地增强：

- **candidate-supersede（候选封存/退役）**：Preflight APPROVED 新修订可以替换同 lane 既有候选，旧候选移入 `retiredCandidates` 并保持 Trial 血统可校验（见 `dsh-autolab/src/state.ts` 与 `tests/candidate-supersede.test.ts`）。

## 安装到 DSH profile

两个插件以 `link:` 方式挂载进 DSH 的 web profile：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-autolab": "link:/path/to/dsh-autolab-plugins/dsh-autolab",
    "dsh-local-session-messaging": "link:/path/to/dsh-autolab-plugins/dsh-local-session-messaging"
  }
}
```

依赖均为 `@deepseek-ai/*` peer 包，由 DSH 安装树提供；安装后无需重新构建（仓库自带 `lib/`），如需从源码重建：

```bash
cd dsh-autolab && pnpm install && pnpm typecheck && pnpm test && pnpm build
cd dsh-local-session-messaging && pnpm install && pnpm typecheck && pnpm test && pnpm build
```

## 标签 / Topics

GitHub topics：`dsh` · `deepseek-harness` · `autolab` · `cordis` · `plugin` · `research-automation`

## License

MIT（各包目录内 LICENSE，源自 deepseek-ai/deepseek）。
