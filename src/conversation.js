import { providerById, providerForUrl } from "./providers.js";

const PRIVATE_MARKER_PATTERN = /\uE200(?:cite|filecite|turn_aborted|navlist)\uE202.*?\uE201/gu;
const SUPPORTED_ROLES = new Set(["user", "assistant"]);

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function mappingToMap(mapping) {
  if (Array.isArray(mapping)) {
    return new Map(mapping.filter(Boolean).map((node) => [node.id, node]));
  }
  return new Map(Object.entries(asObject(mapping)));
}

function unwrapApiPayload(payload) {
  const root = asObject(payload);
  return firstDefined(root.conversation, root.data?.conversation, root.data, root) || root;
}

function findCurrentNode(nodes, declaredCurrentNode) {
  if (declaredCurrentNode && nodes.has(declaredCurrentNode)) return declaredCurrentNode;

  const leaves = [...nodes.values()].filter((node) => {
    const children = Array.isArray(node?.children) ? node.children : [];
    return children.length === 0 || children.every((childId) => !nodes.has(childId));
  });

  return leaves.sort((a, b) => {
    const aTime = Number(a?.message?.create_time || 0);
    const bTime = Number(b?.message?.create_time || 0);
    return bTime - aTime;
  })[0]?.id;
}

function walkCurrentBranch(nodes, currentNodeId) {
  const branch = [];
  const visited = new Set();
  let nodeId = currentNodeId;

  while (nodeId && nodes.has(nodeId) && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = nodes.get(nodeId);
    branch.push(node);
    nodeId = node?.parent;
  }

  return branch.reverse();
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(PRIVATE_MARKER_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function safeAssetUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function renderContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";

  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;

  const kind = part.content_type || part.type;
  const pointer = safeAssetUrl(part.asset_pointer || part.url || part.download_url);
  if (kind === "image_asset_pointer" || kind === "image") {
    return pointer ? `![ChatGPT image](${pointer})` : "_[Image]_";
  }
  if (kind === "audio_asset_pointer" || kind === "audio") {
    return pointer ? `[Audio attachment](${pointer})` : "_[Audio attachment]_";
  }
  if (pointer) return `[Attachment](${pointer})`;
  return "";
}

function contentToMarkdown(content) {
  if (typeof content === "string") return normalizeText(content);
  const safeContent = asObject(content);
  const parts = Array.isArray(safeContent.parts)
    ? safeContent.parts
    : Array.isArray(safeContent.content)
      ? safeContent.content
      : [];

  if (parts.length > 0) {
    return normalizeText(parts.map(renderContentPart).filter(Boolean).join("\n\n"));
  }

  return normalizeText(firstDefined(safeContent.text, safeContent.result, ""));
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return "";
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    return "";
  }
}

function extractSources(metadata) {
  const candidates = [
    ...(Array.isArray(metadata?.content_references) ? metadata.content_references : []),
    ...(Array.isArray(metadata?.citations) ? metadata.citations : []),
  ];
  const seen = new Set();

  return candidates.flatMap((source) => {
    const url = normalizeUrl(firstDefined(source?.url, source?.metadata?.url));
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{
      title: normalizeText(firstDefined(source?.title, source?.metadata?.title, url)),
      url,
    }];
  });
}

function isVisibleMessage(message) {
  const role = message?.author?.role || message?.role;
  if (!SUPPORTED_ROLES.has(role)) return false;
  if (message?.metadata?.is_visually_hidden_from_conversation) return false;
  return true;
}

function normalizeApiMessage(node) {
  const message = node.message;
  return {
    id: firstDefined(message.id, node.id, ""),
    role: message.author?.role || message.role,
    markdown: contentToMarkdown(message.content),
    createdAt: Number(message.create_time) || null,
    status: message.status || "finished_successfully",
    sources: extractSources(message.metadata),
  };
}

function normalizeTitle(value, providerId = "chatgpt") {
  const provider = providerById(providerId) || providerById("chatgpt");
  const title = normalizeText(value)
    .replace(/\n+/g, " ")
    .replace(/\s*[|\-]\s*ChatGPT\s*$/i, "")
    .replace(/\s*[|\-]\s*OpenAI\s*$/i, "")
    .replace(/\s*[|\-]\s*Google Gemini\s*$/i, "")
    .replace(/\s*[|\-]\s*Gemini\s*$/i, "")
    .trim();
  return title || `Untitled ${provider.label} conversation`;
}

export function conversationFromApi(payload, context = {}) {
  const data = unwrapApiPayload(payload);
  const nodes = mappingToMap(data.mapping);
  if (nodes.size === 0) throw new Error("The conversation response did not contain a message graph.");

  const currentNodeId = findCurrentNode(nodes, data.current_node);
  const branch = walkCurrentBranch(nodes, currentNodeId);
  const messages = branch
    .filter((node) => isVisibleMessage(node?.message))
    .map(normalizeApiMessage)
    .filter((message) => message.markdown || message.sources.length > 0);

  if (messages.length === 0) throw new Error("The current conversation branch contained no exportable messages.");

  return createConversation({
    provider: "chatgpt",
    id: firstDefined(data.conversation_id, data.id, context.conversationId),
    title: firstDefined(data.title, context.pageTitle),
    sourceUrl: context.sourceUrl,
    createdAt: firstDefined(data.create_time, messages[0]?.createdAt),
    updatedAt: firstDefined(data.update_time, messages.at(-1)?.createdAt),
    messages,
    extractionMethod: "api",
    scanComplete: true,
    incomplete: messages.some((message) => message.status === "in_progress"),
  });
}

