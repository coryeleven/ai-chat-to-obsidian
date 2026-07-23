# Popup V2 design specification

## Product and audience

ChatGPT to Obsidian is a focused capture utility for people who use ChatGPT as working material and Obsidian as their durable knowledge base. The common action is repeated frequently: inspect the current conversation, confirm that the complete branch was found, and save it. The interface should feel like a quiet macOS utility rather than a webpage, setup wizard, or Markdown editor.

## Core workflow

1. Open the extension while viewing a ChatGPT conversation.
2. See the title, message/round count, extraction status, and destination in one scan.
3. Click one primary action to copy the Markdown and hand it to Obsidian through its URI protocol.
4. Receive a compact sent state. The browser or operating system may show its own confirmation for opening Obsidian.

There is no separate directory authorization page. Vault and relative folder configuration live in an in-popup settings dialog. An empty Vault value means the current or most recently focused Obsidian Vault. The default folder is `ChatGPT`.

## Information hierarchy

- Header: custom product mark, product name, settings and refresh tools.
- Conversation: title as the strongest text, followed by message count and extraction status.
- Destination: one unframed target row showing `Vault / folder`, editable through a settings icon.
- Preview: collapsed by default; expansion reveals the filename and read-only Markdown.
- Actions: one full-width primary save button. Copy and download are compact icon tools with tooltips.
- Settings dialog: Vault, relative folder, silent-open toggle, detailed-metadata toggle, cancel and apply.

## Visual system

- Audience distance: approximately 40-70 cm in a desktop browser popup.
- Temperature: quiet, precise, locally owned, trustworthy.
- Size: stable 400 px width; target height about 460-520 px before an expanded preview.
- Typography: Apple system stack, 14 px body, 12 px supporting text, 19-20 px conversation title.
- Geometry: 16 px functional panels, 12 px controls, 11 px icon tiles; pills only for status.
- Color: neutral macOS gray surfaces, system blue for the single primary action, green only for complete states, amber only for warnings.
- Effects: thin translucent borders and one restrained surface shadow; no gradients or decorative imagery.
- Motion: one short state transition, disabled when reduced motion is requested.

## Metadata behavior

Minimal metadata is the default: `title`, `source`, `conversation_id`, and `tags: [chatgpt]`. Detailed metadata adds timestamps, counts, extraction method, and the `ai-conversation` tag. The setting updates both the preview and the saved note immediately.

## Assumptions

- Obsidian is installed and has registered the `obsidian://` protocol.
- Clipboard handoff is acceptable because it is the official Web Clipper approach and avoids URL-length limits.
- Downloads remain available as a fallback.
- Existing direct-directory modules remain temporarily in the source tree for migration safety but are no longer part of the user-facing flow or release bundle.
