# DSH-AutoLab

**把人工科研流程变成受控的自治实验：人类冻结目标，机器跑完整科研循环。**

## AutoLab 是什么

AutoLab 是运行在 DeepSeek Harness (DSH) 之上的**自治研究控制器**。它不替代研究者的判断，而是把判断放进一条**可审计、可复现、可断点续跑**的机器流水线里：

**① 契约先行 —— 一切以冻结的 Lab 规范为唯一权威。**
`LAB_SPEC` + `lab.yaml` 把研究目标、协议、参数预算、GPU 拓扑一次性写成 SHA-256 锚定的不可变契约；此后每一步活动——方法设计、代码实现、实验执行、结果裁决——都以该契约为唯一对照物。**Preflight 在实现前裁决"方法是否合法可行"，Postflight 在实验后裁决"结果是否可信"**，跑偏即退回。

**② 五角色协奏 —— 每一步都有独立的执行者与见证者。**
- **Method** 设计研究方法与修订方案；
- **Preflight Judge** 在实现前裁决方法（协议层闸门）；
- **Coder** 实现并冻结候选代码（candidate）；
- **Ops** 提供环境与执行的机械保障；
- **Postflight Judge** 在实验后裁决结果（科学层闸门）。

五个角色各有独立会话与工具面，跨 lane 通信在协议层隔离——**没有人能既当运动员又当裁判**。

**③ 三级记账 —— 逻辑、种子、进程严格分层。**
`Trial`（一次逻辑实验）× `RunSlot`（一个随机种子）× `Attempt`（一次进程执行）。机器故障（重试与血统）与科学结论（Postflight 裁决）分开记账，每一次重试都在不可变血统中留痕。

**④ Controller Goal 驱动 —— 无轮询的自治节拍。**
Controller 以单个原生 Goal 挂起，Runtime 在确切的持久事件（评审判定、候选冻结、实验终止）上唤醒它继续编排——**空闲即静默，事件即行动**。

**⑤ 机械确定性 —— 收据即真相。**
从 Method Ticket、Preflight Verdict、Coder 提交、Attempt 状态到 Postflight 结果，全部以 SHA-256 收据 + canonical JSON 冻结；重放幂等、历史不可变。这份"确定性优先"的纪律，同时也是 97% 前缀缓存命中率的来源。

## 仓库组成

| 目录 | 包名 | 作用 |
|---|---|---|
| [`dsh-autolab/`](./dsh-autolab) | `dsh-autolab` | AutoLab 自治研究控制器（上文五条核心机制的实现） |
| [`dsh-local-session-messaging/`](./dsh-local-session-messaging) | `dsh-local-session-messaging` | DSH 本地会话间通信层：control/ack 消息、会话写入者租约（writer lease）与持久化围栏——五角色协奏的通信底座 |

## 特点与优势：沿袭 DSH 极致内核

**高性能、低成本来自内核，不是堆配置。** DSH-AutoLab 不重新发明调度、会话、存储与推理基建，而是直接骑在 DeepSeek Harness 的内核原语上：

- **事件驱动 Goal 运行时**：Controller 以单一原生 Goal 挂起（AutoLabWait），由 Runtime 在确切持久事件上唤醒——无轮询、无忙等，空闲期推理成本趋近于零；
- **单飞队列 + 持久化存储域**：所有 Lab 变更串行化、状态落盘可恢复，重启后从持久事件精确续跑；
- **角色会话复用与通信围栏**：Method/Coder/Judge/Ops 会话一次创建、跨任务复用，跨 lane 通信在协议层隔离。

**架构性高缓存命中（实测 97%）不是偶然**——AutoLab 的"冻结工件"纪律天然就是缓存友好设计：

- 每个角色回合读的是 **SHA-256 锚定的冻结原件**（ticket / verdict / receipt），系统提示内核段逐字节固定；
- 同一角色的连续回合共享完全一致的前缀上下文，直接命中 DeepSeek 前缀缓存；
- 判定者"只读冻结文件、不信聊天记忆"的协议纪律，恰好等价于"上下文可缓存"。

一次完整四线实验（Controller Goal **100 轮 · 1161 步**）的实测剖面：

| 指标 | 实测 |
|---|---|
| LLM 推理时长 | 257m21s |
| 工具调用时长 | 287m03s |
| 首 token 平均 | ~4s |
| 生成速度 | 78 tok/s |
| **缓存命中** | **97%** |
| 输入规模 | 416M tokens（输入） |

**风格沿袭 DSH 一贯路线**：机械确定性优先——收据 > 会话、事件 > 轮询、幂等重放 > 容错猜测；每一步都可审计、可复现、可断点续跑。

## 引用 / 上游

两个插件均派生自 [deepseek-ai/deepseek](https://github.com/deepseek-ai/deepseek)（DeepSeek Harness 官方仓库，MIT License）内的同名包，保留原始 LICENSE 与包元数据。

本仓库相对上游的本地增强：

- **candidate-supersede（候选封存/退役）**：Preflight APPROVED 新修订可以替换同 lane 既有候选，旧候选移入 `retiredCandidates` 并保持 Trial 血统可校验（见 `dsh-autolab/src/state.ts` 与 `tests/candidate-supersede.test.ts`）。
- **Lab fact set 登记机制（fact-registry）**：加性、不可变、canonical-JSON 的用户决策登记——用户对冻结 LAB_SPEC 的修订/裁决落点为 `authority_paths.fact_set`，后续编译的每个 Role Packet 锚定当前 fact set 字节，历史包保持历史锚定并可复现（见 `dsh-autolab/src/fact-registry.ts`，贯通 role-assignment / review / coder-fix / postflight 全链路）。

构建产物 `lib/` 与当前源码一致（本仓库提交前已用 `pnpm build` 重新生成）；验证状态：dsh-autolab `typecheck ✓ · 492/492 tests ✓`，dsh-local-session-messaging `typecheck ✓ · 94/94 tests ✓`。

## 安装到 DSH profile

两个插件以 `link:` 方式挂载进 DSH 的 web profile：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-autolab": "link:/path/to/DSH-AutoLab/dsh-autolab",
    "dsh-local-session-messaging": "link:/path/to/DSH-AutoLab/dsh-local-session-messaging"
  }
}
```

依赖均为 `@deepseek-ai/*` peer 包，由 DSH 安装树提供；安装后无需重新构建（仓库自带 `lib/`），如需从源码重建：

```bash
cd dsh-autolab && pnpm install && pnpm typecheck && pnpm test && pnpm build
cd dsh-local-session-messaging && pnpm install && pnpm typecheck && pnpm test && pnpm build
```

## 标签 / Topics

GitHub topics：`dsh-plugin` · `dsh` · `deepseek` · `deepseek-harness` · `autolab` · `cordis` · `plugin` · `research` · `research-automation`

## License

MIT（各包目录内 LICENSE，源自 deepseek-ai/deepseek）。
