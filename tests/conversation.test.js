import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConversationMarkdown,
  conversationFromApi,
  conversationFromDom,
  conversationToMarkdown,
  safeFilename,
} from "../src/conversation.js";

function node(id, parent, message, children = []) {
  return { id, parent, children, message };
}

function message(id, role, parts, createTime, metadata = {}) {
  return {
    id,
    author: { role },
    content: { content_type: "text", parts },
    create_time: createTime,
    status: "finished_successfully",
    metadata,
  };
}

function conversationPayload() {
  return {
    id: "conversation-12345678",
    title: "Queue design / production?",
    create_time: 1_700_000_000,
    update_time: 1_700_000_500,
    current_node: "a2",
    mapping: {
      root: node("root", null, message("system", "system", ["hidden"], 1), ["u1"]),
      u1: node("u1", "root", message("u1", "user", ["First question"], 2), ["old", "new"]),
      old: node("old", "u1", message("old", "assistant", ["Old branch"], 3)),
      new: node("new", "u1", message("new", "assistant", ["Selected answer \uE200cite\uE202turn0search0\uE201"], 4, {
        content_references: [
          { title: "Reliable queues", url: "https://example.com/queues" },
          { title: "Duplicate", url: "https://example.com/queues" },
        ],
      }), ["hidden"]),
      hidden: node("hidden", "new", message("hidden", "assistant", ["Internal UI message"], 5, {
        is_visually_hidden_from_conversation: true,
      }), ["u2"]),
      u2: node("u2", "hidden", message("u2", "user", ["Show an image"], 6), ["a2"]),
      a2: node("a2", "u2", message("a2", "assistant", [
        "Here it is",
        { content_type: "image_asset_pointer", asset_pointer: "https://example.com/image.png" },
      ], 7)),
    },
  };
}

test("normalizes only the active conversation branch", () => {
  const result = conversationFromApi(conversationPayload(), {
    sourceUrl: "https://chatgpt.com/c/conversation-12345678",
  });

  assert.deepEqual(result.messages.map(({ id }) => id), ["u1", "new", "u2", "a2"]);
  assert.equal(result.stats.messageCount, 4);
  assert.equal(result.stats.roundCount, 2);
  assert.equal(result.provider, "chatgpt");
  assert.doesNotMatch(result.messages[1].markdown, /turn0search/);
  assert.equal(result.messages[1].sources.length, 1);
  assert.match(result.messages[3].markdown, /!\[ChatGPT image\]/);
});

test("accepts nested share payloads and chooses the latest leaf", () => {
  const payload = conversationPayload();
  delete payload.current_node;
  payload.mapping.old.message.create_time = 1;

  const result = conversationFromApi({ conversation: payload }, {
    sourceUrl: "https://chatgpt.com/share/conversation-12345678",
  });

  assert.equal(result.messages.at(-1).id, "a2");
  assert.equal(result.id, "conversation-12345678");
});

