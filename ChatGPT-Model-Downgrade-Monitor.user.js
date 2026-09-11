// ==UserScript==
// @name         ChatGPT Model Downgrade Monitor | 模型鉴定姬
// @name:zh-CN   ChatGPT Model Downgrade Monitor | 模型鉴定姬
// @name:en      ChatGPT Model Downgrade Monitor
// @namespace    chatgpt-model-downgrade-monitor
// @version      1.5.0-rc.1
// @description  Detect ChatGPT silent model downgrades, hidden model routing, mini fallbacks, and requested-vs-response model mismatches. Designed for Tampermonkey users on Firefox and Chromium-family browsers.
// @description:zh-CN  检测 ChatGPT 请求模型、服务器路由与最终应答模型是否一致，帮助发现静默模型切换、mini fallback 与路由冲突；重点面向 Firefox 及其他可安装 Tampermonkey 的桌面浏览器。
// @description:en  Monitor requested, routed, resolved and assistant-reported ChatGPT models to surface silent model switches and routing conflicts, with Firefox/Tampermonkey compatibility as a primary goal.
// @author       DAIORANGE
// @homepageURL  https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor
// @supportURL   https://github.com/DAIORANGE/chatgpt-model-downgrade-monitor/issues
// @downloadURL  https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js
// @updateURL    https://raw.githubusercontent.com/DAIORANGE/chatgpt-model-downgrade-monitor/main/ChatGPT-Model-Downgrade-Monitor.user.js
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
    turn.lifecycle = LIFECYCLE.FINALIZED;
    turn.finalizedAt = Date.now();
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
    ["为什么重要","它和“调用模型”是两项核心证据。两者不同，就可以客观地说“请求与应答模型不一致”，无需先猜是不是降级。"]]},
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
    ["核心证据 2/2","核心证据只有两项：调用模型、应答模型。2/2 表示两项都抓到了。"],
    ["模型证据 4/4","完整模型证据最多四项：调用模型、服务器确认模型、服务器路由、应答模型。4/4 表示四项都抓到了。"],
    ["为什么这样量化","这样能把“信息不足”变成可检查的事实：到底缺的是哪一项，而不是给一个模糊的置信度百分比。"]]},
  rtt:{title:"浏览器网络延迟 · RTT",lead:"浏览器根据近期实际联网情况估算的网络往返延迟，单位是毫秒（ms）。",sections:[
    ["代理环境下包含哪一段","如果你使用 VPN、Clash 或其他代理，它反映的是浏览器实际联网环境的整体效果，可能包含你的电脑 → 本地网络 → 代理链路 → 远端网络 → 网站服务器。"],
    ["它不是什么","它不是“代理节点 → OpenAI”的单独 Ping，也不是专门针对当前这一条 ChatGPT 请求测出的精确延迟。浏览器可能根据近期多个连接做估算。"],
    ["怎么读","通常数值越小代表近期整体网络往返更快，但不应拿它直接判断模型是否降级。"]]},
  downlink:{title:"浏览器下行估算",lead:"浏览器根据近期连接估算的有效下载能力，通常以 Mbps 表示。",sections:[
    ["它包含什么","使用代理时，这个数字体现的是浏览器当前整条联网环境的效果，不等同于你的宽带标称速度，也不等同于某个代理节点的单独限速。"],
    ["为什么记录","主要用于给网络环境留一个旁证，便于你比较不同节点或不同时间段；它不是模型路由判定指标。"]]},
  status:{title:"状态判定是怎么来的",lead:"模型鉴定姬只根据已捕获字段之间是否一致来显示状态，不用模糊的“感觉像降级”。",sections:[
    ["模型一致","调用模型与应答模型相同，并且已捕获的服务器侧模型字段没有与它们冲突。"],
    ["请求与应答模型不一致","两项核心证据 2/2 都已捕获，而且调用模型 ≠ 应答模型。这个提示只描述事实，不自动声称原因。"],
    ["路由证据冲突","服务器确认/服务器路由/应答模型之间出现不同模型值。界面会列出具体哪个字段不同。"],
    ["信息未完整捕获","核心证据没有达到 2/2，因此当前信息不足以直接比较“请求”和“最终回答”。"]]}
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
  const metrics=[`核心证据 ${e.coreCaptured}/2`,`模型证据 ${e.captured.length}/4`,`${e.unique.length||0} 种模型值`];
  if(entry.verdict===VERDICT.EVIDENCE_CONFLICT){
    const groups=e.unique.map(v=>`${friendlyModelName(v)}：${e.captured.filter(x=>x.value===v).map(x=>x.label).join("、")}`);
    return{title:"路由证据冲突",tone:"conflict",basis:`触发条件：${e.captured.length} 项已捕获模型证据中出现 ${e.unique.length} 种不同模型值。${groups.join("；")}。`,metrics};
  }
  if(entry.verdict===VERDICT.MODEL_MISMATCH||entry.verdict===VERDICT.DOWNGRADE_SUSPECTED||(req&&ans&&req!==ans)){
    return{title:"请求与应答模型不一致",tone:"danger",basis:`触发条件：两项核心证据已捕获（2/2），调用模型 ${friendlyModelName(req)} ≠ 应答模型 ${friendlyModelName(ans)}。这里先报告可观察事实，不自动猜测发生变化的原因。`,metrics};
  }
  if(entry.verdict===VERDICT.ROUTE_NOTICE){
    const changed=e.captured.filter(x=>x.key!=="requested"&&req&&x.value!==req).map(x=>`${x.label}=${friendlyModelName(x.value)}`);
    return{title:"模型字段发生变化",tone:"warn",basis:`触发条件：${changed.join("；")||"服务器侧模型字段与调用模型不同"}。应答模型${ans?"已捕获":"尚未捕获"}，因此这里只报告字段变化。`,metrics};
  }
  if(req&&ans&&req===ans&&e.unique.length<=1){
    return{title:"模型一致",tone:"normal",basis:`触发条件：调用模型 = 应答模型 = ${friendlyModelName(req)}；已捕获的 ${e.captured.length}/4 项模型证据中只出现 1 种模型值。`,metrics};
  }
  const missing=e.items.filter(x=>!x.value).map(x=>x.label);
  return{title:"信息未完整捕获",tone:"unknown",basis:`触发条件：核心证据只有 ${e.coreCaptured}/2。当前缺少：${missing.join("、")||"未知字段"}。`,metrics};
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
      .bar{position:relative;display:flex;align-items:stretch;height:48px;min-width:230px;max-width:280px;padding:0;border-radius:12px;cursor:grab;user-select:none;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--border, rgba(226,205,239,.20));backdrop-filter:blur(15px) saturate(135%);box-shadow:0 9px 28px rgba(10,8,16,.24);transition:height .28s cubic-bezier(.34,1.56,.64,1),max-width .28s cubic-bezier(.34,1.56,.64,1),border-color .35s ease;overflow:hidden}
      .bar:hover{height:62px;max-width:380px}
      .bar:active{cursor:grabbing}
      .bar-left{display:flex;align-items:center;gap:8px;padding:0 10px;min-width:0;flex-shrink:1}
      .bar-seal{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;flex-shrink:0;background:color-mix(in srgb,var(--accent) 20%,var(--surface2));color:var(--accent);font-size:12px;font-weight:850;transition:background-color .35s,color .35s}
      .bar-model{min-width:0}
      .bar-model-name{font-size:15px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .35s}
      .bar-model-status{font-size:12px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bar-model-status.collecting{opacity:.5;animation:bar-pulse-text 1.8s ease-in-out infinite}
      @keyframes bar-pulse-text{0%,100%{opacity:.5}50%{opacity:1}}
      .bar-model-status.hint{font-size:12px;color:var(--muted)}
      .bar-right{display:flex;align-items:center;padding:0 10px 0 6px;flex-shrink:0;cursor:pointer}
      .bar-right:hover .wave-svg{filter:brightness(1.15)}
      .wave-svg{display:block;transition:filter .25s}
      .bar-wave-label{font-size:10px;color:var(--muted);text-align:center;display:none;line-height:1}
      .bar:hover .bar-wave-label{display:block}
      @media(prefers-reduced-motion:reduce){.bar:hover{height:48px;max-width:280px;transition:none}.bar-model-status.collecting{animation:none}}
    </style><div class="bar" title="拖动移动 · 点击打开模型鉴定姬 · 双击恢复位置"><div class="bar-left" data-region="main"><span class="bar-seal">鉴</span><div class="bar-model"><div class="bar-model-name">模型鉴定姬</div><div class="bar-model-status hint"></div></div></div><div class="bar-right" data-region="pow" title="查看 PoW 分析"><svg class="wave-svg" width="90" height="44" viewBox="0 0 90 44"><polyline fill="none" stroke="var(--muted)" stroke-width="1.5" points="0,22 90,22"/></svg><div class="bar-wave-label">PoW</div></div></div>`;
    try{document.documentElement.appendChild(this.host)}catch{return this.root}
    this.restorePosition();this.applyTheme();
    var bar=this.root.querySelector('.bar');
    var self=this;
    if(bar){
      this.installDrag(bar);
      bar.querySelector('.bar-left').addEventListener('click',function(e){e.stopPropagation();if(self._dragged){self._dragged=false;return}AudioFeedback.unlockOnGesture();Dashboard.toggle()});
      bar.querySelector('.bar-right').addEventListener('click',function(e){e.stopPropagation();if(self._dragged){self._dragged=false;return}Dashboard.show();Dashboard.activeTab='network';Dashboard.powExpanded=true;Dashboard.render()});
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
    this._pulseProgress=0;
    this._pulsePathLen=1;
    var lastT=0;
    function frame(ts){
      if(!lastT)lastT=ts;
      var dt=Math.min(50,ts-lastT);lastT=ts;
      var speed=self._pulsePathLen/(self._expanded?7:11)*dt/1000;
      self._pulseProgress+=speed;
      if(self._pulseProgress>=self._pulsePathLen)self._pulseProgress=0;
      self._renderPulseOnly();
      self.animFrame=requestAnimationFrame(frame);
    }
    this.animFrame=requestAnimationFrame(frame);
  },

  stopAnim(){
    if(this.animFrame){cancelAnimationFrame(this.animFrame);this.animFrame=null}
    this._pulseProgress=0;
  },

  _expanded:false,
  _lastGeomTS:0,

  getPoWPoints(count){
    count=count||9;
    var pow=loadPowHistory().slice(0,count);
    var finalized=TurnAggregator.finalized;
    var turnById={};
    for(var fi=finalized.length-1;fi>=0;fi--){var ft=finalized[fi];if(ft.turnId)turnById[ft.turnId]=ft;}
    var results=[];
    for(var i=pow.length-1;i>=0;i--){
      var p=pow[i];
      var work=estimatePowWork(p.rawHex);if(!Number.isFinite(work))continue;
      var associated=null;
      if(p.turnId&&turnById[p.turnId])associated=turnById[p.turnId];
      else if(p.turnId){for(var j=finalized.length-1;j>=0;j--){if(finalized[j].turnId===p.turnId){associated=finalized[j];break;}}}
      if(!associated){
        for(var k=finalized.length-1;k>=0;k--){
          var fk=finalized[k];
          if(fk.powDecimal===p.decimal&&p.decimal&&p.decimal!=='undefined'&&p.decimal!=='null'&&Number(p.decimal)>0){
            if(!associated||(fk.timestamp&&Math.abs(fk.timestamp-Date.now())<30000))associated=fk;
            break;
          }
        }
      }
      var v=associated?associated.primaryVerdict:null;
      var hasConflict=associated&&associated.findings&&associated.findings.indexOf('ROUTE_EVIDENCE_CONFLICT')>=0;
      results.push({work:work,rawDecimal:Number(p.decimal),raw:p.rawHex,t:p.observedAt?new Date(p.observedAt).getTime():0,verdict:v,hasConflict:hasConflict,turnId:p.turnId||null,assistantModel:associated?associated.assistantModel:null});
      if(results.length>=count)break;
    }
    results.reverse();
    return results;
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
    var points=this.getPoWPoints(count);
    this._lastGeomTS=Date.now();
    if(points.length<2){
      svg.setAttribute('width',_expanded?'220':'90');
      svg.setAttribute('viewBox','0 0 ' + (_expanded?'220':'90') + ' 44');
      svg.innerHTML='<polyline fill="none" stroke="var(--muted)" stroke-width="1.5" points="0,22 ' + (_expanded?'220':'90') + ',22"/>';
      return;
    }
    var n=points.length;
    var w=_expanded?220:90;var h=44;
    var padX=5,l=padX,r=w-padX,plotW=r-l,plotH=h-10;
    var works=points.map(function(p){return p.work;});
    var maxW=Math.max.apply(null,works),minW=Math.min.apply(null,works);
    var span=Math.max(0.001,maxW-minW);
    function xFn(i){return l+(n===1?plotW/2:i/(n-1))*plotW;}
    function yFn(v){return 5+(1-(v-minW)/span)*plotH;}

    var t=activeTheme();
    function nodeColor(v2,hasC){return v2===VERDICT.NORMAL?t.normal:v2===VERDICT.MODEL_MISMATCH||v2===VERDICT.DOWNGRADE_SUSPECTED?t.danger:v2===VERDICT.EVIDENCE_CONFLICT||hasC?t.conflict:v2===VERDICT.ROUTE_NOTICE||v2===VERDICT.UNKNOWN?t.warn:t.muted;}

    var segColors=[];
    for(var i=0;i<n-1;i++){
      var cA=nodeColor(points[i].verdict,points[i].hasConflict);
      var cB=nodeColor(points[i+1].verdict,points[i+1].hasConflict);
      var gradId='seg-grad-' + i;
      segColors.push({id:gradId,from:cA,to:cB});
    }

    var segments='';
    var defs='';
    for(var i=0;i<n-1;i++){
      var x1=xFn(i),y1=yFn(works[i]),x2=xFn(i+1),y2=yFn(works[i+1]);
      var sc=segColors[i];
      defs+='<linearGradient id="'+sc.id+'" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="'+sc.from+'" stop-opacity="0.85"/><stop offset="100%" stop-color="'+sc.to+'" stop-opacity="0.85"/></linearGradient>';
      segments+='<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="url(#'+sc.id+')" stroke-width="2" stroke-linecap="round"/>';
    }

    var nodes='';
    for(var i=0;i<n;i++){
      var xx=xFn(i),yy=yFn(works[i]);
      var v=points[i].verdict;
      var hasC=points[i].hasConflict;
      var fill=v===VERDICT.NORMAL?t.normal:v===VERDICT.MODEL_MISMATCH||v===VERDICT.DOWNGRADE_SUSPECTED?t.danger:v===VERDICT.EVIDENCE_CONFLICT||hasC?t.conflict:v===VERDICT.ROUTE_NOTICE||v===VERDICT.UNKNOWN?t.warn:t.muted;
      var r2=v&&(v===VERDICT.MODEL_MISMATCH||v===VERDICT.DOWNGRADE_SUSPECTED)?4:2.8;
      var stroke2=v&&(v===VERDICT.MODEL_MISMATCH||v===VERDICT.DOWNGRADE_SUSPECTED)&&hasC?' stroke="'+t.conflict+'" stroke-width="1.5"':'';
      nodes+='<circle cx="'+xx+'" cy="'+yy+'" r="'+r2+'" fill="'+fill+'" opacity=".85"'+stroke2+'/>';
    }

    var pathD='M' + xFn(0) + ',' + yFn(works[0]);
    for(var i=1;i<n;i++){pathD+=' L'+xFn(i)+','+yFn(works[i]);}

    svg.setAttribute('width',String(w));
    svg.setAttribute('viewBox','0 0 '+w+' '+h);
    svg.innerHTML='<defs>'+defs+'</defs>' + segments + nodes + '<path id="wave-path" d="'+pathD+'" fill="none" stroke="transparent" stroke-width="4"/>';
    this._lastPathD=pathD;
    this._cachedSegCount=n;
    this._cachedSegColors=[];
    for(var si=0;si<segColors.length;si++)this._cachedSegColors.push(segColors[si].to);
    if(segColors.length>0)this._cachedSegColors.unshift(segColors[0].from);
    this._pulsePathLen=this._getPulsePathLen(svg);
    // Precompute cumulative per-segment path lengths for accurate pulse→segment mapping
    var pathEl2=svg.querySelector('#wave-path');
    this._segCumulativeLen=[];
    if(pathEl2&&n>=2){
      var totalLen=this._pulsePathLen||pathEl2.getTotalLength();
      var cumSum=0;
      for(var si=0;si<n-1;si++){
        var x1=xFn(si),y1=yFn(works[si]),x2=xFn(si+1),y2=yFn(works[si+1]);
        var dx=x2-x1,dy=y2-y1;
        var segLenApprox=Math.sqrt(dx*dx+dy*dy);
        cumSum+=segLenApprox;
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
    var pulseGroup=svg.querySelector('.pulse-group');
    if(!pulseGroup){
      pulseGroup=document.createElementNS('http://www.w3.org/2000/svg','g');
      pulseGroup.setAttribute('class','pulse-group');
      svg.appendChild(pulseGroup);
    }
    var pathEl=svg.querySelector('#wave-path');
    if(!pathEl)return;
    try{
      if(!this._pulsePathLen||this._pulsePathLen<1)this._pulsePathLen=pathEl.getTotalLength();
    }catch(e){return;}
    var pathLen=this._pulsePathLen;
    if(pathLen<1)return;
    if(!this._pulseProgress)this._pulseProgress=0;
    var prog=this._pulseProgress%pathLen;
    var pt=pathEl.getPointAtLength(prog);
    var trailLen=pathLen*0.06;
    var r=this._expanded?12:9;

    var n=this._cachedSegCount||0;
    var segIndex=0;
    if(n>=2){
      var frac=prog/pathLen;
      var cumLen=this._segCumulativeLen;
      if(cumLen&&cumLen.length>0){
        for(var i=0;i<cumLen.length;i++){if(frac<=cumLen[i]){segIndex=i;break;}segIndex=i+1;}
        if(segIndex>=cumLen.length)segIndex=cumLen.length-1;
      } else {
        segIndex=Math.min(Math.floor(frac*(n-1)),n-2);
      }
    }
    var clr=this._cachedSegColors&&this._cachedSegColors.length>segIndex?this._cachedSegColors[segIndex]:null;
    if(!clr||clr==='var(--muted)')clr='var(--accent)';

    var pluseHTML='';
    for(var tr=0;tr<3;tr++){
      var off=prog-(tr+1)*trailLen*0.7;
      if(off<0)off+=pathLen;
      var tp=pathEl.getPointAtLength(off);
      var tr2=3.5-tr*0.8;
      pluseHTML+='<circle cx="'+tp.x+'" cy="'+tp.y+'" r="'+tr2+'" fill="'+clr+'" opacity="'+(0.35-tr*0.1)+'"/>';
    }
    pluseHTML+='<circle cx="'+pt.x+'" cy="'+pt.y+'" r="'+r+'" fill="'+clr+'" opacity="0.85"/>';
    pluseHTML+='<circle cx="'+pt.x+'" cy="'+pt.y+'" r="'+(r+6)+'" fill="none" stroke="'+clr+'" stroke-width="2" opacity="0.45"/>';
    pulseGroup.innerHTML=pluseHTML;
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
      try{target.setPointerCapture(e.pointerId)}catch{}
      function mv(ev){
        var dx=ev.clientX-sx,dy=ev.clientY-sy;
        if(!moved&&Math.hypot(dx,dy)<4)return;moved=true;
        var ml=Math.max(4,window.innerWidth-r.width-4),mt=Math.max(4,window.innerHeight-r.height-4);
        self.host.style.right='auto';
        self.host.style.left=Math.max(4,Math.min(r.left+dx,ml))+'px';
        self.host.style.top=Math.max(4,Math.min(r.top+dy,mt))+'px';
      }
      function up(ev){
        target.removeEventListener('pointermove',mv);target.removeEventListener('pointerup',up);target.removeEventListener('pointercancel',up);
        try{target.releasePointerCapture(ev.pointerId)}catch{}
        if(moved){self._dragged=true;self.savePosition();setTimeout(function(){self._dragged=false},120)}
      }
      target.addEventListener('pointermove',mv);target.addEventListener('pointerup',up);target.addEventListener('pointercancel',up);
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
      button,select,input{font:inherit}.iconbtn,.tab,.btn{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:10px;padding:7px 10px;font-size:11px;cursor:pointer}.iconbtn:hover,.tab:hover,.btn:hover{filter:brightness(1.05)}.tabs{position:sticky;top:59px;z-index:4;display:flex;gap:7px;padding:10px 15px;background:color-mix(in srgb,var(--panel) 95%,transparent);border-bottom:1px solid var(--border)}.tab.active{background:color-mix(in srgb,var(--accent) 18%,var(--surface));border-color:color-mix(in srgb,var(--accent) 45%,var(--border));color:var(--accent)}
      .content{padding:16px 17px 20px}.pane{display:none}.pane.active{display:block}.section-title{font-size:12px;font-weight:800;letter-spacing:.02em;margin:14px 2px 8px}.kicker{font-size:10px;color:var(--muted);margin-bottom:8px}.card{border:1px solid var(--border);background:var(--surface);border-radius:17px;padding:13px;margin-bottom:11px;box-shadow:0 7px 22px color-mix(in srgb,var(--shadow) 28%,transparent)}.hero{padding:15px 16px}.card.status-normal{border-left:4px solid var(--normal)}.card.status-danger{border-left:4px solid var(--danger)}.card.status-conflict{border-left:4px solid var(--conflict)}.card.status-warn{border-left:4px solid var(--warn)}.card.status-unknown{border-left:4px solid var(--muted)}
      .verdictline{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}.verdictwrap{display:flex;align-items:center;gap:6px;min-width:0}.verdict{font-size:12px;font-weight:850;padding:4px 9px;border-radius:999px;background:var(--surface2)}.tone-normal{color:var(--normal)}.tone-danger{color:var(--danger)}.tone-conflict{color:var(--conflict)}.tone-warn{color:var(--warn)}.tone-unknown{color:var(--muted)}.time{color:var(--muted);font-size:10px}.basis{font-size:11px;line-height:1.55;color:var(--muted);padding:8px 10px;border-radius:11px;background:var(--surface2);margin-bottom:10px}.metrics{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.metric{font-size:9px;padding:3px 7px;border-radius:999px;background:color-mix(in srgb,var(--accent) 9%,var(--surface2));color:var(--muted);border:1px solid var(--border)}
      .dialogue{display:grid;gap:9px}.chatrow{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;align-items:start}.avatar{width:27px;height:27px;border-radius:10px;display:grid;place-items:center;font-size:10px;font-weight:850;border:1px solid var(--border);background:var(--surface2)}.bubble{padding:10px 12px;border-radius:14px;line-height:1.55;font-size:12px;border:1px solid color-mix(in srgb,var(--border) 75%,transparent)}.bubble.user{background:var(--user)}.bubble.assistant{background:var(--assistant)}.who{font-size:9px;color:var(--muted);margin-bottom:4px}.topic{font-weight:780;margin-bottom:3px}.preview{word-break:break-word}
      .models{display:grid;grid-template-columns:minmax(0,1fr) 56px minmax(0,1fr);gap:8px;align-items:center;margin:12px 0;padding:12px;border-radius:15px;background:var(--surface2);border:1px solid var(--border)}.modelbox{min-width:0}.modellabel{display:flex;align-items:center;gap:4px;color:var(--muted);font-size:10px}.modelbox b{display:block;margin-top:4px;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.modelbox code{display:block;color:var(--muted);font-size:9px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.arrow{text-align:center;color:var(--accent);font-size:22px;filter:drop-shadow(0 0 7px color-mix(in srgb,var(--accent) 35%,transparent))}.resultcheck{font-size:10px;margin-top:4px;color:var(--muted)}
      .info{appearance:none;border:0;background:transparent;color:var(--accent);padding:0 2px;cursor:pointer;font-size:11px;font-weight:900;text-decoration:none}.info:hover{transform:scale(1.12)}.network-chip{display:inline-flex;padding:3px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent2) 12%,var(--surface2));color:var(--accent2);font-size:10px;border:1px solid color-mix(in srgb,var(--accent2) 24%,transparent)}
      details{margin-top:10px;border-top:1px solid var(--border);padding-top:8px}summary{cursor:pointer;color:var(--accent);font-size:11px}.tech{font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);white-space:pre-wrap;word-break:break-all;margin-top:7px}.empty{color:var(--muted);font-size:12px;padding:16px 3px}.muted{color:var(--muted);font-size:10px;line-height:1.55}
      .statgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.stat{padding:10px;border-radius:13px;background:var(--surface2);text-align:center;border:1px solid var(--border)}.stat b{display:block;font-size:18px}.stat small{color:var(--muted);font-size:9px}.barrow{margin:9px 0}.barhead{display:flex;justify-content:space-between;font-size:11px}.bar{height:7px;background:var(--surface2);border-radius:999px;overflow:hidden;margin-top:4px}.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent2),var(--accent));border-radius:999px}.splitgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.minirow{font-size:11px;color:var(--muted);line-height:1.55}.minirow b{color:var(--text)}
      .field{display:grid;gap:5px;margin:10px 0}.field label{font-size:11px;color:var(--muted)}.field input[type=text],.field select,.select{border:1px solid var(--border);background:var(--surface2);color:var(--text);border-radius:10px;padding:8px 9px;outline:none}.setting-group{border:1px solid var(--border);background:var(--surface);border-radius:16px;padding:12px;margin-bottom:11px}.setting-group>h3{font-size:12px;margin:0 0 8px}.toggle{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 2px;border-bottom:1px solid var(--border);font-size:12px}.toggle:last-child{border-bottom:0}.subsetting{margin:5px 0 4px 17px;padding-left:10px;border-left:2px solid color-mix(in srgb,var(--accent) 35%,transparent)}.soundrow{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.range{width:100%;accent-color:var(--accent)}.theme-swatches{display:flex;gap:4px;margin-top:5px}.swatch{width:16px;height:8px;border-radius:999px;border:1px solid var(--border)}
      .pow-wrap{overflow-x:auto;padding-bottom:6px}.pow-svg{display:block;min-height:270px}.pow-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:8px 0}.pow-stat{padding:12px 8px;border-radius:11px;background:var(--surface2);text-align:center;border:1px solid var(--border)}.pow-stat b{display:block;font-size:22px;font-weight:700;line-height:1.2}.pow-stat small{font-size:13px;font-weight:500;color:var(--muted)}
      .pin-window{position:fixed;width:min(390px,calc(100vw - 28px));max-height:min(560px,calc(100vh - 28px));overflow:auto;pointer-events:auto;background:var(--panel);color:var(--text);border:1px solid color-mix(in srgb,var(--accent) 38%,var(--border));border-radius:17px;box-shadow:0 20px 60px var(--shadow);z-index:20}.pin-head{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 11px;background:color-mix(in srgb,var(--panel) 96%,transparent);border-bottom:1px solid var(--border);cursor:move;user-select:none}.pin-head b{font-size:12px}.pin-actions{display:flex;gap:5px}.pin-actions button{padding:3px 7px}.pin-body{padding:12px}.pin-lead{font-size:12px;font-weight:750;line-height:1.6;padding:9px 10px;border-radius:11px;background:color-mix(in srgb,var(--accent) 10%,var(--surface));margin-bottom:11px}.pin-section{margin:10px 0}.pin-section b{display:block;font-size:11px;color:var(--accent);margin-bottom:3px}.pin-section p{margin:0;font-size:11px;line-height:1.65;color:var(--muted)}
      .danger-text{color:var(--danger)!important}@media(max-width:720px){.panel{width:calc(100vw - 16px)!important;left:8px!important;resize:none}.statgrid,.splitgrid{grid-template-columns:1fr 1fr}.models{grid-template-columns:1fr 38px 1fr}.content{padding:12px}}
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
  openConcept(key,anchor){const data=CONCEPTS[key];if(!data||!this.root)return;const existing=this.openPins.get(key);if(existing&&existing.isConnected){existing.style.display='block';existing.focus();return}const win=document.createElement('div');win.className='pin-window';win.dataset.conceptKey=key;win.tabIndex=-1;applyThemeVars(win);const sections=data.sections.map(([h,t])=>`<div class="pin-section"><b>${escapeHtml(h)}</b><p>${escapeHtml(t)}</p></div>`).join('');win.innerHTML=`<div class="pin-head"><b>📌 ${escapeHtml(data.title)}</b><div class="pin-actions"><button class="iconbtn" data-pin-act="keep" title="固定这张解释卡">固定</button><button class="iconbtn" data-pin-act="close">×</button></div></div><div class="pin-body"><div class="pin-lead">${escapeHtml(data.lead)}</div>${sections}</div>`;this.root.querySelector('.overlay').appendChild(win);const st=loadSettings(),saved=st.conceptPinPositions&&st.conceptPinPositions[key];let left=saved&&Number.isFinite(saved.left)?saved.left:Math.min(window.innerWidth-410,Math.max(18,(anchor&&anchor.getBoundingClientRect().right+12)||80));let top=saved&&Number.isFinite(saved.top)?saved.top:Math.min(window.innerHeight-300,Math.max(18,(anchor&&anchor.getBoundingClientRect().top-20)||100));win.style.left=`${Math.max(8,left)}px`;win.style.top=`${Math.max(8,top)}px`;win.dataset.pinned=saved?'1':'0';this.openPins.set(key,win);this.installPinDrag(win,key);win.querySelector('[data-pin-act="close"]').addEventListener('click',()=>{this.openPins.delete(key);win.remove()});win.querySelector('[data-pin-act="keep"]').addEventListener('click',e=>{win.dataset.pinned='1';e.currentTarget.textContent='已固定';this.savePinPosition(win,key)});
    // Only one unpinned explainer at a time; fixed cards can remain together.
    for(const [k,w] of this.openPins){if(k!==key&&w.dataset.pinned!=="1"){this.openPins.delete(k);w.remove()}}
  },
  installPinDrag(win,key){const head=win.querySelector('.pin-head');head.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button'))return;const r=win.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;try{head.setPointerCapture(e.pointerId)}catch{}const mv=ev=>{const ml=Math.max(8,window.innerWidth-r.width-8),mt=Math.max(8,window.innerHeight-50);win.style.left=`${Math.max(8,Math.min(r.left+ev.clientX-sx,ml))}px`;win.style.top=`${Math.max(8,Math.min(r.top+ev.clientY-sy,mt))}px`};const up=ev=>{head.removeEventListener('pointermove',mv);head.removeEventListener('pointerup',up);head.removeEventListener('pointercancel',up);try{head.releasePointerCapture(ev.pointerId)}catch{}this.savePinPosition(win,key)};head.addEventListener('pointermove',mv);head.addEventListener('pointerup',up);head.addEventListener('pointercancel',up)})},
  savePinPosition(win,key){const r=win.getBoundingClientRect(),st=loadSettings();st.conceptPinPositions={...(st.conceptPinPositions||{}),[key]:{left:Math.round(r.left),top:Math.round(r.top)}};saveSettings(st)},
  render(){try{const r=this.ensure();if(!r)return;this.applyTheme();r.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===this.activeTab));r.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active',p.dataset.pane===this.activeTab));this.renderCurrent(r.querySelector('[data-pane="current"]'));this.renderArchive(r.querySelector('[data-pane="archive"]'));this.renderNetwork(r.querySelector('[data-pane="network"]'));this.renderSettings(r.querySelector('[data-pane="settings"]'))}catch(e){try{console.warn('[Model Downgrade Monitor] render failed',e)}catch{}}},
  routeCard(entry,compact=false){
    if(!entry)return '<div class="empty">还没有捕获到模型应答。发送一条消息后，这里会出现“调用模型 → 应答模型”。</div>';
    const st=statusInfo(entry),call=entry.requestedModel,answer=entry.assistantModel||null,topic=entry.promptTopic||entry.replyTopic||'本轮对话',network=entry.networkLabel||'未命名网络';const prompt=entry.promptPreview||'（这条旧记录没有保存对话摘要）',reply=entry.replyPreview||'（尚未提取到回复摘要）';const tech=JSON.stringify({...entry,promptPreview:undefined,promptTopic:undefined,replyPreview:undefined,replyTopic:undefined},null,2);const resultMark=st.tone==='normal'?'✓':st.tone==='danger'?'≠':st.tone==='conflict'?'◇':st.tone==='warn'?'△':'?';
    return `<div class="card ${compact?'archive-card':'hero'} status-${st.tone}"><div class="verdictline"><div class="verdictwrap"><span class="verdict tone-${st.tone}">${escapeHtml(resultMark+' '+st.title)}</span>${conceptButton(st.tone==='conflict'?'conflict':'status')}</div><span class="time">${escapeHtml(new Date(entry.timestamp).toLocaleTimeString())}</span></div><div class="basis">${escapeHtml(st.basis)}<div class="metrics">${st.metrics.map(x=>`<span class="metric">${escapeHtml(x)}</span>`).join('')}${conceptButton('completeness')}</div></div><div class="dialogue"><div class="chatrow"><div class="avatar">你</div><div class="bubble user"><div class="who">你问 · ${escapeHtml(topic)}</div><div class="preview">${escapeHtml(prompt)}</div></div></div><div class="models"><div class="modelbox"><div class="modellabel">调用模型 ${conceptButton('requested')}</div><b>${escapeHtml(friendlyModelName(call))}</b><code>${escapeHtml(call||'未捕获')}</code></div><div class="arrow">→</div><div class="modelbox"><div class="modellabel">应答模型 ${conceptButton('assistant')}</div><b>${escapeHtml(friendlyModelName(answer))}</b><code>${escapeHtml(answer||'未捕获')}</code><div class="resultcheck">${escapeHtml(st.title)}</div></div></div><div class="chatrow"><div class="avatar">AI</div><div class="bubble assistant"><div class="who">ChatGPT 回答${entry.replyIsCode?' · 代码回答':''}</div><div class="preview">${escapeHtml(reply)}</div></div></div></div><div style="margin-top:10px"><span class="network-chip">${escapeHtml(network)}</span></div><details><summary>技术证据</summary><div class="minirow" style="margin-top:8px">服务器确认模型 ${conceptButton('resolved')}：<b>${escapeHtml(friendlyModelName(entry.resolvedModel))}</b> · ${escapeHtml(entry.resolvedSource||'未捕获')}</div><div class="minirow">服务器路由 ${conceptButton('server')}：<b>${escapeHtml(friendlyModelName(entry.serverModel))}</b> · ${escapeHtml(entry.serverSource||'未捕获')}</div><div class="tech">${escapeHtml(tech)}</div>${Array.isArray(entry.internalMessages)&&entry.internalMessages.length?`<div class="tech">内部 message (${entry.internalMessages.length}):\n${escapeHtml(JSON.stringify(entry.internalMessages,null,2))}</div>`:''}</details></div>`;
  },
  renderCurrent(el){if(!el)return;const h=State.hookHealth(),last=State.lastRouteResult();el.innerHTML=`<div class="kicker">${last?'本轮鉴定':'等待应答'} · 捕获器 ${zhHook(h.overall)}</div>${this.routeCard(last,false)}<div class="muted">主界面只保留“这轮对话 / 调用了什么 / 什么模型回答 / 是否一致 / 当前网络”。服务器字段与其他技术项放在“技术证据”里。</div>`},
  renderArchive(el){
    if(!el)return;const hist=State.historyForUi(),total=hist.length;const counts={normal:0,mismatch:0,conflict:0,notice:0,unknown:0};const models=new Map(),networks=new Map();for(const x of hist){if(x.verdict===VERDICT.NORMAL)counts.normal++;else if(x.verdict===VERDICT.EVIDENCE_CONFLICT)counts.conflict++;else if(x.verdict===VERDICT.MODEL_MISMATCH||x.verdict===VERDICT.DOWNGRADE_SUSPECTED)counts.mismatch++;else if(x.verdict===VERDICT.ROUTE_NOTICE)counts.notice++;else counts.unknown++;const m=x.assistantModel||'未知';models.set(m,(models.get(m)||0)+1);const n=x.networkLabel||'未命名网络',g=networks.get(n)||{n:0,bad:0};g.n++;if(x.verdict===VERDICT.MODEL_MISMATCH||x.verdict===VERDICT.DOWNGRADE_SUSPECTED||x.verdict===VERDICT.EVIDENCE_CONFLICT)g.bad++;networks.set(n,g)}
    const bars=[...models.entries()].sort((a,b)=>b[1]-a[1]).map(([m,n])=>`<div class="barrow"><div class="barhead"><span>${escapeHtml(friendlyModelName(m))}</span><span>${n} · ${total?Math.round(n/total*100):0}%</span></div><div class="bar"><i style="width:${total?n/total*100:0}%"></i></div></div>`).join('');const netRows=[...networks.entries()].map(([n,g])=>`<div class="minirow"><b>${escapeHtml(n)}</b> · ${g.n} 次 · 模型不一致/冲突 ${g.bad} 次 · ${g.n?Math.round(g.bad/g.n*100):0}%</div>`).join('');
    el.innerHTML=`<div class="section-title">总览</div><div class="statgrid"><div class="stat"><b>${total}</b><small>记录</small></div><div class="stat"><b>${counts.normal}</b><small>模型一致</small></div><div class="stat"><b>${counts.mismatch}</b><small>请求≠应答</small></div><div class="stat"><b>${counts.conflict}</b><small>证据冲突</small></div></div><div class="splitgrid"><div class="card"><div class="section-title" style="margin-top:0">异常监测</div><div class="minirow">请求与应答不一致：<b>${counts.mismatch}</b></div><div class="minirow">路由证据冲突：<b>${counts.conflict}</b></div><div class="minirow">服务器字段变化：<b>${counts.notice}</b></div><div class="minirow">信息未完整：<b>${counts.unknown}</b></div></div><div class="card"><div class="section-title" style="margin-top:0">节点表现</div>${netRows||'<div class="empty">暂无数据</div>'}</div></div><div class="card"><div class="section-title" style="margin-top:0">模型使用比例</div>${bars||'<div class="empty">暂无数据</div>'}</div><div class="section-title">模型档案 · 一问一答一张卡</div>${hist.length?hist.map(x=>this.routeCard(x,true)).join(''):'<div class="empty">暂无档案。</div>'}`;
  },
powChart(samples){
    var finalized=TurnAggregator.finalized;
    var powToTurn={};
    for(var fi=finalized.length-1;fi>=0;fi--){var ft=finalized[fi];if(ft.powDecimal)powToTurn[ft.powDecimal]=ft;}
    var pts=[];for(var i=0;i<samples.length;i++){
      var x=samples[i];var work=estimatePowWork(x.rawHex);if(!Number.isFinite(work))continue;
      var assoc=powToTurn[x.decimal]||null;
      pts.push({raw:x.rawHex||'',rawDecimal:Number(x.decimal),work:work,t:x.observedAt?new Date(x.observedAt):null,label:x.networkLabel||'',verdict:assoc?assoc.primaryVerdict:null,turn:assoc});
    }pts.reverse();
    if(pts.length<2)return '<div class="empty">PoW 样本不足，暂时无法画估算工作量趋势。</div>';
    var vals=pts.map(function(p){return p.work;}),min=Math.min.apply(null,vals),max=Math.max.apply(null,vals),span=Math.max(.001,max-min),n=pts.length,w=Math.max(700,n*76),h=300,l=70,r=26,tt=36,b=54,plotW=w-l-r,plotH=h-tt-b;
    function xFn(i){return l+(n===1?0:i/(n-1))*plotW;}function yFn(v){return tt+(max-v)/span*plotH;}
    function fmtWork(v){return v>=1000?(v/1000).toFixed(v>=10000?0:1)+'k×':v>=100?v.toFixed(0)+'×':v>=10?v.toFixed(1)+'×':v.toFixed(2)+'×';}
    var ticks=5;var grid='';
    for(var ti=0;ti<ticks;ti++){var val=max-(span*ti/(ticks-1)),yy=yFn(val);grid+='<line x1="'+l+'" y1="'+yy+'" x2="'+(w-r)+'" y2="'+yy+'" stroke="var(--border)" stroke-width="1"/><text x="'+(l-9)+'" y="'+(yy+4)+'" text-anchor="end" fill="var(--muted)" font-size="12">'+fmtWork(val)+'</text>';}
    var line=pts.map(function(p,i){return xFn(i)+','+yFn(p.work);}).join(' ');
    var circles='';
    for(var ci=0;ci<pts.length;ci++){var p=pts[ci],xx=xFn(ci),yy2=yFn(p.work),time=p.t&&!Number.isNaN(p.t)?p.t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'#'+(ci+1);
      var fill='var(--muted)',stroke='var(--panel)';
      if(p.verdict===VERDICT.NORMAL){fill='var(--normal)';}
      else if(p.verdict===VERDICT.MODEL_MISMATCH||p.verdict===VERDICT.DOWNGRADE_SUSPECTED){fill='var(--danger)';if(p.turn&&p.turn.findings&&p.turn.findings.indexOf('ROUTE_EVIDENCE_CONFLICT')>=0)stroke='var(--conflict)';}
      else if(p.verdict===VERDICT.EVIDENCE_CONFLICT){fill='var(--conflict)';}
      else if(p.verdict===VERDICT.ROUTE_NOTICE||p.verdict===VERDICT.UNKNOWN){fill='var(--warn)';}
      var tooltip=escapeHtml(time+' · 估算工作量 '+fmtWork(p.work)+' · raw '+p.rawDecimal.toLocaleString());if(p.label)tooltip+=' · '+escapeHtml(p.label);
      var showLabel=n<=20||ci%Math.ceil(n/20)===0;
      circles+='<circle cx="'+xx+'" cy="'+yy2+'" r="5" fill="'+fill+'" stroke="'+stroke+'" stroke-width="2"><title>'+tooltip+'</title></circle>';
      if(showLabel){circles+='<text x="'+xx+'" y="'+Math.max(14,yy2-10)+'" text-anchor="middle" fill="var(--text)" font-size="12">'+fmtWork(p.work)+'</text><text x="'+xx+'" y="'+(h-18)+'" text-anchor="middle" fill="var(--muted)" font-size="12">'+escapeHtml(time)+'</text>';}
    }
    var legend='<div class="pow-legend" style="display:flex;gap:12px;flex-wrap:wrap;margin:6px 0;font-size:12px">';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--normal)"></span> 绿色 · 模型一致</span>';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--danger)"></span> 红色 · 请求与应答不一致</span>';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--conflict)"></span> 紫色 · 路由证据冲突</span>';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--warn)"></span> 黄色 · 证据未完整</span>';
    legend+='<span class="pow-legend-item" style="display:flex;align-items:center;gap:4px"><span class="pow-legend-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--muted)"></span> 灰色 · 未关联模型记录</span>';
    legend+='</div>';
    return '<div class="pow-wrap">'+legend+'<svg class="pow-svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'" aria-label="PoW estimated work trend">'+grid+'<line x1="'+l+'" y1="'+(h-b)+'" x2="'+(w-r)+'" y2="'+(h-b)+'" stroke="var(--muted)"/><line x1="'+l+'" y1="'+tt+'" x2="'+l+'" y2="'+(h-b)+'" stroke="var(--muted)"/><text x="12" y="17" fill="var(--muted)" font-size="13">估算工作量（期望尝试次数）</text><polyline fill="none" stroke="var(--accent)" stroke-width="2" points="'+line+'"/>'+circles+'</svg></div><div class="muted">Y 轴越高 = 按公开逆向算法估算，需要的尝试次数越多。点位悬停可看原始 difficulty 十进制/十六进制值；这是逆向估算，不是 OpenAI 官方"风控分"。</div>';
  },
  renderNetwork(el){
    if(!el)return;const st=loadSettings(),hist=State.historyForUi(),groups=new Map();for(const x of hist){const k=x.networkLabel||'未命名网络',g=groups.get(k)||{n:0,mismatch:0,conflict:0,pow:[]};g.n++;if(x.verdict===VERDICT.MODEL_MISMATCH||x.verdict===VERDICT.DOWNGRADE_SUSPECTED)g.mismatch++;if(x.verdict===VERDICT.EVIDENCE_CONFLICT)g.conflict++;const p=Number(x.powDecimal);if(Number.isFinite(p))g.pow.push(p);groups.set(k,g)}const rows=[...groups.entries()].map(([k,g])=>`<div class="card"><b>${escapeHtml(k)}</b><div class="minirow">应答 ${g.n} 次 · 请求≠应答 ${g.mismatch} · 路由冲突 ${g.conflict} · 平均 PoW ${g.pow.length?Math.round(g.pow.reduce((a,b)=>a+b,0)/g.pow.length).toLocaleString():'—'}</div></div>`).join('');const snap=currentNetworkSnapshot(),pow=loadPowHistory().slice(0,50),nums=pow.map(x=>Number(x.decimal)).filter(Number.isFinite),works=pow.map(x=>estimatePowWork(x.rawHex)).filter(Number.isFinite),sortedWork=[...works].sort((a,b)=>a-b),medianWork=sortedWork.length?sortedWork[Math.floor(sortedWork.length/2)]:null,avgWork=works.length?works.reduce((a,b)=>a+b,0)/works.length:null,latest=pow[0]||null;const c=snap.connection||{},fmtWork=v=>!Number.isFinite(v)?'—':v>=1000?`${(v/1000).toFixed(v>=10000?0:1)}k×`:v>=100?`${v.toFixed(0)}×`:v>=10?`${v.toFixed(1)}×`:`${v.toFixed(2)}×`;
    el.innerHTML=`<div class="section-title">当前网络</div><div class="card"><div class="field"><label>节点 / 网络名称（手动命名）</label><input type="text" data-role="network-label" value="${escapeHtml(st.networkLabel||'未命名网络')}" maxlength="64"></div><button class="btn" data-act="save-network">保存标签</button><div class="muted" style="margin-top:8px">浏览器无法可靠读取 OpenClash 当前节点名，所以这里使用你自己定义的标签；之后每轮鉴定都会自动带上它。</div>${snap.connection?`<div class="splitgrid" style="margin-top:10px"><div class="minirow">浏览器网络延迟 ${conceptButton('rtt')}<br><b>${Number.isFinite(c.rtt)?c.rtt+' ms':'—'}</b></div><div class="minirow">浏览器下行估算 ${conceptButton('downlink')}<br><b>${Number.isFinite(c.downlink)?c.downlink+' Mbps':'—'}</b></div></div>`:''}</div><div class="section-title">PoW 分析 ${conceptButton('pow')}</div><div class="card"><div class="pow-summary"><div class="pow-stat"><b>${pow.length}</b><small>样本</small></div><div class="pow-stat"><b>${fmtWork(avgWork)}</b><small>平均估算工作量</small></div><div class="pow-stat"><b>${fmtWork(medianWork)}</b><small>中位估算工作量</small></div><div class="pow-stat"><b>${latest&&latest.decimal?Number(latest.decimal).toLocaleString():'—'}</b><small>最新 raw 阈值</small></div></div><button class="btn" data-act="pow-toggle">${this.powExpanded?'收起':'展开'} PoW 趋势图</button>${this.powExpanded?this.powChart(pow):'<div class="muted" style="margin-top:8px">默认折叠。点 PoW ⓘ 可以看“为什么平台使用它、数字大小怎么读、为什么不能把它当 IP 质量分”。</div>'}</div><div class="section-title">按网络标签统计</div>${rows||'<div class="empty">暂无网络统计。</div>'}`;const save=el.querySelector('[data-act="save-network"]');if(save)save.addEventListener('click',()=>{const input=el.querySelector('[data-role="network-label"]'),s=loadSettings();s.networkLabel=(input.value||'未命名网络').trim().slice(0,64)||'未命名网络';saveSettings(s);save.textContent='已保存';setTimeout(()=>this.render(),450)});const pt=el.querySelector('[data-act="pow-toggle"]');if(pt)pt.addEventListener('click',()=>{this.powExpanded=!this.powExpanded;this.render()})
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
  _last:null,_dedupe:new Map(),_historyWritten:new Set(),_powSeen:0,_hooks:{fetch:false,sse:false,pow:"waiting",ws:false},_sessionEntries:[],_latestPow:null,
  setHooks(h){Object.assign(this._hooks,h)},
  hookHealth(){const h=this._hooks,overall=h.fetch&&h.sse?'READY':(h.fetch||h.sse)?'PARTIAL':'FAILED';return{overall,fetch:h.fetch,sse:h.sse,pow:h.pow,ws:h.ws}},
  recordPow(sample){if(!loadSettings().powEnabled)return;this._powSeen+=1;this._hooks.pow='observed';const snap=currentNetworkSnapshot(),enriched={...sample,networkLabel:snap.label,networkConnection:snap.connection,turnId:TurnAggregator.activeTurn&&!TurnAggregator.activeTurn.finalizedAt?TurnAggregator.activeTurn.turnId:null};this._latestPow=enriched;addPowSample(enriched);if(TurnAggregator.activeTurn&&!TurnAggregator.activeTurn.finalizedAt)TurnAggregator.associatePow(TurnAggregator.activeTurn,sample);postBus(MSG_TYPE.POW,{sample:enriched,total:this._powSeen})},
  resetSession(){this._last=null;this._dedupe.clear();this._historyWritten.clear();this._sessionEntries=[];TurnAggregator.reset()},
  historyForUi(){const persisted=loadHistory(),all=[...this._sessionEntries,...persisted],seen=new Set(),out=[];for(const x of all){const k=x.captureId||x.turnId||`${x.timestamp}:${x.messageId||x.conversationId||''}`;if(seen.has(k))continue;seen.add(k);out.push(x);if(out.length>=CONFIG.MAX_HISTORY)break;}return out},
  // v1.5: emitTurn called by TurnAggregator after finalization.
  emitTurn(turn){
    const pow=this._latestPow||null;
    const entry={captureId:turn.turnId,turnId:turn.turnId,timestamp:turn.startedAt,conversationId:turn.conversationId||null,messageId:turn.messageId||null,requestedModel:turn.requestedModel||null,resolvedModel:turn.resolvedModel||null,assistantModel:turn.assistantModel||null,serverModel:turn.serverModel||null,requestedSource:turn.requestedSource||null,resolvedSource:turn.resolvedSource||null,assistantSource:turn.assistantSource||null,serverSource:turn.serverSource||null,promptPreview:turn.promptPreview||null,promptTopic:turn.promptTopic||null,replyPreview:turn.replyPreview||null,replyTopic:turn.replyTopic||null,replyIsCode:Boolean(turn.replyIsCode),internalMessages:Array.isArray(turn.internalMessages)?turn.internalMessages.slice(0,CONFIG.MAX_INTERNAL_MESSAGES):[],networkLabel:turn.networkLabel||'',networkConnection:turn.networkConnection||null,powRaw:turn.powRaw||(pow&&pow.rawHex)||null,powDecimal:turn.powDecimal||(pow&&pow.decimal)||null,transport:Object.keys(turn.transportsSeen||{}).join(',')||'fetch',transportsSeen:turn.transportsSeen||{}};
    const result=runVerdict({requested:entry.requestedModel,resolved:entry.resolvedModel,resolvedSource:entry.resolvedSource,server:entry.serverModel,serverSource:entry.serverSource,assistant:entry.assistantModel,assistantSource:entry.assistantSource});
    entry.verdict=result.verdict;entry.confidence=result.confidence;entry.evidenceConflict=result.verdict===VERDICT.EVIDENCE_CONFLICT;entry.reasons=result.reasons;
    this._last=entry;const key=entry.captureId||entry.messageId||entry.conversationId||entry.timestamp;if(this._historyWritten.has(key)){Badge.setStatus(entry.verdict,entry.assistantModel||entry.resolvedModel||entry.serverModel||entry.requestedModel);if(Dashboard.open)Dashboard.render();return;}this._historyWritten.add(key);if(this._historyWritten.size>300){const o=this._historyWritten.keys().next().value;if(o!==undefined)this._historyWritten.delete(o)}this._sessionEntries.unshift(entry);this._sessionEntries=this._sessionEntries.slice(0,CONFIG.MAX_HISTORY);addHistoryEntry(entry);postBus(MSG_TYPE.ROUTE_RESULT,persistableEntry(entry));this.alert(entry);Badge.setStatus(entry.verdict,entry.assistantModel||entry.resolvedModel||entry.serverModel||entry.requestedModel);if(Dashboard.open)Dashboard.render();
  },
  handleRouteEvidence(evidence){
    const result=runVerdict({requested:evidence.requestedModel||null,resolved:evidence.resolvedModel||null,resolvedSource:evidence.resolvedSource||null,server:evidence.serverModel||null,serverSource:evidence.serverSource||null,assistant:evidence.assistantModel||null,assistantSource:evidence.assistantSource||null});
    const pow=loadPowHistory()[0]||null,network=evidence.network||currentNetworkSnapshot();
    const entry={turnId:evidence.captureId||crypto.randomUUID(),captureId:evidence.captureId||crypto.randomUUID(),timestamp:Date.now(),conversationId:evidence.conversationId||null,messageId:evidence.messageId||null,requestedModel:evidence.requestedModel||null,resolvedModel:evidence.resolvedModel||null,assistantModel:evidence.assistantModel||null,serverModel:evidence.serverModel||null,requestedSource:evidence.requestedSource||null,resolvedSource:evidence.resolvedSource||null,assistantSource:evidence.assistantSource||null,serverSource:evidence.serverSource||null,promptPreview:evidence.promptPreview||null,promptTopic:evidence.promptTopic||null,replyPreview:evidence.replyPreview||null,replyTopic:evidence.replyTopic||null,replyIsCode:Boolean(evidence.replyIsCode),internalMessages:Array.isArray(evidence.internalMessages)?evidence.internalMessages.slice(0,CONFIG.MAX_INTERNAL_MESSAGES):[],networkLabel:network.label||'',networkConnection:network.connection||null,powRaw:pow&&pow.rawHex||null,powDecimal:pow&&pow.decimal||null,verdict:result.verdict,confidence:result.confidence,transport:evidence.transport||'fetch',evidenceConflict:result.verdict===VERDICT.EVIDENCE_CONFLICT,reasons:result.reasons};
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
    Badge.setStatus(State._last ? State._last.verdict : null, State._last ? (State._last.resolvedModel || State._last.assistantModel) : null);
    return;
  }
  document.addEventListener("DOMContentLoaded", () => {
    AudioFeedback.attachUnlock();
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
      powCount: loadPowHistory().length
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
  _internals: { Network, State, TurnAggregator, SSEParser: createSSEParser }
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