export function conversationFromDom(payload, convertHtml, options = {}) {
  if (!payload || !Array.isArray(payload.messages)) {
    throw new Error("The page did not return any conversation messages.");
  }

  const provider = providerById(options.provider || payload.provider)
    || providerForUrl(payload.sourceUrl)
    || providerById("chatgpt");
  const messages = payload.messages.flatMap((message) => {
    if (!SUPPORTED_ROLES.has(message.role)) return [];
    const convertedHtml = message.html && typeof convertHtml === "function"
      ? convertHtml(message.html)
      : "";
    const markdown = normalizeText(convertedHtml || message.text);
    if (!markdown) return [];
    return [{
      id: message.id || "",
      role: message.role,
      markdown,
      createdAt: null,
      status: "finished_successfully",
      sources: extractSources({ citations: message.sources }),
    }];
  });

  if (messages.length === 0) throw new Error(`No visible ${provider.label} messages were found on this page.`);

  if (payload.isGenerating) {
    const lastAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
    if (lastAssistantIndex >= 0) messages[lastAssistantIndex].status = "in_progress";
  }

  const warnings = [];
  if (payload.scroll?.complete !== true) {
    warnings.push(`${provider.label} 的长对话扫描未到达两端，当前导出可能只包含页面已加载的消息。`);
  } else if (provider.id === "chatgpt") {
    warnings.push("ChatGPT 的结构化数据不可用，已扫描完整页面消息；归档前请核对消息数量。");
  }
  if (payload.roleReliable === false) warnings.push("部分消息角色来自顺序推断，请核对 User/Assistant 顺序。");
  if (Array.isArray(payload.warnings)) warnings.push(...payload.warnings.map(normalizeText).filter(Boolean));

  return createConversation({
    provider: provider.id,
    id: payload.conversationId,
    title: payload.title,
    sourceUrl: payload.sourceUrl,
    messages,
    extractionMethod: "dom",
    scanComplete: payload.scroll?.complete === true,
    incomplete: Boolean(payload.isGenerating),
    warnings,
  });
}

export function createConversation(input) {
  const sourceUrl = normalizeUrl(input.sourceUrl);
  const provider = providerById(input.provider)
    || providerForUrl(sourceUrl)
    || providerById("chatgpt");
  const fallbackId = sourceUrl.match(/\/(?:c|share|app)\/([^/?#]+)/)?.[1] || "local";
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const userCount = messages.filter((message) => message.role === "user").length;
  const assistantCount = messages.filter((message) => message.role === "assistant").length;

  return {
    provider: provider.id,
    id: String(input.id || fallbackId),
    title: normalizeTitle(input.title, provider.id),
    sourceUrl,
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
    messages,
    extractionMethod: input.extractionMethod || "unknown",
    scanComplete: input.scanComplete === true,
    incomplete: Boolean(input.incomplete),
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    stats: {
      messageCount: messages.length,
      roundCount: Math.min(userCount, assistantCount),
      userCount,
      assistantCount,
    },
  };
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function isoDate(value, fallback = new Date()) {
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

function renderSources(sources) {
  if (!sources?.length) return "";
  const lines = sources.map((source) => `> - [${source.title.replace(/([\\[\]])/g, "\\$1")}](${source.url})`);
  return `\n\n> [!info]- Sources\n${lines.join("\n")}`;
}

function resolveMarkdownArguments(importedAtOrOptions, maybeOptions) {
  if (importedAtOrOptions instanceof Date) {
    return {
      importedAt: importedAtOrOptions,
      options: maybeOptions || {},
    };
  }

  return {
    importedAt: new Date(),
    options: importedAtOrOptions || {},
  };
}

export function conversationToMarkdown(
  conversation,
  importedAtOrOptions = new Date(),
  maybeOptions = {},
) {
  const { importedAt, options } = resolveMarkdownArguments(importedAtOrOptions, maybeOptions);
  const detailedMetadata = options.detailedMetadata === true;
  const properties = [
    "---",
    `title: ${yamlString(conversation.title)}`,
    `source: ${yamlString(conversation.sourceUrl)}`,
    `conversation_id: ${yamlString(conversation.id)}`,
  ];

  if (detailedMetadata) {
    properties.push(
      `provider: ${yamlString(conversation.provider)}`,
      `created: ${yamlString(isoDate(conversation.createdAt, importedAt))}`,
      `updated: ${yamlString(isoDate(conversation.updatedAt, importedAt))}`,
      `imported: ${yamlString(importedAt.toISOString())}`,
      `messages: ${conversation.stats.messageCount}`,
      `rounds: ${conversation.stats.roundCount}`,
      `extraction: ${yamlString(conversation.extractionMethod)}`,
    );
  }

  const provider = providerById(conversation.provider) || providerById("chatgpt");
  properties.push("tags:", `  - ${provider.tag}`);
  if (detailedMetadata) properties.push("  - ai-conversation");
  properties.push("---");

  const body = conversation.messages.map((message) => {
    const label = message.role === "user" ? "User" : "Assistant";
    return `## ${label}\n\n${message.markdown}${renderSources(message.sources)}`.trim();
  });

  const incompleteNotice = conversation.incomplete
    ? `> [!warning] Incomplete export\n> ${provider.label} was still generating a response when this note was exported.\n\n`
    : "";

  return `${properties.join("\n")}\n\n# ${conversation.title}\n\n${incompleteNotice}${body.join("\n\n---\n\n")}\n`;
}

export function safeFilename(conversation) {
  const safeTitle = conversation.title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96) || `${(providerById(conversation.provider) || providerById("chatgpt")).label} conversation`;
  const safeId = String(conversation.id || "local")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(-8) || "local";
  return `${safeTitle} [${safeId}].md`;
}
