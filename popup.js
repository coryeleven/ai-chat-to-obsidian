import {
  conversationFromApi,
  conversationFromDom,
  conversationToMarkdown,
  safeFilename,
} from "./src/conversation.js";
import { htmlToMarkdown } from "./src/html-to-markdown.js";
import { extractCurrentChat } from "./src/extract-page.js";
import { extractCurrentGemini } from "./src/extract-gemini.js";
import {
  assertCompleteMarkdownExport,
  formatMarkdownStats,
  writeCompleteMarkdownToClipboard,
} from "./src/export-payload.js";
import { buildObsidianNewUri, normalizeObsidianFolder } from "./src/obsidian.js";
import { sendCompleteMarkdownToObsidian } from "./src/obsidian-transport.js";
import { demoConversation, demoGeminiConversation } from "./src/demo-data.js";
import { providerById, providerForUrl } from "./src/providers.js";
import {
  DEFAULT_SETTINGS,
  destinationLabel,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "./src/settings.js";
import { detectBrowserKind, getWebExtensionApi } from "./src/webext.js";

const elements = Object.fromEntries([
  "app-shell", "loading-view", "error-view", "conversation-view", "error-message",
  "conversation-title", "conversation-meta", "extraction-badge", "warning-panel", "warning-message",
  "destination-name", "preview-section", "filename-label", "markdown-preview", "markdown-stats", "refresh-button",
  "settings-button", "retry-button", "edit-destination-button", "save-button", "save-button-icon",
  "save-button-label", "save-shortcut", "copy-button", "download-button", "toast", "settings-dialog", "settings-form",
  "close-settings-button", "cancel-settings-button", "vault-input", "folder-input", "silent-open-input",
  "detailed-metadata-input",
].map((id) => [id, document.getElementById(id)]));

const state = {
  conversation: null,
  markdown: "",
  filename: "",
  importedAt: new Date(),
  sourceTabId: null,
  sourceUrl: "",
  provider: null,
  browserKind: "unknown",
  settings: { ...DEFAULT_SETTINGS },
  busy: false,
  sent: false,
  exportStats: null,
  toastTimer: null,
};

const CLIPBOARD_FALLBACK = [
  "> [!warning] 剪贴板传输失败",
  "> 请返回原对话，使用“复制 Markdown”后手动粘贴完整正文。",
].join("\n");

const query = new URLSearchParams(window.location.search);
const isDemo = query.has("demo");
const demoBrowser = query.get("browser");
const demoTheme = query.get("theme");
const demoProvider = providerById(query.get("provider")) || providerById("chatgpt");
const webExtensionApi = getWebExtensionApi();

if (isDemo && new Set(["light", "dark"]).has(demoTheme)) {
  document.documentElement.dataset.theme = demoTheme;
}

function setView(name) {
  elements["loading-view"].hidden = name !== "loading";
  elements["error-view"].hidden = name !== "error";
  elements["conversation-view"].hidden = name !== "conversation";
}

function setBusy(busy) {
  state.busy = busy;
  elements["app-shell"].setAttribute("aria-busy", String(busy));
  [
    elements["refresh-button"],
    elements["settings-button"],
    elements["retry-button"],
    elements["edit-destination-button"],
    elements["save-button"],
    elements["copy-button"],
    elements["download-button"],
  ].forEach((button) => {
    if (button) button.disabled = busy;
  });
  if (elements["save-button"]) renderSaveState();
}

function showToast(message, kind = "success") {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600);
}

function readableError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Cannot access contents")) {
    return "浏览器无法访问此页面，请刷新对话页面后再试。";
  }
  if (message.includes("No visible") && message.includes("messages")) {
    return "当前页面没有找到可导出的对话。";
  }
  if (message.includes("clipboard") || message.includes("Clipboard")) {
    return "浏览器未允许写入剪贴板，请检查扩展权限。";
  }
  if (message.includes("Markdown export is incomplete")) {
    return "Markdown 正文校验失败，已阻止创建空笔记。请重新读取对话后再试。";
  }
  if (message.includes("no longer a supported")) {
    return "原对话标签已关闭或跳转到了其他页面，请重新打开对话。";
  }
  if (message.includes("provider no longer matches") || message.includes("provider is required")) {
    return "原对话的平台信息已变化，请重新读取后再保存。";
  }
  return message;
}

