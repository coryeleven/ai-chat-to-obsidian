import test from "node:test";
import assert from "node:assert/strict";

import {
  completePendingExport,
  createPendingExport,
  isCompletedPendingExport,
  isPendingExport,
  isSafeChatGptReturnTarget,
  PendingExportBusyError,
} from "../src/export-flow.js";

test("creates an isolated pending export for the authorization handoff", () => {
  const pending = createPendingExport({
    requestId: "request-1",
    conversationId: "conversation-1234",
    filename: "Conversation [1234].md",
    markdown: "---\nconversation_id: \"conversation-1234\"\n---\n",
    sourceTabId: 42,
    sourceWindowId: 7,
    sourceUrl: "https://chatgpt.com/c/conversation-1234",
  });

  assert.equal(isPendingExport(pending), true);
  assert.equal(pending.id, "request-1");
  assert.equal(pending.sourceTabId, 42);
  assert.equal(pending.sourceWindowId, 7);
  assert.equal(pending.status, "pending");
  assert.match(pending.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.throws(
    () => createPendingExport({ conversationId: "", filename: "x.md", markdown: "content" }),
    /conversation ID/,
  );
});

test("claims, writes and atomically finalizes a pending export", async () => {
  const calls = [];
  const pending = createPendingExport({
    requestId: "request-1",
    conversationId: "conversation-1234",
    filename: "Conversation [1234].md",
    markdown: "# Export",
  });

  const completed = await completePendingExport("request-1", "owner-1", { name: "ChatGPT" }, {
    async claim(requestId, ownerId) {
      calls.push(["claim", requestId, ownerId]);
      return { ...pending, status: "processing", ownerId };
    },
    async writeFile(handle, filename, markdown) {
      calls.push(["write", handle.name, filename, markdown]);
      return "Conversation [1234] (2).md";
    },
    async recordFilename(requestId, ownerId, filename) {
      calls.push(["record", requestId, ownerId, filename]);
    },
    async finalize(requestId, ownerId, filename) {
      calls.push(["finalize", requestId, ownerId, filename]);
      return { ...pending, status: "completed", filename, markdown: undefined };
    },
    async release() {
      calls.push(["release"]);
    },
  });

  assert.equal(isCompletedPendingExport(completed), true);
  assert.equal(completed.filename, "Conversation [1234] (2).md");
  assert.deepEqual(calls, [
    ["claim", "request-1", "owner-1"],
    ["write", "ChatGPT", "Conversation [1234].md", "# Export"],
    ["record", "request-1", "owner-1", "Conversation [1234] (2).md"],
    ["finalize", "request-1", "owner-1", "Conversation [1234] (2).md"],
  ]);
});

test("releases a claimed export when persistence fails", async () => {
  const pending = createPendingExport({
    requestId: "request-1",
    conversationId: "conversation-1234",
    filename: "Conversation.md",
    markdown: "# Export",
  });
  const releases = [];

  await assert.rejects(
    completePendingExport("request-1", "owner-1", {}, {
      async claim() { return { ...pending, status: "processing", ownerId: "owner-1" }; },
      async writeFile() { return "Conversation.md"; },
      async recordFilename() { throw new Error("IndexedDB failed"); },
      async finalize() { throw new Error("must not be called"); },
      async release(...args) { releases.push(args); },
    }),
    /IndexedDB failed/,
  );
  assert.deepEqual(releases, [["request-1", "owner-1", "IndexedDB failed"]]);
});

test("does not process a request claimed by another page", async () => {
  await assert.rejects(
    completePendingExport("request-1", "owner-2", {}, {
      async claim() {
        return {
          version: 1,
          id: "request-1",
          status: "processing",
          ownerId: "owner-1",
          conversationId: "conversation-1",
          filename: "Conversation.md",
          markdown: "# Export",
        };
      },
    }),
    PendingExportBusyError,
  );
});

test("returns an existing completion without writing the file again", async () => {
  const completed = {
    version: 1,
    id: "request-1",
    status: "completed",
    conversationId: "conversation-1",
    filename: "Conversation.md",
  };
  let wrote = false;

  const result = await completePendingExport("request-1", "owner-2", {}, {
    async claim() { return completed; },
    async writeFile() { wrote = true; },
  });

  assert.equal(result, completed);
  assert.equal(wrote, false);
});

test("returns only to a ChatGPT tab while allowing harmless URL changes", () => {
  assert.equal(
    isSafeChatGptReturnTarget(
      "https://chatgpt.com/c/example?model=gpt-5#latest",
      "https://chatgpt.com/c/example",
    ),
    true,
  );
  assert.equal(
    isSafeChatGptReturnTarget("https://chatgpt.com/", "https://chat.openai.com/c/example"),
    true,
  );
  assert.equal(
    isSafeChatGptReturnTarget("https://example.com/", "https://chatgpt.com/c/example"),
    false,
  );
  assert.equal(isSafeChatGptReturnTarget("not a url", "https://chatgpt.com/c/example"), false);
});
