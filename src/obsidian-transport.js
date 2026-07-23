import { writeCompleteMarkdownToClipboard } from "./export-payload.js";

export async function sendCompleteMarkdownToObsidian({
  clipboard,
  runtime,
  conversation,
  markdown,
  tabId,
  uri,
}) {
  const stats = await writeCompleteMarkdownToClipboard(clipboard, conversation, markdown);
  if (typeof runtime?.sendMessage !== "function") {
    throw new Error("The browser runtime messaging API is unavailable.");
  }

  const response = await runtime.sendMessage({
    type: "open-obsidian-uri",
    tabId,
    provider: conversation.provider,
    uri,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "The browser could not open Obsidian.");
  }

  return { response, stats };
}