function renderSaveState() {
  const buttonState = state.busy ? "loading" : state.sent ? "success" : "idle";
  elements["save-button"].dataset.state = buttonState;
  elements["save-button-label"].textContent = buttonState === "loading"
    ? "正在保存..."
    : buttonState === "success" ? "已保存到 Obsidian" : "保存到 Obsidian";
  elements["save-button-icon"].innerHTML = buttonState === "success"
    ? '<path d="m5 12 4 4L19 6"></path>'
    : buttonState === "loading"
      ? '<circle cx="12" cy="12" r="8"></circle><path d="M12 4a8 8 0 0 1 8 8"></path>'
      : '<path d="M7 17 17 7"></path><path d="M7 7h10v10"></path>';
}

function renderDestination() {
  const label = destinationLabel(state.settings);
  elements["destination-name"].textContent = label;
  elements["destination-name"].title = label;
}

function updateMarkdown() {
  if (!state.conversation) return;
  state.markdown = conversationToMarkdown(state.conversation, state.importedAt, {
    detailedMetadata: state.settings.detailedMetadata,
  });
  state.exportStats = assertCompleteMarkdownExport(state.conversation, state.markdown);
  elements["markdown-preview"].value = state.markdown;
  elements["markdown-stats"].textContent = formatMarkdownStats(state.exportStats);
  elements["conversation-view"].dataset.markdownBytes = String(state.exportStats.bytes);
  elements["conversation-view"].dataset.markdownSections = String(state.exportStats.messageSections);
}

function renderConversation(conversation) {
  state.conversation = conversation;
  state.filename = safeFilename(conversation);
  state.sent = false;
  updateMarkdown();

  elements["conversation-title"].textContent = conversation.title;
  const provider = providerById(conversation.provider) || providerById("chatgpt");
  elements["conversation-meta"].textContent = `${conversation.stats.messageCount} 条消息 · ${conversation.stats.roundCount} 轮对话 · ${provider.label}`;
  elements["extraction-badge"].dataset.method = conversation.extractionMethod;
  elements["extraction-badge"].dataset.quality = conversation.scanComplete ? "complete" : "partial";
  const quality = conversation.extractionMethod === "api"
    ? "完整数据"
    : conversation.scanComplete ? "已扫描页面" : "页面数据";
  elements["extraction-badge"].textContent = quality;
  elements["filename-label"].textContent = state.filename;
  elements["filename-label"].title = state.filename;
  elements["filename-label"].setAttribute("aria-label", `文件名：${state.filename}`);

  const warnings = [...conversation.warnings];
  if (conversation.incomplete) warnings.push("当前回答仍在生成，建议生成完成后重新导出。");
  elements["warning-panel"].hidden = warnings.length === 0;
  elements["warning-message"].textContent = warnings.join(" ");
  renderSaveState();
  setView("conversation");
}

async function readCurrentConversation() {
  setBusy(true);
  setView("loading");
  try {
    if (isDemo) {
      const conversation = demoProvider.id === "gemini" ? demoGeminiConversation : demoConversation;
      state.sourceTabId = 42;
      state.sourceUrl = conversation.sourceUrl;
      state.provider = demoProvider;
      renderConversation(conversation);
      return;
    }

    if (!webExtensionApi?.tabs || !webExtensionApi?.scripting) {
      throw new Error("请从已安装的浏览器扩展中打开此界面。");
    }

    const [tab] = await webExtensionApi.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id) || !tab.url) throw new Error("无法确定当前浏览器标签页。");
    state.sourceTabId = tab.id;
    state.sourceUrl = tab.url;
    const provider = providerForUrl(tab.url);
    if (!provider) {
      throw new Error("请先打开一条 ChatGPT 或 Gemini 对话，再点击扩展按钮。");
    }
    state.provider = provider;

    const results = await webExtensionApi.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: provider.id === "gemini" ? extractCurrentGemini : extractCurrentChat,
    });
    const extracted = results?.[0]?.result;
    if (!extracted) throw new Error(`${provider.label} 页面没有返回对话数据。`);

    const conversation = extracted.kind === "api"
      ? conversationFromApi(extracted.payload, extracted.context)
      : conversationFromDom(extracted.payload, htmlToMarkdown, { provider: provider.id });
    renderConversation(conversation);
  } catch (error) {
    elements["error-message"].textContent = readableError(error);
    setView("error");
  } finally {
    setBusy(false);
  }
}

function buildSaveUri() {
  const folder = normalizeObsidianFolder(state.settings.folder);
  const file = folder ? `${folder}/${state.filename}` : state.filename;
  return buildObsidianNewUri({
    file,
    vault: state.settings.vault,
    clipboard: true,
    overwrite: true,
    silent: state.settings.silentOpen,
    clipboardFallback: CLIPBOARD_FALLBACK,
  });
}

