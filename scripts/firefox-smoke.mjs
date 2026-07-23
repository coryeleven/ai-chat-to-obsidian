import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const port = process.argv[2] || "9224";
const profilePath = process.argv[3] || "/tmp/chatgpt-to-obsidian-firefox";
const extensionPath = path.resolve(process.argv[4] || "dist/firefox");
const screenshotDirectory = process.env.SMOKE_SCREENSHOT_DIR
  ? path.resolve(process.env.SMOKE_SCREENSHOT_DIR)
  : "";
const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
const pending = new Map();
const logErrors = [];
let commandId = 0;

function send(method, params = {}) {
  const id = ++commandId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.type === "success" && pending.has(message.id)) {
    pending.get(message.id).resolve(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.type === "error" && pending.has(message.id)) {
    pending.get(message.id).reject(new Error(`${message.error}: ${message.message}`));
    pending.delete(message.id);
    return;
  }
  if (message.type === "event" && message.method === "log.entryAdded") {
    if (message.params?.level === "error") logErrors.push(message.params.text);
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let session;
let installed;
const extensionUrls = [];
const states = {};

try {
  session = await send("session.new", { capabilities: { alwaysMatch: {} } });
  installed = await send("webExtension.install", {
    extensionData: { type: "path", path: extensionPath },
  });
  await send("session.subscribe", { events: ["log.entryAdded"] });

  async function readExtensionUuid() {
    try {
      const prefs = await readFile(path.join(profilePath, "prefs.js"), "utf8");
      const encoded = prefs.match(/user_pref\("extensions\.webextensions\.uuids", "(.*)"\);/)?.[1];
      if (!encoded) return "";
      const mappings = JSON.parse(JSON.parse(`"${encoded}"`));
      return mappings[installed.extension] || "";
    } catch {
      return "";
    }
  }

  let extensionUuid = "";
  for (let attempt = 0; attempt < 40 && !extensionUuid; attempt += 1) {
    extensionUuid = await readExtensionUuid();
    if (!extensionUuid) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!extensionUuid) throw new Error(`Firefox did not persist a moz-extension UUID for ${installed.extension}.`);

  const tree = await send("browsingContext.getTree");
  let context = tree.contexts[0]?.context;
  if (!context) {
    const created = await send("browsingContext.create", { type: "tab" });
    context = created.context;
  }
  if (!context) throw new Error("Firefox could not create a top-level browsing context.");
  await send("browsingContext.setViewport", {
    context,
    viewport: { width: 400, height: 600 },
    devicePixelRatio: 1,
  });
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });

  for (const provider of ["chatgpt", "gemini"]) {
    const theme = provider === "gemini" ? "dark" : "light";
    const extensionUrl = `moz-extension://${extensionUuid}/popup.html?demo=1&browser=firefox&provider=${provider}&detailed=1&theme=${theme}`;
    extensionUrls.push(extensionUrl);
    await send("browsingContext.navigate", { context, url: extensionUrl, wait: "complete" });

    const evaluated = await send("script.evaluate", {
      expression: `(async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (!document.querySelector('#conversation-view')?.hidden) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await new Promise(resolve => setTimeout(resolve, 280));
        const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
        const rect = selector => {
          const value = document.querySelector(selector)?.getBoundingClientRect();
          return value ? {
            top: value.top,
            right: value.right,
            bottom: value.bottom,
            left: value.left,
            width: value.width,
            height: value.height,
          } : null;
        };
        const isVisibleInViewport = value => Boolean(value
          && value.top >= 0
          && value.left >= 0
          && value.right <= innerWidth
          && value.bottom <= innerHeight);
        const sameRect = (first, second) => Boolean(first && second
          && Math.abs(first.top - second.top) < 0.5
          && Math.abs(first.right - second.right) < 0.5
          && Math.abs(first.bottom - second.bottom) < 0.5
          && Math.abs(first.left - second.left) < 0.5);
        const dispatchSaveShortcut = target => {
          const usesMetaKey = document.querySelector('#save-shortcut')?.textContent.includes('⌘');
          const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            metaKey: usesMetaKey,
            ctrlKey: !usesMetaKey,
            bubbles: true,
            cancelable: true,
          });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };

        const markdown = document.querySelector('#markdown-preview')?.textContent || '';
        const details = document.querySelector('#preview-section');
        const saveSettingsSection = document.querySelector('#save-settings-section');
        const propertyValues = Object.fromEntries([...document.querySelectorAll('.property-row')]
          .map(row => [row.dataset.property, row.querySelector('dd')?.textContent || '']));
        const propertyNames = Object.keys(propertyValues);
        const scrollContainer = document.querySelector('.conversation-scroll');
        const saveButton = document.querySelector('#save-button');
        const topbarBefore = rect('.topbar');
        const footerBefore = rect('.action-dock');
        const saveBefore = rect('#save-button');
        const copyRect = rect('#copy-button');
        const downloadRect = rect('#download-button');
        const toggleRect = rect('#preview-toggle-button');
        const state = {
          runtimeId: browser.runtime.id,
          version: browser.runtime.getManifest().version,
          browserKind: document.body.dataset.browser,
          brand: document.querySelector('.brand h1')?.textContent || '',
          title: document.querySelector('#conversation-title')?.textContent || '',
          messageMeta: document.querySelector('#conversation-meta')?.textContent || '',
          extractionBadge: document.querySelector('#extraction-badge')?.textContent || '',
          destinationLabel: document.querySelector('.destination-copy .eyebrow')?.textContent || '',
          destinationName: document.querySelector('#destination-name')?.textContent || '',
          settingsButtonVisible: Boolean(document.querySelector('#settings-button')),
          previewOpen: details?.open,
          previewExpanded: document.querySelector('#preview-toggle-button')?.getAttribute('aria-expanded'),
          previewToggleLabel: document.querySelector('#preview-toggle-button')?.getAttribute('aria-label'),
          bodyPreviewOpen: document.querySelector('#markdown-body-section')?.open,
          previewBeforeSaveSettings: Boolean(details && saveSettingsSection
            && (details.compareDocumentPosition(saveSettingsSection) & 4)),
          destinationInsideSaveSettings: Boolean(saveSettingsSection
            && saveSettingsSection.contains(document.querySelector('#edit-destination-button'))),
          silentOpenChecked: document.querySelector('#silent-open-input')?.checked,
          detailedMetadataChecked: document.querySelector('#detailed-metadata-input')?.checked,
          propertyNames,
          propertyValues,
          hasInventedProperties: propertyNames.some(name => ['author', 'published', 'description'].includes(name)),
          saveText: saveButton?.textContent.trim() || '',
          saveShortcut: document.querySelector('#save-shortcut')?.textContent.trim() || '',
          viewport: { width: innerWidth, height: innerHeight },
          htmlSize: {
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
          },
          bodySize: {
            width: document.body.getBoundingClientRect().width,
            height: document.body.getBoundingClientRect().height,
          },
          pageInitiallyUnscrolled: scrollX === 0
            && scrollY === 0
            && document.documentElement.scrollTop === 0
            && document.body.scrollTop === 0,
          pageInitiallyContained: document.documentElement.scrollWidth <= innerWidth
            && document.documentElement.scrollHeight <= innerHeight
            && document.body.scrollWidth <= innerWidth
            && document.body.scrollHeight <= innerHeight,
          topbarHeight: topbarBefore?.height || 0,
          topbarVisible: isVisibleInViewport(topbarBefore),
          footerVisible: isVisibleInViewport(footerBefore),
          saveButtonHeight: saveBefore?.height || 0,
          saveButtonVisible: isVisibleInViewport(saveBefore),
          actionButtonSizes: [copyRect, downloadRect, toggleRect].map(value => ({
            width: value?.width || 0,
            height: value?.height || 0,
          })),
          actionButtonsAligned: Boolean(copyRect && downloadRect && toggleRect
            && Math.abs(copyRect.top - downloadRect.top) < 0.5
            && Math.abs(copyRect.top - toggleRect.top) < 0.5
            && copyRect.right <= downloadRect.left
            && downloadRect.right <= toggleRect.left),
          markdownLength: markdown.length,
          markdownLines: markdown.split('\\n').length,
          providerProperty: propertyValues.provider || '',
          providerTag: propertyValues.tags?.split(' · ')[0] || '',
          userSections: (markdown.match(/^## User$/gm) || []).length,
          assistantSections: (markdown.match(/^## Assistant$/gm) || []).length,
          markdownBytes: Number(document.querySelector('#conversation-view')?.dataset.markdownBytes || 0),
          markdownSections: Number(document.querySelector('#conversation-view')?.dataset.markdownSections || 0),
          popupHeight: document.body.scrollHeight,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          backgroundResponse: await browser.runtime.sendMessage({
            type: 'download-markdown', markdown: '', filename: 'smoke.md', saveAs: false
          })
        };

        document.querySelector('#copy-button').click();
        await delay(60);
        state.copyKeptPreviewOpen = details.open === true;
        document.querySelector('#download-button').click();
        await delay(60);
        state.downloadKeptPreviewOpen = details.open === true;

        const detailedInput = document.querySelector('#detailed-metadata-input');
        const detailedBytes = Number(document.querySelector('#conversation-view')?.dataset.markdownBytes || 0);
        detailedInput.click();
        await delay(40);
        state.compactProperties = [...document.querySelectorAll('.property-row')]
          .map(row => row.dataset.property);
        state.compactBytesReduced = Number(document.querySelector('#conversation-view')?.dataset.markdownBytes || 0)
          < detailedBytes;
        state.compactToggleUnchecked = detailedInput.checked === false;
        detailedInput.click();
        await delay(40);
        state.detailedPropertiesRestored = document.querySelectorAll('.property-row').length === propertyNames.length
          && Boolean(document.querySelector('.property-row[data-property="provider"]'))
          && detailedInput.checked === true;

        document.querySelector('#preview-toggle-button').click();
        await delay(240);
        state.previewClosed = details.open === false
          && document.querySelector('#preview-toggle-button').getAttribute('aria-expanded') === 'false';
        document.querySelector('#preview-toggle-button').click();
        await delay(240);
        state.previewReopened = details.open === true
          && document.querySelector('#preview-toggle-button').getAttribute('aria-expanded') === 'true';
        state.contentHasVerticalOverflow = scrollContainer.scrollHeight > scrollContainer.clientHeight;
        state.verticalScrollers = [...document.querySelectorAll('*')]
          .filter(element => {
            const overflowY = getComputedStyle(element).overflowY;
            return /^(auto|scroll)$/.test(overflowY)
              && element.scrollHeight > element.clientHeight + 1;
          })
          .map(element => element.id || element.className)
          .filter(value => typeof value === 'string');
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const topbarAfterScroll = rect('.topbar');
        const footerAfterScroll = rect('.action-dock');
        state.contentScrolled = scrollContainer.scrollTop > 0;
        state.windowStayedUnscrolled = scrollX === 0
          && scrollY === 0
          && document.documentElement.scrollTop === 0
          && document.body.scrollTop === 0;
        state.pageStayedContained = document.documentElement.scrollWidth <= innerWidth
          && document.documentElement.scrollHeight <= innerHeight
          && document.body.scrollWidth <= innerWidth
          && document.body.scrollHeight <= innerHeight;
        state.headerFixedDuringContentScroll = sameRect(topbarBefore, topbarAfterScroll);
        state.footerFixedDuringContentScroll = sameRect(footerBefore, footerAfterScroll)
          && isVisibleInViewport(footerAfterScroll);
        scrollContainer.scrollTop = 0;
        await delay(60);
        state.previewStayedOpen = details.open === true;

        // Preserve the existing click-driven success checks.
        saveButton.click();
        await delay(460);
        state.saveSuccessState = saveButton.dataset.state;
        state.saveSuccessDisabled = saveButton.disabled;
        dispatchSaveShortcut(document);
        state.successShortcutState = saveButton.dataset.state;

        await delay(1600);
        state.returnedToIdleAfterClick = saveButton.dataset.state === 'idle' && !saveButton.disabled;

        document.querySelector('#settings-button').click();
        const settingsInput = document.querySelector('#vault-input');
        settingsInput.focus();
        state.inputShortcutPreventedDefault = dispatchSaveShortcut(settingsInput);
        await delay(30);
        state.inputShortcutIgnored = saveButton.dataset.state === 'idle'
          && !saveButton.disabled
          && document.querySelector('#settings-dialog').open;
        document.querySelector('#close-settings-button').click();

        state.idleShortcutPreventedDefault = dispatchSaveShortcut(document);
        state.shortcutLoadingState = saveButton.dataset.state;
        state.shortcutLoadingDisabled = saveButton.disabled;
        state.shortcutLoadingAriaBusy = saveButton.getAttribute('aria-busy');
        state.repeatedShortcutPreventedDefault = dispatchSaveShortcut(document);
        state.repeatedShortcutState = saveButton.dataset.state;
        state.repeatedShortcutDisabled = saveButton.disabled;
        await delay(460);
        state.shortcutSuccessState = saveButton.dataset.state;
        state.shortcutSuccessDisabled = saveButton.disabled;
        state.shortcutSuccessAriaBusy = saveButton.getAttribute('aria-busy');
        await delay(1600);
        state.shortcutReturnedToIdle = saveButton.dataset.state === 'idle'
          && !saveButton.disabled
          && saveButton.getAttribute('aria-busy') === 'false';
        return JSON.stringify(state);
      })()`,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (evaluated.result?.type !== "string") {
      throw new Error(`Unexpected script result: ${JSON.stringify(evaluated)}`);
    }
    states[provider] = JSON.parse(evaluated.result.value);

    if (screenshotDirectory) {
      await send("browsingContext.setViewport", {
        context,
        viewport: { width: 400, height: 600 },
        devicePixelRatio: 1,
      });
      const screenshot = await send("browsingContext.captureScreenshot", {
        context,
        origin: "viewport",
      });
      const filename = provider === "chatgpt" ? "popup-preview.png" : "firefox-popup-preview.png";
      await writeFile(path.join(screenshotDirectory, filename), Buffer.from(screenshot.data, "base64"));

      if (provider === "gemini") {
        await send("script.evaluate", {
          expression: "document.querySelector('.conversation-scroll').scrollTop = document.querySelector('.conversation-scroll').scrollHeight; true",
          target: { context },
          awaitPromise: false,
          resultOwnership: "none",
        });
        await send("browsingContext.setViewport", {
          context,
          viewport: { width: 400, height: 600 },
          devicePixelRatio: 1,
        });
        const settingsScreenshot = await send("browsingContext.captureScreenshot", {
          context,
          origin: "viewport",
        });
        await writeFile(
          path.join(screenshotDirectory, "save-settings-preview.png"),
          Buffer.from(settingsScreenshot.data, "base64"),
        );
        await send("script.evaluate", {
          expression: "document.querySelector('.conversation-scroll').scrollTop = 0; true",
          target: { context },
          awaitPromise: false,
          resultOwnership: "none",
        });
      }
      await send("browsingContext.setViewport", {
        context,
        viewport: { width: 400, height: 600 },
        devicePixelRatio: 1,
      });
    }
  }

  const errorUrl = `moz-extension://${extensionUuid}/popup.html?demo=1&browser=firefox&provider=chatgpt&detailed=1&theme=dark&demoSave=error`;
  extensionUrls.push(errorUrl);
  await send("browsingContext.navigate", { context, url: errorUrl, wait: "complete" });
  const errorEvaluation = await send("script.evaluate", {
    expression: `(async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!document.querySelector('#conversation-view')?.hidden) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const saveButton = document.querySelector('#save-button');
      const state = {
        initialState: saveButton?.dataset.state || '',
        initialDisabled: saveButton?.disabled,
      };
      saveButton.click();
      state.loadingState = saveButton.dataset.state;
      state.loadingDisabled = saveButton.disabled;
      state.loadingAriaBusy = saveButton.getAttribute('aria-busy');
      await new Promise(resolve => setTimeout(resolve, 460));
      state.errorState = saveButton.dataset.state;
      state.errorDisabled = saveButton.disabled;
      state.errorAriaBusy = saveButton.getAttribute('aria-busy');
      state.errorLabel = document.querySelector('#save-button-label')?.textContent || '';
      state.errorMessage = document.querySelector('#save-status-message')?.textContent.trim() || '';
      const rect = saveButton.getBoundingClientRect();
      state.errorButtonVisible = rect.top >= 0 && rect.bottom <= innerHeight;
      return JSON.stringify(state);
    })()`,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (errorEvaluation.result?.type !== "string") {
    throw new Error(`Unexpected error-state script result: ${JSON.stringify(errorEvaluation)}`);
  }
  states.error = JSON.parse(errorEvaluation.result.value);
} finally {
  if (installed?.extension) {
    try { await send("webExtension.uninstall", { extension: installed.extension }); } catch {}
  }
  if (session) {
    try { await send("session.end"); } catch {}
  }
  socket.close();
}

const popupStatesPassed = ["chatgpt", "gemini"].every((provider) => {
  const state = states[provider];
  return state?.runtimeId === "chatgpt-to-obsidian@local"
    && state.version === "0.5.0"
    && state.browserKind === "firefox"
    && state.brand === "AI Chat to Obsidian"
    && state.messageMeta === `8 条消息 · 4 轮对话 · ${provider === "gemini" ? "Gemini" : "ChatGPT"}`
    && state.extractionBadge === "页面已解析"
    && state.destinationLabel === "保存到"
    && state.destinationName === "当前仓库 / AI Chats"
    && state.settingsButtonVisible === true
    && state.previewOpen === true
    && state.previewExpanded === "true"
    && state.previewToggleLabel === "收起 Markdown"
    && state.bodyPreviewOpen === false
    && state.previewBeforeSaveSettings === true
    && state.destinationInsideSaveSettings === true
    && state.silentOpenChecked === true
    && state.detailedMetadataChecked === true
    && state.propertyNames?.join(",") === "title,source,conversation_id,provider,created,updated,imported,messages,rounds,extraction,tags"
    && state.propertyValues?.title === (provider === "gemini"
      ? "把研究资料整理成可执行方案"
      : "设计一个可靠的任务队列")
    && state.propertyValues?.source?.includes(provider === "gemini" ? "gemini.google.com" : "chatgpt.com")
    && /^\d{4}-\d{2}-\d{2}$/.test(state.propertyValues?.created || "")
    && state.propertyValues?.tags === provider + " · ai-conversation"
    && state.hasInventedProperties === false
    && state.saveText.startsWith("保存到 Obsidian")
    && /^(⌘ ↵|Ctrl ↵)$/.test(state.saveShortcut)
    && state.viewport?.width === 400
    && state.viewport?.height === 600
    && state.htmlSize?.width === 400
    && state.htmlSize?.height === 600
    && state.bodySize?.width === 400
    && state.bodySize?.height === 600
    && state.pageInitiallyUnscrolled === true
    && state.pageInitiallyContained === true
    && state.topbarHeight === 52
    && state.topbarVisible === true
    && state.footerVisible === true
    && state.saveButtonHeight === 52
    && state.saveButtonVisible === true
    && state.actionButtonSizes?.length === 3
    && state.actionButtonSizes.every(({ width, height }) => width === 32 && height === 32)
    && state.actionButtonsAligned === true
    && state.copyKeptPreviewOpen === true
    && state.downloadKeptPreviewOpen === true
    && state.compactProperties?.join(",") === "title,source,conversation_id,tags"
    && state.compactBytesReduced === true
    && state.compactToggleUnchecked === true
    && state.detailedPropertiesRestored === true
    && state.previewClosed === true
    && state.previewReopened === true
    && state.contentHasVerticalOverflow === true
    && state.verticalScrollers?.length === 1
    && state.verticalScrollers[0] === "conversation-scroll"
    && state.contentScrolled === true
    && state.windowStayedUnscrolled === true
    && state.pageStayedContained === true
    && state.headerFixedDuringContentScroll === true
    && state.footerFixedDuringContentScroll === true
    && state.previewStayedOpen === true
    && state.saveSuccessState === "success"
    && state.saveSuccessDisabled === true
    && state.successShortcutState === "success"
    && state.returnedToIdleAfterClick === true
    && state.inputShortcutPreventedDefault === false
    && state.inputShortcutIgnored === true
    && state.idleShortcutPreventedDefault === true
    && state.shortcutLoadingState === "loading"
    && state.shortcutLoadingDisabled === true
    && state.shortcutLoadingAriaBusy === "true"
    && state.repeatedShortcutPreventedDefault === false
    && state.repeatedShortcutState === "loading"
    && state.repeatedShortcutDisabled === true
    && state.shortcutSuccessState === "success"
    && state.shortcutSuccessDisabled === true
    && state.shortcutSuccessAriaBusy === "false"
    && state.shortcutReturnedToIdle === true
    && state.markdownLength > 600
    && state.markdownLines >= 50
    && state.providerProperty === provider
    && state.providerTag === provider
    && state.userSections === 4
    && state.assistantSections === 4
    && state.markdownBytes > 1200
    && state.markdownSections === 8
    && state.popupHeight === 600
    && state.horizontalOverflow === false
    && state.backgroundResponse?.ok === false
    && /No Markdown content/.test(state.backgroundResponse?.error || "");
});

const errorStatePassed = states.error?.initialState === "idle"
  && states.error.initialDisabled === false
  && states.error.loadingState === "loading"
  && states.error.loadingDisabled === true
  && states.error.loadingAriaBusy === "true"
  && states.error.errorState === "error"
  && states.error.errorDisabled === false
  && states.error.errorAriaBusy === "false"
  && states.error.errorLabel === "保存失败，重试"
  && states.error.errorMessage.length > 0
  && states.error.errorButtonVisible === true;

const passed = popupStatesPassed && errorStatePassed && logErrors.length === 0;

console.log(JSON.stringify({
  passed,
  browserVersion: session.capabilities?.browserVersion,
  extension: installed.extension,
  extensionUrls,
  states,
  logErrors,
}, null, 2));
if (!passed) process.exitCode = 1;
