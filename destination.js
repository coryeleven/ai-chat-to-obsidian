import {
  chooseDestination,
  ensureWritePermission,
  getDestinationHandle,
  getPendingExport,
  queryWritePermission,
} from "./src/file-store.js";
import {
  completePendingExport,
  isCompletedPendingExport,
  isPendingExport,
  isSafeChatGptReturnTarget,
  PendingExportBusyError,
} from "./src/export-flow.js";
import { getWebExtensionApi } from "./src/webext.js";

const folderName = document.getElementById("setup-folder-name");
const folderStatus = document.getElementById("folder-status");
const permissionLabel = document.getElementById("setup-permission");
const errorPanel = document.getElementById("setup-error");
const title = document.getElementById("setup-title");
const saveResult = document.getElementById("save-result");
const savedFilenameLabel = document.getElementById("saved-filename");
const primaryButton = document.getElementById("setup-primary-button");
const primaryButtonLabel = document.getElementById("setup-primary-label");
const changeButton = document.getElementById("setup-change-button");
const closeButton = document.getElementById("setup-close-button");
const closeButtonLabel = document.getElementById("setup-close-label");

const query = new URLSearchParams(window.location.search);
const isDemo = query.has("demo");
const demoTheme = query.get("theme");
const intent = query.get("intent") === "save" ? "save" : "setup";
const saveRequestId = intent === "save" ? query.get("saveRequest") : null;
const webExtensionApi = getWebExtensionApi();

let handle = null;
let permission = "prompt";
let pendingExport = null;
let sourceTabId = Number.parseInt(query.get("sourceTabId") || "", 10);
let sourceUrl = "";
let saveState = "idle";
let savedFilename = "";
let busy = false;
let requestUnavailable = false;
const ownerId = globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

if (!Number.isInteger(sourceTabId)) sourceTabId = null;
if (isDemo && demoTheme === "light") document.documentElement.dataset.theme = "light";

function showError(error) {
  const message = error instanceof PendingExportBusyError
    ? "此对话正在另一个授权页面中保存，请稍候再重试。"
    : error instanceof Error
      ? error.message
      : String(error);
  errorPanel.textContent = message;
  errorPanel.hidden = false;
}

function setBusy(nextBusy) {
  busy = nextBusy;
  primaryButton.disabled = nextBusy;
  changeButton.disabled = nextBusy;
  closeButton.disabled = nextBusy;
}

function render() {
  const authorized = permission === "granted";
  const saveFailed = saveState === "error";
  const returnIsPrimary = requestUnavailable
    || saveState === "saved"
    || (authorized && !saveFailed && saveState !== "saving");

  folderName.textContent = handle?.name || "尚未选择";
  folderName.title = handle?.name || "";
  folderName.setAttribute("aria-label", `当前目录：${handle?.name || "尚未选择"}`);
  folderStatus.dataset.state = permission;
  permissionLabel.dataset.state = permission;
  permissionLabel.textContent = authorized ? "已授权" : handle ? "需要授权" : "未授权";

  title.textContent = saveState === "saved"
    ? "已保存到 Obsidian"
    : saveState === "saving"
      ? "正在保存到 Obsidian"
      : saveState === "error"
        ? "保存未完成"
        : "选择 Obsidian 保存目录";

  saveResult.hidden = saveState !== "saved";
  savedFilenameLabel.textContent = savedFilename;
  savedFilenameLabel.title = savedFilename;

  primaryButtonLabel.textContent = saveFailed
    ? "重试保存"
    : !handle
      ? "选择目录"
      : "授权此目录";
  primaryButton.hidden = requestUnavailable || (authorized && !saveFailed);
  primaryButton.disabled = busy;
  changeButton.hidden = requestUnavailable || !handle || saveState === "saving" || saveState === "saved";

  closeButton.classList.toggle("primary-button", returnIsPrimary);
  closeButton.classList.toggle("quiet-button", !returnIsPrimary);
  closeButtonLabel.textContent = Number.isInteger(sourceTabId) ? "返回对话" : "关闭此页";
}

