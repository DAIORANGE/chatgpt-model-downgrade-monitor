<div align="center">

# ChatGPT Model Downgrade Monitor

**An evidence-oriented Tampermonkey userscript for observing ChatGPT model routing, silent model switches, and request/response model mismatches.**

[![Latest Release](https://img.shields.io/github/v/release/DAIORANGE/chatgpt-model-downgrade-monitor?display_name=tag&sort=semver)](https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/releases/latest)
[![Userscript](https://img.shields.io/badge/userscript-Tampermonkey-00ad9f)](https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js)
[![Firefox](https://img.shields.io/badge/Firefox-primary%20target-ff7139)](https://www.mozilla.org/firefox/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2020+-f7df1e)](ChatGPT-Model-Downgrade-Monitor.user.js)

[简体中文](README.md) · [Install userscript](https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js) · [Releases](https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/releases) · [Issues](https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/issues)

</div>

## Latest release

Current public version: **v1.5.0**

- [View release](https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/releases/tag/v1.5.0)
- [Install the userscript directly](https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js)
- [SHA-256](ChatGPT-Model-Downgrade-Monitor.user.js.sha256)

## Why this project exists

Many ChatGPT model-monitoring tools started as Chrome / Chromium extensions. That leaves a practical gap for Firefox users and for people on other desktop browsers that can run Tampermonkey-compatible userscripts.

**ChatGPT Model Downgrade Monitor** is an independent userscript focused on that gap:

- Firefox + Tampermonkey as a primary use case;
- other desktop browsers capable of running Tampermonkey-compatible userscripts;
- users who want model-routing visibility without depending on a Chrome MV3 extension.

It does not guess the model from response speed, writing style, subjective answer quality, or what the model claims to be. It compares model-related fields that are actually observable in ChatGPT's web requests and responses.

## What it observes

Each user turn is aggregated into one record when possible. The monitor keeps separate evidence for:

- **Requested model** — the model the ChatGPT web client asked the server to use;
- **Assistant response model** — the model label attached to the final ChatGPT answer shown to you;
- **Resolved model** — server-returned `resolved_model_slug` evidence;
- **Server route** — routing evidence such as `server_ste_metadata.model_slug`;
- **PoW** — observed proof-of-work challenge data for network / anti-abuse trend analysis;
- **Network label** — a user-defined label for the current proxy/node/network environment.

When these sources disagree, the UI explains **which fields disagree, how many evidence fields were captured, and why the status was triggered** instead of simply showing a vague “suspected downgrade” label.

## Features

- Requested model → final assistant response model comparison;
- one-turn aggregation across multiple internal SSE messages;
- evidence-conflict handling instead of treating one server field as ground truth;
- short prompt/reply previews to identify historical turns;
- local history, network labels, model statistics and anomaly counts;
- PoW trend visualization and network-side auxiliary observations;
- **anime-friendly multi-theme UI** with nine switchable Japanese-inspired / light-anime / light-dark themes;
- **beginner-friendly explanations** for PoW, RTT, server routing and other technical concepts through clickable `ⓘ` cards;
- **settings with plain-language annotations** that try to explain what each switch actually changes and when it is useful, instead of exposing raw engineering labels only;
- optional visual alerts, selectable alert sounds, volume control and preview;
- movable/resizable panel with persisted geometry;
- a built-in **GitHub project** link inside the userscript UI;
- observer-only design: it does not modify request bodies, headers, cookies, model selection or ChatGPT answer content.

### Design goal: understandable, not merely functional

Model-routing inspection naturally contains developer-oriented terminology. This project tries to translate that into plain language: the main UI prioritizes the requested model, response model, and the exact reason a status was triggered, while technical details live behind `ⓘ` cards and evidence panels.

The same principle applies to settings. Options such as anomaly alerts, sounds, per-reply model warnings, and conversation-summary persistence are accompanied by short explanations so users do not have to guess what a switch will do before enabling it.

## Installation

### Install with Tampermonkey

After installing Tampermonkey, open:

**[Install ChatGPT Model Downgrade Monitor](https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js)**

Tampermonkey can recognize a `.user.js` Raw URL and open its installation page.

### Manual installation

1. Install Tampermonkey;
2. open the Tampermonkey Dashboard;
3. create a new script;
4. paste the complete contents of `ChatGPT-Model-Downgrade-Monitor.user.js`;
5. save it;
6. reopen `https://chatgpt.com/`.

> Newer Chrome-family browsers may require enabling userscript execution / Developer Mode. Exact permission requirements depend on the current Tampermonkey build and browser.

## Why a userscript version?

This project is not intended to duplicate a Chrome extension for its own sake. Its main purpose is browser coverage:

- the reference projects are primarily Chromium / Chrome extensions;
- Firefox users cannot always use the same installation path;
- a userscript allows the core observer to run through Tampermonkey on browsers that support userscripts;
- it avoids requiring a Chrome-specific popup, service worker, and storage bridge.

Compatibility still depends on ChatGPT's internal web protocol and the browser's userscript implementation. **Firefox is a primary target, but not every Tampermonkey-capable browser has been individually verified.**

## References and acknowledgements

This project was strongly informed by two public projects during research and design:

### 1. ChatGPT Route Inspector

- Repository: https://github.com/Liu-Bot24/chatgpt-route-inspector
- Ideas studied: separating requested-model evidence from server-routing evidence, provenance tracking, PoW observation, and route diagnostics.
- That project is positioned as a Chromium extension; this project independently reimplements the use case as a Tampermonkey userscript for broader browser coverage.

### 2. GPT-Monitor

- Repository: https://github.com/Kaede-118/GPT-Monitor
- Ideas studied: parsing model fields from ChatGPT SSE streams, reply model labels, alerts, and local history.
- This project does not use a simple “slug contains `mini` = downgrade” rule. Requested, assistant, resolved, and server-route evidence are retained separately and conflicts are explained explicitly.

Thanks to both projects for publicly sharing their work and research direction. This project is an independent userscript implementation and does not imply endorsement by either project or its authors.

## Privacy

Data is stored locally by default.

The monitor does not intentionally upload:

- cookies or login credentials;
- authorization material;
- full prompts or full assistant answers;
- unfiltered network responses.

If “remember which conversation this record belongs to” is enabled, only shortened prompt/reply previews are persisted for local identification.

## Evidence policy

The guiding rule is: **show observable facts, do not guess.**

For example:

```text
Requested: GPT-5.6 Thinking
Assistant response: GPT-5.6 Thinking
Server route: GPT-5.5 Mini
```

The monitor reports a routing-evidence conflict and explains which field differs. It does not automatically claim that a downgrade definitely occurred.

If the requested model and the assistant response model differ, the UI states that specific mismatch and shows the fields that triggered it.

## PoW

Proof of Work can be understood as a client-side computational cost that a service may require before allowing a request to continue. It is commonly useful for increasing the cost of automated abuse or high-volume request generation.

This project records PoW for long-term network/environment comparison. It is **not an IP quality score**.

A single high or low PoW observation does not prove that an account, IP address, or model route is unhealthy.

## Known limitations

- ChatGPT changes continuously; internal protocol changes may temporarily break detection;
- WebSocket capture is a best-effort fallback and may not be as reliable as Fetch/SSE;
- server-route, resolved-model and assistant-model fields are independent evidence and must not be substituted for one another blindly;
- browser RTT/downlink values are network estimates, not isolated proxy-node-to-OpenAI measurements;
- the tool can only report fields exposed to the web client and cannot prove every internal OpenAI routing decision.

## Disclaimer

**This is an unofficial, independent community tool. It is not affiliated with, authorized by, sponsored by, or endorsed by OpenAI, ChatGPT, Tampermonkey, or their operators.**

- `ChatGPT`, `OpenAI`, related product names, logos and trademarks belong to their respective owners. They are referenced here only to identify compatibility and technical scope.
- The monitor observes only request/response fields exposed to the browser. It cannot verify or prove undisclosed OpenAI model-routing logic, billing behavior, account state, anti-abuse decisions, or infrastructure status.
- ChatGPT's web client and internal interfaces change frequently. This project may therefore experience missing fields, breakage, false positives, false negatives, or compatibility issues without notice. No guarantee is made that detection will remain complete or always accurate.
- PoW, RTT, downlink, server-route and similar values are auxiliary observations. None of them alone should be treated as proof of IP reputation, account health, model downgrade, or official service status.
- The software is provided as-is. Users are responsible for evaluating the output and assume the risks associated with installation, operation, debugging, and reliance on changing web internals.
- Users are responsible for complying with applicable service terms, browser/userscript platform rules, and local laws.

For authoritative questions about account status, billing, subscription entitlements, or official service availability, rely on OpenAI's official UI, documentation, and support channels.

## Search keywords

`ChatGPT model downgrade` · `ChatGPT silent downgrade` · `ChatGPT model routing` · `ChatGPT mini fallback` · `Firefox ChatGPT model monitor` · `Tampermonkey ChatGPT model detector`
