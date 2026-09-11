# ChatGPT Model Downgrade Monitor | 模型鉴定姬 v1.4.1

## 中文

这是首个面向公开分发整理的稳定版本，重点服务 **Firefox + Tampermonkey**，以及其他能够运行 userscript、但不方便直接使用 Chrome/Chromium 扩展的桌面浏览器。

### 主要功能

- 对照 **调用模型 → 最终应答模型**，并保留服务器确认模型与服务器路由作为独立证据；
- 一问一答聚合，避免同一轮 SSE 内部消息产生大量重复记录；
- 出现不一致时直接解释 **为什么出现这个状态、哪些字段不同、抓到了多少证据**；
- 对小白更友好：PoW、RTT、服务器路由等技术概念可以点击 `ⓘ` 查看白话解释；
- 设置项尽量写清楚“这个开关打开后会发生什么”，减少工程术语；
- **二次元友好的多主题界面**：提供 9 套日系 / 轻二次元 / 深浅色主题，可由用户自行切换；
- Prompt / 回复短摘要、本地模型档案、网络标签、统计与 PoW 趋势；
- 可拖动、缩放的监控窗口，以及可拖动固定的概念说明卡；
- 异常提醒、可选提示音、音量控制与试听；
- 默认仅观察，不修改请求、Header、Cookie、模型选择或 ChatGPT 回答正文。

### 为什么做 userscript 版

本项目的一个主要目标，是补足现有 Chromium 扩展方案在 Firefox 和其他 userscript 浏览器上的使用空缺。实现与设计阶段参考了：

- [ChatGPT Route Inspector](https://github.com/Liu-Bot24/chatgpt-route-inspector)
- [GPT-Monitor](https://github.com/Kaede-118/GPT-Monitor)

本项目为独立 userscript 实现，并不代表上述项目作者对本项目提供支持或背书。

### 免责声明

这是非官方社区工具，与 OpenAI、ChatGPT、Tampermonkey 及其运营方无隶属、授权、赞助或背书关系。工具只能报告浏览器端可见字段，不能证明 OpenAI 未公开的内部路由、计费、账号状态或风控结论。ChatGPT 网页接口变化可能造成误判、漏判或暂时失效。PoW、RTT、downlink 与 server route 等辅助数据也不能单独作为 IP 质量、账号健康或模型降级的证明。

---

## English

This is the first public-distribution-ready stable release, with a primary focus on **Firefox + Tampermonkey** and other desktop browsers that can run userscripts but cannot conveniently use the same Chrome/Chromium extension workflow.

### Highlights

- Compare the **requested model → final assistant response model**, while retaining resolved-model and server-route fields as separate evidence;
- aggregate one visible user turn into one record instead of emitting many SSE-internal duplicates;
- explain **why a status was triggered, which fields disagree, and how much evidence was captured**;
- beginner-friendly `ⓘ` explainers for technical concepts such as PoW, RTT and server routing;
- settings are described in plain language so users can understand what each switch actually changes;
- **anime-friendly multi-theme UI** with nine switchable Japanese-inspired / light-anime / light-dark themes;
- short prompt/reply previews, local history, network labels, statistics and PoW trends;
- movable/resizable monitor window and draggable/pinnable concept cards;
- optional anomaly alerts, selectable sounds, volume control and preview;
- observer-only by design: no modification of request bodies, headers, cookies, model selection or ChatGPT answer content.

### Why a userscript

A major goal is to cover Firefox and other userscript-capable browsers where Chromium-extension installation paths are inconvenient or unavailable. Research and design were informed by:

- [ChatGPT Route Inspector](https://github.com/Liu-Bot24/chatgpt-route-inspector)
- [GPT-Monitor](https://github.com/Kaede-118/GPT-Monitor)

This is an independent userscript implementation and does not imply endorsement by either referenced project.

### Disclaimer

This is an unofficial community tool and is not affiliated with, authorized by, sponsored by, or endorsed by OpenAI, ChatGPT, Tampermonkey, or their operators. It can only report fields visible to the browser and cannot prove undisclosed OpenAI routing, billing, account-state or anti-abuse decisions. ChatGPT web changes may cause false positives, false negatives or temporary breakage. Auxiliary values such as PoW, RTT, downlink and server route are not, by themselves, proof of IP reputation, account health or model downgrade.
