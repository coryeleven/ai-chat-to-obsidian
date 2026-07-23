import { markdownToDataUrl, startMarkdownDownload } from "./src/download.js";
import { isObsidianNewUri } from "./src/obsidian.js";
import { providerById, providerForUrl } from "./src/providers.js";

const api = globalThis.browser || globalThis.chrome || null;

function respondToDownload(message, extensionApi = api) {
  return startMarkdownDownload(extensionApi, message)
    .then((downloadId) => ({ ok: true, downloadId }))
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
}

function isSupportedConversationUrl(value) {
  return Boolean(providerForUrl(value));
}

const isChatGptUrl = isSupportedConversationUrl;

async function openObsidianUri(extensionApi, message) {
  if (!extensionApi?.tabs?.get || !extensionApi?.tabs?.update) {
    throw new Error("The browser tabs API is unavailable.");
  }
  if (!Number.isInteger(message?.tabId) || message.tabId < 0) {
    throw new Error("A valid conversation tab ID is required.");
  }
  if (!isObsidianNewUri(message?.uri)) {
    throw new Error("Only obsidian://new URIs can be opened.");
  }

  const tab = await extensionApi.tabs.get(message.tabId);
  const tabProvider = providerForUrl(tab?.url);
  if (!tabProvider) {
    throw new Error("The target tab is no longer a supported AI conversation.");
  }
  const requestedProvider = providerById(message?.provider);
  if (!requestedProvider) {
    throw new Error("A supported conversation provider is required.");
  }
  if (requestedProvider.id !== tabProvider.id) {
    throw new Error("The target tab provider no longer matches the exported conversation.");
  }

  await extensionApi.tabs.update(message.tabId, { url: message.uri });
  return message.tabId;
}

function respondToOpenObsidianUri(message, extensionApi = api) {
  return openObsidianUri(extensionApi, message)
    .then((tabId) => ({ ok: true, tabId }))
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
}

function handleRuntimeMessage(message, extensionApi = api) {
  if (message?.type === "download-markdown") {
    return respondToDownload(message, extensionApi);
  }
  if (message?.type === "open-obsidian-uri") {
    return respondToOpenObsidianUri(message, extensionApi);
  }
  return undefined;
}

if (api?.runtime?.onMessage) {
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const response = handleRuntimeMessage(message);
    if (!response) return undefined;
    if (globalThis.browser) return response;

    response.then(sendResponse);
    return true;
  });
}

export {
  handleRuntimeMessage,
  isChatGptUrl,
  isSupportedConversationUrl,
  markdownToDataUrl,
  openObsidianUri,
  respondToDownload,
  respondToOpenObsidianUri,
};