async function loadState() {
  try {
    [handle, pendingExport] = await Promise.all([
      getDestinationHandle(),
      intent === "save" && saveRequestId ? getPendingExport(saveRequestId) : Promise.resolve(null),
    ]);
    permission = await queryWritePermission(handle);
    if (!Number.isInteger(sourceTabId) && Number.isInteger(pendingExport?.sourceTabId)) {
      sourceTabId = pendingExport.sourceTabId;
    }
    sourceUrl = typeof pendingExport?.sourceUrl === "string" ? pendingExport.sourceUrl : "";
    if (intent === "save" && isCompletedPendingExport(pendingExport)) {
      saveState = "saved";
      savedFilename = pendingExport.filename;
    } else if (intent === "save" && (!saveRequestId || !pendingExport || pendingExport.status === "expired")) {
      requestUnavailable = true;
      saveState = "error";
      showError(new Error(
        pendingExport?.status === "expired"
          ? "待保存的对话已过期，请返回 ChatGPT 后重试。"
          : "待保存的对话已失效，请返回 ChatGPT 后重试。",
      ));
    }
  } catch {
    handle = null;
    permission = "prompt";
  }
  render();
}

async function savePendingConversation() {
  if (intent !== "save" || saveState === "saved") return;
  if (!saveRequestId) throw new Error("待保存的对话已失效，请返回 ChatGPT 后重试。");
  if (!pendingExport) pendingExport = await getPendingExport(saveRequestId);
  if (isCompletedPendingExport(pendingExport)) {
    savedFilename = pendingExport.filename;
    saveState = "saved";
    render();
    return;
  }
  if (!isPendingExport(pendingExport)) {
    throw new Error("待保存的对话已失效，请返回 ChatGPT 后重试。");
  }

  saveState = "saving";
  render();
  try {
    pendingExport = await completePendingExport(saveRequestId, ownerId, handle);
    savedFilename = pendingExport.filename;
    sourceUrl = typeof pendingExport.sourceUrl === "string" ? pendingExport.sourceUrl : sourceUrl;
    saveState = "saved";
  } catch (error) {
    saveState = "error";
    throw error;
  } finally {
    render();
  }
}

async function authorizeCurrent() {
  errorPanel.hidden = true;
  setBusy(true);
  try {
    if (!handle) handle = await chooseDestination();
    const granted = await ensureWritePermission(handle);
    permission = granted ? "granted" : "denied";
    if (!granted) throw new Error("未获得此目录的写入权限。");
    await savePendingConversation();
  } catch (error) {
    if (error?.name !== "AbortError") showError(error);
  } finally {
    setBusy(false);
    render();
  }
}

async function changeDirectory() {
  errorPanel.hidden = true;
  setBusy(true);
  try {
    handle = await chooseDestination();
    const granted = await ensureWritePermission(handle);
    permission = granted ? "granted" : "denied";
    if (!granted) throw new Error("未获得此目录的写入权限。");
    await savePendingConversation();
  } catch (error) {
    if (error?.name !== "AbortError") showError(error);
  } finally {
    setBusy(false);
    render();
  }
}

async function returnToConversation() {
  setBusy(true);
  let currentTabId = null;
  try {
    const currentTab = await webExtensionApi?.tabs?.getCurrent?.();
    currentTabId = Number.isInteger(currentTab?.id) ? currentTab.id : null;
    if (Number.isInteger(sourceTabId) && webExtensionApi?.tabs?.get && webExtensionApi.tabs.update) {
      const sourceTab = await webExtensionApi.tabs.get(sourceTabId);
      if (isSafeChatGptReturnTarget(sourceTab?.url, sourceUrl)) {
        await webExtensionApi.tabs.update(sourceTabId, { active: true });
        if (Number.isInteger(sourceTab.windowId) && webExtensionApi?.windows?.update) {
          try { await webExtensionApi.windows.update(sourceTab.windowId, { focused: true }); } catch {}
        }
      }
    }
  } catch {
    // Closing the setup tab still returns to the previously active browser tab.
  } finally {
    try {
      if (Number.isInteger(currentTabId) && webExtensionApi?.tabs?.remove) {
        await webExtensionApi.tabs.remove(currentTabId);
      } else {
        window.close();
      }
    } catch {
      window.close();
    }
    setBusy(false);
  }
}

primaryButton.addEventListener("click", authorizeCurrent);
changeButton.addEventListener("click", changeDirectory);
closeButton.addEventListener("click", returnToConversation);

if (isDemo) {
  handle = { name: "ChatGPT" };
  permission = "granted";
  if (intent === "save") {
    sourceTabId = Number.isInteger(sourceTabId) ? sourceTabId : 42;
    saveState = "saved";
    savedFilename = "设计一个可靠的任务队列 [7a2f19c4].md";
  }
  render();
} else if (typeof window.showDirectoryPicker !== "function") {
  showError("当前浏览器不支持直接写入目录，请在 Chrome 或 Edge 桌面版中使用此扩展。");
  primaryButton.disabled = true;
  changeButton.disabled = true;
} else {
  await loadState();
  if (intent === "save" && permission === "granted") {
    setBusy(true);
    try {
      await savePendingConversation();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      render();
    }
  }
}
