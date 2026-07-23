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
    viewport: { width: 380, height: 500 },
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
        const markdown = document.querySelector('#markdown-preview')?.value || '';
        return JSON.stringify({
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
          previewOpen: document.querySelector('#preview-section')?.open,
          saveText: document.querySelector('#save-button')?.textContent.trim() || '',
          markdownLength: markdown.length,
          markdownLines: markdown.split('\\n').length,
          providerProperty: markdown.match(/^provider: "([^"]+)"$/m)?.[1] || '',
          providerTag: markdown.match(/^  - (chatgpt|gemini)$/m)?.[1] || '',
          userSections: (markdown.match(/^## User$/gm) || []).length,
          assistantSections: (markdown.match(/^## Assistant$/gm) || []).length,
          markdownBytes: Number(document.querySelector('#conversation-view')?.dataset.markdownBytes || 0),
          markdownSections: Number(document.querySelector('#conversation-view')?.dataset.markdownSections || 0),
          popupHeight: document.body.scrollHeight,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          backgroundResponse: await browser.runtime.sendMessage({
            type: 'download-markdown', markdown: '', filename: 'smoke.md', saveAs: false
          })
        });
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
        viewport: { width: 380, height: states[provider].popupHeight },
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
          expression: "document.querySelector('#settings-button').click(); true",
          target: { context },
          awaitPromise: false,
          resultOwnership: "none",
        });
        await send("browsingContext.setViewport", {
          context,
          viewport: { width: 380, height: 452 },
          devicePixelRatio: 1,
        });
        const settingsScreenshot = await send("browsingContext.captureScreenshot", {
          context,
          origin: "viewport",
        });
        await writeFile(
          path.join(screenshotDirectory, "destination-preview.png"),
          Buffer.from(settingsScreenshot.data, "base64"),
        );
      }
      await send("browsingContext.setViewport", {
        context,
        viewport: { width: 380, height: 500 },
        devicePixelRatio: 1,
      });
    }
  }
} finally {
  if (installed?.extension) {
    try { await send("webExtension.uninstall", { extension: installed.extension }); } catch {}
  }
  if (session) {
    try { await send("session.end"); } catch {}
  }
  socket.close();
}

const passed = ["chatgpt", "gemini"].every((provider) => {
  const state = states[provider];
  return state?.runtimeId === "chatgpt-to-obsidian@local"
    && state.version === "0.5.0"
    && state.browserKind === "firefox"
    && state.brand === "AI Chat to Obsidian"
    && state.messageMeta === "8 条消息 · 4 轮对话"
    && state.extractionBadge.startsWith(provider === "gemini" ? "Gemini ·" : "ChatGPT ·")
    && state.destinationLabel === "保存到"
    && state.destinationName === "当前 Vault / AI Chats"
    && state.settingsButtonVisible === true
    && state.previewOpen === false
    && state.saveText === "保存到 Obsidian"
    && state.markdownLength > 700
    && state.markdownLines >= 60
    && state.providerProperty === provider
    && state.providerTag === provider
    && state.userSections === 4
    && state.assistantSections === 4
    && state.markdownBytes > 1200
    && state.markdownSections === 8
    && state.popupHeight < 430
    && state.horizontalOverflow === false
    && state.backgroundResponse?.ok === false
    && /No Markdown content/.test(state.backgroundResponse?.error || "");
}) && logErrors.length === 0;

console.log(JSON.stringify({
  passed,
  browserVersion: session.capabilities?.browserVersion,
  extension: installed.extension,
  extensionUrls,
  states,
  logErrors,
}, null, 2));
if (!passed) process.exitCode = 1;
