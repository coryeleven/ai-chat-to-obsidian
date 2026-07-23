import test from "node:test";
import assert from "node:assert/strict";

import { conversationToMarkdown } from "../src/conversation.js";
import { demoConversation } from "../src/demo-data.js";
import {
  assertCompleteMarkdownExport,
  formatMarkdownStats,
  inspectMarkdownExport,
  writeCompleteMarkdownToClipboard,
} from "../src/export-payload.js";

const importedAt = new Date("2026-07-23T08:00:00.000Z");

test("accepts a complete conversation document and reports its payload size", () => {
  const markdown = conversationToMarkdown(demoConversation, importedAt);
  const stats = inspectMarkdownExport(demoConversation, markdown);

  assert.equal(stats.complete, true);
  assert.equal(stats.expectedMessages, 8);
  assert.equal(stats.messageSections, 8);
  assert.ok(stats.characters > 700);
  assert.ok(stats.bytes > 1200);
  assert.match(formatMarkdownStats(stats), /^8 个内容段落 · \d+\.\d KB$/);
});

test("blocks a title-only document before transport", () => {
  const titleOnly = `# ${demoConversation.title}\n`;

  assert.equal(inspectMarkdownExport(demoConversation, titleOnly).complete, false);
  assert.throws(
    () => assertCompleteMarkdownExport(demoConversation, titleOnly),
    /expected 8 message sections, found 0/,
  );
});

test("writes the complete Markdown string to the clipboard without truncation", async () => {
  const markdown = conversationToMarkdown(demoConversation, importedAt);
  let copied = "";
  const clipboard = {
    async writeText(value) { copied = value; },
  };

  const stats = await writeCompleteMarkdownToClipboard(clipboard, demoConversation, markdown);

  assert.equal(copied, markdown);
  assert.equal(stats.messageSections, 8);
  assert.match(copied, /## User\n\n我需要一个支持重试和幂等的任务队列/);
  assert.match(copied, /## Assistant\n\n先上线单消费者和幂等保护/);
});
