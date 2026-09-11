// ==UserScript==
// @name         ChatGPT Model Downgrade Monitor | 模型鉴定姬
// @name:zh-CN   ChatGPT Model Downgrade Monitor | 模型鉴定姬
// @name:en      ChatGPT Model Downgrade Monitor
// @namespace    chatgpt-model-downgrade-monitor
// @version      1.5.0-rc.8
// @description  Detect ChatGPT silent model downgrades, hidden model routing, mini fallbacks, and requested-vs-response model mismatches. Designed for Tampermonkey users on Firefox and Chromium-family browsers.
// @description:zh-CN  检测 ChatGPT 请求模型、服务器路由与最终应答模型是否一致，帮助发现静默模型切换、mini fallback 与路由冲突；重点面向 Firefox 及其他可安装 Tampermonkey 的桌面浏览器。
// @description:en  Monitor requested, routed, resolved and assistant-reported ChatGPT models to surface silent model switches and routing conflicts, with Firefox/Tampermonkey compatibility as a primary goal.
// @author       DAIORANGE
// @homepageURL  https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor
// @supportURL   https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/issues
// @downloadURL  https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/v1.5.0-rc/ChatGPT-Model-Downgrade-Monitor.user.js
// @updateURL    https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/v1.5.0-rc/ChatGPT-Model-Downgrade-Monitor.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

"use strict";

/*
 * ChatGPT Model Downgrade Monitor / 模型鉴定姬 - Main World observer for model-routing evidence.
 *
 * Engineering notes:
 *  - Runs in the MAIN world via Tampermonkey @run-at document-start + sandbox default
 *    (Tampermonkey executes @grant none scripts in page context by default; no inline
 *    <script> injection is used).
 *  - This is an OBSERVER ONLY. It never modifies fetch request bodies/headers, never
 *    modifies server responses or chunk bytes, never touches React state, never sends
 *    prompts, never re-sends or retries requests.
 *  - Fail-open: every subsystem wraps its own try/catch. If the Guard breaks, the
 *    underlying ChatGPT request/response pipeline is untouched.
 */

/* ------------------------------------------------------------------ */
/* CONFIG                                                              */
/* ------------------------------------------------------------------ */

const CONFIG = {
  NAMESPACE: "CHATGPT_MODEL_DOWNGRADE_MONITOR",
  PROTOCOL_VERSION: 3,
  STORAGE_HISTORY_KEY: "chatgpt-model-downgrade-monitor:history",
  STORAGE_POW_KEY: "chatgpt-model-downgrade-monitor:pow",
  STORAGE_SETTINGS_KEY: "chatgpt-model-downgrade-monitor:settings",
  MAX_HISTORY: 50,
  MAX_POW_SAMPLES: 100,
  MAX_INTERNAL_MESSAGES: 16,
  POW_MAX_BYTES: 256 * 1024,
  STREAM_MAX_EVENT_BYTES: 1024 * 1024,
  PENDING_CAPTURE_TTL_MS: 10 * 60 * 1000,
  MAX_PENDING_CAPTURES: 32,
  DOM_FIND_TIMEOUT_MS: 8000,
  TOAST_DURATION_MS: 5000,
  WS_MAX_FRAME_BYTES: 2 * 1024 * 1024,
  WS_MAX_ENCODED_ITEM_BYTES: 1024 * 1024,
  FINALIZE_GRACE_MS: 2000,
  PENDING_POW_TTL_MS: 15000,
  MAX_PENDING_POW: 8,
  POW_WINDOW: 50,
  DEFAULT_SETTINGS: {
    settingsVersion: 2,
    theme: "wisteria",
    alertEnabled: true,
    soundEnabled: true,
    soundType: "glass",
    soundVolume: 0.55,
    ghostWarningEnabled: true,
    ghostMarkAll: false,
    titleFlashEnabled: true,
    toastEnabled: true,
    silent: false,
    powEnabled: true,
    wsFallbackEnabled: true,
    persistChatSummaries: true,
    floatingAnimEnabled: true,
    networkLabel: "未命名网络",
    conceptPinPositions: {},
    badgePosition: null,
    dashboardPosition: null,
    dashboardSize: null
  },
  ENDPOINTS: {
    POW: [
      "/backend-api/sentinel/chat-requirements",
      "/backend-anon/sentinel/chat-requirements",
      "/api/sentinel/chat-requirements",
      "/backend-api/sentinel/chat-requirements/prepare",
      "/backend-anon/sentinel/chat-requirements/prepare",
      "/api/sentinel/chat-requirements/prepare"
    ],
    CONVERSATION_STREAM: "/backend-api/f/conversation"
  }
};

/* ------------------------------------------------------------------ */
/* UTILS                                                               */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value, max = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function safeUrl(input, base) {
  try {
    return new URL(input instanceof Request ? input.url : String(input), base);
  } catch {
    return null;
  }
}

function isAllowedOrigin(url, base) {
  try {
    const u = safeUrl(url, base);
    if (!u) return false;
    const page = new URL(base);
    return u.origin === page.origin;
  } catch {
    return false;
  }
}

function classifyEndpoint(url, base) {
  try {
    const u = safeUrl(url, base);
    if (!u) return { kind: "other" };
    const pathname = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    if (CONFIG.ENDPOINTS.POW.includes(pathname)) return { kind: "pow_requirements" };
    if (pathname === CONFIG.ENDPOINTS.CONVERSATION_STREAM) return { kind: "conversation_stream" };
    return { kind: "other" };
  } catch {
    return { kind: "other" };
  }
}

function boundedId(value) {
  return asString(value, 512);
}

function friendlyModelName(slug) {
  if (!slug) return "未捕获";
  const raw = String(slug);
  const m = raw.match(/^gpt-(\d+)-(\d+)(.*)$/i);
  if (!m) return raw;
  let suffix = m[3] || "";
  suffix = suffix
    .replace(/^-thinking$/i, " Thinking")
    .replace(/^-mini$/i, " Mini")
    .replace(/^-pro$/i, " Pro")
    .replace(/^-instant$/i, " Instant")
    .replace(/^-([a-z0-9_-]+)$/i, (_, x) => " " + x.replace(/[-_]/g, " "));
  return `GPT-${m[1]}.${m[2]}${suffix}`;
}

function simpleRouteSummary(entry) {
  if (!entry) return { call: null, answer: null, route: null, answerSource: null, text: "尚未捕获模型信息" };
  const call = entry.requestedModel || null;
  const answer = entry.assistantModel || null;
  const route = entry.resolvedModel || entry.serverModel || null;
  let text;
  if (call && answer) {
    text = call === answer
      ? `调用 ${friendlyModelName(call)} → ${friendlyModelName(answer)} 完成应答`
      : `调用 ${friendlyModelName(call)} → ${friendlyModelName(answer)} 完成应答`;
  } else if (answer) {
    text = `最终由 ${friendlyModelName(answer)} 完成应答；调用模型未捕获`;
  } else if (call && route) {
    text = `调用 ${friendlyModelName(call)}；已观测服务器路由 ${friendlyModelName(route)}，最终应答标签尚未捕获`;
  } else if (route) {
    text = `已观测服务器路由 ${friendlyModelName(route)}；调用模型与最终应答标签尚未捕获`;
  } else if (call) {
    text = `调用 ${friendlyModelName(call)}；最终应答模型尚未捕获`;
  } else {
    text = "尚未捕获可用的模型路由信息";
  }
  return { call, answer, route, answerSource: entry.assistantSource || null, text };
}


function normalizeChatText(value) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function clipText(text, max = 120) {
  const t = normalizeChatText(text);
  return t.length <= max ? t : t.slice(0, Math.max(1, max - 1)) + "…";
}

function adaptiveHeadTail(text) {
  const t = normalizeChatText(text);
  if (!t) return "";
  if (t.length <= 72) return t;
  if (t.length <= 140) return `${t.slice(0, 42)}…${t.slice(-30)}`;
  return `${t.slice(0, 52)}…${t.slice(-40)}`;
}

function sentenceList(text) {
  const t = normalizeChatText(text);
  if (!t) return [];
  const matches = t.match(/[^。！？.!?]+[。！？.!?]?/g) || [t];
  return matches.map((x) => x.trim()).filter(Boolean);
}

function localTopic(text) {
  let t = normalizeChatText(text).replace(/```[\s\S]*?```/g, " [代码] ");
  if (!t) return "未命名对话";
  t = t.replace(/^(请|麻烦|帮我|能不能|可以|我想|我要|你能不能|你可以)\s*/i, "");
  const first = (sentenceList(t)[0] || t).replace(/^[:：,，\s]+/, "");
  return clipText(first, 26) || "未命名对话";
}

function summarizePromptText(text) {
  const t = normalizeChatText(text);
  return t ? { topic: localTopic(t), preview: adaptiveHeadTail(t) } : { topic: null, preview: null };
}

