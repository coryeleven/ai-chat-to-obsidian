import {
  buildConversationMarkdown,
  conversationFromApi,
  conversationFromDom,
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
  "status-separator", "destination-name", "preview-section", "preview-toggle-button", "filename-label",
  "markdown-preview", "markdown-stats", "properties-list", "properties-count", "refresh-button",
  "settings-button", "retry-button", "edit-destination-button", "save-button", "save-button-icon",
  "save-button-label", "save-shortcut", "save-status-message", "copy-button", "download-button", "toast",
  "settings-dialog", "settings-form", "settings-error-message",
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
  settingsBusy: false,
  isMac: false,
  saveStatus: "disabled",
  saveMessage: "",
  saveResetTimer: null,
  copyFeedbackTimer: null,
  exportStats: null,
  toastTimer: null,
};

const CLIPBOARD_FALLBACK = [
  "> [!warning] 剪贴板传输失败",
  "> 请返回原对话，使用“复制 Markdown”后手动粘贴完整正文。",
].join("\n");

const PROPERTY_ICONS = Object.freeze({
  title: '<path d="M4 7V4h16v3"></path><path d="M9 20h6"></path><path d="M12 4v16"></path>',
  source: '<path d="M9 17H7A5 5 0 0 1 7 7h2"></path><path d="M15 7h2a5 5 0 1 1 0 10h-2"></path><path d="M8 12h8"></path>',
  conversation_id: '<path d="M4 9h16"></path><path d="M4 15h16"></path><path d="M10 3 8 21"></path><path d="m16 3-2 18"></path>',
  provider: '<path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M9 13v2"></path><path d="M15 13v2"></path>',
  created: '<path d="M8 2v4"></path><path d="M16 2v4"></path><rect width="18" height="18" x="3" y="4" rx="2"></rect><path d="M3 10h18"></path><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path>',
  updated: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  imported: '<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path>',
  messages: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
  rounds: '<path d="m17 2 4 4-4 4"></path><path d="M3 11V9a3 3 0 0 1 3-3h15"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v2a3 3 0 0 1-3 3H3"></path>',
  extraction: '<path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><path d="M7 12h10"></path>',
  tags: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" stroke="none"></circle>',
});

const query = new URLSearchParams(window.location.search);
const isDemo = query.has("demo");
const demoBrowser = query.get("browser");
const demoTheme = query.get("theme");
const demoSaveMode = query.get("demoSave");
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

function renderControlAvailability() {
  const controlsBusy = state.busy || state.settingsBusy;
  elements["app-shell"].setAttribute("aria-busy", String(controlsBusy));
  [
    elements["refresh-button"],
    elements["settings-button"],
    elements["retry-button"],
    elements["edit-destination-button"],
    elements["copy-button"],
    elements["download-button"],
    elements["silent-open-input"],
    elements["detailed-metadata-input"],
  ].forEach((control) => {
    if (control) control.disabled = controlsBusy;
  });
  if (elements["save-button"]) renderSaveState();
}

function setBusy(busy) {
  state.busy = busy;
  renderControlAvailability();
}

function setSettingsBusy(busy) {
  state.settingsBusy = busy;
  renderControlAvailability();
}

function showToast(message, kind = "success") {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.setAttribute("role", kind === "error" ? "alert" : "status");
  elements.toast.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
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
  const buttonState = state.saveStatus;
  const states = {
    idle: {
      label: "保存到 Obsidian",
      icon: [
        '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"></path>',
        '<path d="M17 21v-8H7v8"></path>',
        '<path d="M7 3v5h8"></path>',
      ].join(""),
    },
    loading: {
      label: "正在保存…",
      icon: '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>',
    },
    success: {
      label: "已保存",
      icon: '<path d="M20 6 9 17l-5-5"></path>',
    },
    error: {
      label: "保存失败，重试",
      icon: '<circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>',
    },
    disabled: {
      label: "保存到 Obsidian",
      icon: [
        '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"></path>',
        '<path d="M17 21v-8H7v8"></path>',
        '<path d="M7 3v5h8"></path>',
      ].join(""),
    },
  };
  const presentation = states[buttonState] || states.disabled;
  elements["save-button"].dataset.state = buttonState;
  elements["save-button-label"].textContent = presentation.label;
  elements["save-button-icon"].innerHTML = presentation.icon;
  elements["save-button"].disabled = state.busy
    || state.settingsBusy
    || buttonState === "loading"
    || buttonState === "success"
    || buttonState === "disabled";
  elements["save-button"].setAttribute("aria-busy", String(buttonState === "loading"));
  elements["save-button"].setAttribute("aria-label", presentation.label);
  elements["save-status-message"].textContent = state.saveMessage;
  elements["save-status-message"].title = state.saveMessage;
  elements["save-status-message"].dataset.kind = buttonState;
}

