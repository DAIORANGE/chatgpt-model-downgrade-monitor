# ChatGPT Model Downgrade Monitor | 模型鉴定姬 v1.5.0

## 中文

v1.5.0 是一次围绕“证据不碎片化、PoW 可读性、状态一眼可见”完成的稳定版更新。

### 主要变化

- **一问一答一张卡**：Fetch + WebSocket 证据按同一轮聚合，减少重复卡片和“调用模型未捕获”的假象。
- **四项模型证据更清楚**：调用模型、应答模型、服务器确认模型、服务器路由分别保留，并显示核心对比 / 总证据完整度。
- **PoW 图重做**：大图与悬浮小图使用同一份 canonical 数据；绿色 / 红色 / 紫色 / 黄色 / 灰色节点表达不同状态。
- **真实路径脉冲**：悬浮条上的脉冲沿 PoW 折线路径移动，并随节点状态渐变颜色。
- **刷新不丢关联**：PoW 与模型轮次的关联会通过持久化 history / semantic snapshot 恢复，刷新后不再无故全部变灰。
- **状态视觉更直接**：模型对比区域整体使用翠绿 / 红 / 紫 / 黄语义底色；正常时绿色成为主视觉，异常时切换对应颜色。
- **界面可读性提升**：放大关键字号、调整模型流对齐、将 AI 头像移到回复右侧，并降低粉 / 蓝对话气泡的视觉抢占。
- **网络说明更严谨**：RTT 明确标注为浏览器粗略估算；PoW 继续只作为辅助观测，不解释成官方 IP / 账号风控分。

### 兼容与原则

- 面向 Tampermonkey userscript，重点覆盖 Chrome / Chromium 与 Firefox 等桌面浏览器。
- 只观察浏览器可见证据，不修改请求体、Header、Cookie、模型选择或 ChatGPT 回答。
- 本项目为非官方独立社区工具，与 OpenAI、ChatGPT、Tampermonkey 无隶属、授权、赞助或背书关系。

---

## English

v1.5.0 focuses on turn-level evidence integrity, readable PoW diagnostics, and stronger semantic status presentation.

### Highlights

- Merge Fetch + WebSocket evidence into one visible turn instead of fragmented duplicate records.
- Keep requested, assistant, resolved, and server-route model evidence separate and explain evidence completeness.
- Use one canonical PoW series for both the full chart and the floating mini waveform.
- Add semantic PoW node colors, path-following pulse animation, detailed hover information, and reload-safe turn association.
- Make the model comparison panel itself use semantic green / red / purple / amber states.
- Improve typography, model-flow alignment, archive readability, assistant-avatar placement, and dialogue visual hierarchy.
- Clarify that browser RTT is only a coarse estimate and PoW is auxiliary observational data, not an official IP reputation score.

Observer-only by design: the userscript does not modify ChatGPT request bodies, headers, cookies, model selection, or answer content.
