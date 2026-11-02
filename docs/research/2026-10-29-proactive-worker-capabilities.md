# Worker 主动使用 skills 与插件能力：官方资料核对

日期：2026-10-29。范围：外部官方资料；未检查本地插件实现，也未调用模型。当前文档可能高于本地锁定的 Agent SDK 0.2.94，具体可用字段须以本地类型及实际初始化消息为准。

## 已核实事实

1. Claude Code 的 skill 有名称/描述，模型按上下文选择，完整内容在调用时加载。Agent SDK 文档明确说明实际调用在流中表现为 `Skill` 工具使用。主动提示应要求选择并实际调用相关 skill、应用其指引。文档中的新 `skills` 选项不应未经本地版本核实就加入旧 SDK。[Agent SDK skills](https://code.claude.com/docs/en/agent-sdk/skills)

2. 插件可以包含 skills、agents、hooks、MCP servers。可调用的是它提供的具体能力；不存在统一的“执行整个插件”动作。SDK 提供 `plugins: [{type: "local", path: ...}]` 显式加载本地插件；初始化消息中的 `plugins`、`skills`、`slash_commands` 可用于核对会话已加载项目。插件技能带 `plugin:skill` 命名空间。[Agent SDK plugins](https://code.claude.com/docs/en/agent-sdk/plugins)

3. `disable-model-invocation: true` 禁止模型自行调用，不能通过复刻步骤绕过；`user-invocable: false` 则允许模型调用、隐藏用户命令入口。原生权限和可见性规则仍然适用。[Claude Code skills：调用控制](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill)

4. 安装、启用和当前会话实际加载是不同状态。插件可以安装后处于关闭状态；作用域、配置、加载错误及待刷新状态会影响可用性。官方对 Agent SDK 的指引是使用其插件加载选项。因此，不能只凭用户设置或安装目录保证 worker 已能使用全部插件。[安装与管理插件](https://code.claude.com/docs/en/discover-plugins#jetbrains-non-interactive-runs-and-the-agent-sdk)

5. 初始化的 `skills` 数组有覆盖边界：主要列可用户调用的技能，`user-invocable: false` 的已加载技能可能不在数组中。`skills` 数组也不等同当前调用授权清单。因而运行时清单是观测证据，不能称为所有已安装、所有可用技能的完整目录。[Agent SDK skills：确认加载](https://code.claude.com/docs/en/agent-sdk/skills#confirm-skills-loaded)

## 本次最小改进建议

用户已经接受泛化提示，因此本次只需补齐 worker 常驻提示词与派工说明。无需为这条要求增加配置目录扫描、持久能力清单、插件自动安装/加载或 MCP schema。主管无法完整列举能力时，让 worker 依据本会话已暴露的元数据主动匹配，既明确又适应不同模型与配置。

建议英文常驻提示（这是针对本插件的推论与文案，不是官方原文）：

```text
Proactively use relevant capabilities already available in this Claude Code session. Before substantive work, match the task to the exposed skill descriptions and plugin-provided tools; invoke an applicable permitted skill through the native Skill mechanism and apply its guidance, and use relevant connected MCP tools when they help. Do not wait for Codex to remind you, or merely mention a capability without using it. Plugins package capabilities: use their specific skills, tools or agents rather than assuming a generic plugin-call command. Respect native invocation controls, enabled states and permissions. If an explicitly requested capability is unavailable, report that gap and continue with a suitable available method within the task. Reuse already loaded guidance and settled evidence; do not scan every plugin or force unrelated calls. In normal progress or the final result, briefly name the capabilities actually used and any material availability limitation.
```

任务 brief 建议增加一项：

```text
Capability use: actively select and use relevant skills and plugin-provided tools from this worker session. <Name any user-requested capability and purpose, when known.> Use the actual loaded name/namespace; if absent or restricted, report that fact instead of claiming it was used. Preserve the assigned research owner and reuse settled findings.
```

“能用就用”应落实为任务相关、确实可用且实际调用。无需强制每个任务至少一次 Skill 调用；简单修改可以没有相关技能。只报告已发生的调用，不能把可见、已加载、计划使用或主管点名写成已使用。

## 验证建议与边界

- 检查常驻提示在首次启动和冷恢复后仍在；派工文本明确主动使用与实际可用性的边界。
- 用 mock 初始化数据验证能力信息传输，不把存在元数据当作实际模型调用证明。
- 若进行真实行为测试，记录是否出现相应 `Skill` 或插件工具调用，以及结果是否应用指引；提示词字符串测试无法证明模型一定主动调用。
- 本研究没有证明小模型普遍不调用或大模型普遍会调用；这种差异需具体模型的可比较轨迹验证。

## 版本注意事项

当前 plugins 文档中的 `reloadPlugins({addPlugins: ...})` 要求 TypeScript Agent SDK 0.3.301 或更新，不能直接套到本地 0.2.94。本次建议不依赖这个新 API。`settingSources` 用来决定文件系统技能与原生设置的来源；它本身不构成“全部插件已加载”的证明。最终应以本地锁定 SDK 的类型、实际 init 记录与 worker 当前可见能力共同判断。

## 本地实现

本地核查：锁定版本 0.2.94 的 `sdk.d.ts` 确实声明了 init 的 `skills`、`slash_commands` 和 `plugins` 字段。插件当前 `capabilitiesFromInit` 只保留原生工具、MCP 状态和策略，未将这些名称传递为完整技能/插件目录；本次没有新增能力清单或自动加载机制。

0.11.1 的修改包括：`worker.ts` 的系统附加提示增加主动选择、实际调用、应用指引及使用报告规则；`controller.ts` 的每次派工增加简短提醒；主技能、研究交接模板、使用说明及 worker policy inventory 同步。用户已明确接受不知道具体名称时使用通用要求。已有研究责任、同会话复用、原生配置与权限边界继续适用。

回归检查覆盖系统提示在启动和冷恢复后的保留，以及首次派工和同会话续作中的提醒传递。它们验证请求内容，不代表实际模型一定调用相关技能，也不建立不同模型之间的调用率差异。