test("renders Obsidian Markdown with minimal metadata and sources by default", () => {
  const conversation = conversationFromApi(conversationPayload(), {
    sourceUrl: "https://chatgpt.com/c/conversation-12345678",
  });
  const markdown = conversationToMarkdown(conversation, new Date("2026-07-21T08:00:00.000Z"));

  assert.match(markdown, /^---\ntitle: "Queue design \/ production\?"/);
  assert.match(markdown, /source: "https:\/\/chatgpt\.com\/c\/conversation-12345678"/);
  assert.match(markdown, /conversation_id: "conversation-12345678"/);
  assert.doesNotMatch(markdown, /provider:/);
  assert.match(markdown, /tags:\n  - chatgpt\n---/);
  assert.doesNotMatch(markdown, /\ncreated:|\nupdated:|\nimported:|\nmessages:|\nrounds:|\nextraction:/);
  assert.doesNotMatch(markdown, /ai-conversation/);
  assert.match(markdown, /## User\n\nFirst question/);
  assert.match(markdown, /> \[!info\]- Sources/);
  assert.match(markdown, /\[Reliable queues\]\(https:\/\/example.com\/queues\)/);
});

test("builds structured properties from the same Markdown document", () => {
  const conversation = conversationFromApi(conversationPayload(), {
    sourceUrl: "https://chatgpt.com/c/conversation-12345678",
  });
  const importedAt = new Date("2026-07-21T08:00:00.000Z");
  const document = buildConversationMarkdown(conversation, importedAt, {
    detailedMetadata: true,
  });

  assert.deepEqual(document.properties, [
    { name: "title", value: "Queue design / production?" },
    { name: "source", value: "https://chatgpt.com/c/conversation-12345678" },
    { name: "conversation_id", value: "conversation-12345678" },
    { name: "provider", value: "chatgpt" },
    { name: "created", value: "2023-11-14T22:13:20.000Z" },
    { name: "updated", value: "2023-11-14T22:21:40.000Z" },
    { name: "imported", value: "2026-07-21T08:00:00.000Z" },
    { name: "messages", value: 4 },
    { name: "rounds", value: 2 },
    { name: "extraction", value: "api" },
    { name: "tags", value: ["chatgpt", "ai-conversation"] },
  ]);
  assert.equal(document.markdown, conversationToMarkdown(conversation, importedAt, {
    detailedMetadata: true,
  }));
  assert.match(document.frontmatter, /^---\ntitle:/);
  assert.match(document.body, /^# Queue design \/ production\?/);
  assert.doesNotMatch(document.body, /^---/);
});

test("adds detailed metadata when requested while preserving importedAt", () => {
  const conversation = conversationFromApi(conversationPayload(), {
    sourceUrl: "https://chatgpt.com/c/conversation-12345678",
  });
  const importedAt = new Date("2026-07-21T08:00:00.000Z");
  const markdown = conversationToMarkdown(conversation, importedAt, {
    detailedMetadata: true,
  });

  assert.match(markdown, /source: "https:\/\/chatgpt\.com\/c\/conversation-12345678"/);
  assert.match(markdown, /created: "2023-11-14T22:13:20\.000Z"/);
  assert.match(markdown, /updated: "2023-11-14T22:21:40\.000Z"/);
  assert.match(markdown, /imported: "2026-07-21T08:00:00\.000Z"/);
  assert.match(markdown, /messages: 4/);
  assert.match(markdown, /rounds: 2/);
  assert.match(markdown, /extraction: "api"/);
  assert.match(markdown, /provider: "chatgpt"/);
  assert.match(markdown, /tags:\n  - chatgpt\n  - ai-conversation\n---/);
  assert.match(markdown, /## User\n\nFirst question/);
  assert.match(markdown, /\[Reliable queues\]\(https:\/\/example.com\/queues\)/);

  const markdownWithOptionsOnly = conversationToMarkdown(conversation, {
    detailedMetadata: true,
  });
  assert.match(markdownWithOptionsOnly, /\nmessages: 4\n/);
  assert.match(markdownWithOptionsOnly, /  - ai-conversation\n---/);
});

test("creates a stable filesystem-safe filename", () => {
  const conversation = conversationFromApi(conversationPayload(), {
    sourceUrl: "https://chatgpt.com/c/conversation-12345678",
  });
  const filename = safeFilename(conversation);

  assert.equal(filename, "Queue design production [12345678].md");
  assert.doesNotMatch(filename, /[\\/:*?"<>|]/);
});

test("rejects API responses without a message graph", () => {
  assert.throws(
    () => conversationFromApi({ title: "Broken" }),
    /did not contain a message graph/,
  );
});

test("normalizes Gemini DOM messages, sources, title, ID, and generating state", () => {
  const result = conversationFromDom({
    provider: "gemini",
    conversationId: "",
    sourceUrl: "https://gemini.google.com/app/research-a91c42ef?hl=zh-CN#answer",
    title: "Research plan | Google Gemini",
    messages: [
      { id: "g-u1", role: "user", text: "Collect the evidence" },
      {
        id: "g-a1",
        role: "assistant",
        text: "Start with primary sources.",
        sources: [
          { title: "Gemini API", url: "https://ai.google.dev/gemini-api/docs" },
          { title: "Duplicate", url: "https://ai.google.dev/gemini-api/docs" },
          { title: "Unsafe", url: "javascript:alert(1)" },
        ],
      },
      { id: "g-u2", role: "user", text: "Turn it into actions" },
      { id: "g-a2", role: "assistant", text: "Create an owner and deadline table." },
    ],
    isGenerating: true,
    scroll: { attempted: true, complete: true },
  });

  assert.equal(result.provider, "gemini");
  assert.equal(result.id, "research-a91c42ef");
  assert.equal(result.title, "Research plan");
  assert.equal(result.scanComplete, true);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.messages.map(({ role }) => role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(result.messages.map(({ status }) => status), [
    "finished_successfully",
    "finished_successfully",
    "finished_successfully",
    "in_progress",
  ]);
  assert.deepEqual(result.messages[1].sources, [{
    title: "Gemini API",
    url: "https://ai.google.dev/gemini-api/docs",
  }]);

  const markdown = conversationToMarkdown(result, new Date("2026-07-23T08:00:00.000Z"));
  assert.doesNotMatch(markdown, /provider:/);
  assert.match(markdown, /tags:\n  - gemini\n---/);
  assert.doesNotMatch(markdown, /  - chatgpt/);
  assert.match(markdown, /Gemini was still generating a response/);
  assert.match(markdown, /\[Gemini API\]\(https:\/\/ai\.google\.dev\/gemini-api\/docs\)/);
  assert.equal(safeFilename(result), "Research plan [a91c42ef].md");

  const detailedMarkdown = conversationToMarkdown(result, { detailedMetadata: true });
  assert.match(detailedMarkdown, /provider: "gemini"/);
});

test("warns when a Gemini DOM scan or role inference is incomplete", () => {
  const result = conversationFromDom({
    provider: "gemini",
    conversationId: "scan-warning",
    sourceUrl: "https://gemini.google.com/app/scan-warning",
    title: "Scan warning - Gemini",
    messages: [
      { id: "u1", role: "user", text: "Question" },
      { id: "a1", role: "assistant", text: "Answer" },
    ],
    roleReliable: false,
    scroll: { attempted: true, complete: false },
  });

  assert.equal(result.scanComplete, false);
  assert.match(result.warnings.join(" "), /Gemini 的长对话扫描未到达两端/);
  assert.match(result.warnings.join(" "), /角色来自顺序推断/);
});
