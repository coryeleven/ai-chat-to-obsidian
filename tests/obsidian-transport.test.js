import test from "node:test";
import assert from "node:assert/strict";

import { conversationToMarkdown } from "../src/conversation.js";
import { demoConversation, demoGeminiConversation } from "../src/demo-data.js";
import { buildObsidianNewUri } from "../src/obsidian.js";
import { sendCompleteMarkdownToObsidian } from "../src/obsidian-transport.js";

const markdown = conversationToMarkdown(
  demoConversation,
  new Date("2026-07-23T08:00:00.000Z"),
);
const uri = buildObsidianNewUri({
  file: "ChatGPT/设计一个可靠的任务队列 [7a2f19c4].md",
  overwrite: true,
  silent: true,
  clipboard: true,
});

test("writes the complete payload before opening the Obsidian URI", async () => {
  const calls = [];
  const clipboard = {
    async writeText(value) { calls.push(["clipboard", value]); },
  };
  const runtime = {
    async sendMessage(message) {
      calls.push(["runtime", message]);
      return { ok: true, tabId: 42 };
    },
  };

  const result = await sendCompleteMarkdownToObsidian({
    clipboard,
    runtime,
    conversation: demoConversation,
    markdown,
    tabId: 42,
    uri,
  });

  assert.equal(calls[0][0], "clipboard");
  assert.equal(calls[0][1], markdown);
  assert.equal(calls[1][0], "runtime");
  assert.deepEqual(calls[1][1], {
    type: "open-obsidian-uri",
    tabId: 42,
    provider: "chatgpt",
    uri,
  });
  assert.equal(result.stats.messageSections, 8);
});

test("carries the Gemini provider after copying the complete payload", async () => {
  const geminiMarkdown = conversationToMarkdown(
    demoGeminiConversation,
    new Date("2026-07-23T08:00:00.000Z"),
  );
  const geminiUri = buildObsidianNewUri({
    file: "Gemini/研究方案 [a91c42ef].md",
    clipboard: true,
  });
  const calls = [];

  const result = await sendCompleteMarkdownToObsidian({
    clipboard: {
      async writeText(value) { calls.push(["clipboard", value]); },
    },
    runtime: {
      async sendMessage(message) {
        calls.push(["runtime", message]);
        return { ok: true, tabId: 43 };
      },
    },
    conversation: demoGeminiConversation,
    markdown: geminiMarkdown,
    tabId: 43,
    uri: geminiUri,
  });

  assert.equal(calls[0][1], geminiMarkdown);
  assert.deepEqual(calls[1][1], {
    type: "open-obsidian-uri",
    tabId: 43,
    provider: "gemini",
    uri: geminiUri,
  });
  assert.equal(result.stats.messageSections, demoGeminiConversation.stats.messageCount);
});

test("does not open Obsidian when the Markdown body is incomplete", async () => {
  let touched = false;
  const clipboard = {
    async writeText() { touched = true; },
  };
  const runtime = {
    async sendMessage() { touched = true; },
  };

  await assert.rejects(
    sendCompleteMarkdownToObsidian({
      clipboard,
      runtime,
      conversation: demoConversation,
      markdown: `# ${demoConversation.title}\n`,
      tabId: 42,
      uri,
    }),
    /Markdown export is incomplete/,
  );
  assert.equal(touched, false);
});
