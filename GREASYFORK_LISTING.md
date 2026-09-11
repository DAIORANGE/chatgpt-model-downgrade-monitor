# Greasy Fork / Userscript listing copy

## 中文名称
ChatGPT Model Downgrade Monitor | 模型鉴定姬

## English name
ChatGPT Model Downgrade Monitor

## 中文简介
用于 Firefox、Tampermonkey 及其他可运行 userscript 的桌面浏览器的 ChatGPT 模型路由监测脚本。比较调用模型、最终应答模型、服务器确认模型与服务器路由证据，帮助发现静默模型切换、mini fallback 与路由证据冲突。

这版特别强调两件事：

1. **二次元友好的多主题 UI**：内置 9 套日系 / 轻二次元 / 深浅色主题，用户可以自己切换，不强制固定一种视觉风格；
2. **尽量对小白友好**：PoW、RTT、服务器路由等技术概念都提供可点击的 `ⓘ` 白话解释；设置页也尽量说明“这个开关打开以后会发生什么”，减少只有开发者才看得懂的术语。

同时提供一问一答聚合、Prompt / 回复短摘要、本地模型档案、网络标签、模型与异常统计、PoW 趋势、可拖动说明卡、异常提醒和可选提示音。脚本默认只观察，不修改 ChatGPT 请求、Header、Cookie、模型选择或回答正文。

## English summary
A Tampermonkey userscript for Firefox and other userscript-capable desktop browsers that monitors ChatGPT requested, assistant-reported, resolved and server-routed model evidence. It helps surface silent model switches, mini fallbacks and routing conflicts without modifying ChatGPT requests or answers.

Two UX goals are emphasized:

1. **Anime-friendly multi-theme UI** — nine switchable Japanese-inspired / light-anime / light-dark themes, so users can choose the look instead of being locked to one style;
2. **Beginner-friendly explanations** — technical concepts such as PoW, RTT and server routing include clickable plain-language `ⓘ` explainers, and settings try to explain what each switch actually changes instead of exposing raw engineering terminology.

It also includes one-turn aggregation, short prompt/reply previews, local model history, network labels, model/anomaly statistics, PoW trends, draggable concept cards, anomaly alerts and selectable sounds. Observer-only by design.

## Keywords
ChatGPT, model downgrade, silent downgrade, model routing, mini fallback, Firefox, Tampermonkey, userscript, model monitor, cross-browser, PoW, anime UI

## References / acknowledgements
- ChatGPT Route Inspector: https://github.com/Liu-Bot24/chatgpt-route-inspector
- GPT-Monitor: https://github.com/Kaede-118/GPT-Monitor

## Disclaimer
This is an unofficial independent community userscript. It is not affiliated with, authorized by, sponsored by, or endorsed by OpenAI, ChatGPT, Tampermonkey, or the referenced projects. It can only observe fields exposed to the browser and cannot prove undisclosed internal routing, billing, account-state or anti-abuse decisions. ChatGPT web changes may cause temporary breakage, false positives or false negatives.

本项目为非官方独立社区脚本，与 OpenAI、ChatGPT、Tampermonkey 及参考项目不存在隶属、授权、赞助或背书关系。它只能观察浏览器端可见字段，不能证明未公开的内部路由、计费、账号状态或风控结论；ChatGPT 网页变化也可能导致暂时失效、误判或漏判。
