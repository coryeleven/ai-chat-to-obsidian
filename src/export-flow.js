import {
  claimPendingExport,
  finalizePendingExport,
  recordPendingExportFilename,
  releasePendingExport,
  writeMarkdownFile,
} from "./file-store.js";

const MAX_PENDING_EXPORT_BYTES = 64 * 1024 * 1024;
const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class PendingExportBusyError extends Error {
  constructor() {
    super("This export is already being saved in another page.");
    this.name = "PendingExportBusyError";
  }
}

export function createPendingExport({
  conversationId,
  filename,
  markdown,
  sourceTabId,
  sourceWindowId,
  sourceUrl,
  requestId,
}) {
  if (typeof conversationId !== "string" || !conversationId.trim()) {
    throw new Error("A pending export requires a conversation ID.");
  }
  if (typeof filename !== "string" || !filename.trim()) {
    throw new Error("A pending export requires a filename.");
  }
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new Error("A pending export requires Markdown content.");
  }
  if (new TextEncoder().encode(markdown).byteLength > MAX_PENDING_EXPORT_BYTES) {
    throw new Error("The conversation is too large to hand off for folder authorization.");
  }

  return {
    version: 1,
    id: requestId || createRequestId(),
    status: "pending",
    conversationId,
    filename,
    markdown,
    sourceTabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
    sourceWindowId: Number.isInteger(sourceWindowId) ? sourceWindowId : null,
    sourceUrl: typeof sourceUrl === "string" ? sourceUrl : "",
    createdAt: new Date().toISOString(),
    attempts: 0,
    resolvedFilename: null,
    ownerId: null,
    claimedAt: null,
    lastError: "",
  };
}

export function isPendingExport(value) {
  return value?.version === 1
    && typeof value.id === "string"
    && Boolean(value.id)
    && new Set(["pending", "processing"]).has(value.status)
    && typeof value.conversationId === "string"
    && Boolean(value.conversationId.trim())
    && typeof value.filename === "string"
    && Boolean(value.filename.trim())
    && typeof value.markdown === "string"
    && Boolean(value.markdown.trim());
}

export function isCompletedPendingExport(value) {
  return value?.version === 1
    && value.status === "completed"
    && typeof value.filename === "string"
    && Boolean(value.filename.trim());
}

export function isSafeChatGptReturnTarget(currentUrl, expectedUrl = "") {
  try {
    const current = new URL(currentUrl);
    if (!CHATGPT_HOSTS.has(current.hostname)) return false;
    if (!expectedUrl) return true;
    return CHATGPT_HOSTS.has(new URL(expectedUrl).hostname);
  } catch {
    return false;
  }
}

export async function completePendingExport(requestId, ownerId, destination, dependencies = {}) {
  const claim = dependencies.claim || claimPendingExport;
  const writeFile = dependencies.writeFile || writeMarkdownFile;
  const recordFilename = dependencies.recordFilename || recordPendingExportFilename;
  const finalize = dependencies.finalize || finalizePendingExport;
  const release = dependencies.release || releasePendingExport;
  const claimed = await claim(requestId, ownerId);

  if (!claimed) throw new Error("The pending export is missing.");
  if (isCompletedPendingExport(claimed)) return claimed;
  if (claimed.status === "expired") throw new Error("The pending export has expired.");
  if (claimed.status === "processing" && claimed.ownerId !== ownerId) {
    throw new PendingExportBusyError();
  }
  if (!isPendingExport(claimed)) throw new Error("The pending export is invalid.");

  try {
    const preferredFilename = claimed.resolvedFilename || claimed.filename;
    const savedFilename = await writeFile(destination, preferredFilename, claimed.markdown);
    await recordFilename(requestId, ownerId, savedFilename);
    return await finalize(requestId, ownerId, savedFilename);
  } catch (error) {
    try { await release(requestId, ownerId, error?.message || error); } catch {}
    throw error;
  }
}