function summarizeReplyText(text) {
  const raw = String(text ?? "");
  const t = normalizeChatText(raw);
  if (!t) return { topic: null, preview: null, isCode: false };
  const hasFence = /```/.test(raw);
  const codeish = hasFence || (/\b(const|let|var|function|class|import|def|return|SELECT|FROM)\b/.test(t) && /[{}();=]/.test(t));
  const sansCode = normalizeChatText(raw.replace(/```[\s\S]*?```/g, " "));
  const sentences = sentenceList(sansCode || t);
  const first = sentences[0] || t;
  const last = sentences.length > 1 ? sentences[sentences.length - 1] : "";
  let preview;
  if (codeish) {
    preview = `[代码回答] ${clipText(first, 92)}`;
  } else if (last && last !== first) {
    preview = `${clipText(first, 86)} … ${clipText(last, 72)}`;
  } else {
    preview = adaptiveHeadTail(first);
  }
  return { topic: localTopic(first), preview, isCode: codeish };
}

function messageText(record) {
  const rec = asRecord(record);
  if (!rec) return "";
  const content = asRecord(rec.content);
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const out = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(part);
    else if (asRecord(part) && typeof part.text === "string") out.push(part.text);
  }
  return out.join("\n");
}

function latestUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const rec = asRecord(messages[i]);
    if (!rec) continue;
    const author = asRecord(rec.author);
    const role = (author && asString(author.role, 64)) || asString(rec.role, 64);
    if (role === "user" || role === "human") return rec;
  }
  return asRecord(messages[messages.length - 1]) || null;
}

function currentNetworkSnapshot() {
  const settings = loadSettings();
  let connection = null;
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) connection = {
      effectiveType: typeof c.effectiveType === "string" ? c.effectiveType : null,
      rtt: Number.isFinite(c.rtt) ? c.rtt : null,
      downlink: Number.isFinite(c.downlink) ? c.downlink : null,
      saveData: Boolean(c.saveData)
    };
  } catch {}
  return { label: (settings.networkLabel || "未命名网络").trim() || "未命名网络", connection };
}

// B10: refresh coarse RTT/downlink display when the browser reports a change.
// Uses the browser's own change event only; no extra network probe is sent.
function attachConnectionChangeListener() {
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c || typeof c.addEventListener !== "function") return;
    if (c.__cgmdmBound) return;
    try { Object.defineProperty(c, "__cgmdmBound", { value: true, configurable: true }); }
    catch { c.__cgmdmBound = true; }
    c.addEventListener("change", function () {
      try { if (FloatingMonitor.updateDisplay) FloatingMonitor.updateDisplay(); } catch {}
      try { if (Dashboard.open) Dashboard.render(); } catch {}
    });
  } catch { /* fail open */ }
}

function verdictRank(v) {
  return ({ UNKNOWN: 0, NORMAL: 1, ROUTE_NOTICE: 2, MODEL_MISMATCH: 3, DOWNGRADE_SUSPECTED: 3, EVIDENCE_CONFLICT: 4 })[v] ?? 0;
}

function parsePowDifficulty(value) {
  // Returns { rawHex, decimal } or null.
  // Accepts number, string, hex string, or anything else -> null (unknown).
  let raw;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    raw = Math.floor(value).toString(16);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      raw = BigInt(trimmed).toString(16);
    } else {
      raw = trimmed.replace(/^0[xX]/, "");
      if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
    }
  } else {
    return null;
  }
  if (!raw || raw.length > 256) return null;
  try {
    return { rawHex: raw, decimal: BigInt("0x" + raw).toString(10) };
  } catch {
    return null;
  }
}

function parsePowResponse(root) {
  const candidates = [root, root && asRecord(root.chat_requirements), root && asRecord(root.requirements)]
    .filter((c) => asRecord(c));
  for (const candidate of candidates) {
    const pow = asRecord(candidate.proofofwork) || asRecord(candidate.proof_of_work) || asRecord(candidate.pow);
    if (!pow) continue;
    const parsed = parsePowDifficulty(pow.difficulty);
    if (parsed) return parsed;
  }
  return null;
}

function estimatePowWork(rawHex) {
  // Reverse-engineered ChatGPT clients commonly accept a candidate when a hash
  // prefix of the same hex length is <= the server-provided difficulty threshold.
  // Under that model, p ~= (threshold + 1) / 16^digits and E[attempts] ~= 1/p.
  // This is an explanatory estimate, not an official OpenAI metric.
  try {
    const raw = String(rawHex || "").trim().replace(/^0[xX]/, "");
    if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length < 1 || raw.length > 12) return null;
    const threshold = BigInt("0x" + raw);
    const total = 16n ** BigInt(raw.length);
    const p = Number(threshold + 1n) / Number(total);
    if (!Number.isFinite(p) || p <= 0) return null;
    const attempts = 1 / p;
    return Number.isFinite(attempts) ? attempts : null;
  } catch { return null; }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function safeSetInterval(fn, ms) {
  // window.setInterval is used only for the low-frequency hook re-assert
  // and pending-capture prune; bounded and cheap.
  return window.setInterval(fn, ms);
}

/* ------------------------------------------------------------------ */
/* SSE PARSER (incremental, pass-through)                              */
/* ------------------------------------------------------------------ */

/*
 * SSEParser is a streaming incremental SSE splitter. It does NOT hold the whole
 * stream in memory. It keeps only a small carry buffer between chunks and emits
 * one parsed event object per event boundary.
 *
 * Boundary handling:
 *  - splits on "\n\n" or "\r\n\r\n"
 *  - handles data split across chunks (carry buffer)
 *  - ignores non-data lines (event:, id:, :, retry:)
 *  - ignores "[DONE]"
 *  - malformed JSON within a data block is ignored (emits nothing), never throws
 *  - UTF-8 multibyte characters split across chunk boundaries are handled by
 *    TextDecoder(stream:true) so the carry buffer is always valid string text.
 *
 * The parser is a pure consumer; the caller is responsible for enqueueing the
 * raw chunk to the TransformStream FIRST (pass-through priority).
 */

function createSSEParser(onEvent) {
  let carry = "";
  function push(text) {
    carry += text;
    let boundary;
    while ((boundary = indexOfBoundary(carry)) >= 0) {
      const block = carry.slice(0, boundary);
      carry = carry.slice(boundary + (carry[boundary] === "\n" && carry[boundary + 1] === "\n" ? 2 : 4));
      handleBlock(block);
    }
  }
  function indexOfBoundary(text) {
    const lf = text.indexOf("\n\n");
    const crlf = text.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return -1;
    if (crlf === -1) return lf;
    if (lf === -1) return crlf;
    return Math.min(lf, crlf);
  }
  function handleBlock(block) {
    // block is a complete SSE event (may span multiple lines).
    let dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      // other fields (event:, id:, retry:, comments ":") ignored
    }
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") return;
    try {
      const obj = JSON.parse(payload);
      if (asRecord(obj)) onEvent(obj);
    } catch {
      // malformed event -> ignore, never break the stream
    }
  }
  function flush() {
    if (carry.trim()) handleBlock(carry);
    carry = "";
  }
  // Debug/test accessor: current carry buffer length (bounded memory check).
  return { push, flush, _carryLength: () => carry.length };
}

/* ------------------------------------------------------------------ */
/* EVIDENCE EXTRACTOR                                                  */
/* ------------------------------------------------------------------ */

/*
 * Extracts a small, allowlisted set of routing fields from a parsed SSE event.
 * Sources are tagged so the verdict engine can reason about provenance:
 *   - assistant.metadata.model_slug
 *   - server_ste_metadata.model_slug
 *   - message.metadata.resolved_model_slug
 *   - message.metadata.model_slug
 *   - message.author.role === "assistant"
 *   - message.id
 *   - message.metadata.request_id / conversation_id
 *
 * All values pass through asString with a length bound.
 */

function blankEvidence() {
  return {
    assistantModel: null,
    assistantSource: null,
    resolvedModel: null,
    resolvedSource: null,
    serverModel: null,
    serverSource: null,
    requestedModel: null,
    requestedSource: null,
    messageId: null,
    role: null,
    requestId: null,
    conversationId: null,
    replyPreview: null,
    replyTopic: null,
    replyIsCode: false
  };
}

function mergeEvidence(base, next) {
  for (const [key, value] of Object.entries(next || {})) {
    if (value !== null && value !== undefined && value !== "") base[key] = value;
  }
  return base;
}

/*
 * ChatGPT 的 SSE payload 并不保证 message 位于 JSON 第一层。
 * 递归只抽取 allowlist 路由字段与“短摘要”，从不保存完整回复正文。
 */
function walkEvidence(value, acc, depth = 0, budget = { count: 0 }) {
  if (depth > 10 || budget.count > 3000) return acc;
  budget.count += 1;
  if (Array.isArray(value)) {
    for (const item of value) walkEvidence(item, acc, depth + 1, budget);
    return acc;
  }
  const record = asRecord(value);
  if (!record) return acc;

  const metadata = asRecord(record.metadata);
  const author = asRecord(record.author);
  const role = asString(author ? author.role : null, 64) || asString(record.role, 64);

  if (boundedId(record.conversation_id)) acc.conversationId = boundedId(record.conversation_id);
  if (boundedId(record.request_id)) acc.requestId = boundedId(record.request_id);

  if (metadata) {
    const metaConv = boundedId(metadata.conversation_id);
    const metaReq = boundedId(metadata.request_id);
    if (metaConv) acc.conversationId = metaConv;
    if (metaReq) acc.requestId = metaReq;

    const resolved = boundedId(metadata.resolved_model_slug);
    if (resolved) {
      acc.resolvedModel = resolved;
      acc.resolvedSource = "message.metadata.resolved_model_slug";
    }

    const nestedServer = asRecord(metadata.server_ste_metadata);
    if (nestedServer) {
      const nestedSlug = boundedId(nestedServer.model_slug);
      if (nestedSlug) {
        acc.serverModel = nestedSlug;
        acc.serverSource = "message.metadata.server_ste_metadata.model_slug";
      }
    }

    if (record.type === "server_ste_metadata") {
      const serverSlug = boundedId(metadata.model_slug);
      if (serverSlug) {
        acc.serverModel = serverSlug;
        acc.serverSource = "server_ste_metadata.model_slug";
      }
    }

    if (role === "assistant") {
      const assistantSlug = boundedId(metadata.model_slug);
      if (assistantSlug) {
        acc.assistantModel = assistantSlug;
        acc.assistantSource = "assistant.metadata.model_slug";
      }
      const messageId = boundedId(record.id);
      if (messageId) acc.messageId = messageId;
      acc.role = "assistant";
      const text = messageText(record);
      if (text) {
        const summary = summarizeReplyText(text);
        if (summary.preview) acc.replyPreview = summary.preview;
        if (summary.topic) acc.replyTopic = summary.topic;
        acc.replyIsCode = Boolean(summary.isCode);
      }
    }
  } else if (role === "assistant") {
    const messageId = boundedId(record.id);
    if (messageId) acc.messageId = messageId;
    acc.role = "assistant";
    const text = messageText(record);
    if (text) {
      const summary = summarizeReplyText(text);
      if (summary.preview) acc.replyPreview = summary.preview;
      if (summary.topic) acc.replyTopic = summary.topic;
      acc.replyIsCode = Boolean(summary.isCode);
    }
  }

  if (record.type === "server_ste_metadata" && !metadata) {
    const serverSlug = boundedId(record.model_slug);
    if (serverSlug) {
      acc.serverModel = serverSlug;
      acc.serverSource = "server_ste_metadata.model_slug";
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (record.type === "server_ste_metadata" && key === "metadata") continue;
    if (nested && typeof nested === "object") walkEvidence(nested, acc, depth + 1, budget);
  }
  return acc;
}

function extractEvidence(event) {
  return walkEvidence(event, blankEvidence());
}

function extractRequestEvidence(root) {
  const messages = Array.isArray(root.messages) ? root.messages : [];
  const userMsg = latestUserMessage(messages);
  const prompt = userMsg ? summarizePromptText(messageText(userMsg)) : { topic: null, preview: null };
  return {
    requestedModel: boundedId(root.model),
    requestedSource: "conversation_request.model",
    conversationId: boundedId(root.conversation_id),
    inputMessageId: userMsg ? boundedId(userMsg.id) : null,
    parentMessageId: boundedId(root.parent_message_id),
    promptPreview: prompt.preview,
    promptTopic: prompt.topic
  };
}

/* ------------------------------------------------------------------ */
/* MODEL MATCHER / RISK HEURISTICS                                     */
/* ------------------------------------------------------------------ */

/*
 * Central classification table. Update here when OpenAI introduces new slugs.
 * Risk hint is a HEURISTIC only; the final verdict combines requested +
 * resolved + assistant evidence (see verdict engine).
 */

const MODEL_RULES = [
  { pattern: /(^|[-_])(mini|flash|lite)([-_]|$)/i, tier: "low", riskHint: "mini-class" },
  { pattern: /(^|[-_])fast($|[-_])/i, tier: "low", riskHint: "fast" },
  { pattern: /(^|[-_])text-($|[-_])/i, tier: "low", riskHint: "text-class" },
  { pattern: /(^|[-_])thinking($|[-_])/i, tier: "high", riskHint: "thinking" }
];

function classifyModelSlug(slug) {
  if (!slug) return { tier: null, riskHint: null };
  for (const rule of MODEL_RULES) {
    if (rule.pattern.test(slug)) return { tier: rule.tier, riskHint: rule.riskHint };
  }
  return { tier: "high", riskHint: null };
}

/* ------------------------------------------------------------------ */
/* VERDICT ENGINE                                                      */
/* ------------------------------------------------------------------ */

/*
 * Evidence-Based Route Verdict Engine
 * ----------------------------------
 * Verdicts:
 *   NORMAL               requested/resolved/assistant agree (or no anomaly evidence)
 *   ROUTE_NOTICE         routing changed but evidence insufficient for "downgrade"
 *   DOWNGRADE_SUSPECTED  explicit: higher requested model, lower resolved/assistant
 *   EVIDENCE_CONFLICT    resolved and assistant disagree with each other
 *   UNKNOWN              insufficient evidence
 *
 * Rules are ordered; first match wins. "auto"/"default"/"gpt-4o-mini" style
 * requested models are treated as non-committal (no high->low claim possible).
 */

const VERDICT = Object.freeze({
  NORMAL: "NORMAL",
  ROUTE_NOTICE: "ROUTE_NOTICE",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  DOWNGRADE_SUSPECTED: "DOWNGRADE_SUSPECTED", // legacy history compatibility only
  EVIDENCE_CONFLICT: "EVIDENCE_CONFLICT",
  UNKNOWN: "UNKNOWN"
});

const UI_ZH = Object.freeze({
  verdict: {
    NORMAL: "模型一致",
    ROUTE_NOTICE: "模型字段发生变化",
    MODEL_MISMATCH: "请求与应答模型不一致",
    DOWNGRADE_SUSPECTED: "请求与应答模型不一致",
    EVIDENCE_CONFLICT: "路由证据冲突",
    UNKNOWN: "信息未完整捕获"
  },
  confidence: { high: "高", medium: "中", low: "低" },
  hook: { READY: "正常", PARTIAL: "部分可用", FAILED: "异常" }
});

function zhVerdict(value) {
  return UI_ZH.verdict[value] || value || "信息不足";
}

function zhHook(value) {
  return UI_ZH.hook[value] || value || "未知";
}

function zhReason(reason) {
  let text = String(reason || "");
  const replacements = [
    ["route fields disagree with each other", "服务器路由字段彼此不一致"],
    ["route field and assistant metadata disagree", "服务器路由字段与 Assistant 元数据不一致"],
    ["requested model tier is higher than observed route model tier", "请求模型等级高于实际观测到的路由模型等级"],
    ["route field differs from requested", "服务器路由字段与请求模型不同"],
    ["assistant metadata differs from requested", "Assistant 元数据与请求模型不同"],
    ["requested model differs from final assistant model", "调用模型与最终应答模型不同"],
    ["insufficient evidence to compare", "当前证据不足，无法可靠比较"],
    ["matches observed route evidence", "与当前观测到的路由证据一致"]
  ];
  for (const [from, to] of replacements) text = text.replace(from, to);
  text = text.replace(/\(unknown\)/g, "（来源未知）");
  return text;
}

const NON_COMMITTAL = /^(auto|default|gpt-4o-mini|gpt-5-mini|gpt-5-5-mini|gpt-5-6-mini)$/i;

function isCommittalRequest(model) {
  return Boolean(model && !NON_COMMITTAL.test(model));
}

function lowerTierThan(requested, observed) {
  const a = classifyModelSlug(requested);
  const b = classifyModelSlug(observed);
  if (!a.tier || !b.tier) return false;
  return a.tier === "high" && b.tier === "low";
}

function runVerdict({ requested, resolved, resolvedSource, server, serverSource, assistant, assistantSource }) {
  const routeFields = [
    { k: "resolved", v: resolved, s: resolvedSource || "resolved_model_slug" },
    { k: "server", v: server, s: serverSource || "server_ste_metadata.model_slug" }
  ].filter((f) => Boolean(f.v));

  // 1) Server-side route evidence contradicts itself.
  if (routeFields.length >= 2 && routeFields[0].v !== routeFields[1].v) {
    return {
      verdict: VERDICT.EVIDENCE_CONFLICT,
      confidence: "high",
      reasons: [
        `${routeFields[0].s}=${routeFields[0].v}`,
        `${routeFields[1].s}=${routeFields[1].v}`,
        "route fields disagree with each other"
      ]
    };
  }

  // 2) Server-side evidence and the final ChatGPT answer label disagree.
  if (assistant && routeFields.length) {
    const disagree = routeFields.find((f) => f.v !== assistant);
    if (disagree) {
      return {
        verdict: VERDICT.EVIDENCE_CONFLICT,
        confidence: "high",
        reasons: [
          `${disagree.s}=${disagree.v}`,
          `assistant.metadata.model_slug=${assistant} (${assistantSource || "unknown"})`,
          "route field and assistant metadata disagree"
        ]
      };
    }
  }

  // 3) Core fact: what the page requested and what the final answer labels itself as differ.
  if (isCommittalRequest(requested) && assistant && requested !== assistant) {
    return {
      verdict: VERDICT.MODEL_MISMATCH,
      confidence: "high",
      reasons: [
        `requested=${requested}`,
        `assistant.metadata.model_slug=${assistant} (${assistantSource || "unknown"})`,
        "requested model differs from final assistant model"
      ]
    };
  }

  // 4) The final answer label is not available, but a server-side model field changed.
  if (isCommittalRequest(requested) && routeFields.length && requested !== routeFields[0].v) {
    return {
      verdict: VERDICT.ROUTE_NOTICE,
      confidence: "medium",
      reasons: [
        `requested=${requested}`,
        `${routeFields[0].s}=${routeFields[0].v}`,
        "route field differs from requested"
      ]
    };
  }

  // 5) Core evidence agrees. Other captured model fields must also agree or we would have exited above.
  if (isCommittalRequest(requested) && assistant && requested === assistant) {
    return {
      verdict: VERDICT.NORMAL,
      confidence: routeFields.length ? "high" : "medium",
      reasons: [`requested=${requested} matches final assistant model`]
    };
  }

  // 6) Requested-only / route-only evidence is not enough to make a final answer claim.
  return { verdict: VERDICT.UNKNOWN, confidence: "low", reasons: ["insufficient evidence to compare"] };
}

/* ------------------------------------------------------------------ */
/* TURN-LEVEL EVIDENCE AGGREGATOR                                      */
/* ------------------------------------------------------------------ */

/*
 * TurnEvidence — one user question + one ChatGPT answer = one history card.
 * Fetch and WebSocket are transport sources, NOT separate turns.
 *
 * Merge rules:
 *   1. exact messageId match (strongest)
 *   2. active turn + same conversationId
 *   3. WS evidence arriving post-DONE enriches same turn during grace period
 *   4. null from one transport MUST NOT erase non-null from another
 */

const LIFECYCLE = Object.freeze({
  COLLECTING: "collecting",
  STREAM_DONE: "stream_done",
  FINALIZED: "finalized",
  GRACE: "grace"
});

function createTurnEvidence(streamId) {
  return {
    turnId: crypto.randomUUID(),
    conversationId: null,
    streamId: streamId || null,
    messageId: null,

    requestedModel: null,
    requestedSource: null,
    resolvedModel: null,
    resolvedSource: null,
    serverModel: null,
    serverSource: null,
    assistantModel: null,
    assistantSource: null,

    promptPreview: null,
    promptTopic: null,
    replyPreview: null,
    replyTopic: null,
    replyIsCode: false,

    internalMessages: [],
    transportsSeen: {},
    networkLabel: null,
    networkConnection: null,
    powId: null,
    powRaw: null,
    powDecimal: null,

    evidenceEvents: [],

    lifecycle: LIFECYCLE.COLLECTING,
    finalizedAt: null,
    startedAt: Date.now(),
    pendingCapture: null
  };
}

const TurnAggregator = {
  activeTurn: null,
  finalized: [],
  graceTimer: null,
  turnsByMessageId: new Map(),
  seenEvidenceKeys: new Set(),

  getOrCreateActiveTurn(streamId, conversationId) {
    if (this.activeTurn && !this.activeTurn.finalizedAt) {
      if (streamId && this.activeTurn.streamId === streamId) return this.activeTurn;
      if (conversationId && this.activeTurn.conversationId === conversationId) return this.activeTurn;
    }
    // existing turn entering grace
    if (this.activeTurn && this.activeTurn.lifecycle === LIFECYCLE.STREAM_DONE) {
      this.activeTurn.lifecycle = LIFECYCLE.GRACE;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(function(){ TurnAggregator.finalizeGrace(); }, CONFIG.FINALIZE_GRACE_MS);
    }
    var turn = createTurnEvidence(streamId);
    if (conversationId) turn.conversationId = conversationId;
    this.activeTurn = turn;
    // A7: a PoW observed BEFORE this turn existed is claimed here (newest safe pending sample).
    try { if (typeof State !== "undefined" && State.claimPendingPowForTurn) State.claimPendingPowForTurn(turn); } catch (e) { /* fail open */ }
    return turn;
  },

  finalizeGrace() {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    if (!this.activeTurn || this.activeTurn.lifecycle === LIFECYCLE.FINALIZED) return;
    this.finalizeActiveTurn();
  },

  finalizeActiveTurn() {
    if (!this.activeTurn || this.activeTurn.lifecycle === LIFECYCLE.FINALIZED) return;
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    var turn = this.activeTurn;
    // Compute verdict + findings ON THE TURN so downstream consumers
    // (FloatingMonitor, PoW chart) can read primaryVerdict/findings directly.
    var result = runVerdict({
      requested: turn.requestedModel,
      resolved: turn.resolvedModel,
      resolvedSource: turn.resolvedSource,
      server: turn.serverModel,
      serverSource: turn.serverSource,
      assistant: turn.assistantModel,
      assistantSource: turn.assistantSource
    });
    turn.primaryVerdict = result.verdict;
    turn.confidence = result.confidence;
    turn.reasons = result.reasons;
    // Derive machine-readable findings from the verdict for UI/colors.
    turn.findings = [];
    if (result.verdict === VERDICT.NORMAL) turn.findings.push('CORE_MATCH');
    else if (result.verdict === VERDICT.MODEL_MISMATCH || result.verdict === VERDICT.DOWNGRADE_SUSPECTED) {
      turn.findings.push('REQUEST_RESPONSE_MISMATCH');
      var rf = [
        turn.resolvedModel, turn.serverModel
      ].filter(function(x){ return x; });
      if (rf.length >= 1 && turn.assistantModel && rf.some(function(x){ return x !== turn.assistantModel; })) {
        turn.findings.push('ROUTE_EVIDENCE_CONFLICT');
      }
    }
    else if (result.verdict === VERDICT.EVIDENCE_CONFLICT) {
      turn.findings.push('ROUTE_EVIDENCE_CONFLICT');
    }
    else if (result.verdict === VERDICT.ROUTE_NOTICE) turn.findings.push('ROUTE_NOTICE');
    else turn.findings.push('EVIDENCE_INCOMPLETE');

    turn.lifecycle = LIFECYCLE.FINALIZED;
    turn.finalizedAt = Date.now();
    // RC5: persist a compact semantic snapshot on the linked PoW sample so the
    // historical verdict survives a page reload (runtime turns do not).
    if (turn.powId) {
      try {
        updatePowSample(turn.powId, {
          turnId: turn.turnId,
          linkState: "linked",
          semanticSnapshot: semanticSnapshotFromTurn(turn)
        });
      } catch (e) { /* fail open */ }
    }
    this.finalized.push(turn);
    if (this.finalized.length > 100) this.finalized.shift();
    State.emitTurn(turn);
    this.activeTurn = null;
    this.graceTimer = null;
  },

  /* Provenance: non-null wins. null from one transport must not erase another. */
  applyRequestCapture(turn, entry) {
    turn.pendingCapture = entry;
    if (entry.requestedModel) {
      turn.requestedModel = entry.requestedModel;
      turn.requestedSource = entry.requestedSource || "conversation_request.model";
    }
    if (!turn.conversationId && entry.conversationId) turn.conversationId = entry.conversationId;
    if (entry.promptPreview) { turn.promptPreview = entry.promptPreview; turn.promptTopic = entry.promptTopic; }
    if (entry.network) {
      turn.networkLabel = entry.network.label || turn.networkLabel;
      turn.networkConnection = entry.network.connection || turn.networkConnection;
    }
  },

  applyEvidence(turn, evidence, transport) {
    if (transport) turn.transportsSeen[transport] = true;

    var eventRecord = {
      transport: transport,
      conversationId: evidence.conversationId,
      messageId: evidence.messageId,
      requestedModel: evidence.requestedModel,
      resolvedModel: evidence.resolvedModel,
      serverModel: evidence.serverModel,
      assistantModel: evidence.assistantModel,
      ts: Date.now()
    };
    turn.evidenceEvents.push(eventRecord);
    if (turn.evidenceEvents.length > 50) turn.evidenceEvents.shift();

    if (evidence.conversationId && !turn.conversationId) turn.conversationId = evidence.conversationId;
    if (evidence.messageId) {
      if (!turn.messageId) turn.messageId = evidence.messageId;
      this.turnsByMessageId.set(evidence.messageId, turn);
    }

    /* NON-NULL evidence wins. null transport = no opinion. */
    if (evidence.requestedModel) { turn.requestedModel = evidence.requestedModel; turn.requestedSource = evidence.requestedSource || "ws"; }
    if (evidence.resolvedModel) { turn.resolvedModel = evidence.resolvedModel; turn.resolvedSource = evidence.resolvedSource || turn.resolvedSource; }
    if (evidence.serverModel) { turn.serverModel = evidence.serverModel; turn.serverSource = evidence.serverSource || turn.serverSource; }
    if (evidence.assistantModel) { turn.assistantModel = evidence.assistantModel; turn.assistantSource = evidence.assistantSource || turn.assistantSource; }
    if (evidence.replyPreview) {
      turn.replyPreview = evidence.replyPreview;
      turn.replyTopic = evidence.replyTopic || turn.replyTopic;
      turn.replyIsCode = Boolean(evidence.replyIsCode);
    }

    /* Deduplicated internalMessages by messageId */
    if (evidence.messageId && (evidence.assistantModel || evidence.resolvedModel)) {
      var dup = false;
      for (var k = 0; k < turn.internalMessages.length; k++) {
        if (turn.internalMessages[k].messageId === evidence.messageId) { dup = true; break; }
      }
      if (!dup) {
        turn.internalMessages.push({
          messageId: evidence.messageId,
          role: evidence.role || null,
          assistantModel: evidence.assistantModel || null,
          resolvedModel: evidence.resolvedModel || null
        });
        if (turn.internalMessages.length > CONFIG.MAX_INTERNAL_MESSAGES) turn.internalMessages.shift();
      }
    }

    if (!turn.networkLabel) {
      var snap = currentNetworkSnapshot();
      turn.networkLabel = snap.label;
      turn.networkConnection = snap.connection;
    }
  },

  markStreamDone(streamId) {
    if (!this.activeTurn) return;
    if (this.activeTurn.streamId === streamId && this.activeTurn.lifecycle === LIFECYCLE.COLLECTING) {
      this.activeTurn.lifecycle = LIFECYCLE.STREAM_DONE;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      var self = this;
      this.graceTimer = setTimeout(function(){ self.finalizeGrace(); }, CONFIG.FINALIZE_GRACE_MS);
    }
  },

  associatePow(turn, powSample) {
    if (!turn.powRaw) {
      turn.powId = powSample.powId || null;
      turn.powRaw = powSample.rawHex;
      turn.powDecimal = powSample.decimal;
    }
  },

  findTurnByMessageId(messageId) {
    if (this.turnsByMessageId.has(messageId)) return this.turnsByMessageId.get(messageId);
    if (this.activeTurn && this.activeTurn.messageId === messageId && !this.activeTurn.finalizedAt) return this.activeTurn;
    for (var i = this.finalized.length - 1; i >= 0; i--) {
      if (this.finalized[i].messageId === messageId) return this.finalized[i];
    }
    return null;
  },

  findTurnByConversation(conversationId) {
    if (this.activeTurn && this.activeTurn.conversationId === conversationId && !this.activeTurn.finalizedAt) return this.activeTurn;
    for (var i = this.finalized.length - 1; i >= 0; i--) {
      if (this.finalized[i].conversationId === conversationId) return this.finalized[i];
    }
    return null;
  },

  makeEvidenceKey(evidence, transport) {
    return [
      evidence.conversationId || "_",
      evidence.messageId || "_",
      transport || "_",
      evidence.resolvedModel || "_",
      evidence.serverModel || "_",
      evidence.messageId ? "assistant:" + (evidence.assistantModel || "_") : "_"
    ].join("|");
  },

  isDuplicateEvidence(evidence, transport) {
    var key = this.makeEvidenceKey(evidence, transport);
    if (this.seenEvidenceKeys.has(key)) return true;
    this.seenEvidenceKeys.add(key);
    if (this.seenEvidenceKeys.size > 500) {
      var it = this.seenEvidenceKeys.values().next();
      if (!it.done) this.seenEvidenceKeys.delete(it.value);
    }
    return false;
  },

  reset() {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.activeTurn = null;
    this.finalized = [];
    this.graceTimer = null;
    this.turnsByMessageId.clear();
    this.seenEvidenceKeys.clear();
  },

  // v1.5: Canonical accessors for FloatingMonitor + dashboard consumers
  getActiveTurn() { return this.activeTurn; },
  getLatestFinalizedTurn() {
    for (var i = this.finalized.length - 1; i >= 0; i--) return this.finalized[i];
    return null;
  },
  latestFinalized() { return this.getLatestFinalizedTurn(); }
};

/* ------------------------------------------------------------------ */
/* MESSAGE BUS                                                         */
/* ------------------------------------------------------------------ */

/*
 * Namespaced, versioned bus between the (potentially sandboxed) observer
 * layer and the UI layer. In this single-file script both layers live in the
 * same page context, but the bus keeps the contract explicit and lets the UI
 * layer be driven purely by events (decoupling).
 */

const MSG_TYPE = Object.freeze({
  POW: "CHATGPT_GUARD_POW",
  MODEL_EVIDENCE: "CHATGPT_GUARD_MODEL_EVIDENCE",
  ROUTE_RESULT: "CHATGPT_GUARD_ROUTE_RESULT",
  STATUS: "CHATGPT_GUARD_STATUS"
});

function postBus(type, payload) {
  try {
    window.postMessage(
      {
        source: CONFIG.NAMESPACE,
        version: CONFIG.PROTOCOL_VERSION,
        type,
        payload
      },
      window.location.origin
    );
  } catch {
    /* fail open: bus failure never breaks the network layer */
  }
}

function isValidBusEvent(data) {
  return Boolean(
    data &&
    typeof data === "object" &&
    data.source === CONFIG.NAMESPACE &&
    data.version === CONFIG.PROTOCOL_VERSION &&
    typeof data.type === "string"
  );
}

function listenBus(handler) {
  const listener = (event) => {
    if (event.source !== window) return;
    if (!isValidBusEvent(event.data)) return;
    handler(event.data.type, event.data.payload);
  };
  window.addEventListener("message", listener);
  return listener;
}

/* ------------------------------------------------------------------ */
/* STORAGE                                                             */
/* ------------------------------------------------------------------ */

function loadHistory() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, CONFIG.MAX_HISTORY) : [];
  } catch { return []; }
}

function persistableEntry(entry) {
  const copy = { ...entry };
  if (!loadSettings().persistChatSummaries) {
    delete copy.promptPreview;
    delete copy.promptTopic;
    delete copy.replyPreview;
    delete copy.replyTopic;
    delete copy.replyIsCode;
  }
  return copy;
}

function saveHistory(history) {
  try { localStorage.setItem(CONFIG.STORAGE_HISTORY_KEY, JSON.stringify(history.slice(0, CONFIG.MAX_HISTORY))); }
  catch { /* fail open */ }
}

function addHistoryEntry(entry) {
  const history = loadHistory();
  history.unshift(persistableEntry(entry));
  saveHistory(history);
  return history;
}

function loadPowHistory() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_POW_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, CONFIG.MAX_POW_SAMPLES) : [];
  } catch { return []; }
}

function savePowHistory(samples) {
  try { localStorage.setItem(CONFIG.STORAGE_POW_KEY, JSON.stringify(samples.slice(0, CONFIG.MAX_POW_SAMPLES))); }
  catch { /* fail open */ }
}

function addPowSample(sample) {
  const samples = loadPowHistory();
  samples.unshift(sample);
  savePowHistory(samples);
  return samples;
}

// A7: linked-in-place update of an EXISTING persisted sample (never a duplicate).
function updatePowSample(powId, patch) {
  if (!powId) return false;
  const samples = loadPowHistory();
  let changed = false;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] && samples[i].powId === powId) {
      samples[i] = { ...samples[i], ...patch };
      changed = true;
      break;
    }
  }
  if (changed) savePowHistory(samples);
  return changed;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const merged = { ...CONFIG.DEFAULT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    // v1.3 shipped chat-summary persistence OFF by default. v1.4 makes short summaries
    // part of the normal archive experience; migrate old defaults once.
    if (!parsed || Number(parsed.settingsVersion || 0) < 2) {
      merged.settingsVersion = 2;
      merged.persistChatSummaries = true;
      if (!parsed || typeof parsed.theme !== "string") merged.theme = "wisteria";
      if (!parsed || typeof parsed.soundType !== "string") merged.soundType = "glass";
      if (!parsed || !Number.isFinite(Number(parsed.soundVolume))) merged.soundVolume = 0.55;
      try { localStorage.setItem(CONFIG.STORAGE_SETTINGS_KEY, JSON.stringify(merged)); } catch {}
    }
    return merged;
  } catch { return { ...CONFIG.DEFAULT_SETTINGS }; }
}

function saveSettings(settings) {
  try { localStorage.setItem(CONFIG.STORAGE_SETTINGS_KEY, JSON.stringify(settings)); }
  catch { /* fail open */ }
}

function clearAllStorage() {
  try {
    localStorage.removeItem(CONFIG.STORAGE_HISTORY_KEY);
    localStorage.removeItem(CONFIG.STORAGE_POW_KEY);
  } catch { /* fail open */ }
}

/* ------------------------------------------------------------------ */
/* AUDIO                                                               */
/* ------------------------------------------------------------------ */

/*
 * Singleton WebAudio. One AudioContext per page. Autoplay policies mean the
 * context may stay "suspended"; we resume lazily on first user gesture (Badge
 * click) and otherwise silently no-op. Sounds are short, low-volume and
 * non-abrasive, synthesized with oscillators only.
 */

const AudioFeedback = {
  ctx: null,
  lastClickUnlockAttached: false,
  ensure() {
    if (!this.ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      } catch { this.ctx = null; }
    }
    return this.ctx;
  },
  unlockOnGesture() {
    const ctx = this.ensure();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  },
  attachUnlock() {
    if (this.lastClickUnlockAttached) return;
    this.lastClickUnlockAttached = true;
    window.addEventListener("pointerdown", () => this.unlockOnGesture(), { passive: true });
  },
  tone(freq, durationMs, opts = {}) {
    const st = loadSettings();
    if (!opts.force && !st.soundEnabled) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state === "suspended") return;
    const volume = Math.max(0, Math.min(1, Number(st.soundVolume ?? 0.55)));
    const gain = Math.max(0.0001, (opts.gain ?? 0.055) * volume);
    try {
      const t0 = ctx.currentTime + (opts.delayMs || 0) / 1000;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = opts.type || "sine";
      osc.frequency.setValueAtTime(freq, t0);
      if (opts.toFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.toFreq), t0 + durationMs / 1000);
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
      osc.connect(g); g.connect(ctx.destination); osc.start(t0); osc.stop(t0 + durationMs / 1000 + 0.03);
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch {} };
    } catch {}
  },
  playPreset(name, force = false) {
    this.unlockOnGesture();
    const n = name || loadSettings().soundType || "glass";
    if (n === "none") return;
    if (n === "glass") {
      this.tone(980, 145, { type:"sine", gain:.045, force });
      this.tone(1480, 210, { type:"sine", gain:.03, delayMs:55, force });
    } else if (n === "beep") {
      this.tone(720, 150, { type:"square", gain:.025, force });
    } else if (n === "water") {
      this.tone(1150, 260, { type:"sine", toFreq:620, gain:.04, force });
    } else if (n === "dual") {
      this.tone(660, 130, { type:"sine", gain:.045, force });
      this.tone(880, 160, { type:"sine", gain:.04, delayMs:135, force });
    } else if (n === "alert") {
      this.tone(260, 180, { type:"triangle", gain:.06, force });
      this.tone(220, 230, { type:"triangle", gain:.055, delayMs:180, force });
    }
  },
  good() { /* normal answers are intentionally silent */ },
  danger() { this.playPreset(loadSettings().soundType || "glass"); },
  preview(name) { this.playPreset(name || loadSettings().soundType || "glass", true); }
};

/* ------------------------------------------------------------------ */
/* UI: THEMES / EXPLAINERS / BADGE / DASHBOARD                         */
/* ------------------------------------------------------------------ */

const THEMES = Object.freeze({
  wisteria:{name:"紫藤夜 · Wisteria Night",bg:"#16141d",panel:"#211e2b",surface:"#2c2837",surface2:"#181620",text:"#f7f1fb",muted:"#b8aebe",border:"rgba(226,205,239,.20)",accent:"#c9a7e8",accent2:"#8fd6c1",user:"#56394f",assistant:"#263e43",normal:"#78dfb0",warn:"#f4c96d",danger:"#ff879f",conflict:"#c8a0ff",shadow:"rgba(9,6,15,.48)"},
  sakura:{name:"樱莓奶油 · Sakura Cream",bg:"#f5eee9",panel:"#fff9f5",surface:"#fffdfb",surface2:"#f7ecec",text:"#3f323b",muted:"#8f7884",border:"rgba(129,92,111,.18)",accent:"#d983a5",accent2:"#83adc9",user:"#f8dce7",assistant:"#deedf5",normal:"#4aa57c",warn:"#c88738",danger:"#ce5872",conflict:"#8f6ac0",shadow:"rgba(101,73,86,.18)"},
  mint:{name:"薄荷研究所 · Mint Lab",bg:"#eef7f4",panel:"#f9fffc",surface:"#ffffff",surface2:"#e8f4f1",text:"#243b38",muted:"#708985",border:"rgba(65,116,107,.18)",accent:"#65b8a1",accent2:"#9e86c5",user:"#eee7f7",assistant:"#daf1ea",normal:"#39a67e",warn:"#bd8c39",danger:"#d95d72",conflict:"#8f70bd",shadow:"rgba(49,90,82,.16)"},
  aqua:{name:"水色玻璃 · Aqua Glass",bg:"#0e202b",panel:"rgba(17,41,54,.94)",surface:"rgba(31,61,75,.86)",surface2:"rgba(10,30,42,.82)",text:"#eefaff",muted:"#9fc0cc",border:"rgba(157,218,234,.20)",accent:"#7ed8e4",accent2:"#b5a2ef",user:"rgba(83,80,130,.46)",assistant:"rgba(48,111,124,.45)",normal:"#70dfb6",warn:"#f4ca71",danger:"#ff879f",conflict:"#c3a5ff",shadow:"rgba(3,14,20,.46)"},
  latte:{name:"杏仁拿铁 · Almond Latte",bg:"#eee4d7",panel:"#fffaf2",surface:"#fffdf8",surface2:"#f0e6d8",text:"#4a3c32",muted:"#8b7869",border:"rgba(121,91,67,.18)",accent:"#bd8d68",accent2:"#8ba6a0",user:"#f2d9ca",assistant:"#dfe9e4",normal:"#4f9c76",warn:"#bd8434",danger:"#cb6070",conflict:"#866eb0",shadow:"rgba(104,78,57,.18)"},
  berry:{name:"黑莓霓虹 · Berry Neon",bg:"#100d16",panel:"#191421",surface:"#261b30",surface2:"#110e17",text:"#fff2fb",muted:"#bea8bb",border:"rgba(243,149,219,.18)",accent:"#f08fc6",accent2:"#7fcfe7",user:"#4b1d3e",assistant:"#173d4c",normal:"#75e3b6",warn:"#ffd06f",danger:"#ff668e",conflict:"#bd8cff",shadow:"rgba(6,3,10,.55)"},
  rain:{name:"雨夜终端 · Rainy Terminal",bg:"#111923",panel:"#18232f",surface:"#223140",surface2:"#101821",text:"#ecf5ff",muted:"#9aafc0",border:"rgba(151,190,221,.18)",accent:"#7aaad2",accent2:"#a996d8",user:"#30344e",assistant:"#1f4146",normal:"#70d5a7",warn:"#eec66c",danger:"#ef8199",conflict:"#b9a0ef",shadow:"rgba(5,10,16,.48)"},
  mono:{name:"墨色漫画 · Mono Ink",bg:"#121212",panel:"#f6f4ef",surface:"#ffffff",surface2:"#ece9e3",text:"#1e1e1e",muted:"#6e6a64",border:"rgba(25,25,25,.17)",accent:"#222222",accent2:"#c94954",user:"#eeeae4",assistant:"#e2e5e6",normal:"#247652",warn:"#a36e1e",danger:"#b43142",conflict:"#65499a",shadow:"rgba(0,0,0,.25)"}
});

function activeTheme() {
  const st=loadSettings();
  let id=st.theme||"wisteria";
  if(id==="system") id=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?"sakura":"wisteria";
  return THEMES[id]||THEMES.wisteria;
}
function applyThemeVars(el, theme=activeTheme()) {
  if(!el||!theme)return;
  for(const [k,v] of Object.entries(theme)) if(k!=="name") el.style.setProperty(`--${k}`,v);
}

const CONCEPTS = Object.freeze({
  pow:{title:"PoW · 工作量证明",lead:"服务器要求你的浏览器先完成一个计算挑战，再允许请求继续。",sections:[
    ["为什么平台会用它","自动脚本、爬虫和高频滥用可以非常廉价地制造大量请求。PoW 让每一次请求都先承担计算成本：正常用户通常感觉不到，但批量制造海量请求的总成本会明显上升，因此常用于提高自动化滥用的成本。"],
    ["为什么是用户的电脑来做","服务器负责给出挑战参数，你的浏览器自动计算答案，服务器再检查结果。PoW 要证明的正是“发起请求的一方确实为这次请求付出了计算资源”；如果计算都由服务器完成，就失去了提高客户端请求成本的意义。"],
    ["这个数字到底是什么","模型鉴定姬同时保存服务器返回的 difficulty 原始十六进制阈值和它的十进制显示值。它不是一个简单的“数字越大越难”的分数。公开逆向实现通常把它作为哈希前缀的通过阈值：在位数相同的情况下，阈值越小通常越严格；位数不同时不能直接拿十进制大小比较。"],
    ["模型鉴定姬怎么让它更好懂","除了原始阈值，图表会给出“估算工作量”：按公开逆向算法估算，一次随机尝试通过的概率约等于 (阈值+1) / 16^位数，因此期望尝试次数约为它的倒数。这个估算不是 OpenAI 官方指标，但比直接比较 400000、70000 这类原始数值更直观。"],
    ["常见误区","PoW 不是 IP 质量分。原始阈值高或估算工作量高，都不能单独证明“IP 差”“账号被风控”或“模型降级”。更合理的用法是比较长期分布，再和模型不一致/路由冲突是否同时变化做对照。"]]},
  requested:{title:"调用模型",lead:"你点发送时，ChatGPT 网页要求服务器调用的模型。",sections:[
    ["数据来自哪里","模型鉴定姬从本次 conversation 请求中读取模型字段。它回答的是：“网页这次向服务器请求的是什么模型？”"],
    ["为什么重要","它是比较的起点。只有先知道网页请求了什么模型，才能判断后续服务器字段和最终回答是否发生变化。"]]},
  assistant:{title:"应答模型",lead:"这条 ChatGPT 回答自己标记的模型。",sections:[
    ["什么是 Assistant 回复","ChatGPT 的数据结构把用户叫 user，把 ChatGPT 这一侧叫 assistant。白话就是：你发完问题后，屏幕上 ChatGPT 给你的那条回答。"],
    ["数据来自哪里","模型鉴定姬读取这条回答自身元数据中的 model_slug，用来回答：“最后这条 ChatGPT 回答标记自己是由什么模型生成的？”"],
    ["为什么重要","它和“调用模型”是两项核心对比。两者不同，就可以客观地说“请求与应答模型不一致”，无需先猜是不是降级。"]]},
  server:{title:"服务器路由",lead:"ChatGPT 响应里暴露出的服务器侧模型路由字段。",sections:[
    ["它表示什么","模型鉴定姬读取类似 server_ste_metadata.model_slug 的字段，把它当作服务器内部路由的一项旁证。"],
    ["为什么不能单独下结论","服务器路由字段并不等于最终回答自己的模型标签。若它和应答模型不同，模型鉴定姬会标记“路由证据冲突”，而不是擅自选一个当真相。"]]},
  resolved:{title:"服务器确认模型",lead:"服务器处理这次请求后，在返回数据里给出的模型标记。",sections:[
    ["白话解释","网页先告诉服务器“我要用这个模型”。服务器收到请求以后，返回的数据里有时还会给出 resolved_model_slug。可以把它理解成：“服务器收到你的模型请求以后，返回数据里把这次请求记成了哪个模型。”"],
    ["怎么使用","它是一项服务器侧证据。若它与调用模型或应答模型不同，会参与冲突判断；但它不会单独覆盖最终回答自己的模型标记。"]]},
  conflict:{title:"路由证据冲突",lead:"不同来源报告了不同模型，模型鉴定姬不会替你猜哪个才是真相。",sections:[
    ["调用模型","网页发送消息时，请求服务器使用的模型。"],
    ["服务器路由","服务器响应中暴露出的内部路由模型字段。"],
    ["应答模型","最终显示给你的 ChatGPT 回答自身携带的模型标记。"],
    ["为什么提示冲突","当已捕获证据中出现不止一种模型值，尤其服务器路由/确认字段与最终应答模型不一致时，会显示冲突并列出具体不同字段。"]]},
  completeness:{title:"证据完整度",lead:"它表示这一轮成功捕获了多少项模型证据，不是“插件有多大把握”的主观分数。",sections:[
    ["核心对比 2/2","核心对比只有两项：调用模型、应答模型，是“总证据”里的一个子集。2/2 表示两项都抓到了。"],
    ["总证据 4/4","总证据一共四项：调用模型、应答模型（核心对比），加服务器确认模型、服务器路由（服务器辅助证据）。4/4 表示四项都抓到了。"],
    ["为什么这样量化","核心对比是子集、总证据是全集，这样能把“信息不足”变成可检查的事实：到底缺的是哪一项，而不是给一个模糊的置信度百分比。"]]},
  rtt:{title:"浏览器 RTT 粗略估算",lead:"navigator.connection.rtt 是浏览器提供的粗略网络往返延迟估算，单位毫秒（ms）。它是整数、更新不频繁，这是正常现象。",sections:[
    ["这是粗略估算，不是精确 Ping","浏览器基于近期实际联网情况给出一个粗略估算值，可能长时间保持同一个整数（例如 100 ms）。它不会精确到小数，也不代表针对 OpenAI 单独做了一次实时 Ping。"],
    ["代理环境下包含哪一段","如果你使用 VPN、Clash 或其他代理，它反映的是浏览器实际联网环境的整体效果，可能包含你的电脑 → 本地网络 → 代理链路 → 远端网络 → 网站服务器。"],
    ["为什么不应据此判断模型路由","它可能更新不频繁，也不是针对当前这条 ChatGPT 请求测出的精确延迟，精度不足以用来判断模型是否降级。"],
    ["界面如何更新","浏览器支持 connection.change 事件时，模型鉴定姬会监听并刷新显示；不会为了让它变化而额外发起网络探测请求。"]]},
  downlink:{title:"浏览器下行估算",lead:"浏览器根据近期连接估算的有效下载能力，通常以 Mbps 表示。",sections:[
    ["它包含什么","使用代理时，这个数字体现的是浏览器当前整条联网环境的效果，不等同于你的宽带标称速度，也不等同于某个代理节点的单独限速。"],
    ["为什么记录","主要用于给网络环境留一个旁证，便于你比较不同节点或不同时间段；它不是模型路由判定指标。"]]},
  status:{title:"状态判定是怎么来的",lead:"模型鉴定姬只根据已捕获字段之间是否一致来显示状态，不用模糊的“感觉像降级”。",sections:[
    ["模型一致","调用模型与应答模型相同，并且已捕获的服务器侧模型字段没有与它们冲突。"],
    ["请求与应答模型不一致","两项核心对比 2/2 都已捕获，而且调用模型 ≠ 应答模型。这个提示只描述事实，不自动声称原因。"],
    ["路由证据冲突","服务器确认/服务器路由/应答模型之间出现不同模型值。界面会列出具体哪个字段不同。"],
    ["信息未完整捕获","核心对比没有达到 2/2，因此当前信息不足以直接比较“请求”和“最终回答”。"]]}
});

function conceptButton(key,label="ⓘ") { return `<button class="info" data-concept="${escapeHtml(key)}" title="点开解释">${escapeHtml(label)}</button>`; }
function evidenceSnapshot(entry){
  const items=[
    {key:"requested",label:"调用模型",value:entry&&entry.requestedModel,concept:"requested"},
    {key:"resolved",label:"服务器确认",value:entry&&entry.resolvedModel,concept:"resolved"},
    {key:"server",label:"服务器路由",value:entry&&entry.serverModel,concept:"server"},
    {key:"assistant",label:"应答模型",value:entry&&entry.assistantModel,concept:"assistant"}
  ];
  const captured=items.filter(x=>x.value);
  const core=items.filter(x=>x.key==="requested"||x.key==="assistant");
  const coreCaptured=core.filter(x=>x.value).length;
  const unique=[...new Set(captured.map(x=>x.value))];
  return {items,captured,coreCaptured,unique};
}
function statusInfo(entry){
  if(!entry)return{title:"等待鉴定",tone:"unknown",basis:"发送一条消息后，模型鉴定姬会比较调用模型和最终应答模型。",metrics:[]};
  const e=evidenceSnapshot(entry), req=entry.requestedModel, ans=entry.assistantModel;
  const metrics=[`核心对比 ${e.coreCaptured}/2`,`总证据 ${e.captured.length}/4`,`${e.unique.length||0} 种模型值`];
  if(entry.verdict===VERDICT.EVIDENCE_CONFLICT){
    const groups=e.unique.map(v=>`${friendlyModelName(v)}：${e.captured.filter(x=>x.value===v).map(x=>x.label).join("、")}`);
    return{title:"路由证据冲突",tone:"conflict",basis:`触发条件：${e.captured.length} 项已捕获模型证据中出现 ${e.unique.length} 种不同模型值。${groups.join("；")}。`,metrics};
  }
  if(entry.verdict===VERDICT.MODEL_MISMATCH||entry.verdict===VERDICT.DOWNGRADE_SUSPECTED||(req&&ans&&req!==ans)){
    return{title:"请求与应答模型不一致",tone:"danger",basis:`触发条件：两项核心对比已捕获（2/2），调用模型 ${friendlyModelName(req)} ≠ 应答模型 ${friendlyModelName(ans)}。这里先报告可观察事实，不自动猜测发生变化的原因。`,metrics};
  }
  if(entry.verdict===VERDICT.ROUTE_NOTICE){
    const changed=e.captured.filter(x=>x.key!=="requested"&&req&&x.value!==req).map(x=>`${x.label}=${friendlyModelName(x.value)}`);
    return{title:"模型字段发生变化",tone:"warn",basis:`触发条件：${changed.join("；")||"服务器侧模型字段与调用模型不同"}。应答模型${ans?"已捕获":"尚未捕获"}，因此这里只报告字段变化。`,metrics};
  }
  if(req&&ans&&req===ans&&e.unique.length<=1){
    return{title:"模型一致",tone:"normal",basis:`触发条件：调用模型 = 应答模型 = ${friendlyModelName(req)}；已捕获的 ${e.captured.length}/4 项总证据中只出现 1 种模型值。`,metrics};
  }
  const missing=e.items.filter(x=>!x.value).map(x=>x.label);
  return{title:"信息未完整捕获",tone:"unknown",basis:`触发条件：核心对比只有 ${e.coreCaptured}/2。当前缺少：${missing.join("、")||"未知字段"}。`,metrics};
}

/* ------------------------------------------------------------------ */
/* CANONICAL POW SERIES (single source of truth)                       */
/* ------------------------------------------------------------------ */

const COLOR_RGB_CACHE = new Map();
function parseCssColorToRgb(value){
  const key=String(value||"");
  if(COLOR_RGB_CACHE.has(key))return COLOR_RGB_CACHE.get(key);
  let out=null;
  const raw=key.trim();
  if(/^#[0-9a-f]{3}$/i.test(raw)){
    out={r:parseInt(raw[1]+raw[1],16),g:parseInt(raw[2]+raw[2],16),b:parseInt(raw[3]+raw[3],16)};
  }else if(/^#[0-9a-f]{6}$/i.test(raw)){
    out={r:parseInt(raw.slice(1,3),16),g:parseInt(raw.slice(3,5),16),b:parseInt(raw.slice(5,7),16)};
  }else{
    const m=raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if(m)out={r:+m[1],g:+m[2],b:+m[3]};
  }
  COLOR_RGB_CACHE.set(key,out);
  return out;
}
function mixCssColor(c1,c2,t){
  // Continuous local color transition for the travelling pulse (A16).
  const a=parseCssColorToRgb(c1),b=parseCssColorToRgb(c2);
  if(!a||!b)return c1;
  const k=Math.max(0,Math.min(1,Number(t)||0));
  return "rgb("+Math.round(a.r+(b.r-a.r)*k)+","+Math.round(a.g+(b.g-a.g)*k)+","+Math.round(a.b+(b.b-a.b)*k)+")";
}

// Canonical semantic phase — ONE mapping shared by node, segment and pulse (A14/A15/A16).
function powSemanticPhase(linkState,verdict,hasConflict){
  if(linkState==="pending")return "incomplete";
  if(linkState==="unlinked"||linkState==="ambiguous")return "unlinked";
  if(hasConflict&&(verdict===VERDICT.MODEL_MISMATCH||verdict===VERDICT.DOWNGRADE_SUSPECTED))return "mismatch-conflict";
  if(verdict===VERDICT.NORMAL)return "normal";
  if(verdict===VERDICT.MODEL_MISMATCH||verdict===VERDICT.DOWNGRADE_SUSPECTED)return "mismatch";
  if(verdict===VERDICT.EVIDENCE_CONFLICT)return "conflict";
  return "incomplete";
}
function powSemanticColor(phase,theme){
  const t=theme||activeTheme();
  if(phase==="normal")return t.normal;
  if(phase==="mismatch"||phase==="mismatch-conflict")return t.danger;
  if(phase==="conflict")return t.conflict;
  if(phase==="incomplete")return t.warn;
  return t.muted;
}

// ONE builder for every PoW consumer (full chart + collapsed/expanded mini + tooltip + debug).
// Ordering is always OLD -> NEW (left -> right); consumers take .slice(-N) for tails (A11/A12).
// Association is powId <-> turnId only. powDecimal is never an identity (A10).
// RC5: reconstruct machine-readable findings from a persisted history entry.
// Old records may not carry findings, so derive them conservatively from the
// verdict/evidenceConflict/models that WERE persisted. Never invent data.
function findingsFromHistoryEntry(entry){
  if(!entry)return [];
  if(Array.isArray(entry.findings)&&entry.findings.length)return entry.findings.slice();
  const out=[];
  const v=entry.verdict;
  if(v===VERDICT.NORMAL)out.push("CORE_MATCH");
  else if(v===VERDICT.MODEL_MISMATCH||v===VERDICT.DOWNGRADE_SUSPECTED){
    out.push("REQUEST_RESPONSE_MISMATCH");
    const rf=[entry.resolvedModel,entry.serverModel].filter(Boolean);
    if(rf.length>=1&&entry.assistantModel&&rf.some(function(x){return x!==entry.assistantModel;}))out.push("ROUTE_EVIDENCE_CONFLICT");
  }
  else if(v===VERDICT.EVIDENCE_CONFLICT)out.push("ROUTE_EVIDENCE_CONFLICT");
  else if(v===VERDICT.ROUTE_NOTICE)out.push("ROUTE_NOTICE");
  else if(v)out.push("EVIDENCE_INCOMPLETE");
  if(entry.evidenceConflict&&out.indexOf("ROUTE_EVIDENCE_CONFLICT")<0)out.push("ROUTE_EVIDENCE_CONFLICT");
  return out;
}
function turnLikeFromHistoryEntry(entry){
  if(!entry)return null;
  return {
    turnId:entry.turnId||entry.captureId||null,
    primaryVerdict:entry.verdict||null,
    verdict:entry.verdict||null,
    findings:findingsFromHistoryEntry(entry),
    requestedModel:entry.requestedModel||null,
    resolvedModel:entry.resolvedModel||null,
    serverModel:entry.serverModel||null,
    assistantModel:entry.assistantModel||null,
    finalizedAt:entry.timestamp||null
  };
}
// RC5: self-sufficient semantic snapshot persisted onto the PoW sample.
function semanticSnapshotFromTurn(turn){
  if(!turn)return null;
  return {
    verdict:turn.primaryVerdict||turn.verdict||null,
    findings:Array.isArray(turn.findings)?turn.findings.slice():[],
    requestedModel:turn.requestedModel||null,
    resolvedModel:turn.resolvedModel||null,
    serverModel:turn.serverModel||null,
    assistantModel:turn.assistantModel||null,
    finalizedAt:turn.finalizedAt||Date.now()
  };
}
function turnLikeFromSnapshot(snap){
  if(!snap)return null;
  return {
    turnId:null,
    primaryVerdict:snap.verdict||null,
    verdict:snap.verdict||null,
    findings:Array.isArray(snap.findings)?snap.findings.slice():[],
    requestedModel:snap.requestedModel||null,
    resolvedModel:snap.resolvedModel||null,
    serverModel:snap.serverModel||null,
    assistantModel:snap.assistantModel||null,
    finalizedAt:snap.finalizedAt||null
  };
}
// Guards the optional one-time snapshot backfill (exact match only).
const POW_SNAPSHOT_BACKFILL_DONE = new Set();

function buildPowSeries(limit){
  const cap=Number.isFinite(limit)&&limit>0?Math.min(limit,CONFIG.MAX_POW_SAMPLES):CONFIG.POW_WINDOW;
  const samples=loadPowHistory();
  const finalized=TurnAggregator&&Array.isArray(TurnAggregator.finalized)?TurnAggregator.finalized:[];
  const active=TurnAggregator&&TurnAggregator.activeTurn?TurnAggregator.activeTurn:null;
  const liveTurnById={};
  for(let i=0;i<finalized.length;i++){const ft=finalized[i];if(ft&&ft.turnId)liveTurnById[ft.turnId]=ft;}
  if(active&&active.turnId)liveTurnById[active.turnId]=active;

  // RC5: persisted model history participates in turn lookup. Runtime memory is
  // wiped on reload, but history survives, so a valid link must not degrade.
  const persistedTurnById={};
  const persistedEntryById={};
  const history=loadHistory();
  for(let i=0;i<history.length;i++){
    const e=history[i];if(!e)continue;
    if(e.turnId&&!persistedTurnById[e.turnId]){persistedTurnById[e.turnId]=turnLikeFromHistoryEntry(e);persistedEntryById[e.turnId]=e;}
    if(e.captureId&&!persistedTurnById[e.captureId]){persistedTurnById[e.captureId]=turnLikeFromHistoryEntry(e);persistedEntryById[e.captureId]=e;}
  }

  const now=Date.now();
  const raw=[];
  for(let i=0;i<samples.length&&i<cap;i++){
    const p=samples[i];
    if(!p)continue;
    const work=estimatePowWork(p.rawHex);
    if(!Number.isFinite(work))continue;

    let linkState=p.linkState||(p.turnId?"linked":"unlinked");
    let turn=null;
    let hydrationSource="none";

    // STEP 1 live runtime turn (active or finalized)
    if(p.turnId&&liveTurnById[p.turnId]){turn=liveTurnById[p.turnId];hydrationSource="live-turn";}
    // STEP 2 persisted model history by exact turnId / captureId
    else if(p.turnId&&persistedTurnById[p.turnId]){turn=persistedTurnById[p.turnId];hydrationSource="persisted-history";}
    // STEP 3 self-sufficient semantic snapshot stored on the PoW sample
    else if(p.semanticSnapshot){turn=turnLikeFromSnapshot(p.semanticSnapshot);hydrationSource="semantic-snapshot";}

    if(turn){
      linkState="linked";
      // STEP 9 optional one-time backfill, exact id match only.
      if(hydrationSource==="persisted-history"&&!p.semanticSnapshot&&p.powId&&!POW_SNAPSHOT_BACKFILL_DONE.has(p.powId)){
        POW_SNAPSHOT_BACKFILL_DONE.add(p.powId);
        const entry=persistedEntryById[p.turnId];
        const exact=Boolean(entry&&(entry.turnId===p.turnId||entry.captureId===p.turnId));
        const snap=semanticSnapshotFromTurn(turn);
        if(snap&&exact){try{updatePowSample(p.powId,{turnId:p.turnId,linkState:"linked",semanticSnapshot:snap});}catch(e){}}
      }
    } else {
      if(linkState==="linked")linkState="unlinked";
      if(linkState==="pending"){
        const pendTs=p.observedAt?new Date(p.observedAt).getTime():0;
        if(!pendTs||now-pendTs>CONFIG.PENDING_POW_TTL_MS)linkState="unlinked";
      }
      // STEP 4 conservative legacy fallback (pre-powId samples only).
      if(linkState==="unlinked"&&!p.powId&&!p.semanticSnapshot){
        const matches=[];
        for(let lk=finalized.length-1;lk>=0;lk--){const ft=finalized[lk];if(ft&&ft.powRaw&&ft.powRaw===p.rawHex)matches.push(ft);}
        if(matches.length===1){turn=matches[0];linkState="legacy";hydrationSource="legacy";}
        else if(matches.length>1){linkState="ambiguous";}
      }
    }

    const verdict=turn?(turn.primaryVerdict||turn.verdict||null):null;
    const findings=turn&&Array.isArray(turn.findings)?turn.findings.slice():[];
    const hasConflict=findings.indexOf("ROUTE_EVIDENCE_CONFLICT")>=0;
    raw.push({
      powId:p.powId||null,
      turnId:p.turnId||null,
      observedAt:p.observedAt||null,
      rawHex:p.rawHex||"",
      decimal:p.decimal!==undefined&&p.decimal!==null?String(p.decimal):null,
      work:work,
      linkState:linkState,
      hydrationSource:hydrationSource,
      phase:powSemanticPhase(linkState,verdict,hasConflict),
      verdict:verdict,
      findings:findings,
      hasConflict:hasConflict,
      requestedModel:turn?turn.requestedModel||null:null,
      resolvedModel:turn?turn.resolvedModel||null:null,
      serverModel:turn?turn.serverModel||null:null,
      assistantModel:turn?turn.assistantModel||null:null,
      networkLabel:p.networkLabel||"",
      turn:turn||null
    });
  }
  const points=raw.reverse(); // OLD -> NEW
  let scaleMin=null,scaleMax=null;
  if(points.length){
    scaleMin=points[0].work;scaleMax=points[0].work;
    for(let i=1;i<points.length;i++){const w=points[i].work;if(w<scaleMin)scaleMin=w;if(w>scaleMax)scaleMax=w;}
    if(scaleMax-scaleMin<0.001)scaleMax=scaleMin+0.001;
  }
  return {points:points,scaleMin:scaleMin,scaleMax:scaleMax,count:points.length};
}

/* ================================================================== */
/* FLOATING MONITOR BAR (replaces old Badge)                           */
/* ================================================================== */

const FloatingMonitor = {
  host:null,root:null,animFrame:null,_dragged:false,pulseOffset:0,_visible:true,
  _lastFinalizedModel:null,_lastFinalizedVerdict:null,_activeCollecting:false,

  ensure(){
    if(this.host&&this.host.isConnected){this.applyTheme();return this.root;}
    this.host=document.createElement("div");this.host.id="chatgpt-model-downgrade-monitor-badge";this.host.style.cssText="all:initial;position:fixed;z-index:2147483647;touch-action:none;";this.root=this.host.attachShadow({mode:"open"});
    this.root.innerHTML=`<style>
      :host{--accent:#c9a7e8;--panel:#211e2b;--text:#f7f1fb;--surface:#2c2837;--surface2:#181620;--normal:#78dfb0;--danger:#ff879f;--conflict:#c8a0ff;--warn:#f4c96d;--muted:#b8aebe}
      .bar{position:relative;display:flex;align-items:stretch;height:48px;min-width:230px;max-width:280px;padding:0;border-radius:12px;cursor:pointer;user-select:none;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--border, rgba(226,205,239,.20));backdrop-filter:blur(15px) saturate(135%);box-shadow:0 9px 28px rgba(10,8,16,.24);transition:height .28s cubic-bezier(.34,1.56,.64,1),max-width .28s cubic-bezier(.34,1.56,.64,1),border-color .35s ease;overflow:hidden}
      .bar:hover{height:62px;max-width:380px}
      .bar-main-hit{display:flex;align-items:center;gap:8px;padding:0 10px;min-width:0;flex:1;cursor:pointer;border:0;background:transparent;color:inherit;font:inherit;text-align:left}
      .bar-main-hit:focus{outline:none}
      .bar-seal{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;flex-shrink:0;background:color-mix(in srgb,var(--accent) 20%,var(--surface2));color:var(--accent);font-size:12px;font-weight:850;transition:background-color .35s,color .35s}
      .bar-model{min-width:0}
      .bar-model-name{font-size:15px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .35s}
      .bar-model-status{font-size:12px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bar-model-status.collecting{opacity:.5;animation:bar-pulse-text 1.8s ease-in-out infinite}
      @keyframes bar-pulse-text{0%,100%{opacity:.5}50%{opacity:1}}
      .bar-model-status.hint{font-size:12px;color:var(--muted)}
      .bar-pow-hit{display:flex;align-items:center;padding:0 10px 0 6px;flex-shrink:0;flex-basis:104px;cursor:pointer;border:0;background:transparent;color:inherit;font:inherit}
      .bar-pow-hit:focus{outline:none}
      .wave-svg{display:block;pointer-events:none}
      .wave-svg *{pointer-events:none}
      .pulse-group{pointer-events:none}
      /* Expanded: hide left text block so waveform owns the space; seal stays small */
      .bar:hover .bar-model{opacity:0;width:0;overflow:hidden;margin:0}
      .bar:hover .bar-main-hit{padding-left:8px}
      .bar:hover .bar-pow-hit{flex:1;flex-basis:auto;padding:0 10px}
      @media(prefers-reduced-motion:reduce){.bar:hover{height:48px;max-width:280px;transition:none}.bar:hover .bar-model{opacity:1;width:auto;margin:0}.bar-model-status.collecting{animation:none}}
    </style><div class="bar"><button class="bar-main-hit" data-region="main" title="打开模型鉴定姬"><span class="bar-seal">鉴</span><span class="bar-model"><span class="bar-model-name">模型鉴定姬</span><span class="bar-model-status hint"></span></span></button><button class="bar-pow-hit" data-region="pow" title="查看 PoW 分析"><svg class="wave-svg" width="90" height="44" viewBox="0 0 90 44"><polyline fill="none" stroke="var(--muted)" stroke-width="1.5" points="0,22 90,22"/></svg></button></div>`;
    try{document.documentElement.appendChild(this.host)}catch{return this.root}
    this.restorePosition();this.applyTheme();
    var bar=this.root.querySelector('.bar');
    var self=this;
    if(bar){
      this.installDrag(bar);
      // Stable bar-level click routing via explicit hit-area data-region.
      bar.addEventListener('click',function(e){
        if(self._dragged){self._dragged=false;return}
        AudioFeedback.unlockOnGesture();
        var region=null;
        try{var hit=e.target&&e.target.closest?e.target.closest('[data-region]'):null;region=hit?hit.getAttribute('data-region'):null;}catch(_){}
        if(region==='pow'){
          Dashboard.show();Dashboard.activeTab='network';Dashboard.powExpanded=true;Dashboard.render();
        }else{
          Dashboard.toggle();
        }
      });
      bar.addEventListener('dblclick',function(e){e.preventDefault();e.stopPropagation();self.resetPosition()});
      bar.addEventListener('mouseenter',function(){self._expanded=true;self.drawWave()});
      bar.addEventListener('mouseleave',function(){self._expanded=false;self.drawWave()});
    }
    this.maybeStartAnim();
    return this.root;
  },

  applyTheme(){
    var bar=this.root&&this.root.querySelector('.bar');
    if(!bar)return;
    var t=activeTheme();
    bar.style.setProperty('--panel',t.panel);bar.style.setProperty('--text',t.text);
    bar.style.setProperty('--surface',t.surface);bar.style.setProperty('--surface2',t.surface2);
    bar.style.setProperty('--normal',t.normal);bar.style.setProperty('--danger',t.danger);
    bar.style.setProperty('--conflict',t.conflict);bar.style.setProperty('--warn',t.warn);
    bar.style.setProperty('--muted',t.muted);bar.style.setProperty('--border',t.border);
    bar.style.setProperty('--accent',t.accent);
  },

  maybeStartAnim(){
    var self=this;
    var st=loadSettings();
    if(!st.floatingAnimEnabled){this.stopAnim();return;}
    if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches){this.stopAnim();return;}
    this.startAnim();
  },

  startAnim(){
    if(this.animFrame)return;
    var self=this;
    this._animActive=true;
    this._pulseProgress=0;
    if(!this._pulsePathLen)this._pulsePathLen=1;
    var lastT=0;
    function frame(ts){
      if(!lastT)lastT=ts;
      var dt=Math.min(50,ts-lastT);lastT=ts;
      var speed=self._pulsePathLen/(self._expanded?7:11)*dt/1000;
      self._pulseProgress+=speed;
      // A4: progress keeps increasing and wraps; the opacity envelope fades both
      // ends, so there is no hard disappearance and no broken tail.
      if(self._pulseProgress>=self._pulsePathLen)self._pulseProgress=self._pulseProgress%self._pulsePathLen;
      self._renderPulseOnly();
      self.animFrame=requestAnimationFrame(frame);
    }
    this.animFrame=requestAnimationFrame(frame);
  },

  stopAnim(){
    this._animActive=false;
    if(this.animFrame){cancelAnimationFrame(this.animFrame);this.animFrame=null}
    this._pulseProgress=0;
    this._renderPulseOnly();
  },

  _expanded:false,
  _lastGeomTS:0,

  getPoWPoints(count){
    // Canonical delegation: the mini chart is an exact tail of the ONE canonical series.
    count=count||9;
    var series=buildPowSeries(CONFIG.POW_WINDOW);
    return series.points.slice(-count);
  },

  getStateInfo(){
    var activeTurn=TurnAggregator.activeTurn;
    var latestFinalized=TurnAggregator.latestFinalized();
    var isCollecting=activeTurn&&activeTurn.lifecycle!==LIFECYCLE.FINALIZED;
    var stale=latestFinalized||null;
    if(stale){this._lastFinalizedModel=stale.assistantModel;this._lastFinalizedVerdict=stale.primaryVerdict}
    this._activeCollecting=isCollecting;
    return{
      isCollecting:isCollecting,
      model:this._lastFinalizedModel||null,
      verdict:this._lastFinalizedVerdict||null,
      activeTurn:activeTurn||null,
      finalized:stale||null
    };
  },

  setStatus(verdict,model){
    if(model)this._lastFinalizedModel=model;
    if(verdict)this._lastFinalizedVerdict=verdict;
    this.ensure();this.updateDisplay();
  },

  updateDisplay(){
    var root=this.root;if(!root)return;
    var nameEl=root.querySelector('.bar-model-name');
    var statusEl=root.querySelector('.bar-model-status');
    var sealEl=root.querySelector('.bar-seal');
    if(!nameEl||!statusEl||!sealEl)return;
    var info=this.getStateInfo();
    var t=activeTheme();
    var accent=t.accent;

    if(info.model){
      nameEl.textContent=friendlyModelName(info.model);
    }else{
      nameEl.textContent='模型鉴定姬';
    }

    statusEl.classList.remove('collecting','hint');
    if(info.isCollecting){
      statusEl.textContent='正在采集本轮证据…';statusEl.classList.add('collecting');
      accent=info.finalized?this.colorForVerdict(info.finalized.primaryVerdict,t):t.accent;
    }else if(info.verdict===VERDICT.NORMAL){
      statusEl.textContent='模型一致';accent=t.normal;
    }else if(info.verdict===VERDICT.MODEL_MISMATCH||info.verdict===VERDICT.DOWNGRADE_SUSPECTED){
      statusEl.textContent='请求与应答模型不一致';accent=t.danger;
    }else if(info.verdict===VERDICT.EVIDENCE_CONFLICT){
      statusEl.textContent='路由证据冲突';accent=t.conflict;
    }else if(info.verdict===VERDICT.ROUTE_NOTICE){
      statusEl.textContent='模型字段发生变化';accent=t.warn;
    }else if(info.verdict===VERDICT.UNKNOWN||!info.model){
      statusEl.textContent='等待鉴定';statusEl.classList.add('hint');accent=t.muted;
    }else{
      statusEl.textContent='';statusEl.classList.add('hint');
    }
    sealEl.style.setProperty('background',`color-mix(in srgb,${accent} 20%,${t.surface2})`);
    sealEl.style.setProperty('color',accent);
    this.drawWave();
  },

  colorForVerdict(v,t){if(!t)t=activeTheme();return v===VERDICT.NORMAL?t.normal:v===VERDICT.MODEL_MISMATCH||v===VERDICT.DOWNGRADE_SUSPECTED?t.danger:v===VERDICT.EVIDENCE_CONFLICT?t.conflict:v===VERDICT.ROUTE_NOTICE||v===VERDICT.UNKNOWN?t.warn:t.muted},

  drawWave(){
    var root=this.root;if(!root)return;
    var svg=root.querySelector('.wave-svg');if(!svg)return;
    var _expanded=this._expanded;
    var count=_expanded?18:9;
    // A12: the mini chart is an EXACT tail of the canonical full window.
    var series=buildPowSeries(CONFIG.POW_WINDOW);
    var points=series.points.slice(-count);
    this._lastGeomTS=Date.now();
    if(points.length<2){
      svg.setAttribute('width',_expanded?'220':'90');
      svg.setAttribute('viewBox','0 0 ' + (_expanded?'220':'90') + ' 44');
      svg.innerHTML='<polyline fill="none" stroke="var(--muted)" stroke-width="1.5" points="0,22 ' + (_expanded?'220':'90') + ',22"/>';
      this._lastPathD=null;this._pulsePathLen=0;this._cachedSegCount=0;this._segColorPairs=[];
      return;
    }
    var n=points.length;
    var w=_expanded?220:90;var h=44;
    var padX=5,l=padX,r=w-padX,plotW=r-l,plotH=h-10;
    // A13: shared Y scale from the FULL canonical window, never the mini subset.
    var minW=Number.isFinite(series.scaleMin)?series.scaleMin:Math.min.apply(null,points.map(function(p){return p.work;}));
    var maxW=Number.isFinite(series.scaleMax)?series.scaleMax:Math.max.apply(null,points.map(function(p){return p.work;}));
    var span=Math.max(0.001,maxW-minW);
    function xFn(i){return l+(n===1?plotW/2:i/(n-1))*plotW;}
    function yFn(v){return 5+(1-(v-minW)/span)*plotH;}

    var t=activeTheme();
    function nodeColor(p){return powSemanticColor(p.phase,t);}

    var segColors=[];
    for(var i=0;i<n-1;i++){
      segColors.push({id:'seg-grad-'+i,from:nodeColor(points[i]),to:nodeColor(points[i+1])});
    }

    var segments='';
    var defs='';
    for(var i=0;i<n-1;i++){
      var x1=xFn(i),y1=yFn(points[i].work),x2=xFn(i+1),y2=yFn(points[i+1].work);
      var sc=segColors[i];
      defs+='<linearGradient id="'+sc.id+'" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="'+sc.from+'" stop-opacity="0.92"/><stop offset="100%" stop-color="'+sc.to+'" stop-opacity="0.92"/></linearGradient>';
      segments+='<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="url(#'+sc.id+')" stroke-width="2.4" stroke-linecap="round"/>';
    }

    var nodes='';
    for(var i=0;i<n;i++){
      var xx=xFn(i),yy=yFn(points[i].work);
      var fill=nodeColor(points[i]);
      var r2=(points[i].phase==='mismatch'||points[i].phase==='mismatch-conflict')?4:2.8;
      var stroke2=points[i].phase==='mismatch-conflict'?' stroke="'+t.conflict+'" stroke-width="1.5"':'';
      nodes+='<circle cx="'+xx+'" cy="'+yy+'" r="'+r2+'" fill="'+fill+'" opacity=".95"'+stroke2+'/>';
    }

    var pathD='M' + xFn(0) + ',' + yFn(points[0].work);
    for(var i=1;i<n;i++){pathD+=' L'+xFn(i)+','+yFn(points[i].work);}

    svg.setAttribute('width',String(w));
    svg.setAttribute('viewBox','0 0 '+w+' '+h);
    svg.innerHTML='<defs>'+defs+'</defs>' + segments + nodes + '<path id="wave-path" d="'+pathD+'" fill="none" stroke="transparent" stroke-width="4"/>';
    this._lastPathD=pathD;
    this._cachedSegCount=n;
    this._segColorPairs=[];
    for(var si=0;si<segColors.length;si++){
      this._segColorPairs.push({from:segColors[si].from,to:segColors[si].to});
    }
    this._pulsePathLen=this._getPulsePathLen(svg);
    // Precompute cumulative per-segment path lengths for accurate pulse->segment mapping.
    var pathEl2=svg.querySelector('#wave-path');
    this._segCumulativeLen=[];
    if(pathEl2&&n>=2){
      var totalLen=this._pulsePathLen||pathEl2.getTotalLength();
      var cumSum=0;
      for(var sj=0;sj<n-1;sj++){
        var sx1=xFn(sj),sy1=yFn(points[sj].work),sx2=xFn(sj+1),sy2=yFn(points[sj+1].work);
        var dx=sx2-sx1,dy=sy2-sy1;
        cumSum+=Math.sqrt(dx*dx+dy*dy);
        this._segCumulativeLen.push(cumSum/totalLen);
      }
    }
    this._renderPulseOnly();
  },

  _getPulsePathLen(svg){
    try{
      var pathEl=svg.querySelector('#wave-path');
      if(pathEl)return pathEl.getTotalLength();
    }catch(e){}
    return 300;
  },

  _renderPulseOnly(){
    var root=this.root;if(!root)return;
    var svg=root.querySelector('.wave-svg');if(!svg)return;
    // A2: pulse overlays share the EXACT path geometry of #wave-path via
    // stroke-dasharray / stroke-dashoffset. Never a two-point straight chord.
    var ids=['pulse-main','pulse-trail-1','pulse-trail-2'];
    if(!this._animActive){
      for(var ri=0;ri<ids.length;ri++){var re=svg.querySelector('#'+ids[ri]);if(re&&re.parentNode)re.parentNode.removeChild(re);}
      return;
    }
    for(var pi=0;pi<ids.length;pi++){
      if(!svg.querySelector('#'+ids[pi])){
        var pe=document.createElementNS('http://www.w3.org/2000/svg','path');
        pe.setAttribute('id',ids[pi]);
        pe.setAttribute('fill','none');
        pe.setAttribute('stroke-linecap','round');
        pe.style.pointerEvents='none';
        svg.appendChild(pe);
      }
    }
    var pathEl=svg.querySelector('#wave-path');
    if(!pathEl||!this._lastPathD)return;
    try{
      if(!this._pulsePathLen||this._pulsePathLen<=1)this._pulsePathLen=pathEl.getTotalLength();
    }catch(e){return;}
    var pathLen=this._pulsePathLen;
    if(pathLen<1)return;
    if(!this._pulseProgress)this._pulseProgress=0;
    var prog=this._pulseProgress%pathLen;
    if(prog<0)prog+=pathLen;

    // Exact segment index + local fraction for continuous color interpolation (A16).
    var n=this._cachedSegCount||0;
    var segIndex=0;
    var localFrac=0;
    if(n>=2){
      var frac=prog/pathLen;
      var cumLen=this._segCumulativeLen;
      if(cumLen&&cumLen.length>0){
        for(var i=0;i<cumLen.length;i++){
          if(frac<=cumLen[i]){
            segIndex=i;
            var prev=i>0?cumLen[i-1]:0;
            var segSpan=cumLen[i]-prev;
            localFrac=segSpan>0?(frac-prev)/segSpan:0;
            break;
          }
          segIndex=i+1;
        }
        if(segIndex>=cumLen.length)segIndex=cumLen.length-1;
      } else {
        segIndex=Math.min(Math.floor(frac*(n-1)),n-2);
        localFrac=(frac*(n-1))-segIndex;
      }
    }
    var segPairs=this._segColorPairs;
    var fromClr=segPairs&&segPairs[segIndex]?segPairs[segIndex].from:'var(--accent)';
    var toClr=segPairs&&segPairs[segIndex]?segPairs[segIndex].to:fromClr;
    var clr=segPairs&&segPairs[segIndex]?mixCssColor(fromClr,toClr,localFrac):fromClr;

    // A4: gentle fade at both cycle ends; the base waveform is never affected.
    var env=this._pulseEnvelope(prog,pathLen);
    var mainLen=pathLen*0.10;
    var mainFrom=Math.max(0,prog-mainLen);
    this._setDashSegment('#pulse-main',mainFrom,prog,pathLen,clr,2.4,0.62*env);
    this._setDashSegment('#pulse-trail-1',Math.max(0,mainFrom-pathLen*0.05),mainFrom,pathLen,clr,1.7,0.24*env);
    this._setDashSegment('#pulse-trail-2',Math.max(0,mainFrom-pathLen*0.10),Math.max(0,mainFrom-pathLen*0.05),pathLen,clr,1.1,0.10*env);
  },

  _pulseEnvelope(prog,pathLen){
    if(!(pathLen>0))return 1;
    var fadeZone=pathLen*0.06;
    var env=Math.min(1,Math.max(0,prog)/fadeZone,Math.max(0,pathLen-prog)/fadeZone);
    return Number.isFinite(env)?Math.max(0,Math.min(1,env)):1;
  },

  _setDashSegment(sel,from,to,pathLen,color,width,opacity){
    var root=this.root;if(!root)return;
    var svg=root.querySelector('.wave-svg');if(!svg)return;
    var el=svg.querySelector(sel);if(!el)return;
    var d=this._lastPathD;
    var len=to-from;
    if(!d||!(len>0.0001)){el.removeAttribute('d');el.setAttribute('opacity','0');return;}
    el.setAttribute('d',d);
    el.setAttribute('stroke-dasharray',len+' '+(pathLen+2));
    el.setAttribute('stroke-dashoffset',String(-from));
    el.setAttribute('stroke',color);
    el.setAttribute('stroke-width',String(width));
    el.setAttribute('opacity',String(Math.max(0,Math.min(1,opacity))));
  },

  maybeStartAnim(){
    var self=this;
    var st=loadSettings();
    if(!st.floatingAnimEnabled){this.stopAnim();return;}
    if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches){this.stopAnim();return;}
    this.startAnim();
  },

  restorePosition(){
    if(!this.host)return;
    var st=loadSettings(),p=st.badgePosition;
    if(p&&Number.isFinite(p.left)&&Number.isFinite(p.top)){
      this.host.style.left=Math.max(4,Math.min(p.left,window.innerWidth-300))+'px';
      this.host.style.top=Math.max(4,Math.min(p.top,window.innerHeight-70))+'px';this.host.style.right='auto';
    }else{this.host.style.left='auto';this.host.style.right='16px';this.host.style.top='12px';}
  },

  resetPosition(){
    var st=loadSettings();st.badgePosition=null;saveSettings(st);this.restorePosition();
    this.updateDisplay();
  },

  savePosition(){
    if(!this.host)return;
    var r=this.host.getBoundingClientRect(),st=loadSettings();
    st.badgePosition={left:Math.round(r.left),top:Math.round(r.top)};saveSettings(st);
  },

  installDrag(target){
    var self=this;
    target.addEventListener('pointerdown',function(e){
      if(e.button!==0)return;
      var r=self.host.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;
      var moved=false;
      function mv(ev){
        var dx=ev.clientX-sx,dy=ev.clientY-sy;
        if(!moved&&Math.hypot(dx,dy)<4)return;moved=true;
        var ml=Math.max(4,window.innerWidth-r.width-4),mt=Math.max(4,window.innerHeight-r.height-4);
        self.host.style.right='auto';
        self.host.style.left=Math.max(4,Math.min(r.left+dx,ml))+'px';
        self.host.style.top=Math.max(4,Math.min(r.top+dy,mt))+'px';
      }
      function up(ev){
        window.removeEventListener('pointermove',mv);
        window.removeEventListener('pointerup',up);
        window.removeEventListener('pointercancel',up);
        if(moved){self._dragged=true;self.savePosition();setTimeout(function(){self._dragged=false},150);try{ev.preventDefault()}catch{}}
      }
      window.addEventListener('pointermove',mv);
      window.addEventListener('pointerup',up);
      window.addEventListener('pointercancel',up);
    });
  }
};

// Alias for backward compatibility
const Badge = FloatingMonitor;

const Dashboard = {
  host:null,root:null,open:false,resizeObserver:null,activeTab:"current",powExpanded:false,openPins:new Map(),
  ensure(){
    if(this.host&&this.host.isConnected){this.applyTheme();return this.root}
    this.host=document.createElement('div');this.host.id='chatgpt-model-downgrade-monitor-panel';this.host.style.cssText='all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';this.root=this.host.attachShadow({mode:'open'});
    this.root.innerHTML=`<style>
      :host{all:initial}.overlay{position:fixed;inset:0;display:none;pointer-events:none;font-family:ui-rounded,"SF Pro Rounded","Segoe UI","Microsoft YaHei",sans-serif;color:var(--text)}.panel{position:fixed;left:0;top:0;width:680px;height:min(790px,calc(100vh - 48px));min-width:450px;min-height:350px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;resize:both;pointer-events:auto;box-sizing:border-box;background:var(--panel);border:1px solid var(--border);border-radius:22px;box-shadow:0 26px 75px var(--shadow);backdrop-filter:blur(18px) saturate(120%)}
      .head{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px 16px;background:color-mix(in srgb,var(--panel) 94%,transparent);border-bottom:1px solid var(--border);cursor:move;user-select:none}.brand{display:flex;gap:10px;align-items:center}.brand-seal{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 18%,var(--surface));color:var(--accent);font-weight:900}.brand b{display:block;font-size:15px}.brand small{display:block;color:var(--muted);font-size:10px;margin-top:2px}.head-actions{display:flex;gap:6px;cursor:default}.head-actions a{display:inline-flex;align-items:center;text-decoration:none}
      button,select,input{font:inherit}.iconbtn,.tab,.btn{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:10px;padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer}.iconbtn:hover,.tab:hover,.btn:hover{filter:brightness(1.05)}.tabs{position:sticky;top:59px;z-index:4;display:flex;gap:8px;padding:10px 15px;background:color-mix(in srgb,var(--panel) 95%,transparent);border-bottom:1px solid var(--border)}.tab.active{background:color-mix(in srgb,var(--accent) 18%,var(--surface));border-color:color-mix(in srgb,var(--accent) 45%,var(--border));color:var(--accent)}
      .content{padding:16px 17px 20px}.pane{display:none}.pane.active{display:block}.section-title{font-size:15px;font-weight:700;letter-spacing:.01em;margin:16px 2px 9px}.kicker{font-size:13px;color:var(--muted);margin-bottom:8px}.card{border:1px solid var(--border);background:var(--surface);border-radius:17px;padding:14px;margin-bottom:11px;box-shadow:0 7px 22px color-mix(in srgb,var(--shadow) 28%,transparent)}.hero{padding:15px 16px}.card.status-normal{border-left:4px solid var(--normal)}.card.status-danger{border-left:4px solid var(--danger)}.card.status-conflict{border-left:4px solid var(--conflict)}.card.status-warn{border-left:4px solid var(--warn)}.card.status-unknown{border-left:4px solid var(--muted)}
      .verdictline{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}.verdictwrap{display:flex;align-items:center;gap:6px;min-width:0}.verdict{font-size:14px;font-weight:700;padding:4px 10px;border-radius:999px;background:var(--surface2)}.tone-normal{color:var(--normal)}.tone-danger{color:var(--danger)}.tone-conflict{color:var(--conflict)}.tone-warn{color:var(--warn)}.tone-unknown{color:var(--muted)}.time{color:var(--muted);font-size:12px}.basis{font-size:13px;line-height:1.55;color:var(--muted);padding:9px 11px;border-radius:11px;background:var(--surface2);margin-bottom:10px}.metrics{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.metric{font-size:12px;padding:4px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent) 9%,var(--surface2));color:var(--muted);border:1px solid var(--border)}
      .dialogue{display:grid;gap:9px}.chatrow{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;align-items:start}.chatrow.assistant{grid-template-columns:minmax(0,1fr) 28px}.chatrow.assistant .bubble{text-align:left}.avatar{width:28px;height:28px;border-radius:10px;display:grid;place-items:center;font-size:12px;font-weight:800;border:1px solid var(--border);background:var(--surface2)}.bubble{padding:11px 13px;border-radius:14px;line-height:1.55;font-size:14px;border:1px solid color-mix(in srgb,var(--border) 75%,transparent)}.bubble.user{background:color-mix(in srgb,var(--user) 26%,var(--surface));border-color:color-mix(in srgb,var(--user) 22%,var(--border))}.bubble.assistant{background:color-mix(in srgb,var(--assistant) 24%,var(--surface));border-color:color-mix(in srgb,var(--assistant) 20%,var(--border))}.who{font-size:11px;color:var(--muted);margin-bottom:4px}.topic{font-weight:780;margin-bottom:3px}.preview{word-break:break-word}
      .models{--flow-accent:var(--accent);--flow-bg:color-mix(in srgb,var(--accent) 7%,var(--surface2));--flow-border:color-mix(in srgb,var(--accent) 22%,var(--border));--flow-title:var(--text);--flow-text:var(--text);--flow-label:color-mix(in srgb,var(--text) 82%,var(--flow-accent));--flow-muted:color-mix(in srgb,var(--text) 64%,var(--flow-accent));--flow-center:color-mix(in srgb,var(--flow-accent) 72%,var(--text));display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:stretch;margin:12px 0;padding:14px 12px;border-radius:15px;background:var(--flow-bg);border:1px solid var(--flow-border);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 4px 14px color-mix(in srgb,var(--flow-accent) 12%,transparent)}.models.is-normal{--flow-accent:var(--normal);--flow-bg:linear-gradient(135deg,color-mix(in srgb,var(--normal) 18%,transparent),color-mix(in srgb,var(--normal) 11%,transparent));--flow-border:color-mix(in srgb,var(--normal) 46%,transparent)}.models.is-mismatch{--flow-accent:var(--danger);--flow-bg:linear-gradient(135deg,color-mix(in srgb,var(--danger) 18%,transparent),color-mix(in srgb,var(--danger) 11%,transparent));--flow-border:color-mix(in srgb,var(--danger) 48%,transparent)}.models.is-conflict{--flow-accent:var(--conflict);--flow-bg:linear-gradient(135deg,color-mix(in srgb,var(--conflict) 20%,transparent),color-mix(in srgb,var(--conflict) 12%,transparent));--flow-border:color-mix(in srgb,var(--conflict) 50%,transparent)}.models.is-incomplete{--flow-accent:var(--warn);--flow-bg:linear-gradient(135deg,color-mix(in srgb,var(--warn) 20%,transparent),color-mix(in srgb,var(--warn) 12%,transparent));--flow-border:color-mix(in srgb,var(--warn) 50%,transparent)}.models.is-unknown{--flow-accent:var(--muted);--flow-bg:var(--surface2);--flow-border:var(--border)}.modelbox{min-width:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}.modellabel{display:flex;align-items:center;justify-content:center;gap:4px;color:var(--muted);font-size:13px;font-weight:600}.modelbox b{display:block;margin-top:5px;font-size:18px;font-weight:700;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.modelbox code{display:block;color:var(--muted);font-size:12px;margin-top:3px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.flow-mid{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-width:64px}.arrow{text-align:center;color:var(--accent);font-size:24px;font-weight:800;line-height:1;filter:drop-shadow(0 0 7px color-mix(in srgb,var(--accent) 35%,transparent))}.arrow.tone-normal{color:var(--normal)}.arrow.tone-danger{color:var(--danger)}.arrow.tone-conflict{color:var(--conflict)}.arrow.tone-warn{color:var(--warn)}.resultcheck{font-size:14px;font-weight:800;text-align:center;line-height:1.25;max-width:96px;color:var(--muted)}.resultcheck.tone-normal{color:var(--normal)}.resultcheck.tone-danger{color:var(--danger)}.resultcheck.tone-conflict{color:var(--conflict)}.resultcheck.tone-warn{color:var(--warn)}.models .modelbox{background:color-mix(in srgb,var(--flow-accent) 8%,transparent);border:1px solid color-mix(in srgb,var(--flow-accent) 18%,transparent);border-radius:12px;padding:10px 8px}.models .modellabel{color:var(--flow-label)}.models .modelbox b{color:var(--flow-text)}.models .modelbox code{color:var(--flow-muted)}.models .info{color:var(--flow-center)}.models .arrow{color:var(--flow-center);filter:drop-shadow(0 0 7px color-mix(in srgb,var(--flow-accent) 40%,transparent))}.models .resultcheck{color:var(--flow-center)}
      .info{appearance:none;border:0;background:transparent;color:var(--accent);padding:0 2px;cursor:pointer;font-size:12px;font-weight:900;text-decoration:none}.info:hover{transform:scale(1.12)}.network-chip{display:inline-flex;padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--accent2) 12%,var(--surface2));color:var(--accent2);font-size:12px;border:1px solid color-mix(in srgb,var(--accent2) 24%,transparent)}
      details{margin-top:10px;border-top:1px solid var(--border);padding-top:8px}summary{cursor:pointer;color:var(--accent);font-size:13px}.tech{font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);white-space:pre-wrap;word-break:break-all;margin-top:7px}.empty{color:var(--muted);font-size:13px;padding:16px 3px}.muted{color:var(--muted);font-size:13px;line-height:1.55}
      .statgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.stat{padding:16px 10px;border-radius:13px;background:var(--surface2);text-align:center;border:1px solid var(--border);display:flex;flex-direction:column;justify-content:center;gap:4px}.stat b{display:block;font-size:24px;font-weight:700;line-height:1.1}.stat small{color:var(--muted);font-size:13px;font-weight:500}.barrow{margin:10px 0}.barhead{display:flex;justify-content:space-between;font-size:13px}.bar{height:7px;background:var(--surface2);border-radius:999px;overflow:hidden;margin-top:4px}.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent2),var(--accent));border-radius:999px}.splitgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.minirow{font-size:13px;color:var(--muted);line-height:1.55}.minirow b{color:var(--text)}
      .field{display:grid;gap:5px;margin:10px 0}.field label{font-size:13px;color:var(--muted)}.field input[type=text],.field select,.select{border:1px solid var(--border);background:var(--surface2);color:var(--text);border-radius:10px;padding:9px 10px;outline:none;font-size:14px}.setting-group{border:1px solid var(--border);background:var(--surface);border-radius:16px;padding:13px;margin-bottom:11px}.setting-group>h3{font-size:15px;font-weight:700;margin:0 0 8px}.toggle{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--border);font-size:14px}.toggle:last-child{border-bottom:0}.subsetting{margin:5px 0 4px 17px;padding-left:10px;border-left:2px solid color-mix(in srgb,var(--accent) 35%,transparent)}.soundrow{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.range{width:100%;accent-color:var(--accent)}.theme-swatches{display:flex;gap:4px;margin-top:5px}.swatch{width:16px;height:8px;border-radius:999px;border:1px solid var(--border)}
      .pow-wrap{overflow-x:auto;padding-bottom:6px}.pow-svg{display:block;min-height:270px}.pow-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:8px 0}.pow-stat{padding:14px 10px;border-radius:11px;background:var(--surface2);text-align:center;border:1px solid var(--border);display:flex;flex-direction:column;justify-content:center;gap:5px}.pow-stat b{display:block;font-size:24px;font-weight:700;line-height:1.15}.pow-stat small{font-size:14px;font-weight:500;color:var(--muted)}
      .pin-window{position:fixed;width:min(390px,calc(100vw - 28px));max-height:min(560px,calc(100vh - 28px));overflow:auto;pointer-events:auto;background:var(--panel);color:var(--text);border:1px solid color-mix(in srgb,var(--accent) 38%,var(--border));border-radius:17px;box-shadow:0 20px 60px var(--shadow);z-index:20}.pin-head{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 11px;background:color-mix(in srgb,var(--panel) 96%,transparent);border-bottom:1px solid var(--border);cursor:move;user-select:none}.pin-head b{font-size:13px}.pin-actions{display:flex;gap:5px}.pin-actions button{padding:3px 7px}.pin-body{padding:12px}.pin-lead{font-size:13px;font-weight:750;line-height:1.6;padding:9px 10px;border-radius:11px;background:color-mix(in srgb,var(--accent) 10%,var(--surface));margin-bottom:11px}.pin-section{margin:10px 0}.pin-section b{display:block;font-size:13px;color:var(--accent);margin-bottom:3px}.pin-section p{margin:0;font-size:13px;line-height:1.65;color:var(--muted)}
      .danger-text{color:var(--danger)!important}.ledger-item{border:1px solid var(--border);border-radius:11px;padding:9px 10px;margin:8px 0;background:var(--surface2)}.ledger-item.ledger-captured{border-left:3px solid var(--border)}.ledger-item.ledger-missing{border-left:3px solid var(--warn)}.ledger-item.cat-core{border-left-color:var(--accent2)}.ledger-item.cat-server{border-left-color:var(--accent)}.ledger-cat{display:inline-block;font-size:11px;font-weight:800;padding:1px 6px;border-radius:999px;margin-right:6px;border:1px solid transparent;vertical-align:middle}.ledger-cat.cat-core{background:color-mix(in srgb,var(--accent2) 16%,transparent);color:var(--accent2);border-color:color-mix(in srgb,var(--accent2) 40%,transparent)}.ledger-cat.cat-server{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)}.ledger-row{display:flex;gap:8px;align-items:flex-start}.ledger-icon{font-weight:900;line-height:1.3}.ledger-main b{font-size:14px}.ledger-value{font-size:13px;font-weight:600;margin-top:2px}.ledger-source{font-size:12px;color:var(--muted)}.ledger-explain{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.5}.ledger-missing-list{font-size:13px;color:var(--warn);margin-top:8px;font-weight:600}.ledger-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}.ledger-status{font-size:13px;font-weight:700;color:var(--accent)}.ledger-why{border-top:1px solid var(--border);margin-top:10px;padding-top:8px;font-size:13px;line-height:1.55}.ledger-why b{font-size:14px}@media(max-width:720px){.panel{width:calc(100vw - 16px)!important;left:8px!important;resize:none}.statgrid,.splitgrid{grid-template-columns:1fr 1fr}.models{grid-template-columns:1fr auto 1fr}.content{padding:12px}}
    </style><div class="overlay"><div class="panel"><div class="head" data-role="drag-handle"><div class="brand"><div class="brand-seal">鉴</div><div><b>模型鉴定姬</b><small>ChatGPT Model Downgrade Monitor</small></div></div><div class="head-actions"><a class="iconbtn" href="https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor" target="_blank" rel="noopener noreferrer" title="打开 GitHub 项目主页">GitHub ↗</a><button class="iconbtn" data-act="copy">复制诊断</button><button class="iconbtn" data-act="close">关闭</button></div></div><div class="tabs"><button class="tab" data-tab="current">当前</button><button class="tab" data-tab="archive">档案</button><button class="tab" data-tab="network">网络</button><button class="tab" data-tab="settings">设置</button></div><div class="content"><section class="pane" data-pane="current"></section><section class="pane" data-pane="archive"></section><section class="pane" data-pane="network"></section><section class="pane" data-pane="settings"></section></div></div></div>`;
    try{document.documentElement.appendChild(this.host)}catch{return this.root}this.applyTheme();this.bindShell();this.restoreGeometry();return this.root;
  },
  applyTheme(){const root=this.root;if(!root)return;const overlay=root.querySelector('.overlay');if(overlay)applyThemeVars(overlay);for(const pin of root.querySelectorAll('.pin-window'))applyThemeVars(pin);Badge.applyTheme()},
  bindShell(){const r=this.root;if(!r)return;const overlay=r.querySelector('.overlay'),panel=r.querySelector('.panel'),handle=r.querySelector('[data-role="drag-handle"]');r.querySelector('[data-act="close"]').addEventListener('click',()=>this.hide());r.querySelector('[data-act="copy"]').addEventListener('click',()=>this.copyDiagnostics());r.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{this.activeTab=b.dataset.tab;this.render()}));this.installPanelDrag(handle,panel);if(typeof ResizeObserver==='function'){this.resizeObserver=new ResizeObserver(()=>this.saveGeometry());this.resizeObserver.observe(panel)}overlay.addEventListener('click',e=>{const btn=e.target.closest&&e.target.closest('[data-concept]');if(btn){e.preventDefault();e.stopPropagation();this.openConcept(btn.dataset.concept,btn)}})},
  installPanelDrag(handle,panel){handle.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button,a'))return;const r=panel.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;try{handle.setPointerCapture(e.pointerId)}catch{}const mv=ev=>{const maxL=Math.max(8,window.innerWidth-r.width-8),maxT=Math.max(8,window.innerHeight-60);panel.style.left=`${Math.max(8,Math.min(r.left+ev.clientX-sx,maxL))}px`;panel.style.top=`${Math.max(8,Math.min(r.top+ev.clientY-sy,maxT))}px`};const up=ev=>{handle.removeEventListener('pointermove',mv);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);try{handle.releasePointerCapture(ev.pointerId)}catch{}this.saveGeometry()};handle.addEventListener('pointermove',mv);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up)})},
  panel(){return this.root&&this.root.querySelector('.panel')},
  restoreGeometry(force=false){const p=this.panel();if(!p)return;const st=loadSettings(),size=!force&&st.dashboardSize,pos=!force&&st.dashboardPosition,dw=Math.min(680,Math.max(470,window.innerWidth-48)),dh=Math.min(790,Math.max(430,window.innerHeight-72)),w=size&&Number.isFinite(size.width)?Math.min(Math.max(size.width,450),window.innerWidth-16):dw,h=size&&Number.isFinite(size.height)?Math.min(Math.max(size.height,350),window.innerHeight-16):dh;p.style.width=`${w}px`;p.style.height=`${h}px`;let l=pos&&Number.isFinite(pos.left)?pos.left:Math.max(16,window.innerWidth-w-24),t=pos&&Number.isFinite(pos.top)?pos.top:56;l=Math.max(8,Math.min(l,window.innerWidth-w-8));t=Math.max(8,Math.min(t,window.innerHeight-Math.min(h,80)-8));p.style.left=`${l}px`;p.style.top=`${t}px`},
  saveGeometry(){const p=this.panel();if(!p||window.innerWidth<=700)return;const r=p.getBoundingClientRect(),st=loadSettings();st.dashboardPosition={left:Math.round(r.left),top:Math.round(r.top)};st.dashboardSize={width:Math.round(r.width),height:Math.round(r.height)};saveSettings(st)},
  show(){const r=this.ensure();this.open=true;const o=r.querySelector('.overlay');if(o)o.style.display='block';this.applyTheme();this.render()},hide(){if(!this.root)return;this.open=false;const o=this.root.querySelector('.overlay');if(o)o.style.display='none'},toggle(){this.open?this.hide():this.show()},
  openConcept(key,anchor){if(key==='completeness'){this.openEvidenceLedger(anchor);return}const data=CONCEPTS[key];if(!data||!this.root)return;const existing=this.openPins.get(key);if(existing&&existing.isConnected){existing.style.display='block';existing.focus();return}const win=document.createElement('div');win.className='pin-window';win.dataset.conceptKey=key;win.tabIndex=-1;applyThemeVars(win);const sections=data.sections.map(([h,t])=>`<div class="pin-section"><b>${escapeHtml(h)}</b><p>${escapeHtml(t)}</p></div>`).join('');win.innerHTML=`<div class="pin-head"><b>📌 ${escapeHtml(data.title)}</b><div class="pin-actions"><button class="iconbtn" data-pin-act="keep" title="固定这张解释卡">固定</button><button class="iconbtn" data-pin-act="close">×</button></div></div><div class="pin-body"><div class="pin-lead">${escapeHtml(data.lead)}</div>${sections}</div>`;this.root.querySelector('.overlay').appendChild(win);const st=loadSettings(),saved=st.conceptPinPositions&&st.conceptPinPositions[key];let left=saved&&Number.isFinite(saved.left)?saved.left:Math.min(window.innerWidth-410,Math.max(18,(anchor&&anchor.getBoundingClientRect().right+12)||80));let top=saved&&Number.isFinite(saved.top)?saved.top:Math.min(window.innerHeight-300,Math.max(18,(anchor&&anchor.getBoundingClientRect().top-20)||100));win.style.left=`${Math.max(8,left)}px`;win.style.top=`${Math.max(8,top)}px`;win.dataset.pinned=saved?'1':'0';this.openPins.set(key,win);this.installPinDrag(win,key);win.querySelector('[data-pin-act="close"]').addEventListener('click',()=>{this.openPins.delete(key);win.remove()});win.querySelector('[data-pin-act="keep"]').addEventListener('click',e=>{win.dataset.pinned='1';e.currentTarget.textContent='已固定';this.savePinPosition(win,key)});
    // Only one unpinned explainer at a time; fixed cards can remain together.
    for(const [k,w] of this.openPins){if(k!==key&&w.dataset.pinned!=="1"){this.openPins.delete(k);w.remove()}}
  },
  installPinDrag(win,key){const head=win.querySelector('.pin-head');head.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button'))return;const r=win.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;try{head.setPointerCapture(e.pointerId)}catch{}const mv=ev=>{const ml=Math.max(8,window.innerWidth-r.width-8),mt=Math.max(8,window.innerHeight-50);win.style.left=`${Math.max(8,Math.min(r.left+ev.clientX-sx,ml))}px`;win.style.top=`${Math.max(8,Math.min(r.top+ev.clientY-sy,mt))}px`};const up=ev=>{head.removeEventListener('pointermove',mv);head.removeEventListener('pointerup',up);head.removeEventListener('pointercancel',up);try{head.releasePointerCapture(ev.pointerId)}catch{}this.savePinPosition(win,key)};head.addEventListener('pointermove',mv);head.addEventListener('pointerup',up);head.addEventListener('pointercancel',up)})},
  savePinPosition(win,key){const r=win.getBoundingClientRect(),st=loadSettings();st.conceptPinPositions={...(st.conceptPinPositions||{}),[key]:{left:Math.round(r.left),top:Math.round(r.top)}};saveSettings(st)},
  evidenceLedgerHTML(turn){
    if(!turn)return '<div class="muted">还没有正在进行的这一轮。发送一条消息后，这里会实时显示证据采集状态。</div>';
    const isFinalized=turn.lifecycle===LIFECYCLE.FINALIZED;
    const isCollecting=!isFinalized;
    const items=[
      {key:"requested",cat:"core",label:"调用模型",value:turn.requestedModel,source:"conversation request",explain:"网页发送这条消息时，请求服务器使用的模型。"},
      {key:"assistant",cat:"core",label:"应答模型",value:turn.assistantModel,source:"assistant metadata",explain:"最终显示给你的这条 ChatGPT 回答自己携带的模型标记。"},
      {key:"resolved",cat:"server",label:"服务器确认模型",value:turn.resolvedModel,source:"resolved_model_slug",explain:"服务器返回的数据里用于记录本次请求最终解析到哪个模型的字段。"},
      {key:"server",cat:"server",label:"服务器路由",value:turn.serverModel,source:"server_ste_metadata",explain:"服务器响应中可能出现的额外路由模型信息。"}
    ];
    const allCaptured=items.filter(x=>x.value).length;
    const coreCaptured=(turn.requestedModel?1:0)+(turn.assistantModel?1:0);
    const statusText=isCollecting?`采集中 · 核心对比 ${coreCaptured}/2 · 总证据 ${allCaptured}/4`:`核心对比 ${coreCaptured}/2 · 总证据 ${allCaptured}/4`;
    const rows=items.map(function(it){
      var icon=it.value?'✓':'…';
      var cls=it.value?'ledger-captured':'ledger-missing';
      var catLabel=it.cat==='core'?'核心':'服务器';
      var valText=it.value?friendlyModelName(it.value):(isCollecting?'正在等待响应证据':'未捕获');
      return '<div class="ledger-item '+cls+' cat-'+it.cat+'"><div class="ledger-row"><span class="ledger-icon">'+icon+'</span><div class="ledger-main"><b><span class="ledger-cat cat-'+it.cat+'">'+catLabel+'</span>'+escapeHtml(it.label)+'</b><div class="ledger-value">'+escapeHtml(valText)+'</div><div class="ledger-source">'+escapeHtml(it.source)+'</div></div></div><div class="ledger-explain">'+escapeHtml(it.explain)+'</div></div>';
    }).join('');
    var missing='';
    if(isFinalized){
      var miss=items.filter(x=>!x.value).map(x=>x.label);
      if(miss.length)missing='<div class="ledger-missing-list">未捕获：'+escapeHtml(miss.join('、'))+'</div>';
    }
    var why='';
    if(isFinalized){
      why='<div class="ledger-why"><b>为什么出现这个结论？</b>';
      if(turn.requestedModel&&turn.assistantModel){
        why+='<div>调用模型：'+escapeHtml(friendlyModelName(turn.requestedModel))+'</div><div>应答模型：'+escapeHtml(friendlyModelName(turn.assistantModel))+'</div>';
        if(turn.requestedModel!==turn.assistantModel){
          why+='<div class="tone-danger">→ 两者不同，因此标记：请求与应答模型不一致</div>';
        }else{
          why+='<div class="tone-normal">→ 两者一致，核心对比匹配</div>';
        }
      }
      if(turn.resolvedModel||turn.serverModel){
        why+='<div style="margin-top:4px">服务器确认：'+escapeHtml(turn.resolvedModel?friendlyModelName(turn.resolvedModel):'未捕获')+'</div><div>服务器路由：'+escapeHtml(turn.serverModel?friendlyModelName(turn.serverModel):'未捕获')+'</div>';
        var rf=[turn.resolvedModel,turn.serverModel].filter(Boolean);
        if(rf.length>=1&&turn.assistantModel&&rf.some(function(x){return x!==turn.assistantModel;}))why+='<div class="tone-conflict">→ 服务器侧证据与应答不一致，附加：路由证据冲突</div>';
      }
      why+='</div>';
    }
    return '<div class="ledger-head"><b>📌 本轮模型证据</b><span class="ledger-status">'+escapeHtml(statusText)+'</span></div><div class="ledger-items">'+rows+'</div>'+missing+why+'<div class="muted" style="margin-top:8px"><div>核心对比：调用模型 ↔ 应答模型</div><div>服务器辅助证据：确认模型 ＋ 路由模型</div></div>';
  },
  openEvidenceLedger(anchor){
    if(!this.root)return;
    var key='__live_ledger';
    var existing=this.openPins.get(key);
    if(existing&&existing.isConnected){existing.style.display='block';this.refreshEvidenceLedger(existing);existing.focus();return;}
    var win=document.createElement('div');win.className='pin-window evidence-ledger';win.dataset.conceptKey=key;win.tabIndex=-1;applyThemeVars(win);
    win.innerHTML='<div class="pin-head"><b>📌 本轮模型证据</b><div class="pin-actions"><button class="iconbtn" data-pin-act="close">×</button></div></div><div class="pin-body" data-role="ledger-body"></div>';
    this.root.querySelector('.overlay').appendChild(win);
    var left=Math.min(window.innerWidth-410,Math.max(18,(anchor&&anchor.getBoundingClientRect().right+12)||80));
    var top=Math.min(window.innerHeight-300,Math.max(18,(anchor&&anchor.getBoundingClientRect().top-20)||100));
    win.style.left=Math.max(8,left)+'px';win.style.top=Math.max(8,top)+'px';
    this.openPins.set(key,win);
    this.installPinDrag(win,key);
    win.querySelector('[data-pin-act="close"]').addEventListener('click',function(){this.openPins.delete(key);win.remove();}.bind(this));
    this.refreshEvidenceLedger(win);
  },
  refreshEvidenceLedger(win){
    if(!win||!win.isConnected)return;
    var body=win.querySelector('[data-role="ledger-body"]');
    if(!body)return;
    var turn=TurnAggregator.getActiveTurn()||State._last;
    body.innerHTML=this.evidenceLedgerHTML(turn);
    // Live update while the panel is open
    var self=this;
    if(this._ledgerTimer)clearInterval(this._ledgerTimer);
    this._ledgerTimer=setInterval(function(){
      if(!win.isConnected){clearInterval(self._ledgerTimer);self._ledgerTimer=null;return;}
      var t2=TurnAggregator.getActiveTurn()||State._last;
      body.innerHTML=self.evidenceLedgerHTML(t2);
    },1200);
  },
  render(){try{const r=this.ensure();if(!r)return;this.applyTheme();r.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===this.activeTab));r.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active',p.dataset.pane===this.activeTab));this.renderCurrent(r.querySelector('[data-pane="current"]'));this.renderArchive(r.querySelector('[data-pane="archive"]'));this.renderNetwork(r.querySelector('[data-pane="network"]'));this.renderSettings(r.querySelector('[data-pane="settings"]'))}catch(e){try{console.warn('[Model Downgrade Monitor] render failed',e)}catch{}}},
  routeCard(entry,compact=false){
    if(!entry)return '<div class="empty">还没有捕获到模型应答。发送一条消息后，这里会出现“调用模型 → 应答模型”。</div>';
    const st=statusInfo(entry),call=entry.requestedModel,answer=entry.assistantModel||null,topic=entry.promptTopic||entry.replyTopic||'本轮对话',network=entry.networkLabel||'未命名网络';const prompt=entry.promptPreview||'（这条旧记录没有保存对话摘要）',reply=entry.replyPreview||'（尚未提取到回复摘要）';const tech=JSON.stringify({...entry,promptPreview:undefined,promptTopic:undefined,replyPreview:undefined,replyTopic:undefined},null,2);const resultMark=st.tone==='normal'?'✓':st.tone==='danger'?'≠':st.tone==='conflict'?'◇':st.tone==='warn'?'△':'?';const flow=st.tone==='normal'?{g:'✓',l:'模型一致',t:'normal',s:'is-normal'}:st.tone==='danger'?{g:'↛',l:'模型不一致',t:'danger',s:'is-mismatch'}:st.tone==='conflict'?{g:'⇄',l:'路由证据冲突',t:'conflict',s:'is-conflict'}:st.tone==='warn'?{g:'△',l:'模型字段变化',t:'warn',s:'is-incomplete'}:st.tone==='unknown'?{g:'…',l:'证据未完整',t:'warn',s:'is-incomplete'}:{g:'?',l:'状态未确定',t:'warn',s:'is-unknown'};const ambiguousSlug=Boolean(call&&answer&&call!==answer&&friendlyModelName(call)===friendlyModelName(answer));const slugFor=function(v){return ambiguousSlug?'<code>'+escapeHtml(v||'未捕获')+'</code>':'';};
    return `<div class="card ${compact?'archive-card':'hero'} status-${st.tone}"><div class="verdictline"><div class="verdictwrap"><span class="verdict tone-${st.tone}">${escapeHtml(resultMark+' '+st.title)}</span>${conceptButton(st.tone==='conflict'?'conflict':'status')}</div><span class="time">${escapeHtml(new Date(entry.timestamp).toLocaleTimeString())}</span></div><div class="basis">${escapeHtml(st.basis)}<div class="metrics">${st.metrics.map(x=>`<span class="metric">${escapeHtml(x)}</span>`).join('')}${conceptButton('completeness')}</div></div><div class="dialogue"><div class="chatrow user"><div class="avatar">你</div><div class="bubble user"><div class="who">你问 · ${escapeHtml(topic)}</div><div class="preview">${escapeHtml(prompt)}</div></div></div><div class="models ${flow.s}"><div class="modelbox"><div class="modellabel">调用模型 ${conceptButton('requested')}</div><b>${escapeHtml(friendlyModelName(call))}</b>${slugFor(call)}</div><div class="flow-mid"><div class="arrow tone-${flow.t}">${flow.g}</div><div class="resultcheck tone-${flow.t}">${escapeHtml(flow.l)}</div></div><div class="modelbox"><div class="modellabel">应答模型 ${conceptButton('assistant')}</div><b>${escapeHtml(friendlyModelName(answer))}</b>${slugFor(answer)}</div></div><div class="chatrow assistant"><div class="bubble assistant"><div class="who">ChatGPT 回答${entry.replyIsCode?' · 代码回答':''}</div><div class="preview">${escapeHtml(reply)}</div></div><div class="avatar">AI</div></div></div><div style="margin-top:10px"><span class="network-chip">${escapeHtml(network)}</span></div><details><summary>技术证据</summary><div class="minirow" style="margin-top:8px">服务器确认模型 ${conceptButton('resolved')}：<b>${escapeHtml(friendlyModelName(entry.resolvedModel))}</b> · ${escapeHtml(entry.resolvedSource||'未捕获')}</div><div class="minirow">服务器路由 ${conceptButton('server')}：<b>${escapeHtml(friendlyModelName(entry.serverModel))}</b> · ${escapeHtml(entry.serverSource||'未捕获')}</div><div class="tech">${escapeHtml(tech)}</div>${Array.isArray(entry.internalMessages)&&entry.internalMessages.length?`<div class="tech">内部 message (${entry.internalMessages.length}):\n${escapeHtml(JSON.stringify(entry.internalMessages,null,2))}</div>`:''}</details></div>`;
  },
  renderCurrent(el){if(!el)return;const h=State.hookHealth(),last=State.lastRouteResult();el.innerHTML=`<div class="kicker">${last?'本轮鉴定':'等待应答'} · 捕获器 ${zhHook(h.overall)}</div>${this.routeCard(last,false)}<div class="muted">主界面只保留“这轮对话 / 调用了什么 / 什么模型回答 / 是否一致 / 当前网络”。服务器字段与其他技术项放在“技术证据”里。</div>`},
  renderArchive(el){
    if(!el)return;const hist=State.historyForUi(),total=hist.length;const counts={normal:0,mismatch:0,conflict:0,notice:0,unknown:0};const models=new Map(),networks=new Map();for(const x of hist){if(x.verdict===VERDICT.NORMAL)counts.normal++;else if(x.verdict===VERDICT.EVIDENCE_CONFLICT)counts.conflict++;else if(x.verdict===VERDICT.MODEL_MISMATCH||x.verdict===VERDICT.DOWNGRADE_SUSPECTED)counts.mismatch++;else if(x.verdict===VERDICT.ROUTE_NOTICE)counts.notice++;else counts.unknown++;const m=x.assistantModel||'未知';models.set(m,(models.get(m)||0)+1);const n=x.networkLabel||'未命名网络',g=networks.get(n)||{n:0,bad:0};g.n++;if(x.verdict===VERDICT.MODEL_MISMATCH||x.verdict===VERDICT.DOWNGRADE_SUSPECTED||x.verdict===VERDICT.EVIDENCE_CONFLICT)g.bad++;networks.set(n,g)}
    const bars=[...models.entries()].sort((a,b)=>b[1]-a[1]).map(([m,n])=>`<div class="barrow"><div class="barhead"><span>${escapeHtml(friendlyModelName(m))}</span><span>${total?(n+' 次（'+(n/total*100).toFixed(1)+'%）'):(n+' 次 · —')}</span></div><div class="bar"><i style="width:${total?n/total*100:0}%"></i></div></div>`).join('');const netRows=[...networks.entries()].map(([n,g])=>`<div class="minirow"><b>${escapeHtml(n)}</b> · ${g.n} 次 · 模型不一致/冲突 ${g.bad} 次 · ${g.n?(g.bad/g.n*100).toFixed(1)+'%':'—'}</div>`).join('');
    el.innerHTML=`<div class="section-title">总览</div><div class="statgrid"><div class="stat"><b>${total}</b><small>记录</small></div><div class="stat"><b>${counts.normal}</b><small>模型一致</small></div><div class="stat"><b>${counts.mismatch}</b><small>请求≠应答</small></div><div class="stat"><b>${counts.conflict}</b><small>证据冲突</small></div></div><div class="splitgrid"><div class="card"><div class="section-title" style="margin-top:0">异常监测</div><div class="minirow">请求与应答不一致：<b>${counts.mismatch}</b></div><div class="minirow">路由证据冲突：<b>${counts.conflict}</b></div><div class="minirow">服务器字段变化：<b>${counts.notice}</b></div><div class="minirow">信息未完整：<b>${counts.unknown}</b></div></div><div class="card"><div class="section-title" style="margin-top:0">节点表现</div>${netRows||'<div class="empty">暂无数据</div>'}</div></div><div class="card"><div class="section-title" style="margin-top:0">模型使用比例</div>${bars||'<div class="empty">暂无数据</div>'}</div><div class="section-title">模型档案 · 一问一答一张卡</div>${hist.length?hist.map(x=>this.routeCard(x,true)).join(''):'<div class="empty">暂无档案。</div>'}`;
  },
  powChart(samples){
    // Canonical series only — full chart, collapsed mini and expanded mini share it (A11/A13).
    var series=buildPowSeries(CONFIG.POW_WINDOW);
    var pts=series.points;
    if(pts.length<2)return '<div class="empty">PoW 样本不足，暂时无法画估算工作量趋势。</div>';
    var min=Number.isFinite(series.scaleMin)?series.scaleMin:0,max=Number.isFinite(series.scaleMax)?series.scaleMax:1,span=Math.max(.001,max-min),n=pts.length,w=Math.max(700,n*76),h=300,l=70,r=26,tt=36,b=54,plotW=w-l-r,plotH=h-tt-b;
    function xFn(i){return l+(n===1?0:i/(n-1))*plotW;}function yFn(v){return tt+(max-v)/span*plotH;}
    function fmtWork(v){return v>=1000?(v/1000).toFixed(v>=10000?0:1)+'k×':v>=100?v.toFixed(0)+'×':v>=10?v.toFixed(1)+'×':v.toFixed(2)+'×';}
    var ticks=5;var grid='';
    for(var ti=0;ti<ticks;ti++){var val=max-(span*ti/(ticks-1)),yy=yFn(val);grid+='<line x1="'+l+'" y1="'+yy+'" x2="'+(w-r)+'" y2="'+yy+'" stroke="var(--border)" stroke-width="1"/><text x="'+(l-9)+'" y="'+(yy+4)+'" text-anchor="end" fill="var(--muted)" font-size="12">'+fmtWork(val)+'</text>';}
    var line=pts.map(function(p,i){return xFn(i)+','+yFn(p.work);}).join(' ');
    var circles='';
    var theme=activeTheme();
    for(var ci=0;ci<pts.length;ci++){
      var p=pts[ci],xx=xFn(ci),yy2=yFn(p.work),ts=p.observedAt?new Date(p.observedAt):null,time=ts&&!Number.isNaN(ts.getTime())?ts.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'#'+(ci+1);
      var fill=powSemanticColor(p.phase,theme);
      var stroke=(p.phase==='mismatch-conflict')?theme.conflict:'var(--panel)';
      var showLabel=n<=20||ci%Math.ceil(n/20)===0;
      circles+='<circle data-pow-idx="'+ci+'" cx="'+xx+'" cy="'+yy2+'" r="5.5" fill="'+fill+'" stroke="'+stroke+'" stroke-width="2"/>';
      if(showLabel){circles+='<text x="'+xx+'" y="'+Math.max(14,yy2-10)+'" text-anchor="middle" fill="var(--text)" font-size="12">'+fmtWork(p.work)+'</text><text x="'+xx+'" y="'+(h-18)+'" text-anchor="middle" fill="var(--muted)" font-size="12">'+escapeHtml(time)+'</text>';}
    }
    var legend='<div class="pow-legend" style="display:flex;gap:12px;flex-wrap:wrap;margin:6px 0;font-size:12px">';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--normal)"></span> 绿色 · 模型一致</span>';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--danger)"></span> 红色 · 请求与应答不一致</span>';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--conflict)"></span> 紫色 · 路由证据冲突</span>';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--warn)"></span> 黄色 · 证据未完整</span>';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--muted)"></span> 灰色 · 未关联模型记录</span>';
    legend+='</div>';
    return '<div class="pow-wrap">'+legend+'<div class="pow-svg-wrap" style="position:relative"><svg class="pow-svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'" aria-label="PoW estimated work trend">'+grid+'<line x1="'+l+'" y1="'+(h-b)+'" x2="'+(w-r)+'" y2="'+(h-b)+'" stroke="var(--muted)"/><line x1="'+l+'" y1="'+tt+'" x2="'+l+'" y2="'+(h-b)+'" stroke="var(--muted)"/><text x="12" y="17" fill="var(--muted)" font-size="13">估算工作量（期望尝试次数）</text><polyline fill="none" stroke="var(--accent)" stroke-width="2" points="'+line+'"/>'+circles+'</svg><div class="pow-tooltip" data-role="pow-tooltip" style="display:none;position:absolute;z-index:6;pointer-events:none;max-width:300px"></div></div></div><div class="muted">Y 轴越高 = 按公开逆向算法估算，需要的尝试次数越多。点位悬停可看该轮模型状态；这是逆向估算，不是 OpenAI 官方"风控分"。</div>';
  },
  renderNetwork(el){
    if(!el)return;const st=loadSettings(),hist=State.historyForUi(),groups=new Map();for(const x of hist){const k=x.networkLabel||'未命名网络',g=groups.get(k)||{n:0,mismatch:0,conflict:0,pow:[]};g.n++;if(x.verdict===VERDICT.MODEL_MISMATCH||x.verdict===VERDICT.DOWNGRADE_SUSPECTED)g.mismatch++;if(x.verdict===VERDICT.EVIDENCE_CONFLICT)g.conflict++;const p=Number(x.powDecimal);if(Number.isFinite(p))g.pow.push(p);groups.set(k,g)}const rows=[...groups.entries()].map(([k,g])=>`<div class="card"><b>${escapeHtml(k)}</b><div class="minirow">应答 ${g.n} 次 · 请求≠应答 ${g.mismatch} · 路由冲突 ${g.conflict} · 平均 PoW ${g.pow.length?Math.round(g.pow.reduce((a,b)=>a+b,0)/g.pow.length).toLocaleString():'—'}</div></div>`).join('');const snap=currentNetworkSnapshot(),pow=loadPowHistory().slice(0,50),nums=pow.map(x=>Number(x.decimal)).filter(Number.isFinite),works=pow.map(x=>estimatePowWork(x.rawHex)).filter(Number.isFinite),sortedWork=[...works].sort((a,b)=>a-b),medianWork=sortedWork.length?sortedWork[Math.floor(sortedWork.length/2)]:null,avgWork=works.length?works.reduce((a,b)=>a+b,0)/works.length:null,latest=pow[0]||null;const c=snap.connection||{},fmtWork=v=>!Number.isFinite(v)?'—':v>=1000?`${(v/1000).toFixed(v>=10000?0:1)}k×`:v>=100?`${v.toFixed(0)}×`:v>=10?`${v.toFixed(1)}×`:`${v.toFixed(2)}×`;
    el.innerHTML=`<div class="section-title">当前网络</div><div class="card"><div class="field"><label>节点 / 网络名称（手动命名）</label><input type="text" data-role="network-label" value="${escapeHtml(st.networkLabel||'未命名网络')}" maxlength="64"></div><button class="btn" data-act="save-network">保存标签</button><div class="muted" style="margin-top:8px">浏览器无法可靠读取 OpenClash 当前节点名，所以这里使用你自己定义的标签；之后每轮鉴定都会自动带上它。</div>${snap.connection?`<div class="splitgrid" style="margin-top:10px"><div class="minirow">浏览器 RTT 粗略估算 ${conceptButton('rtt')}<br><b>${Number.isFinite(c.rtt)?'≈ '+c.rtt+' ms':'—'}</b></div><div class="minirow">浏览器下行估算 ${conceptButton('downlink')}<br><b>${Number.isFinite(c.downlink)?c.downlink+' Mbps':'—'}</b></div></div>`:''}</div><div class="section-title">PoW 分析 ${conceptButton('pow')}</div><div class="card"><div class="pow-summary"><div class="pow-stat"><b>${pow.length}</b><small>样本</small></div><div class="pow-stat"><b>${fmtWork(avgWork)}</b><small>平均估算工作量</small></div><div class="pow-stat"><b>${fmtWork(medianWork)}</b><small>中位估算工作量</small></div><div class="pow-stat"><b>${latest&&latest.decimal?Number(latest.decimal).toLocaleString():'—'}</b><small>最新 raw 阈值</small></div></div><button class="btn" data-act="pow-toggle">${this.powExpanded?'收起':'展开'} PoW 趋势图</button>${this.powExpanded?this.powChart(pow):'<div class="muted" style="margin-top:8px">默认折叠。点 PoW ⓘ 可以看“为什么平台使用它、数字大小怎么读、为什么不能把它当 IP 质量分”。</div>'}</div><div class="section-title">按网络标签统计</div>${rows||'<div class="empty">暂无网络统计。</div>'}`;const save=el.querySelector('[data-act="save-network"]');if(save)save.addEventListener('click',()=>{const input=el.querySelector('[data-role="network-label"]'),s=loadSettings();s.networkLabel=(input.value||'未命名网络').trim().slice(0,64)||'未命名网络';saveSettings(s);save.textContent='已保存';setTimeout(()=>this.render(),450)});const pt=el.querySelector('[data-act="pow-toggle"]');if(pt)pt.addEventListener('click',()=>{this.powExpanded=!this.powExpanded;this.render()});this.wirePowTooltip(el)
  },
  wirePowTooltip(el){
    var svg=el.querySelector('.pow-svg');if(!svg)return;
    var tip=el.querySelector('[data-role="pow-tooltip"]');
    // Canonical series: indices match the drawn circles exactly (A11/A12).
    var pts=buildPowSeries(CONFIG.POW_WINDOW).points;
    function pointForIdx(idx){return pts[idx]||null;}
    function buildTip(p){
      if(!p)return '';
      var lines=[];
      var ts=p.observedAt?new Date(p.observedAt):null;
      lines.push('<div style="font-size:12px;font-weight:700;margin-bottom:4px">'+escapeHtml(ts&&!Number.isNaN(ts.getTime())?ts.toLocaleTimeString():'')+'</div>');
      lines.push('<div style="font-size:12px">PoW raw：<b>'+escapeHtml(p.decimal?Number(p.decimal).toLocaleString():'—')+'</b></div>');
      lines.push('<div style="font-size:12px">估算工作量：<b>'+escapeHtml(Number.isFinite(p.work)?(p.work>=1000?(p.work/1000).toFixed(1)+'k×':p.work.toFixed(1)+'×'):'—')+'</b></div>');
      if(p.networkLabel)lines.push('<div style="font-size:12px">网络：'+escapeHtml(p.networkLabel)+'</div>');
      if(p.turnId){
        var st=statusInfo(p);
        lines.push('<div style="font-size:12px;margin-top:4px;color:'+(st.tone==='danger'?'var(--danger)':st.tone==='conflict'?'var(--conflict)':st.tone==='normal'?'var(--normal)':st.tone==='warn'?'var(--warn)':'var(--muted)')+'">状态：'+escapeHtml(st.title)+'</div>');
        if(p.requestedModel)lines.push('<div style="font-size:12px">调用模型：'+escapeHtml(friendlyModelName(p.requestedModel))+'</div>');
        if(p.assistantModel)lines.push('<div style="font-size:12px">应答模型：'+escapeHtml(friendlyModelName(p.assistantModel))+'</div>');
        if(p.resolvedModel)lines.push('<div style="font-size:12px">服务器确认模型：'+escapeHtml(friendlyModelName(p.resolvedModel))+'</div>');
        if(p.serverModel)lines.push('<div style="font-size:12px">服务器路由：'+escapeHtml(friendlyModelName(p.serverModel))+'</div>');
        var allCaptured=(p.requestedModel?1:0)+(p.resolvedModel?1:0)+(p.serverModel?1:0)+(p.assistantModel?1:0);
        lines.push('<div style="font-size:12px">证据完整度：'+allCaptured+'/4</div>');
        var topic=p.turn&&(p.turn.promptTopic||p.turn.promptPreview);
        if(topic)lines.push('<div style="font-size:12px;color:var(--muted);margin-top:4px">“'+escapeHtml(clipText(topic,40))+'”</div>');
      }else{
        lines.push('<div style="font-size:12px;color:var(--muted)">未关联模型记录</div>');
      }
      return '<div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:8px 10px;box-shadow:0 8px 24px var(--shadow);line-height:1.5">'+lines.join('')+'</div>';
    }
    svg.querySelectorAll('[data-pow-idx]').forEach(function(circle){
      circle.style.cursor='pointer';
      circle.addEventListener('mouseenter',function(){
        var idx=parseInt(circle.getAttribute('data-pow-idx'),10);
        var p=pointForIdx(idx);
        if(!tip)return;
        tip.innerHTML=buildTip(p);
        tip.style.display='block';
        var wrap=el.querySelector('.pow-svg-wrap');var cRect=circle.getBoundingClientRect();
        if(wrap){
          var wRect=wrap.getBoundingClientRect();
          var left=cRect.left-wRect.left+14;
          var top=cRect.top-wRect.top-10;
          if(left>wRect.width-160)left-=180;
          if(top<0)top=0;
          tip.style.left=left+'px';
          tip.style.top=top+'px';
        }
      });
      circle.addEventListener('mouseleave',function(){if(tip)tip.style.display='none';});
      circle.addEventListener('click',function(){
        var idx=parseInt(circle.getAttribute('data-pow-idx'),10);
        var p=pointForIdx(idx);
        if(p&&p.turnId&&tip){
          var pinned=tip.hasAttribute('data-pinned')&&tip.getAttribute('data-pinned')==='1';
          if(pinned){tip.removeAttribute('data-pinned');tip.style.display='none';}
          else{tip.setAttribute('data-pinned','1');tip.style.display='block';}
        }
      });
    });
  },
  renderSettings(el){
    if(!el)return;const st=loadSettings();const toggle=(key,label,desc)=>`<label class="toggle"><span>${escapeHtml(label)}<br><small class="muted">${escapeHtml(desc)}</small></span><input type="checkbox" data-setting="${key}" ${st[key]?'checked':''}></label>`;const opts=Object.entries(THEMES).map(([id,t])=>`<option value="${id}" ${st.theme===id?'selected':''}>${escapeHtml(t.name)}</option>`).join('')+`<option value="system" ${st.theme==='system'?'selected':''}>系统自动</option>`;const sounds=[['glass','玻璃铃'],['beep','电子滴'],['water','水滴'],['dual','双音提示'],['alert','警戒音'],['none','无声音']].map(([id,n])=>`<option value="${id}" ${st.soundType===id?'selected':''}>${n}</option>`).join('');
    el.innerHTML=`<div class="setting-group"><h3>外观</h3><div class="field"><label>主题</label><select data-setting-select="theme">${opts}</select><div class="muted">主题会一起改变背景、卡片、用户/AI 气泡、状态色、图表和解释便签，不只是换一个主色。</div></div></div><div class="setting-group"><h3>提醒方式</h3>${toggle('alertEnabled','模型不一致或路由冲突时提醒我','总开关：关闭后仍记录，但不主动打扰你')}${toggle('toastEnabled','页面弹窗提醒','出现模型不一致、路由冲突或服务器字段变化时，在页面顶部显示人话提示')}<div class="subsetting">${toggle('soundEnabled','播放提示音','只在模型不一致或路由冲突时发声')}<div class="soundrow"><div class="field"><label>提示音</label><select data-setting-select="soundType">${sounds}</select></div><button class="btn" data-act="sound-preview">试听</button></div><div class="field"><label>音量 <span data-role="volume-label">${Math.round(Number(st.soundVolume||0)*100)}%</span></label><input class="range" type="range" min="0" max="1" step="0.05" value="${Number(st.soundVolume??0.55)}" data-setting-range="soundVolume"></div></div></div><div class="setting-group"><h3>显示方式</h3>${toggle('ghostWarningEnabled','在异常回复下显示模型警告','如果这一轮请求与应答模型不一致，或服务器证据互相冲突，就在对应 ChatGPT 回复下面标出来')}</div><div class="setting-group"><h3>隐私与记录</h3>${toggle('persistChatSummaries','记住每条记录对应的对话','只保存少量 Prompt 与回复摘要，方便以后认出是哪一次对话；不会保存完整聊天')}</div><div class="setting-group"><h3>高级</h3>${toggle('titleFlashEnabled','后台标签页闪烁','页面在后台时，如果出现模型不一致或路由冲突，用浏览器标签标题提醒你')}${toggle('ghostMarkAll','在每条回复下显示鉴定结果','默认关闭；开启后连正常回复也会显示模型标签')}${toggle('floatingAnimEnabled','浮动监控条动画','关闭后仍显示模型名、状态颜色与真实 PoW 波形，但停止脉冲沿线流动动画')}${toggle('wsFallbackEnabled','WebSocket 备用捕获','只有 ChatGPT 改用 WebSocket 传输时才可能用到，平时不需要管')}${toggle('powEnabled','记录 PoW','保存服务器返回的工作量证明难度，用于网络/风控趋势对比；它不是 IP 质量分')}</div><div class="setting-group"><button class="btn" data-act="reset-pos">重置悬浮窗位置</button> <button class="btn danger-text" data-act="clear">清空历史和 PoW</button><div class="muted" style="margin-top:9px">模型鉴定姬只观察网络证据，不修改请求、Header、Cookie、模型选择或 ChatGPT 的回答内容。</div><div style="margin-top:10px"><a class="btn" href="https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor" target="_blank" rel="noopener noreferrer" style="text-decoration:none;display:inline-flex;align-items:center">GitHub 项目主页 ↗</a></div></div>`;
    el.querySelectorAll('[data-setting]').forEach(i=>i.addEventListener('change',()=>{const s=loadSettings();s[i.dataset.setting]=i.checked;saveSettings(s);if(i.dataset.setting==='floatingAnimEnabled'){if(i.checked)FloatingMonitor.maybeStartAnim();else FloatingMonitor.stopAnim()}}));el.querySelectorAll('[data-setting-select]').forEach(i=>i.addEventListener('change',()=>{const s=loadSettings();s[i.dataset.settingSelect]=i.value;saveSettings(s);if(i.dataset.settingSelect==='theme'){this.applyTheme();FloatingMonitor.applyTheme();FloatingMonitor.updateDisplay();this.render()}}));const range=el.querySelector('[data-setting-range="soundVolume"]');if(range)range.addEventListener('input',()=>{const s=loadSettings();s.soundVolume=Number(range.value);saveSettings(s);const lab=el.querySelector('[data-role="volume-label"]');if(lab)lab.textContent=`${Math.round(Number(range.value)*100)}%`});const preview=el.querySelector('[data-act="sound-preview"]');if(preview)preview.addEventListener('click',()=>{const sel=el.querySelector('[data-setting-select="soundType"]');AudioFeedback.preview(sel&&sel.value)});const reset=el.querySelector('[data-act="reset-pos"]');if(reset)reset.addEventListener('click',()=>{const s=loadSettings();s.dashboardPosition=s.dashboardSize=s.badgePosition=null;s.conceptPinPositions={};saveSettings(s);Badge.restorePosition();this.restoreGeometry(true)});const clear=el.querySelector('[data-act="clear"]');if(clear)clear.addEventListener('click',()=>{clearAllStorage();State.resetSession();Badge.setStatus(null,null);this.render()})
  },
  copyDiagnostics(){try{const data={exportedAt:nowIso(),version:CONFIG.PROTOCOL_VERSION,pow:loadPowHistory(),history:loadHistory(),settings:{...loadSettings(),networkLabel:loadSettings().networkLabel}};const ta=document.createElement('textarea');ta.value=JSON.stringify(data,null,2);document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove()}catch{}}
};

/* ------------------------------------------------------------------ */
/* UI: TOAST                                                           */
/* ------------------------------------------------------------------ */

const Toast = {
  host: null,
  currentTimer: null,
  ensure() {
    if (this.host && this.host.isConnected) return this.host;
    this.host = document.createElement("div");
    this.host.id = "chatgpt-model-downgrade-monitor-toast-host";
    this.host.style.cssText = "all:initial;position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483645;pointer-events:none;";
    this.host.attachShadow({ mode: "open" });
    this.host.shadowRoot.innerHTML = `
      <style>
        .toast{padding:10px 18px;border-radius:10px;color:#fff;font:600 13px/1.4 system-ui,sans-serif;
          box-shadow:0 6px 24px rgba(0,0,0,.4);opacity:0;transition:opacity .3s ease,transform .3s ease;
          transform:translateY(-12px);max-width:min(560px,calc(100vw - 32px));text-align:center;}
        .toast.show{opacity:1;transform:translateY(0);}
        .toast.danger{background:#b91c1c;border:1px solid #ef4444;}
        .toast.conflict{background:#6b21a8;border:1px solid #a855f7;}
        .toast.notice{background:#92400e;border:1px solid #f59e0b;}
      </style>`;
    document.documentElement.appendChild(this.host);
    return this.host;
  },
  show(message, tone = "danger", durationMs = CONFIG.TOAST_DURATION_MS) {
    try {
      const host = this.ensure();
      if (!host || !host.shadowRoot) return;
      const root = host.shadowRoot;
      const el = document.createElement("div");
      el.className = `toast ${tone}`;
      el.textContent = message;
      root.appendChild(el);
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { try { el.classList.add("show"); } catch {} });
      if (this.currentTimer) clearTimeout(this.currentTimer);
      this.currentTimer = setTimeout(() => {
        try {
          el.classList.remove("show");
          setTimeout(() => { if (el.parentNode) { try { el.remove(); } catch {} } }, 400);
        } catch {}
        this.currentTimer = null;
      }, durationMs);
    } catch {
      /* fail open */
    }
  }
};

/* ------------------------------------------------------------------ */
/* UI: GHOST MARKER                                                    */
/* ------------------------------------------------------------------ */

/*
 * Ghost warning: marks the assistant message DOM node with a data-attribute;
 * CSS ::after pseudo-element renders the warning without touching the
 * message's layout/padding/borders.
 */

const GhostMarker = {
  styleInjected: false,
  ensureStyle() {
    if (this.styleInjected) return;
    this.styleInjected = true;
    const style = document.createElement("style");
    style.id = "chatgpt-model-downgrade-monitor-ghost-style";
    style.textContent = `
      [data-message-id][data-model-downgrade-monitor-note]::after {
        content: attr(data-model-downgrade-monitor-note);
        display: block;
        margin-top: 6px;
        padding: 4px 10px;
        border-radius: 6px;
        background: rgba(127,29,29,.15);
        color: #f87171;
        font: 600 11px/1.4 system-ui, sans-serif;
        max-width: fit-content;
        pointer-events: none;
        user-select: none;
      }
    `;
    document.documentElement.appendChild(style);
  },
  mark(messageId, warningText) {
    if (!messageId) return;
    this.ensureStyle();
    const find = () => {
      try {
        const node = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
        if (node) {
          node.setAttribute("data-model-downgrade-monitor-note", warningText);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };
    if (find()) return;
    // bounded MutationObserver: disconnect once found or on timeout
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => {
      if (find()) {
        observer.disconnect();
        clearTimeout(timer);
      }
    });
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      return;
    }
    const timer = setTimeout(() => observer.disconnect(), CONFIG.DOM_FIND_TIMEOUT_MS);
  }
};

/* ------------------------------------------------------------------ */
/* UI: TITLE FLASHER                                                   */
/* ------------------------------------------------------------------ */

const TitleFlasher = {
  timer:null,original:null,flashing:false,_stopHandler:null,
  start(){if(this.flashing)return;const st=loadSettings();if(!st.titleFlashEnabled||!document.hidden)return;this.original=document.title;this.flashing=true;this._stopHandler=()=>this.stop();document.addEventListener('visibilitychange',this._stopHandler);window.addEventListener('focus',this._stopHandler);window.addEventListener('pointerdown',this._stopHandler,{passive:true});this.timer=window.setInterval(()=>{document.title=document.title==='⚠ 模型鉴定姬：模型证据异常'?this.original:'⚠ 模型鉴定姬：模型证据异常'},1200)},
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;if(this.flashing&&this.original!==null)document.title=this.original;this.flashing=false;if(this._stopHandler){document.removeEventListener('visibilitychange',this._stopHandler);window.removeEventListener('focus',this._stopHandler);window.removeEventListener('pointerdown',this._stopHandler);this._stopHandler=null}}
};

/* ------------------------------------------------------------------ */
/* STATE & ALERT COORDINATION                                          */
/* ------------------------------------------------------------------ */

/*
 * Central state: latest evidence, dedupe (by messageId, allowing a single
 * escalation), hook health, route result persistence.
 */

const State = {
  _last:null,_dedupe:new Map(),_historyWritten:new Set(),_powSeen:0,_hooks:{fetch:false,sse:false,pow:"waiting",ws:false},_sessionEntries:[],_pendingPow:[],
  powLinkStats:{linkedByActiveTurn:0,linkedByPendingClaim:0},
  setHooks(h){Object.assign(this._hooks,h)},
  hookHealth(){const h=this._hooks,overall=h.fetch&&h.sse?'READY':(h.fetch||h.sse)?'PARTIAL':'FAILED';return{overall,fetch:h.fetch,sse:h.sse,pow:h.pow,ws:h.ws}},
  recordPow(sample){
    if(!loadSettings().powEnabled)return;
    this._powSeen+=1;this._hooks.pow='observed';
    const snap=currentNetworkSnapshot();
    const powId=(sample&&sample.powId)||crypto.randomUUID();
    const active=TurnAggregator.activeTurn&&!TurnAggregator.activeTurn.finalizedAt?TurnAggregator.activeTurn:null;
    const enriched={powId:powId,observedAt:(sample&&sample.observedAt)||nowIso(),rawHex:sample?sample.rawHex:null,decimal:sample?sample.decimal:null,networkLabel:snap.label,networkConnection:snap.connection,turnId:null,linkState:'pending'};
    if(active){
      // A8 Case B: turn already exists -> strongest direct association.
      enriched.turnId=active.turnId;enriched.linkState='linked';
      active.powId=powId;active.powRaw=enriched.rawHex;active.powDecimal=enriched.decimal;
      this.powLinkStats.linkedByActiveTurn+=1;
    }else{
      // A6/A7 Case A: PoW arrived before its turn -> bounded pending queue.
      this.enqueuePendingPow(enriched);
    }
    addPowSample(enriched);
    postBus(MSG_TYPE.POW,{sample:enriched,total:this._powSeen});
  },
  enqueuePendingPow(sample){
    if(!sample||!sample.powId)return;
    const q=this._pendingPow||(this._pendingPow=[]);
    q.push(sample);
    const now=Date.now();
    for(let i=q.length-1;i>=0;i--){
      const s=q[i];const ts=s&&s.observedAt?new Date(s.observedAt).getTime():0;
      if(!ts||now-ts>CONFIG.PENDING_POW_TTL_MS)q.splice(i,1);
    }
    while(q.length>CONFIG.MAX_PENDING_POW)q.shift();
  },
  claimPendingPowForTurn(turn){
    // A7: claim the newest safe eligible pending PoW (shortly BEFORE, in TTL, unclaimed).
    if(!turn)return null;
    const q=this._pendingPow||[];
    const now=Date.now();
    let best=null,bestIdx=-1,bestTs=0;
    for(let i=0;i<q.length;i++){
      const s=q[i];
      if(!s||s.linkState!=='pending'||s.turnId)continue;
      const ts=s.observedAt?new Date(s.observedAt).getTime():0;
      if(!ts)continue;
      if(now-ts>CONFIG.PENDING_POW_TTL_MS)continue;
      if(ts>turn.startedAt+2000)continue;
      if(!best||ts>bestTs){best=s;bestTs=ts;bestIdx=i;}
    }
    if(!best)return null;
    best.turnId=turn.turnId;best.linkState='linked';
    updatePowSample(best.powId,{turnId:turn.turnId,linkState:'linked'});
    turn.powId=best.powId;turn.powRaw=best.rawHex;turn.powDecimal=best.decimal;
    q.splice(bestIdx,1);
    this.powLinkStats.linkedByPendingClaim+=1;
    return best;
  },
  resetSession(){this._last=null;this._dedupe.clear();this._historyWritten.clear();this._sessionEntries=[];this._pendingPow=[];this.powLinkStats={linkedByActiveTurn:0,linkedByPendingClaim:0};TurnAggregator.reset()},
  historyForUi(){const persisted=loadHistory(),all=[...this._sessionEntries,...persisted],seen=new Set(),out=[];for(const x of all){const k=x.captureId||x.turnId||`${x.timestamp}:${x.messageId||x.conversationId||''}`;if(seen.has(k))continue;seen.add(k);out.push(x);if(out.length>=CONFIG.MAX_HISTORY)break;}return out},
  // v1.5: emitTurn called by TurnAggregator after finalization.
  emitTurn(turn){
    const entry={captureId:turn.turnId,turnId:turn.turnId,timestamp:turn.startedAt,conversationId:turn.conversationId||null,messageId:turn.messageId||null,requestedModel:turn.requestedModel||null,resolvedModel:turn.resolvedModel||null,assistantModel:turn.assistantModel||null,serverModel:turn.serverModel||null,requestedSource:turn.requestedSource||null,resolvedSource:turn.resolvedSource||null,assistantSource:turn.assistantSource||null,serverSource:turn.serverSource||null,promptPreview:turn.promptPreview||null,promptTopic:turn.promptTopic||null,replyPreview:turn.replyPreview||null,replyTopic:turn.replyTopic||null,replyIsCode:Boolean(turn.replyIsCode),internalMessages:Array.isArray(turn.internalMessages)?turn.internalMessages.slice(0,CONFIG.MAX_INTERNAL_MESSAGES):[],networkLabel:turn.networkLabel||'',networkConnection:turn.networkConnection||null,powId:turn.powId||null,powRaw:turn.powRaw||null,powDecimal:turn.powDecimal||null,findings:Array.isArray(turn.findings)?turn.findings.slice():[],transport:Object.keys(turn.transportsSeen||{}).join(',')||'fetch',transportsSeen:turn.transportsSeen||{}};
    const result=runVerdict({requested:entry.requestedModel,resolved:entry.resolvedModel,resolvedSource:entry.resolvedSource,server:entry.serverModel,serverSource:entry.serverSource,assistant:entry.assistantModel,assistantSource:entry.assistantSource});
    entry.verdict=result.verdict;entry.confidence=result.confidence;entry.evidenceConflict=result.verdict===VERDICT.EVIDENCE_CONFLICT;entry.reasons=result.reasons;
    this._last=entry;const key=entry.captureId||entry.messageId||entry.conversationId||entry.timestamp;if(this._historyWritten.has(key)){Badge.setStatus(entry.verdict,entry.assistantModel||entry.resolvedModel||entry.serverModel||entry.requestedModel);if(Dashboard.open)Dashboard.render();return;}this._historyWritten.add(key);if(this._historyWritten.size>300){const o=this._historyWritten.keys().next().value;if(o!==undefined)this._historyWritten.delete(o)}this._sessionEntries.unshift(entry);this._sessionEntries=this._sessionEntries.slice(0,CONFIG.MAX_HISTORY);addHistoryEntry(entry);postBus(MSG_TYPE.ROUTE_RESULT,persistableEntry(entry));this.alert(entry);Badge.setStatus(entry.verdict,entry.assistantModel||entry.resolvedModel||entry.serverModel||entry.requestedModel);if(Dashboard.open)Dashboard.render();
  },
  handleRouteEvidence(evidence){
    const result=runVerdict({requested:evidence.requestedModel||null,resolved:evidence.resolvedModel||null,resolvedSource:evidence.resolvedSource||null,server:evidence.serverModel||null,serverSource:evidence.serverSource||null,assistant:evidence.assistantModel||null,assistantSource:evidence.assistantSource||null});
    const network=evidence.network||currentNetworkSnapshot();
    const entry={turnId:evidence.captureId||crypto.randomUUID(),captureId:evidence.captureId||crypto.randomUUID(),timestamp:Date.now(),conversationId:evidence.conversationId||null,messageId:evidence.messageId||null,requestedModel:evidence.requestedModel||null,resolvedModel:evidence.resolvedModel||null,assistantModel:evidence.assistantModel||null,serverModel:evidence.serverModel||null,requestedSource:evidence.requestedSource||null,resolvedSource:evidence.resolvedSource||null,assistantSource:evidence.assistantSource||null,serverSource:evidence.serverSource||null,promptPreview:evidence.promptPreview||null,promptTopic:evidence.promptTopic||null,replyPreview:evidence.replyPreview||null,replyTopic:evidence.replyTopic||null,replyIsCode:Boolean(evidence.replyIsCode),internalMessages:Array.isArray(evidence.internalMessages)?evidence.internalMessages.slice(0,CONFIG.MAX_INTERNAL_MESSAGES):[],networkLabel:network.label||'',networkConnection:network.connection||null,powId:null,powRaw:null,powDecimal:null,verdict:result.verdict,confidence:result.confidence,transport:evidence.transport||'fetch',evidenceConflict:result.verdict===VERDICT.EVIDENCE_CONFLICT,reasons:result.reasons};
    this._last=entry;const key=entry.captureId||entry.messageId||entry.conversationId||entry.timestamp;if(this._historyWritten.has(key)){Badge.setStatus(entry.verdict,entry.assistantModel||entry.resolvedModel||entry.serverModel||entry.requestedModel);if(Dashboard.open)Dashboard.render();return;}this._historyWritten.add(key);if(this._historyWritten.size>300){const o=this._historyWritten.keys().next().value;if(o!==undefined)this._historyWritten.delete(o)}this._sessionEntries.unshift(entry);this._sessionEntries=this._sessionEntries.slice(0,CONFIG.MAX_HISTORY);addHistoryEntry(entry);postBus(MSG_TYPE.ROUTE_RESULT,persistableEntry(entry));this.alert(entry);Badge.setStatus(entry.verdict,entry.assistantModel||entry.resolvedModel||entry.serverModel||entry.requestedModel);if(Dashboard.open)Dashboard.render();
  },
  alert(entry){
    const st=loadSettings();if(st.silent||st.alertEnabled===false)return;const key=entry.captureId||entry.messageId||entry.conversationId||entry.timestamp,prev=this._dedupe.get(key)||'NORMAL',esc=verdictRank(entry.verdict)>verdictRank(prev),si=statusInfo(entry);
    const severe=entry.verdict===VERDICT.MODEL_MISMATCH||entry.verdict===VERDICT.DOWNGRADE_SUSPECTED||entry.verdict===VERDICT.EVIDENCE_CONFLICT;
    if(severe){if(esc){this._dedupe.set(key,entry.verdict);if(st.toastEnabled)Toast.show(`${si.title} · ${si.metrics.join(' · ')}`,entry.verdict===VERDICT.EVIDENCE_CONFLICT?'conflict':'danger');if(st.soundEnabled)AudioFeedback.danger();TitleFlasher.start();}}
    else if(entry.verdict===VERDICT.ROUTE_NOTICE){if(esc){this._dedupe.set(key,entry.verdict);if(st.toastEnabled)Toast.show(`模型字段发生变化 · ${si.basis}`,'notice',4200)}}
    else this._dedupe.set(key,entry.verdict||'NORMAL');
    if(st.ghostWarningEnabled&&entry.messageId){if(severe){GhostMarker.mark(entry.messageId,`⚠ ${si.title} · ${si.metrics[0]||''}`)}else if(st.ghostMarkAll&&entry.verdict===VERDICT.NORMAL){GhostMarker.mark(entry.messageId,`✓ ${friendlyModelName(entry.assistantModel||entry.resolvedModel||entry.serverModel)}`)}}if(this._dedupe.size>200){const o=this._dedupe.keys().next().value;if(o!==undefined)this._dedupe.delete(o)}
  },
  lastRouteResult(){return this._last}
};

/* ------------------------------------------------------------------ */
/* NETWORK OBSERVERS (MAIN WORLD)                                      */
/* ------------------------------------------------------------------ */

const Network = {
  nativeFetch: null,
  nativeWebSocket: null,
  installed: false,
  fetchInstalled: false,
  wsInstalled: false,
  sseInstalled: false,
  pendingCaptures: new Map(),
  pendingByInputId: new Map(),
  pendingByConversation: new Map(),
  streamPending: new Map(),       // exact fetch-call → response-stream correlation
  accum: new Map(),               // per-turn evidence accumulation (bounded below)
  observedSockets: new WeakSet(),
  installSentinel: typeof Symbol !== "undefined"
    ? Symbol.for("chatgpt-model-downgrade-monitor.installed")
    : "__chatgpt_model_downgrade_monitor_installed__",

  install() {
    if (window[this.installSentinel]) return true;
    if (typeof Symbol === "undefined" && window.__chatgpt_model_downgrade_monitor_installed__) return true;
    this.nativeFetch = window.fetch;
    this.nativeWebSocket = window.WebSocket;
    const fetchOk = this.installFetchHook();
    const wsOk = this.installWebSocketHook();
    this.fetchInstalled = fetchOk;
    this.wsInstalled = wsOk;
    this.sseInstalled = fetchOk; // SSE transform is part of the fetch hook
    try {
      if (typeof Symbol !== "undefined") window[this.installSentinel] = true;
      else window.__chatgpt_model_downgrade_monitor_installed__ = true;
    } catch {
      /* fail open */
    }
    this.installed = true;
    State.setHooks({ fetch: fetchOk, sse: fetchOk, pow: State._hooks.pow, ws: wsOk });
    return true;
  },

  installFetchHook() {
    if (this.fetchInstalled) return true;
    if (typeof this.nativeFetch !== "function") return false;
    try {
      const self = this;
      const original = this.nativeFetch;
      const wrapped = function wrappedFetch(input, init) {
        const receiver = this && this !== window ? this : undefined;
        const endpoint = classifyEndpoint(input, window.location.href);
        if (endpoint.kind === "other") {
          return original.call(receiver, input, init);
        }
        if (endpoint.kind === "pow_requirements") {
          // small JSON: safe to clone
          return original.call(receiver, input, init).then((response) => {
            try {
              if (!response || !response.ok) return response;
              response.clone().text()
                .then((raw) => {
                  if (raw.length > CONFIG.POW_MAX_BYTES) return;
                  const parsed = parsePowResponse(JSON.parse(raw));
                  if (parsed) {
                    State.recordPow({ rawHex: parsed.rawHex, decimal: parsed.decimal, observedAt: nowIso() });
                  }
                })
                .catch(() => {});
            } catch {
              /* fail open */
            }
            return response;
          }, (err) => { throw err; });
        }
        // conversation stream: capture request correlation BEFORE the original
        // fetch consumes the Request body, then wrap the response stream.
        const requestCapturePromise = self.captureRequestCorrelation(input, init);
        return original.call(receiver, input, init).then((response) => {
          if (!response || !response.ok) return response;
          const body = response.body;
          if (!body) return response;
          try {
            // pass-through TransformStream with side-channel parser
            const transformed = self.attachSseTransform(response, requestCapturePromise);
            if (transformed) return transformed;
          } catch {
            /* fail open: return the original response untouched */
          }
          return response;
        }, (err) => { throw err; });
      };
      // preserve function identity for error messages
      Object.defineProperty(wrapped, "name", { value: "fetch", configurable: true });
      window.fetch = wrapped;
      this.fetchInstalled = true;
      this.wrappedFetch = wrapped;
      return true;
    } catch {
      return false;
    }
  },

  captureRequestCorrelation(input, init) {
    const self = this;
    const readBody = async () => {
      try {
        const body = init ? init.body : null;
        if (typeof body === "string") return body;
        if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
        if (typeof Blob !== "undefined" && body instanceof Blob) return await body.text();
        if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
        if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(body)) {
          return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
        }
        // Request / Request-like objects: clone only the outgoing small JSON body; never touch the live body.
        if (input && typeof input === "object" && typeof input.clone === "function") {
          try {
            const cloned = input.clone();
            if (cloned && typeof cloned.text === "function") return await cloned.text();
          } catch {}
        }
        // Last-resort synthetic Request clone. This does not send a second request.
        try {
          const synthetic = new Request(input, init);
          if (synthetic && typeof synthetic.text === "function") return await synthetic.text();
        } catch {}
      } catch {}
      return null;
    };

    return readBody().then((raw) => {
      if (!raw) return null;
      let root;
      try { root = JSON.parse(raw); } catch { return null; }
      const req = extractRequestEvidence(root);
      if (!req.requestedModel && !req.conversationId) return null;
      const entry = {
        captureId: crypto.randomUUID(),
        startedAt: nowIso(),
        requestedModel: req.requestedModel,
        requestedSource: req.requestedSource,
        conversationId: req.conversationId,
        inputMessageId: req.inputMessageId,
        parentMessageId: req.parentMessageId,
        promptPreview: req.promptPreview || null,
        promptTopic: req.promptTopic || null,
        network: currentNetworkSnapshot(),
        expiresAt: Date.now() + CONFIG.PENDING_CAPTURE_TTL_MS
      };
      self.pendingCaptures.set(entry.captureId, entry);
      if (entry.inputMessageId) self.pendingByInputId.set(entry.inputMessageId, entry);
      if (entry.conversationId) self.pendingByConversation.set(entry.conversationId, entry);
      self.prunePendingCaptures();
      return entry;
    }).catch(() => null);
  },

  prunePendingCaptures() {
    const nowTs = Date.now();
    for (const [id, entry] of this.pendingCaptures) {
      if (entry.expiresAt <= nowTs) {
        this.pendingCaptures.delete(id);
        if (entry.inputMessageId) this.pendingByInputId.delete(entry.inputMessageId);
        if (entry.conversationId) this.pendingByConversation.delete(entry.conversationId);
      }
    }
    // bound the accumulation map (Map preserves insertion order)
    if (this.accum.size > 256) {
      const oldest = this.accum.keys().next().value;
      if (oldest !== undefined) this.accum.delete(oldest);
    }
  },

  attachSseTransform(response, requestCapturePromise = null) {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const self = this;
    const streamId = crypto.randomUUID(); // one stream == one user turn
    var turn = TurnAggregator.getOrCreateActiveTurn(streamId, null);
    if (requestCapturePromise && typeof requestCapturePromise.then === "function") {
      requestCapturePromise.then((entry) => {
        if (entry) {
          self.streamPending.set(streamId, entry);
          TurnAggregator.applyRequestCapture(turn, entry);
        }
      }).catch(() => {});
    }

    const parser = createSSEParser((event) => {
      self.accumulateEvidence(event, "fetch", streamId);
    });

    const transform = new TransformStream({
      transform(chunk, controller) {
        // FIRST priority: pass the raw chunk through untouched.
        try {
          controller.enqueue(chunk);
        } catch {
          return;
        }
        // Side-channel parse, never blocks enqueue.
        try {
          let text;
          try { text = decoder.decode(chunk, { stream: true }); } catch { return; }
          parser.push(text);
        } catch {
          /* parser failure never breaks the stream */
        }
      },
      flush(controller) {
        try {
          parser.flush();
          // finalize any turn still open for this stream (stream end = turn done)
          self.finalizeStream(streamId);
        } catch {
          /* fail open */
        }
      }
    });

    const newBody = response.body.pipeThrough(transform);
    const newResponse = new Response(newBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    return newResponse;
  },

  handleSseEvent(event) {
    this.accumulateEvidence(event, "fetch", null);
  },

  // v1.5: Accumulate evidence through TurnAggregator. Fetch → active turn; WS → correlate + merge.
  accumulateEvidence(event, transport, streamId) {
    if (transport === "websocket") {
      this.applyWsEvidence(event);
      return;
    }
    var evidence = extractEvidence(event);
    if (!evidence.assistantModel && !evidence.resolvedModel && !evidence.serverModel && !evidence.replyPreview) return;
    var turn = TurnAggregator.activeTurn;
    if (!turn) turn = TurnAggregator.getOrCreateActiveTurn(streamId, evidence.conversationId);
    TurnAggregator.applyEvidence(turn, evidence, "fetch");
  },

  finalizeTurn(key) {
    this.accum.delete(key);
  },

  finalizeStream(streamId) {
    if (!streamId) return;
    TurnAggregator.markStreamDone(streamId);
    this.streamPending.delete(streamId);
  },

  resolvePending(acc) {
    if (acc.streamId && this.streamPending.has(acc.streamId)) {
      return this.streamPending.get(acc.streamId);
    }
    if (acc.conversationId && this.pendingByConversation.has(acc.conversationId)) {
      return this.pendingByConversation.get(acc.conversationId);
    }
    if (acc.messageId && this.pendingByInputId.has(acc.messageId)) {
      return this.pendingByInputId.get(acc.messageId);
    }
    return null;
  },

  installWebSocketHook() {
    if (this.wsInstalled) return true;
    if (typeof this.nativeWebSocket !== "function") return false;
    const self = this;
    const Original = this.nativeWebSocket;
    const Wrapped = function GuardWebSocket(url, protocols) {
      if (!(this instanceof Wrapped)) return Original.apply(this, arguments);
      const socket = protocols !== undefined
        ? new Original(url, protocols)
        : new Original(url);
      self.observeWebSocket(socket);
      return socket;
    };
    try {
      Wrapped.prototype = Original.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
        Object.defineProperty(Wrapped, k, { value: Original[k], writable: false });
      }
      window.WebSocket = Wrapped;
      this.wsInstalled = true;
      return true;
    } catch {
      return false;
    }
  },

  observeWebSocket(socket) {
    if (this.observedSockets.has(socket)) return;
    try {
      if (!/chatgpt\.com|openai\.com/i.test(socket.url)) return;
    } catch {
      return;
    }
    this.observedSockets.add(socket);
    const self = this;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      if (event.data.length > CONFIG.WS_MAX_FRAME_BYTES) return;
      try {
        self.handleWebSocketText(event.data);
      } catch {
        /* fail open: never break the socket's own message flow */
      }
    });
  },

  handleWebSocketText(raw) {
    // Best-effort parse of ChatGPT conversation payloads carried over WS.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      const payload = asRecord(candidate.payload) || asRecord(candidate);
      const inner = asRecord(payload.payload) || payload;
      const encodedItem = asString(inner.encoded_item, CONFIG.WS_MAX_ENCODED_ITEM_BYTES);
      if (encodedItem) {
        const itemParser = createSSEParser((event) => {
          this.accumulateEvidence(event, "websocket");
        });
        itemParser.push(encodedItem);
        itemParser.flush();
      } else {
        this.accumulateEvidence(candidate, "websocket");
      }
    }
  },

  // v1.5: WS evidence correlation — merge into existing turn, never create standalone card.
  applyWsEvidence(rawEvent) {
    var evidence = extractEvidence(rawEvent);
    if (!evidence.assistantModel && !evidence.resolvedModel && !evidence.serverModel && !evidence.replyPreview) return;
    if (TurnAggregator.isDuplicateEvidence(evidence, "websocket")) return;

    // STEP 1: exact messageId match
    if (evidence.messageId) {
      var found = TurnAggregator.findTurnByMessageId(evidence.messageId);
      if (found) { TurnAggregator.applyEvidence(found, evidence, "websocket"); return; }
    }

    // STEP 2: active turn with matching conversationId
    if (TurnAggregator.activeTurn && !TurnAggregator.activeTurn.finalizedAt) {
      if (evidence.conversationId && TurnAggregator.activeTurn.conversationId === evidence.conversationId) {
        TurnAggregator.applyEvidence(TurnAggregator.activeTurn, evidence, "websocket");
        return;
      }
    }

    // STEP 3: grace period — finished turn with matching conversationId
    if (TurnAggregator.activeTurn && (TurnAggregator.activeTurn.lifecycle === LIFECYCLE.STREAM_DONE || TurnAggregator.activeTurn.lifecycle === LIFECYCLE.GRACE)) {
      if (evidence.conversationId && TurnAggregator.activeTurn.conversationId === evidence.conversationId) {
        TurnAggregator.activeTurn.lifecycle = LIFECYCLE.GRACE;
        if (TurnAggregator.graceTimer) clearTimeout(TurnAggregator.graceTimer);
        var self = this;
        TurnAggregator.graceTimer = setTimeout(function(){ TurnAggregator.finalizeGrace(); }, CONFIG.FINALIZE_GRACE_MS);
        TurnAggregator.applyEvidence(TurnAggregator.activeTurn, evidence, "websocket");
        return;
      }
    }

    // STEP 4: finalized turn with matching conversationId (within grace window)
    if (evidence.conversationId) {
      var recent = TurnAggregator.findTurnByConversation(evidence.conversationId);
      if (recent && recent.lifecycle === LIFECYCLE.FINALIZED && (Date.now() - recent.finalizedAt) < CONFIG.FINALIZE_GRACE_MS) {
        recent.lifecycle = LIFECYCLE.STREAM_DONE;
        recent.finalizedAt = null;
        TurnAggregator.activeTurn = recent;
        TurnAggregator.applyEvidence(recent, evidence, "websocket");
        var self2 = this;
        TurnAggregator.graceTimer = setTimeout(function(){ TurnAggregator.finalizeGrace(); }, CONFIG.FINALIZE_GRACE_MS);
        return;
      }
    }

    // Uncorrelated WS evidence — discard silently, never create standalone card.
  },
};

/* ------------------------------------------------------------------ */
/* SPA / LIFECYCLE                                                     */
/* ------------------------------------------------------------------ */

window.addEventListener("resize", () => {
  try { Badge.restorePosition(); } catch {}
  try { if (Dashboard.open) Dashboard.restoreGeometry(); } catch {}
}, { passive: true });

function ensureUiAfterDom() {
  if (document.documentElement) {
    AudioFeedback.attachUnlock();
    attachConnectionChangeListener();
    Badge.setStatus(State._last ? State._last.verdict : null, State._last ? (State._last.resolvedModel || State._last.assistantModel) : null);
    return;
  }
  document.addEventListener("DOMContentLoaded", () => {
    AudioFeedback.attachUnlock();
    attachConnectionChangeListener();
    Badge.setStatus(null, null);
  }, { once: true });
}

/* ------------------------------------------------------------------ */
/* DEBUG API                                                           */
/* ------------------------------------------------------------------ */

/*
 * window.__chatgptGuardPro - safe local debug surface.
 * test*() functions only exercise local UI/verdict logic; they never send
 * network requests, switch models, or touch ChatGPT state.
 */

window.__chatgptModelDowngradeMonitor = {
  status() {
    return {
      installed: Network.installed,
      hooks: State.hookHealth(),
      latest: State.lastRouteResult(),
      activeTurn: TurnAggregator.activeTurn ? {
        turnId: TurnAggregator.activeTurn.turnId,
        lifecycle: TurnAggregator.activeTurn.lifecycle,
        transports: Object.keys(TurnAggregator.activeTurn.transportsSeen||{}),
        messageId: TurnAggregator.activeTurn.messageId
      } : null,
      finalizedCount: TurnAggregator.finalized.length,
      historyCount: loadHistory().length,
      powCount: loadPowHistory().length,
      powLinkStats: State.powLinkStats
    };
  },
  open() { Dashboard.show(); },
  close() { Dashboard.hide(); },
  getLogs() { return loadHistory(); },
  clearLogs() {
    clearAllStorage();
    State.resetSession();
    if (Dashboard.open) Dashboard.render();
  },
  testSafe() {
    State.handleRouteEvidence({
      messageId: "test-safe-msg",
      requestedModel: "gpt-5-6-thinking",
      resolvedModel: "gpt-5-6-thinking",
      assistantModel: "gpt-5-6-thinking",
      resolvedSource: "message.metadata.resolved_model_slug",
      assistantSource: "assistant.metadata.model_slug",
      transport: "debug"
    });
  },
  testNotice() {
    State.handleRouteEvidence({
      messageId: "test-notice-msg",
      requestedModel: "gpt-5-6-thinking",
      resolvedModel: "gpt-5-5-mini",
      assistantModel: null,
      resolvedSource: "message.metadata.resolved_model_slug",
      assistantSource: null,
      transport: "debug"
    });
  },
  testDanger() {
    State.handleRouteEvidence({
      messageId: "test-danger-msg",
      requestedModel: "gpt-5-6-thinking",
      resolvedModel: "gpt-5-5-mini",
      assistantModel: "gpt-5-5-mini",
      resolvedSource: "message.metadata.resolved_model_slug",
      assistantSource: "assistant.metadata.model_slug",
      transport: "debug"
    });
  },
  testConflict() {
    State.handleRouteEvidence({
      messageId: "test-conflict-msg",
      requestedModel: "gpt-5-6-thinking",
      resolvedModel: "gpt-5-6-thinking",
      assistantModel: "gpt-5-5-mini",
      resolvedSource: "message.metadata.resolved_model_slug",
      assistantSource: "assistant.metadata.model_slug",
      transport: "debug"
    });
  },
  debugTurn() {
    var t = TurnAggregator.activeTurn || State._last;
    if (!t) return null;
    return {
      turnId: t.turnId || null,
      conversationId: t.conversationId || null,
      messageId: t.messageId || null,
      transportsSeen: t.transportsSeen || {},
      requestedModel: t.requestedModel, requestedSource: t.requestedSource,
      resolvedModel: t.resolvedModel, resolvedSource: t.resolvedSource,
      assistantModel: t.assistantModel, assistantSource: t.assistantSource,
      serverModel: t.serverModel, serverSource: t.serverSource,
      evidenceEvents: (t.evidenceEvents || []).length,
      internalMessages: (t.internalMessages || []).length,
      lifecycle: t.lifecycle,
      finalizedAt: t.finalizedAt,
      verdict: t.verdict || t.primaryVerdict
    };
  },
  // ---- v1.5 PoW link debug + regression hooks (local-only, no network) ----
  debugPowLinks() {
    var series=buildPowSeries(CONFIG.POW_WINDOW);
    var pts=series.points;
    var by=function(st){return pts.filter(function(p){return p.linkState===st;}).length;};
    var bySrc=function(s){return pts.filter(function(p){return p.hydrationSource===s;}).length;};
    return {
      totalSamples:loadPowHistory().length,
      pending:(State._pendingPow||[]).length,
      linkedByActiveTurn:State.powLinkStats.linkedByActiveTurn,
      linkedByPendingClaim:State.powLinkStats.linkedByPendingClaim,
      legacyLinkedByTime:by("legacy"),
      unlinked:by("unlinked"),
      ambiguous:by("ambiguous"),
      hydratedFromLive:bySrc("live-turn"),
      hydratedFromHistory:bySrc("persisted-history"),
      hydratedFromSnapshot:bySrc("semantic-snapshot"),
      lastSamples:pts.slice(-5).map(function(p){return {powId:p.powId,observedAt:p.observedAt,turnId:p.turnId,linkState:p.linkState,phase:p.phase,verdict:p.verdict,hydratedFrom:p.hydrationSource};})
    };
  },
  _powTestReset() { State.resetSession(); TurnAggregator.reset(); },
  // TEST A: PoW arrives 500ms BEFORE turn -> pending PoW claimed by that turn.
  testPowBeforeTurn() {
    this._powTestReset();
    State.recordPow({rawHex:"1a2b3c",decimal:BigInt("0x1a2b3c").toString(10),observedAt:new Date(Date.now()-500).toISOString()});
    var pendingBefore=(State._pendingPow||[]).length;
    var turn=TurnAggregator.getOrCreateActiveTurn("pow-stream-a","POW-C-A");
    var first=loadPowHistory()[0]||null;
    return {pendingBefore:pendingBefore,claimedPowId:turn.powId||null,sampleTurnId:first?first.turnId:null,sampleLinkState:first?first.linkState:null,linkedByPendingClaim:State.powLinkStats.linkedByPendingClaim,pass:Boolean(turn.powId)&&Boolean(first)&&first.turnId===turn.turnId&&first.linkState==="linked"};
  },
  // TEST B: Turn exists first, then PoW arrives -> immediate association.
  testPowAfterTurn() {
    this._powTestReset();
    var turn=TurnAggregator.getOrCreateActiveTurn("pow-stream-b","POW-C-B");
    State.recordPow({rawHex:"abcdef",decimal:BigInt("0xabcdef").toString(10),observedAt:nowIso()});
    var first=loadPowHistory()[0]||null;
    return {turnPowId:turn.powId||null,sampleTurnId:first?first.turnId:null,linkedByActiveTurn:State.powLinkStats.linkedByActiveTurn,pass:Boolean(turn.powId)&&Boolean(first)&&first.turnId===turn.turnId};
  },
  // TEST C: PoW older than TTL, then unrelated turn begins -> PoW stays unlinked.
  testStalePow() {
    this._powTestReset();
    State.recordPow({rawHex:"777777",decimal:BigInt("0x777777").toString(10),observedAt:new Date(Date.now()-CONFIG.PENDING_POW_TTL_MS-2000).toISOString()});
    var turn=TurnAggregator.getOrCreateActiveTurn("pow-stream-c","POW-C-C");
    var first=loadPowHistory()[0]||null;
    var point=(buildPowSeries(CONFIG.POW_WINDOW).points.filter(function(p){return p.powId===(first&&first.powId);})[0])||null;
    return {claimedPowId:turn.powId||null,pending:(State._pendingPow||[]).length,canonicalPhase:point?point.phase:null,pass:!turn.powId&&(State._pendingPow||[]).length===0};
  },
  // TEST D: two PoW samples share the same decimal -> no identity collision.
  testRepeatedDecimal() {
    this._powTestReset();
    State.recordPow({rawHex:"1000",decimal:"4096",observedAt:new Date(Date.now()-1000).toISOString()});
    var id1=(loadPowHistory()[0]||{}).powId||null;
    State.recordPow({rawHex:"1000",decimal:"4096",observedAt:new Date(Date.now()-400).toISOString()});
    var id2=(loadPowHistory()[0]||{}).powId||null;
    var turn=TurnAggregator.getOrCreateActiveTurn("pow-stream-d","POW-C-D");
    var claimed=loadPowHistory().filter(function(s){return s.turnId===turn.turnId;});
    return {powId1:id1,powId2:id2,distinctIds:Boolean(id1)&&Boolean(id2)&&id1!==id2,claimedCount:claimed.length,pass:Boolean(id1)&&Boolean(id2)&&id1!==id2&&claimed.length===1};
  },
  _powReloadFixture(sample,historyEntries){
    State.resetSession();TurnAggregator.reset();
    try{
      this._powReloadSaved={pow:localStorage.getItem(CONFIG.STORAGE_POW_KEY),hist:localStorage.getItem(CONFIG.STORAGE_HISTORY_KEY)};
    }catch(e){this._powReloadSaved=null;}
    try{localStorage.setItem(CONFIG.STORAGE_POW_KEY,JSON.stringify(sample?[sample]:[]));}catch(e){}
    try{localStorage.setItem(CONFIG.STORAGE_HISTORY_KEY,JSON.stringify(historyEntries||[]));}catch(e){}
  },
  _powReloadRestore(){
    try{
      if(!this._powReloadSaved)return;
      if(this._powReloadSaved.pow===null)localStorage.removeItem(CONFIG.STORAGE_POW_KEY);else localStorage.setItem(CONFIG.STORAGE_POW_KEY,this._powReloadSaved.pow);
      if(this._powReloadSaved.hist===null)localStorage.removeItem(CONFIG.STORAGE_HISTORY_KEY);else localStorage.setItem(CONFIG.STORAGE_HISTORY_KEY,this._powReloadSaved.hist);
      this._powReloadSaved=null;
    }catch(e){}
  },
  _powReloadPoint(powId){
    var pts=buildPowSeries(CONFIG.POW_WINDOW).points;
    for(var i=0;i<pts.length;i++){if(pts[i].powId===powId)return pts[i];}
    return null;
  },
  // TEST 11: NORMAL link survives reload via persisted history.
  testReloadNormal(){
    this._powReloadFixture({powId:"P1",turnId:"T1",linkState:"linked",observedAt:nowIso(),rawHex:"1000",decimal:"4096",networkLabel:"fixture"},
      [{turnId:"T1",captureId:"T1",timestamp:Date.now(),verdict:"NORMAL",requestedModel:"gpt-5-6-thinking",resolvedModel:"gpt-5-6-thinking",serverModel:"gpt-5-6-thinking",assistantModel:"gpt-5-6-thinking"}]);
    var p=this._powReloadPoint("P1");
    var out={found:Boolean(p),turnId:p?p.turnId:null,linkState:p?p.linkState:null,phase:p?p.phase:null,hydratedFrom:p?p.hydrationSource:null,pass:Boolean(p)&&p.linkState==="linked"&&p.phase==="normal"};
    this._powReloadRestore();
    return out;
  },
  // TEST 12: mismatch link stays RED after reload.
  testReloadMismatch(){
    this._powReloadFixture({powId:"P2",turnId:"T2",linkState:"linked",observedAt:nowIso(),rawHex:"2000",decimal:"8192",networkLabel:"fixture"},
      [{turnId:"T2",captureId:"T2",timestamp:Date.now(),verdict:"MODEL_MISMATCH",requestedModel:"gpt-5-6-thinking",assistantModel:"gpt-5-5-mini"}]);
    var p=this._powReloadPoint("P2");
    var out={found:Boolean(p),phase:p?p.phase:null,hydratedFrom:p?p.hydrationSource:null,pass:Boolean(p)&&p.linkState==="linked"&&(p.phase==="mismatch"||p.phase==="mismatch-conflict")};
    this._powReloadRestore();
    return out;
  },
  // TEST 13: conflict link stays PURPLE after reload.
  testReloadConflict(){
    this._powReloadFixture({powId:"P3",turnId:"T3",linkState:"linked",observedAt:nowIso(),rawHex:"3000",decimal:"12288",networkLabel:"fixture"},
      [{turnId:"T3",captureId:"T3",timestamp:Date.now(),verdict:"EVIDENCE_CONFLICT",requestedModel:"gpt-5-6-thinking",resolvedModel:"gpt-5-6-thinking",assistantModel:"gpt-5-5-mini"}]);
    var p=this._powReloadPoint("P3");
    var out={found:Boolean(p),phase:p?p.phase:null,hydratedFrom:p?p.hydrationSource:null,pass:Boolean(p)&&p.linkState==="linked"&&p.phase==="conflict"};
    this._powReloadRestore();
    return out;
  },
  // TEST 14: genuinely unlinked sample stays GRAY after reload.
  testReloadUnlinked(){
    this._powReloadFixture({powId:"P4",turnId:null,linkState:"unlinked",observedAt:nowIso(),rawHex:"4000",decimal:"16384",networkLabel:"fixture"},[]);
    var p=this._powReloadPoint("P4");
    var out={found:Boolean(p),phase:p?p.phase:null,hydratedFrom:p?p.hydrationSource:null,pass:Boolean(p)&&p.phase==="unlinked"};
    this._powReloadRestore();
    return out;
  },
  // Extra: semantic snapshot alone is enough (no history entry).
  testReloadSnapshot(){
    this._powReloadFixture({powId:"P5",turnId:"T5",linkState:"linked",observedAt:nowIso(),rawHex:"5000",decimal:"20480",networkLabel:"fixture",semanticSnapshot:{verdict:"NORMAL",findings:["CORE_MATCH"],requestedModel:"gpt-5-6-thinking",assistantModel:"gpt-5-6-thinking",finalizedAt:Date.now()}},[]);
    var p=this._powReloadPoint("P5");
    var out={found:Boolean(p),phase:p?p.phase:null,hydratedFrom:p?p.hydrationSource:null,pass:Boolean(p)&&p.linkState==="linked"&&p.phase==="normal"&&p.hydrationSource==="semantic-snapshot"};
    this._powReloadRestore();
    return out;
  },
  // TEST 5: finalization persists a compact semanticSnapshot onto the linked sample.
  testSnapshotOnFinalize(){
    var savedPow=null,savedHist=null;
    try{savedPow=localStorage.getItem(CONFIG.STORAGE_POW_KEY);savedHist=localStorage.getItem(CONFIG.STORAGE_HISTORY_KEY);}catch(e){}
    this._powTestReset();
    var st=loadSettings();if(!st.powEnabled){st.powEnabled=true;saveSettings(st);}
    State.recordPow({rawHex:"6000",decimal:"24576",observedAt:nowIso()});
    var turn=TurnAggregator.getOrCreateActiveTurn("s-snap","C-SNAP");
    turn.requestedModel="gpt-5-6-thinking";turn.assistantModel="gpt-5-6-thinking";
    TurnAggregator.markStreamDone("s-snap");
    if(TurnAggregator.graceTimer){clearTimeout(TurnAggregator.graceTimer);TurnAggregator.graceTimer=null;}
    TurnAggregator.finalizeActiveTurn();
    var sample=null;var all=loadPowHistory();
    for(var i=0;i<all.length;i++){if(all[i]&&all[i].powId===turn.powId){sample=all[i];break;}}
    var snap=sample&&sample.semanticSnapshot?sample.semanticSnapshot:null;
    var out={powId:turn.powId||null,hasSnapshot:Boolean(snap),snapshotVerdict:snap?snap.verdict:null,pass:Boolean(snap)&&snap.verdict==="NORMAL"};
    try{ if(savedPow===null)localStorage.removeItem(CONFIG.STORAGE_POW_KEY);else localStorage.setItem(CONFIG.STORAGE_POW_KEY,savedPow); if(savedHist===null)localStorage.removeItem(CONFIG.STORAGE_HISTORY_KEY);else localStorage.setItem(CONFIG.STORAGE_HISTORY_KEY,savedHist);}catch(e){}
    return out;
  },
  // TEST E/F: mini tail equals canonical full tail.
  testMiniTail(count) {
    var series=buildPowSeries(CONFIG.POW_WINDOW);
    var tail=series.points.slice(-count);
    var shape=function(a){return a.map(function(p){return {id:p.powId,w:p.work,ph:p.phase};});};
    return {requested:count,length:tail.length,powIds:tail.map(function(p){return p.powId;}),works:tail.map(function(p){return p.work;}),phases:tail.map(function(p){return p.phase;}),equalsCanonicalTail:JSON.stringify(shape(tail))===JSON.stringify(shape(series.points.slice(-count)))};
  },
  testMiniTail9(){return this.testMiniTail(9);},
  testMiniTail18(){return this.testMiniTail(18);},
  // TEST G: pulse bends through actual corners, never a straight chord.
  testSharpCornerPulse() {
    try{FloatingMonitor.ensure();FloatingMonitor.maybeStartAnim();FloatingMonitor.drawWave();}catch(e){}
    var d=FloatingMonitor._lastPathD||"";
    var svgEl=(FloatingMonitor.root&&FloatingMonitor.root.querySelector)?FloatingMonitor.root.querySelector('.wave-svg'):null;
    var overlayEl=svgEl&&svgEl.querySelector?svgEl.querySelector('#pulse-main'):null;
    var overlayD=overlayEl?overlayEl.getAttribute('d'):null;
    var corners=(d.match(/L/g)||[]).length;
    return {available:Boolean(d),corners:corners,overlayPresent:Boolean(overlayEl),pulseUsesExactPath:Boolean(overlayD)&&overlayD===d,noChord:Boolean(overlayD)&&(overlayD.match(/L/g)||[]).length>=2,pass:corners>=2&&Boolean(overlayD)&&overlayD===d};
  },
  // TEST H: loop wrap has a smooth fade envelope, no hard break.
  testLoopWrap() {
    var L=1000;
    var e0=FloatingMonitor._pulseEnvelope(0,L);
    var emid=FloatingMonitor._pulseEnvelope(L*0.5,L);
    var eEnd=FloatingMonitor._pulseEnvelope(L*0.99,L);
    var maxStep=0;
    for(var i=1;i<=1000;i++){var g=Math.abs(FloatingMonitor._pulseEnvelope(L*i/1000,L)-FloatingMonitor._pulseEnvelope(L*(i-1)/1000,L));if(g>maxStep)maxStep=g;}
    return {envelopeStart:e0,envelopeMid:emid,envelopeEnd:eEnd,maxStep:maxStep,pass:e0===0&&emid===1&&eEnd<1&&maxStep<0.2};
  },
  // v1.5 CASE A: Fetch + WS same messageId => ONE turn, no duplication, 4/4 evidence
  testRegCaseA() {
    State.resetSession();
    TurnAggregator.reset();
    var turn = TurnAggregator.getOrCreateActiveTurn("stream-a", "C-A");
    TurnAggregator.applyRequestCapture(turn, {
      captureId: "cap-a", requestedModel: "gpt-5-6-thinking", requestedSource: "conversation_request.model",
      conversationId: "C-A", promptPreview: "example prompt", network: currentNetworkSnapshot()
    });
    TurnAggregator.applyEvidence(turn, {
      messageId: "M-A", resolvedModel: "gpt-5-6-thinking", resolvedSource: "message.metadata.resolved_model_slug",
      assistantModel: "gpt-5-6-thinking", assistantSource: "assistant.metadata.model_slug",
      serverModel: "gpt-5-6-thinking", serverSource: "server_ste_metadata.model_slug"
    }, "fetch");
    TurnAggregator.applyEvidence(turn, {
      conversationId: "C-A", messageId: "M-A",
      resolvedModel: "gpt-5-6-thinking", assistantModel: "gpt-5-6-thinking"
    }, "websocket");
    // duplicate WS
    TurnAggregator.applyEvidence(turn, {
      conversationId: "C-A", messageId: "M-A",
      resolvedModel: "gpt-5-6-thinking", assistantModel: "gpt-5-6-thinking"
    }, "websocket");
    TurnAggregator.markStreamDone("stream-a");
    // force finalize
    if (TurnAggregator.graceTimer) { clearTimeout(TurnAggregator.graceTimer); TurnAggregator.graceTimer = null; }
    TurnAggregator.finalizeActiveTurn();
    var entry = State._last;
    var result = {
      turnId: entry ? entry.turnId : null,
      requestedModel: entry ? entry.requestedModel : null,
      resolvedModel: entry ? entry.resolvedModel : null,
      assistantModel: entry ? entry.assistantModel : null,
      serverModel: entry ? entry.serverModel : null,
      transportsSeen: entry ? entry.transportsSeen : {},
      imCount: Array.isArray(entry && entry.internalMessages) ? entry.internalMessages.length : 0,
      verdict: entry ? entry.verdict : null,
      historyLen: loadHistory().length
    };
    return result;
  },
  // v1.5 CASE B: Genuine model disagreement preserved (5.6 req → 5.4 answer)
  testRegCaseB() {
    State.resetSession();
    TurnAggregator.reset();
    var turn = TurnAggregator.getOrCreateActiveTurn("stream-b", "C-B");
    TurnAggregator.applyRequestCapture(turn, {
      captureId: "cap-b", requestedModel: "gpt-5-6-thinking", requestedSource: "conversation_request.model",
      conversationId: "C-B", promptPreview: "mismatch test", network: currentNetworkSnapshot()
    });
    TurnAggregator.applyEvidence(turn, {
      messageId: "M-B", serverModel: "gpt-5-6-thinking", serverSource: "server_ste_metadata.model_slug"
    }, "fetch");
    TurnAggregator.applyEvidence(turn, {
      messageId: "M-B", resolvedModel: "gpt-5-4-auto-thinking", resolvedSource: "message.metadata.resolved_model_slug",
      assistantModel: "gpt-5-4-thinking", assistantSource: "assistant.metadata.model_slug"
    }, "websocket");
    TurnAggregator.markStreamDone("stream-b");
    if (TurnAggregator.graceTimer) { clearTimeout(TurnAggregator.graceTimer); TurnAggregator.graceTimer = null; }
    TurnAggregator.finalizeActiveTurn();
    var entry = State._last;
    return {
      turnId: entry ? entry.turnId : null,
      requestedModel: entry ? entry.requestedModel : null,
      resolvedModel: entry ? entry.resolvedModel : null,
      assistantModel: entry ? entry.assistantModel : null,
      serverModel: entry ? entry.serverModel : null,
      verdict: entry ? entry.verdict : null,
      historyLen: loadHistory().length
    };
  },
  _internals: { Network, State, TurnAggregator, SSEParser: createSSEParser, FloatingMonitor, Dashboard, buildPowSeries, updatePowSample, powSemanticPhase, powSemanticColor, mixCssColor }
};

window.__chatgptGuardPro = window.__chatgptModelDowngradeMonitor; // v1.x compatibility

/* ------------------------------------------------------------------ */
/* BOOT                                                                 */
/* ------------------------------------------------------------------ */

(function boot() {
  try {
    if (window[Network.installSentinel] || window.__chatgpt_model_downgrade_monitor_installed__) return;
    if (!/chatgpt\.com|chat\.openai\.com/i.test(window.location.hostname)) return;
    Network.install();
    ensureUiAfterDom();
    safeSetInterval(() => {
      try {
        Network.prunePendingCaptures();
        if (!Network.fetchInstalled) Network.installFetchHook();
        if (!Network.wsInstalled) Network.installWebSocketHook();
        if (!document.getElementById("chatgpt-model-downgrade-monitor-badge")) Badge.setStatus(State._last ? State._last.verdict : null, State._last ? (State._last.resolvedModel || State._last.assistantModel) : null);
      } catch { /* fail open */ }
    }, 1000);
  } catch (err) {
    try { console.warn("[ChatGPT Model Downgrade Monitor] init error (fail-open):", err); } catch {}
  }
})();
