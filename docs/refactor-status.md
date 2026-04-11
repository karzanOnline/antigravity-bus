# Refactor Status

## Goal

Keep `src/index.mjs` as a compatibility facade and CLI bootstrap, while moving domain logic into focused modules.

## Current Module Map

- `src/cli/*`
  - argument parsing
  - usage text
  - main command routing
- `src/antigravity/*`
  - instance discovery
  - IPC framing and socket client
  - brain activity inspection
  - workspace dispatch orchestration
  - local state helpers
- `src/bridge/*`
  - worker routing
  - inbox/outbox payloads
  - bridge response waiting
- `src/snapshot/*`
  - task/artifact extraction
  - extension-server observation
  - snapshot file persistence
  - snapshot assembly
  - HTTP topic subscription helpers
- `src/supervisor/*`
  - pure policy logic
  - runtime orchestration
- `src/acceptance/*`
  - workspace acceptance checks
  - remediation prompt generation
- `src/vcs/*`
  - dirty file and diff summaries
- `src/shared/*`
  - generic runtime helpers

## What Is Left In `src/index.mjs`

- public exports kept for compatibility
- constant wiring
- dependency injection between modules
- direct executable entrypoint

## Good Signs

- behavior is still covered through the existing `test/index.test.mjs`
- the file has been reduced substantially without changing the external CLI surface
- most policy code now lives outside the entrypoint

## Next Likely Steps

- decide whether to keep `src/index.mjs` as the long-term public facade or introduce smaller public entry modules
- move shared constants into a dedicated module if the remaining facade should shrink further
- add module-level tests over time so coverage is less coupled to the facade export surface

## Async Run Bus Smoke

- **run-status 的用途**：用于追踪记录从任务指令派发直至最终取得闭环结果状态的全生命周期，它提供了一种统一的可观测凭证。
- **completed_chat_only 的含义**：表示 Agent 虽然正常完工并退出运行态，但在此轮交互期间仅仅只进行了单纯的话语沟通（例如解答疑惑或聊天规划），并未对当前运行的工作区（Workspace）涉及任何有效实质性的代码提交、文件写入等环境更改的纯问答完结状态。
- **为什么 Antigravity 需要异步监察总线**：Agent 执行代码工程任务天生具有非即时响应且耗时不确定的复杂离散特征。任务的投递无法被普通同步线程直接阻塞回收：其途中有极大概率会横跨多层内部逻辑思考环、遭遇停顿依赖需人工权限解锁审查、亦或者需要拆解生成多模块组件资源。有鉴于此，系统急需部署一套挂载游离于外的、基于长期事件追踪并独立观察的异步监察总线（bus）模块，借此持续搜集汇流底层活跃活动信号与相关产物指标，才得以安全地分辨捕获该执行到底是真真切切的完工（completed），还是陷入僵死卡顿，在防错杀和防漏过的权衡间取得有效的系统级状态监管。

Async Run Bus Verified 2026-04-11
