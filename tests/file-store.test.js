import test from "node:test";
import assert from "node:assert/strict";

import { queryWritePermission, writeMarkdownFile } from "../src/file-store.js";

test("writes and closes a Markdown file through a granted directory handle", async () => {
  const calls = [];
  const writable = {
    async write(value) { calls.push(["write", value]); },
    async close() { calls.push(["close"]); },
  };
  const handle = {
    async queryPermission(options) {
      calls.push(["permission", options.mode]);
      return "granted";
    },
    async getFileHandle(filename, options) {
      calls.push(["file", filename, options.create]);
      if (!options.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return { async createWritable() { return writable; } };
    },
  };

  const filename = await writeMarkdownFile(
    handle,
    "Conversation [1234].md",
    "---\nconversation_id: \"conversation-1234\"\n---\n# Export\n",
  );

  assert.equal(filename, "Conversation [1234].md");
  assert.deepEqual(calls, [
    ["permission", "readwrite"],
    ["file", "Conversation [1234].md", false],
    ["file", "Conversation [1234].md", true],
    ["write", "---\nconversation_id: \"conversation-1234\"\n---\n# Export\n"],
    ["close"],
  ]);
});

test("refuses to create a file without persisted write permission", async () => {
  const handle = {
    async queryPermission() { return "prompt"; },
    async getFileHandle() { throw new Error("must not be called"); },
  };

  await assert.rejects(
    writeMarkdownFile(handle, "unsafe.md", "content"),
    /Write access .* was not granted/,
  );
  assert.equal(await queryWritePermission(null), "prompt");
});

test("uses a numbered filename instead of overwriting another conversation", async () => {
  const files = new Map([
    ["Shared title [1234].md", "---\nconversation_id: \"different-id\"\n---\n"],
  ]);
  let writtenName = "";
  const handle = {
    async queryPermission() { return "granted"; },
    async getFileHandle(filename, { create }) {
      if (!create && !files.has(filename)) {
        throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      }
      if (!create) {
        return { async getFile() { return { async text() { return files.get(filename); } }; } };
      }
      writtenName = filename;
      return {
        async createWritable() {
          return { async write() {}, async close() {} };
        },
      };
    },
  };

  const result = await writeMarkdownFile(
    handle,
    "Shared title [1234].md",
    "---\nconversation_id: \"current-id\"\n---\n",
  );

  assert.equal(result, "Shared title [1234] (2).md");
  assert.equal(writtenName, result);
});

test("reuses a numbered file that already belongs to the same conversation", async () => {
  const files = new Map([
    ["Shared title.md", "---\nconversation_id: \"different-id\"\n---\n"],
    ["Shared title (2).md", "---\nconversation_id: \"current-id\"\n---\n"],
  ]);
  let writtenName = "";
  const handle = {
    async queryPermission() { return "granted"; },
    async getFileHandle(filename, { create }) {
      if (!create) {
        if (!files.has(filename)) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        return { async getFile() { return { async text() { return files.get(filename); } }; } };
      }
      writtenName = filename;
      return {
        async createWritable() {
          return { async write() {}, async close() {} };
        },
      };
    },
  };

  const result = await writeMarkdownFile(
    handle,
    "Shared title.md",
    "---\nconversation_id: \"current-id\"\n---\n",
  );

  assert.equal(result, "Shared title (2).md");
  assert.equal(writtenName, result);
});

test("aborts instead of closing a writable stream after a failed write", async () => {
  const calls = [];
  const handle = {
    async queryPermission() { return "granted"; },
    async getFileHandle(_filename, { create }) {
      if (!create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return {
        async createWritable() {
          return {
            async write() {
              calls.push("write");
              throw new Error("disk full");
            },
            async close() { calls.push("close"); },
            async abort() { calls.push("abort"); },
          };
        },
      };
    },
  };

  await assert.rejects(
    writeMarkdownFile(handle, "Conversation.md", "# Export"),
    /disk full/,
  );
  assert.deepEqual(calls, ["write", "abort"]);
});
