<div align="center">

# ChatGPT Model Downgrade Monitor | 模型鉴定姬

**用可核对的网页证据，观察 ChatGPT 是否发生模型切换、路由变化或请求/应答不一致。**

[![Latest Release](https://img.shields.io/github/v/release/DAIORANGE/chatgpt-model-downgrade-monitor?display_name=tag&sort=semver)](https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/releases/latest)
[![Userscript](https://img.shields.io/badge/userscript-Tampermonkey-00ad9f)](https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js)
[![Firefox](https://img.shields.io/badge/Firefox-primary%20target-ff7139)](https://www.mozilla.org/firefox/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2020+-f7df1e)](ChatGPT-Model-Downgrade-Monitor.user.js)

[English](README_EN.md) · [安装脚本](https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js) · [Releases](https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/releases) · [Issues](https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/issues)

</div>

## 最新版本

当前公开版本：**v1.5.0**

- [查看 Release](https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/releases/tag/v1.5.0)
- [直接安装 userscript](https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js)
- [查看 SHA-256](ChatGPT-Model-Downgrade-Monitor.user.js.sha256)

## 为什么有这个项目

很多 ChatGPT 模型监测工具首先以 Chrome / Chromium 扩展形式出现，但 Firefox，以及部分可以安装 Tampermonkey 的非 Chrome 浏览器，并不总能直接使用同一套扩展。

**ChatGPT Model Downgrade Monitor（模型鉴定姬）** 是一个独立 userscript，重点解决这类浏览器上的检测需求：

- Firefox + Tampermonkey；
- 其他能够运行 Tampermonkey 兼容 userscript 的桌面浏览器；
- 希望不依赖 Chrome MV3 扩展，也能直接观察 ChatGPT 模型路由的人。

它不会根据“回答变笨了”“速度变快了”“语气像 mini”这类主观感觉判断模型，而是比较 ChatGPT 网页请求与响应里实际可读取的模型字段。

## 它看什么

每一轮对话尽量聚合成一张记录，并区分：

- **调用模型**：网页发送这条消息时，请求服务器使用的模型；
- **应答模型**：最终显示给你的 ChatGPT 回答自身携带的模型标记；
- **服务器确认模型**：响应中的 `resolved_model_slug`；
- **服务器路由**：类似 `server_ste_metadata.model_slug` 的路由旁证；
- **PoW**：ChatGPT 前置工作量证明挑战的观测值，仅用于网络 / 风控趋势辅助分析；
- **网络标签**：可以手动给当前代理或网络环境命名，方便长期对比。

当字段互相不一致时，模型鉴定姬不会简单写一个“疑似降级”，而是告诉你：**哪几个字段不同、为什么触发这个状态、已捕获多少项证据。**

## 主要功能

- 请求模型 → 最终应答模型的直接对照；
- 同一轮 SSE 内部事件聚合，避免一问出现十几条重复历史；
- 路由证据冲突提示，不把单一 server 字段武断当成最终模型；
- Prompt / 回答短摘要，方便认出是哪一轮对话；
- 本地历史、节点标签、模型统计与异常统计；
- PoW 趋势图与网络辅助观测；
- **二次元友好多主题 UI**：内置 9 套日系 / 轻二次元 / 深浅色主题，可由用户自行切换；
- **尽量对小白友好**：PoW、RTT、服务器路由等技术概念提供可点击的 `ⓘ` 白话解释；
- **设置项尽量带说明**：不仅告诉你开关叫什么，也尽量写清楚“打开以后会发生什么、什么时候有用”；
- 异常弹窗、可选提示音、音量与试听；
- 面板可拖动、缩放并记住位置；
- UI 内置 **GitHub 项目主页** 点击入口；
- 只观察，不修改请求、Header、Cookie、模型选择或 ChatGPT 回答正文。

### 设计目标：看得懂，而不只是“能检测”

模型路由本身包含不少开发者术语。这个项目会尽量把它们翻译成普通用户能理解的说法：主界面优先显示“调用模型 → 应答模型”和具体触发原因，技术细节再放到 `ⓘ` 说明卡或“技术证据”中。

设置页也遵循同样原则。像异常提醒、提示音、回复下方模型警告、对话摘要保存等选项，都尽量附上用途说明，避免用户只能靠猜来判断某个开关该不该开。

## 安装

### Tampermonkey 一键安装

安装 Tampermonkey 后，点击：

**[安装 ChatGPT Model Downgrade Monitor](https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js)**

Tampermonkey 可以直接识别 `.user.js` 的 Raw 链接并进入安装界面。

### 手动安装

1. 安装 Tampermonkey；
2. 打开 Tampermonkey Dashboard；
3. 新建脚本；
4. 将 `ChatGPT-Model-Downgrade-Monitor.user.js` 全文粘贴进去；
5. 保存；
6. 重新打开 `https://chatgpt.com/`。

> Chrome 系浏览器的新版本可能还需要允许 userscript / Developer Mode；Firefox 的具体扩展权限以 Tampermonkey 当前版本为准。

## 为什么特别做 userscript 版本

这个项目不是为了重复做一个 Chrome 扩展，而是补上浏览器覆盖面：

- 参考项目主要以 Chromium / Chrome 扩展为主；
- Firefox 用户可能无法直接采用同一安装方式；
- userscript 可以把核心检测逻辑放进 Tampermonkey，在支持 userscript 的浏览器里复用；
- 不需要额外的扩展 Popup / Service Worker / Chrome-specific storage 桥接。

兼容性仍取决于 ChatGPT 网页内部接口和浏览器对 userscript 的实现。**Firefox 是重点目标之一，但不代表所有 Tampermonkey 浏览器都已经逐一实机验证。**

## 参考与致谢

本项目在设计和调研阶段重点参考了以下两个公开项目：

### 1. ChatGPT Route Inspector

- Repository: https://github.com/Liu-Bot24/chatgpt-route-inspector
- 参考方向：请求模型与服务器路由证据的区分、证据来源记录、PoW 观测、路由诊断思路。
- 该项目定位为 Chromium 浏览器扩展；模型鉴定姬则以 Tampermonkey userscript 形式重新实现跨浏览器使用场景。

### 2. GPT-Monitor

- Repository: https://github.com/Kaede-118/GPT-Monitor
- 参考方向：从 ChatGPT SSE 流中提取模型字段、回复模型标记、模型变化提醒与历史记录。
- 模型鉴定姬没有沿用“slug 包含 mini 就直接等同于降级”的单一判定，而是把 requested / assistant / resolved / server route 分开保留，并显示证据冲突原因。

感谢上述项目公开了实现思路和研究方向。本项目是独立 userscript 实现，并不代表上述项目作者对本项目提供支持或背书。

## 许可证与商业授权

本项目源码以 **PolyForm Noncommercial License 1.0.0** 提供。

- 个人、学习、研究、业余项目及其他符合该许可证定义的**非商业用途**可以在许可证条款范围内使用、修改和分发；
- 该许可证**不授予商业使用权**；
- 如需商业使用、商业集成、收费分发，或希望获得其他商业授权，请联系作者 **DAIORANGE** 另行授权；
- 赞助 / 打赏属于对作者维护工作的自愿支持，**不会自动授予额外的商业使用权或其他许可权利**。

完整条款见 [LICENSE](LICENSE) 与 PolyForm Noncommercial 1.0.0 官方文本。

## 隐私

默认情况下，数据保存在浏览器本地。

模型鉴定姬不会主动上传：

- Cookie / 登录凭据；
- Authorization 信息；
- 完整 Prompt / 完整回答正文；
- 未经筛选的网络响应内容。

“记住每条记录对应的对话”开启时，只保存裁剪后的 Prompt / 回答短摘要，用于让用户认出历史记录。

## 判定原则

核心原则是：**显示事实，不猜模型。**

例如：

```text
调用模型：GPT-5.6 Thinking
应答模型：GPT-5.6 Thinking
服务器路由：GPT-5.5 Mini
```

模型鉴定姬会显示为“路由证据冲突”，并解释是哪一项证据不同，而不是直接宣布“已经降级”。

如果调用模型与应答模型本身不同，则直接显示“请求与应答模型不一致”，并展示触发该状态的字段。

## PoW 说明

PoW（Proof of Work）可以理解成：服务器在部分请求前要求浏览器先完成一定计算成本，再继续请求。它通常用于提高自动化滥用、批量请求的成本。

模型鉴定姬记录 PoW 是为了长期比较不同网络环境下的趋势，而不是把它做成“IP 好坏分”。

**高 / 低 PoW 都不能单独证明账号、IP 或模型路由出了问题。**

## 已知限制

- ChatGPT 属于持续更新的网站，内部字段或接口变化可能导致检测暂时失效；
- WebSocket 捕获属于备用路径，不能保证和 Fetch/SSE 一样稳定；
- server route、resolved model、assistant model 是不同来源的证据，不能互相无条件替代；
- RTT / downlink 来自浏览器网络信息估算，不等于代理节点到 OpenAI 的独立测速；
- 本工具只能报告网页实际暴露给浏览器的字段，无法证明 OpenAI 内部所有未公开路由过程。

## 免责声明

**本项目是非官方、独立的社区工具，与 OpenAI、ChatGPT、Tampermonkey 及其运营方不存在隶属、合作、授权、赞助或背书关系。**

- `ChatGPT`、`OpenAI` 及相关名称、标识和商标归其各自权利人所有；本项目使用这些名称仅用于说明兼容对象和技术用途。
- 本工具只观察浏览器端实际可见的请求与响应字段。它不能代表、验证或证明 OpenAI 未公开的内部模型路由、计费逻辑、账号状态、风控结论或基础设施状态。
- ChatGPT 网页和内部接口会持续变化，因此本项目可能随时出现字段缺失、检测失效、误判、漏判或兼容性问题；不承诺持续可用，也不保证检测结果完整或绝对准确。
- PoW、RTT、downlink、server route 等均属于辅助观测数据，不能单独作为 IP 质量、账号健康、模型降级或官方服务状态的证明。
- 本项目按现状提供。使用者需要自行判断结果，并自行承担安装、运行、调试和依赖网页内部接口变化所产生的风险。
- 使用者有责任遵守适用的服务条款、浏览器扩展/userscript 平台规则以及所在地法律法规。

如果你需要对账号、计费、订阅权益或官方服务状态做正式确认，请以 OpenAI 官方界面、官方文档和官方支持渠道为准。

## 搜索关键词

`ChatGPT model downgrade` · `ChatGPT silent downgrade` · `ChatGPT model routing` · `ChatGPT mini fallback` · `ChatGPT Firefox model monitor` · `Tampermonkey ChatGPT model detector`
