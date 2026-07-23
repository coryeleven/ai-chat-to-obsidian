import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PROVIDERS,
  isSupportedProviderUrl,
  providerById,
  providerForUrl,
} from "../src/providers.js";

test("resolves the supported conversation providers", () => {
  assert.equal(providerById("chatgpt"), PROVIDERS.chatgpt);
  assert.equal(providerById("GEMINI"), PROVIDERS.gemini);
  assert.equal(providerById("unknown"), null);

  assert.equal(providerForUrl("https://chatgpt.com/c/conversation-1")?.id, "chatgpt");
  assert.equal(providerForUrl("https://chat.openai.com/share/conversation-1")?.id, "chatgpt");
  assert.equal(providerForUrl("https://gemini.google.com/app/a91c42ef")?.id, "gemini");
});

test("accepts only exact HTTPS provider hosts", () => {
  const rejected = [
    "http://gemini.google.com/app/a91c42ef",
    "https://gemini.google.com.evil.test/app/a91c42ef",
    "https://gemini.google.com@evil.test/app/a91c42ef",
    "https://accounts.google.com/",
    "https://example.com/?next=https://gemini.google.com/app/a91c42ef",
    "not a URL",
  ];

  for (const value of rejected) {
    assert.equal(providerForUrl(value), null, value);
    assert.equal(isSupportedProviderUrl(value), false, value);
  }
  assert.equal(isSupportedProviderUrl("https://gemini.google.com/app/a91c42ef"), true);
});

test("Chromium and Firefox manifests grant only the required conversation hosts", async () => {
  const allowedHosts = new Set([
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://gemini.google.com/*",
  ]);

  for (const filename of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = JSON.parse(await readFile(new URL(`../${filename}`, import.meta.url), "utf8"));
    assert.deepEqual(new Set(manifest.host_permissions), allowedHosts, filename);
  }
});