function setSaveStatus(status, message = "") {
  if (status !== "success") clearTimeout(state.saveResetTimer);
  state.saveStatus = status;
  state.saveMessage = message;
  renderSaveState();
}

function showCopyFeedback() {
  clearTimeout(state.copyFeedbackTimer);
  elements["copy-button"].dataset.state = "success";
  elements["copy-button"].setAttribute("aria-label", "Markdown 已复制");
  elements["copy-button"].title = "Markdown 已复制";
  elements["copy-button"].querySelector("svg").innerHTML = '<path d="M20 6 9 17l-5-5"></path>';
  state.copyFeedbackTimer = setTimeout(() => {
    elements["copy-button"].dataset.state = "idle";
    elements["copy-button"].setAttribute("aria-label", "复制 Markdown");
    elements["copy-button"].title = "复制 Markdown";
    elements["copy-button"].querySelector("svg").innerHTML = [
      '<rect x="8" y="8" width="12" height="12" rx="2"></rect>',
      '<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>',
    ].join("");
  }, 1500);
}

function renderDestination() {
  const label = destinationLabel(state.settings).replace(/^当前 Vault(?=\s|$)/, "当前仓库");
  elements["destination-name"].textContent = label;
  elements["destination-name"].title = label;
}

function renderSettingsControls() {
  elements["silent-open-input"].checked = state.settings.silentOpen;
  elements["detailed-metadata-input"].checked = state.settings.detailedMetadata;
}

function propertyIcon(name) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "property-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = PROPERTY_ICONS[name] || PROPERTY_ICONS.title;
  return icon;
}

function propertyDisplayValue(name, value) {
  if (Array.isArray(value)) return value.join(" · ");
  if (["created", "updated", "imported"].includes(name) && typeof value === "string") {
    return value.slice(0, 10);
  }
  return String(value ?? "");
}

function renderProperties(properties) {
  const fragment = document.createDocumentFragment();
  for (const property of properties) {
    const fullValue = Array.isArray(property.value)
      ? property.value.join(", ")
      : String(property.value ?? "");
    if (!fullValue) continue;

    const row = document.createElement("div");
    row.className = "property-row";
    row.dataset.property = property.name;

    const term = document.createElement("dt");
    term.append(propertyIcon(property.name));
    const label = document.createElement("span");
    label.textContent = property.name;
    term.append(label);

    const description = document.createElement("dd");
    description.textContent = propertyDisplayValue(property.name, property.value);
    description.title = fullValue;

    row.append(term, description);
    fragment.append(row);
  }
  elements["properties-list"].replaceChildren(fragment);
  const count = elements["properties-list"].children.length;
  elements["properties-count"].textContent = `${count} 项`;
}

function updateMarkdown() {
  if (!state.conversation) return;
  const document = buildConversationMarkdown(state.conversation, state.importedAt, {
    detailedMetadata: state.settings.detailedMetadata,
  });
  state.markdown = document.markdown;
  state.exportStats = assertCompleteMarkdownExport(state.conversation, state.markdown);
  elements["markdown-preview"].textContent = document.body;
  renderProperties(document.properties);
  elements["markdown-stats"].textContent = formatMarkdownStats(state.exportStats);
  elements["conversation-view"].dataset.markdownBytes = String(state.exportStats.bytes);
  elements["conversation-view"].dataset.markdownSections = String(state.exportStats.messageSections);
}

