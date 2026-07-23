import test from "node:test";
import assert from "node:assert/strict";

import { markdownToDataUrl, startMarkdownDownload } from "../src/download.js";
import { conversationToMarkdown } from "../src/conversation.js";
import { demoConversation } from "../src/demo-data.js";

test("encodes Unicode Markdown as a downloadable data URL", () => {
  const markdown = "# 对话\n\nFirefox export";
  const url = markdownToDataUrl(markdown);
  const encoded = url.split(",", 2)[1];

  assert.match(url, /^data:text\/markdown;charset=utf-8;base64,/);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), markdown);
});

test("starts a Save As download with a safe filename", async () => {
  let received;
  const api = {
    downloads: {
      async download(options) {
        received = options;
        return 42;
      },
    },
  };

  const id = await startMarkdownDownload(api, {
    markdown: "# Export",
    filename: "folder\\unsafe/name",
    saveAs: true,
  });

  assert.equal(id, 42);
  assert.equal(received.filename, "folder unsafe name.md");
  assert.equal(received.saveAs, true);
  assert.equal(received.conflictAction, "overwrite");
});

test("passes a complete conversation through the download data URL byte-for-byte", async () => {
  const markdown = conversationToMarkdown(
    demoConversation,
    new Date("2026-07-23T08:00:00.000Z"),
  );
  let received;
  const api = {
    downloads: {
      async download(options) {
        received = options;
        return 43;
      },
    },
  };

  await startMarkdownDownload(api, {
    markdown,
    filename: "Conversation.md",
    saveAs: false,
  });

  const encoded = received.url.split(",", 2)[1];
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  assert.equal(decoded, markdown);
  assert.equal((decoded.match(/^## User$/gm) || []).length, 4);
  assert.equal((decoded.match(/^## Assistant$/gm) || []).length, 4);
  assert.match(decoded, /最后根据真实流量扩展并发/);
});