async function saveToObsidian() {
  if (!state.conversation || state.busy) return;
  setBusy(true);
  state.sent = false;
  renderSaveState();
  try {
    const uri = buildSaveUri();
    assertCompleteMarkdownExport(state.conversation, state.markdown);
    if (isDemo) {
      state.sent = true;
      renderSaveState();
      showToast("已发送到 Obsidian");
      return;
    }
    await sendCompleteMarkdownToObsidian({
      clipboard: navigator.clipboard,
      runtime: webExtensionApi?.runtime,
      conversation: state.conversation,
      markdown: state.markdown,
      tabId: state.sourceTabId,
      uri,
    });
    state.sent = true;
    renderSaveState();
    showToast("已发送到 Obsidian");
  } catch (error) {
    showToast(readableError(error), "error");
  } finally {
    setBusy(false);
    renderSaveState();
  }
}

async function copyMarkdown() {
  try {
    await writeCompleteMarkdownToClipboard(navigator.clipboard, state.conversation, state.markdown);
    showToast("Markdown 已复制");
  } catch (error) {
    showToast(readableError(error), "error");
  }
}

async function downloadMarkdown() {
  try {
    assertCompleteMarkdownExport(state.conversation, state.markdown);
    if (webExtensionApi?.runtime?.id && webExtensionApi.runtime.sendMessage) {
      const response = await webExtensionApi.runtime.sendMessage({
        type: "download-markdown",
        markdown: state.markdown,
        filename: state.filename,
        saveAs: false,
      });
      if (!response?.ok) throw new Error(response?.error || "浏览器未能启动下载。");
    } else {
      const blob = new Blob([state.markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = state.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    showToast("Markdown 文件已下载");
  } catch (error) {
    showToast(readableError(error), "error");
  }
}

function openSettings() {
  elements["vault-input"].value = state.settings.vault;
  elements["folder-input"].value = state.settings.folder;
  elements["silent-open-input"].checked = state.settings.silentOpen;
  elements["detailed-metadata-input"].checked = state.settings.detailedMetadata;
  elements["settings-dialog"].showModal();
  elements["vault-input"].focus();
}

function closeSettings() {
  elements["settings-dialog"].close();
}

async function applySettings(event) {
  event.preventDefault();
  const nextSettings = normalizeSettings({
    vault: elements["vault-input"].value,
    folder: elements["folder-input"].value,
    silentOpen: elements["silent-open-input"].checked,
    detailedMetadata: elements["detailed-metadata-input"].checked,
  });
  try {
    state.settings = isDemo ? nextSettings : await saveSettings(webExtensionApi, nextSettings);
    state.sent = false;
    renderDestination();
    updateMarkdown();
    renderSaveState();
    closeSettings();
    showToast("保存设置已更新");
  } catch (error) {
    showToast(readableError(error), "error");
  }
}

async function configure() {
  state.browserKind = demoBrowser || await detectBrowserKind();
  document.body.dataset.browser = state.browserKind;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  elements["save-shortcut"].textContent = isMac ? "⌘ ↵" : "Ctrl ↵";
  if (isDemo) {
    state.settings = normalizeSettings({
      vault: query.get("vault") || "",
      folder: query.has("folder") ? query.get("folder") : DEFAULT_SETTINGS.folder,
      silentOpen: query.get("silent") !== "0",
      detailedMetadata: query.get("detailed") === "1",
    });
  } else {
    try {
      state.settings = await loadSettings(webExtensionApi);
    } catch {
      state.settings = { ...DEFAULT_SETTINGS };
    }
  }
  renderDestination();
}

elements["refresh-button"].addEventListener("click", readCurrentConversation);
elements["retry-button"].addEventListener("click", readCurrentConversation);
elements["settings-button"].addEventListener("click", openSettings);
elements["edit-destination-button"].addEventListener("click", openSettings);
elements["close-settings-button"].addEventListener("click", closeSettings);
elements["cancel-settings-button"].addEventListener("click", closeSettings);
elements["settings-form"].addEventListener("submit", applySettings);
elements["save-button"].addEventListener("click", saveToObsidian);
elements["copy-button"].addEventListener("click", copyMarkdown);
elements["download-button"].addEventListener("click", downloadMarkdown);
[elements["copy-button"], elements["download-button"]].forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  saveToObsidian();
});

await configure();
await readCurrentConversation();
