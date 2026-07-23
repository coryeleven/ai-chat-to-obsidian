import test from "node:test";
import assert from "node:assert/strict";

import {
  buildObsidianNewUri,
  isObsidianNewUri,
  normalizeObsidianFolder,
} from "../src/obsidian.js";
import {
  handleRuntimeMessage,
  isChatGptUrl,
  isSupportedConversationUrl,
  openObsidianUri,
  respondToOpenObsidianUri,
} from "../background.js";

test("normalizes a folder relative to the selected Obsidian vault", () => {
  assert.equal(normalizeObsidianFolder(" /Clippings\\ChatGPT// ./ "), "Clippings/ChatGPT");
  assert.equal(normalizeObsidianFolder(""), "");
  assert.equal(normalizeObsidianFolder(null), "");
  assert.throws(() => normalizeObsidianFolder("../Private"), /inside the Obsidian vault/);
  assert.throws(() => normalizeObsidianFolder("Notes\0Hidden"), /control characters/);
});

test("builds an encoded Obsidian new-note URI with clipboard flags", () => {
  const uri = buildObsidianNewUri({
    file: "ChatGPT/更好用的网盘工具.md",
    vault: "Cory Notes",
    clipboard: true,
    overwrite: true,
    silent: true,
    clipboardFallback: "Clipboard unavailable. Use Copy Markdown.",
  });
  const parsed = new URL(uri);

  assert.equal(
    uri,
    "obsidian://new?file=ChatGPT%2F%E6%9B%B4%E5%A5%BD%E7%94%A8%E7%9A%84%E7%BD%91%E7%9B%98%E5%B7%A5%E5%85%B7.md&overwrite=true&vault=Cory%20Notes&silent=true&clipboard&content=Clipboard%20unavailable.%20Use%20Copy%20Markdown.",
  );
  assert.equal(uri.includes("+"), false);
  assert.equal(uri.includes("clipboard="), false);
  assert.equal(parsed.protocol, "obsidian:");
  assert.equal(parsed.hostname, "new");
  assert.equal(parsed.searchParams.get("file"), "ChatGPT/更好用的网盘工具.md");
  assert.equal(parsed.searchParams.get("vault"), "Cory Notes");
  assert.equal(parsed.searchParams.has("clipboard"), true);
  assert.equal(parsed.searchParams.get("overwrite"), "true");
  assert.equal(parsed.searchParams.get("silent"), "true");
  assert.equal(parsed.searchParams.get("content"), "Clipboard unavailable. Use Copy Markdown.");
  assert.equal(isObsidianNewUri(uri), true);
});

test("omits optional vault and disabled behavior flags", () => {
  const parsed = new URL(buildObsidianNewUri({
    file: "Inbox/Conversation.md",
    clipboard: false,
  }));

  assert.equal(parsed.searchParams.has("vault"), false);
  assert.equal(parsed.searchParams.has("clipboard"), false);
  assert.equal(parsed.searchParams.has("overwrite"), false);
  assert.equal(parsed.searchParams.has("silent"), false);
  assert.throws(() => buildObsidianNewUri({ file: "../Outside.md" }), /inside the Obsidian vault/);
});

test("opens an Obsidian new-note URI from a supplied ChatGPT tab", async () => {
  const calls = [];
  const api = {
    tabs: {
      async get(tabId) {
        calls.push(["get", tabId]);
        return { id: tabId, url: "https://chatgpt.com/c/conversation-1" };
      },
      async update(tabId, options) {
        calls.push(["update", tabId, options]);
      },
    },
  };
  const uri = buildObsidianNewUri({ file: "ChatGPT/Conversation.md" });

  assert.equal(await openObsidianUri(api, { tabId: 42, provider: "chatgpt", uri }), 42);
  assert.deepEqual(calls, [
    ["get", 42],
    ["update", 42, { url: uri }],
  ]);
});

test("opens an Obsidian URI from a matching Gemini tab", async () => {
  const calls = [];
  const api = {
    tabs: {
      async get(tabId) {
        calls.push(["get", tabId]);
        return { id: tabId, url: "https://gemini.google.com/app/a91c42ef" };
      },
      async update(tabId, options) {
        calls.push(["update", tabId, options]);
      },
    },
  };
  const uri = buildObsidianNewUri({ file: "Gemini/Research.md" });

  assert.equal(await openObsidianUri(api, { tabId: 43, provider: "gemini", uri }), 43);
  assert.deepEqual(calls, [
    ["get", 43],
    ["update", 43, { url: uri }],
  ]);
});

test("does not navigate an unsupported tab or accept another protocol", async () => {
  let updated = false;
  const api = {
    tabs: {
      async get() { return { url: "https://example.com/" }; },
      async update() { updated = true; },
    },
  };

  assert.equal(isChatGptUrl("https://chat.openai.com/c/1"), true);
  assert.equal(isSupportedConversationUrl("https://gemini.google.com/app/a91c42ef"), true);
  assert.equal(isChatGptUrl("http://chatgpt.com/c/1"), false);
  assert.equal(isSupportedConversationUrl("https://gemini.google.com.evil.test/app/1"), false);
  assert.equal(isSupportedConversationUrl("https://gemini.google.com@evil.test/app/1"), false);
  assert.equal(isObsidianNewUri("https://example.com"), false);

  const rejectedTab = await respondToOpenObsidianUri({
    tabId: 7,
    uri: "obsidian://new?file=Conversation.md&clipboard",
  }, api);
  assert.equal(rejectedTab.ok, false);
  assert.match(rejectedTab.error, /no longer a supported AI conversation/);

  const rejectedUri = await respondToOpenObsidianUri({
    tabId: 7,
    uri: "https://example.com/",
  }, api);
  assert.equal(rejectedUri.ok, false);
  assert.match(rejectedUri.error, /Only obsidian:\/\/new/);
  assert.equal(updated, false);
});

test("rejects a provider mismatch without navigating the source tab", async () => {
  let updated = false;
  const api = {
    tabs: {
      async get() { return { url: "https://gemini.google.com/app/a91c42ef" }; },
      async update() { updated = true; },
    },
  };

  const response = await respondToOpenObsidianUri({
    tabId: 7,
    provider: "chatgpt",
    uri: "obsidian://new?file=Conversation.md&clipboard",
  }, api);

  assert.equal(response.ok, false);
  assert.match(response.error, /provider no longer matches/);
  assert.equal(updated, false);
});

test("keeps the existing Markdown download message route", async () => {
  const api = {
    downloads: {
      async download(options) {
        assert.equal(options.filename, "Conversation.md");
        assert.equal(options.saveAs, true);
        return 99;
      },
    },
  };

  const response = await handleRuntimeMessage({
    type: "download-markdown",
    markdown: "# Conversation",
    filename: "Conversation.md",
    saveAs: true,
  }, api);

  assert.deepEqual(response, { ok: true, downloadId: 99 });
  assert.equal(handleRuntimeMessage({ type: "unknown" }, api), undefined);
});