function renderConversation(conversation) {
  state.conversation = conversation;
  state.filename = safeFilename(conversation);
  setSaveStatus("idle");
  updateMarkdown();

  elements["conversation-title"].textContent = conversation.title;
  elements["conversation-title"].title = conversation.title;
  const provider = providerById(conversation.provider) || providerById("chatgpt");
  elements["conversation-meta"].textContent = `${conversation.stats.messageCount} 条消息 · ${conversation.stats.roundCount} 轮对话 · ${provider.label}`;
  elements["extraction-badge"].dataset.method = conversation.extractionMethod;
  elements["extraction-badge"].dataset.quality = conversation.scanComplete ? "complete" : "partial";
  elements["status-separator"].dataset.quality = conversation.scanComplete ? "complete" : "partial";
  const quality = conversation.scanComplete ? "页面已解析" : "页面可能不完整";
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
  const scrollContainer = elements["conversation-view"].querySelector(".conversation-scroll");
  if (scrollContainer) scrollContainer.scrollTop = 0;
  state.conversation = null;
  state.markdown = "";
  state.filename = "";
  state.sourceTabId = null;
  state.sourceUrl = "";
  state.provider = null;
  state.exportStats = null;
  setSaveStatus("disabled");
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
  if (
    !state.conversation
    || state.busy
    || state.settingsBusy
    || !["idle", "error"].includes(state.saveStatus)
  ) return;
  setSaveStatus("loading");
  setBusy(true);
  let succeeded = false;
  try {
    const uri = buildSaveUri();
    assertCompleteMarkdownExport(state.conversation, state.markdown);
    if (isDemo) {
      await new Promise((resolve) => setTimeout(resolve, 420));
      if (demoSaveMode === "error") throw new Error("模拟保存失败，请重试。");
      succeeded = true;
      setSaveStatus("success", "对话已保存到 Obsidian。");
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
    succeeded = true;
    setSaveStatus("success", "对话已保存到 Obsidian。");
  } catch (error) {
    setSaveStatus("error", readableError(error));
  } finally {
    setBusy(false);
    if (succeeded) {
      state.saveResetTimer = setTimeout(() => {
        if (state.saveStatus === "success") setSaveStatus("idle");
      }, 1500);
    }
  }
}

async function copyMarkdown() {
  try {
    await writeCompleteMarkdownToClipboard(navigator.clipboard, state.conversation, state.markdown);
    showCopyFeedback();
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
  elements["settings-error-message"].textContent = "";
  elements["vault-input"].value = state.settings.vault;
  elements["folder-input"].value = state.settings.folder;
  elements["settings-dialog"].showModal();
  elements["vault-input"].focus();
}

function closeSettings() {
  elements["settings-dialog"].close();
}

async function commitSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  state.settings = isDemo ? normalized : await saveSettings(webExtensionApi, normalized);
  renderSettingsControls();
  renderDestination();
  updateMarkdown();
}

async function applyInlineSettings() {
  const nextSettings = {
    ...state.settings,
    silentOpen: elements["silent-open-input"].checked,
    detailedMetadata: elements["detailed-metadata-input"].checked,
  };
  setSettingsBusy(true);
  try {
    await commitSettings(nextSettings);
    setSaveStatus(state.conversation ? "idle" : "disabled");
  } catch (error) {
    renderSettingsControls();
    showToast(readableError(error), "error");
  } finally {
    setSettingsBusy(false);
  }
}

async function applySettings(event) {
  event.preventDefault();
  elements["settings-error-message"].textContent = "";
  const nextSettings = {
    ...state.settings,
    vault: elements["vault-input"].value,
    folder: elements["folder-input"].value,
  };
  setSettingsBusy(true);
  try {
    await commitSettings(nextSettings);
    setSaveStatus(state.conversation ? "idle" : "disabled");
    closeSettings();
    showToast("保存设置已更新");
  } catch (error) {
    elements["settings-error-message"].textContent = readableError(error);
  } finally {
    setSettingsBusy(false);
  }
}

async function configure() {
  state.browserKind = demoBrowser || await detectBrowserKind();
  document.body.dataset.browser = state.browserKind;
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
  state.isMac = /Mac|iPhone|iPad/.test(platform);
  elements["save-shortcut"].textContent = state.isMac ? "⌘ ↵" : "Ctrl ↵";
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
  renderSettingsControls();
  renderControlAvailability();
}

elements["refresh-button"].addEventListener("click", readCurrentConversation);
elements["retry-button"].addEventListener("click", readCurrentConversation);
elements["settings-button"].addEventListener("click", openSettings);
elements["edit-destination-button"].addEventListener("click", openSettings);
elements["close-settings-button"].addEventListener("click", closeSettings);
elements["cancel-settings-button"].addEventListener("click", closeSettings);
elements["settings-form"].addEventListener("submit", applySettings);
elements["silent-open-input"].addEventListener("change", applyInlineSettings);
elements["detailed-metadata-input"].addEventListener("change", applyInlineSettings);
elements["save-button"].addEventListener("click", saveToObsidian);
elements["copy-button"].addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  copyMarkdown();
});
elements["download-button"].addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  downloadMarkdown();
});
elements["preview-toggle-button"].addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  elements["preview-section"].open = !elements["preview-section"].open;
});
elements["preview-section"].addEventListener("toggle", () => {
  const expanded = elements["preview-section"].open;
  const label = expanded ? "收起 Markdown" : "展开 Markdown";
  elements["preview-toggle-button"].setAttribute("aria-expanded", String(expanded));
  elements["preview-toggle-button"].setAttribute("aria-label", label);
  elements["preview-toggle-button"].title = label;
});
document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isEditing = target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  const hasSaveModifier = state.isMac ? event.metaKey : event.ctrlKey;
  if (
    event.key !== "Enter"
    || !hasSaveModifier
    || isEditing
    || elements["settings-dialog"].open
    || elements["save-button"].disabled
  ) return;
  event.preventDefault();
  saveToObsidian();
});

await configure();
await readCurrentConversation();
