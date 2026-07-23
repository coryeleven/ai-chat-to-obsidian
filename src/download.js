const MAX_MARKDOWN_BYTES = 64 * 1024 * 1024;

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
    throw new Error("The conversation is larger than the 64 MB download limit.");
  }

  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

export function markdownToDataUrl(markdown) {
  return `data:text/markdown;charset=utf-8;base64,${utf8ToBase64(String(markdown || ""))}`;
}

function safeDownloadFilename(value) {
  const cleaned = String(value || "ChatGPT conversation.md")
    .replace(/[\\/\0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const filename = cleaned || "ChatGPT conversation.md";
  return filename.toLowerCase().endsWith(".md") ? filename : `${filename}.md`;
}

export async function startMarkdownDownload(api, message) {
  if (!api?.downloads?.download) throw new Error("The browser download API is unavailable.");
  if (typeof message?.markdown !== "string" || !message.markdown) {
    throw new Error("No Markdown content was provided for download.");
  }

  return api.downloads.download({
    url: markdownToDataUrl(message.markdown),
    filename: safeDownloadFilename(message.filename),
    saveAs: Boolean(message.saveAs),
    conflictAction: message.saveAs ? "overwrite" : "uniquify",
  });
}
