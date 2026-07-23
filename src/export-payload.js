const MESSAGE_HEADING_PATTERN = /^## (User|Assistant)$/gm;

function markdownByteLength(markdown) {
  return new TextEncoder().encode(markdown).byteLength;
}

export function inspectMarkdownExport(conversation, markdown) {
  const value = typeof markdown === "string" ? markdown : "";
  const messages = Array.isArray(conversation?.messages)
    ? conversation.messages.filter((message) => message?.role === "user" || message?.role === "assistant")
    : [];
  const messageSections = [...value.matchAll(MESSAGE_HEADING_PATTERN)].length;
  const hasDocumentTitle = Boolean(conversation?.title)
    && value.includes(`# ${conversation.title}`);
  const hasAllMessageContent = messages.every((message) => {
    const content = String(message?.markdown || "").trim();
    return !content || value.includes(content);
  });

  return {
    bytes: markdownByteLength(value),
    characters: value.length,
    expectedMessages: messages.length,
    messageSections,
    complete: messages.length > 0
      && messageSections === messages.length
      && hasDocumentTitle
      && hasAllMessageContent,
  };
}

export function assertCompleteMarkdownExport(conversation, markdown) {
  const stats = inspectMarkdownExport(conversation, markdown);
  if (!stats.complete) {
    throw new Error(
      `Markdown export is incomplete: expected ${stats.expectedMessages} message sections, found ${stats.messageSections}.`,
    );
  }
  return stats;
}

export async function writeCompleteMarkdownToClipboard(clipboard, conversation, markdown) {
  const stats = assertCompleteMarkdownExport(conversation, markdown);
  if (typeof clipboard?.writeText !== "function") {
    throw new Error("Clipboard access is unavailable.");
  }
  await clipboard.writeText(markdown);
  return stats;
}

export function formatMarkdownStats(stats) {
  const size = stats.bytes < 1024
    ? `${stats.bytes} B`
    : `${(stats.bytes / 1024).toFixed(1)} KB`;
  return `${stats.messageSections} 段正文 · ${size}`;
}
