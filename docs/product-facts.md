# Product facts: Obsidian handoff

Verified against the official Obsidian Web Clipper repository and Obsidian URI documentation on 2026-07-23.

- Obsidian Web Clipper's primary save path does not request direct filesystem access.
- It copies the generated Markdown to the clipboard and opens an `obsidian://new` or `obsidian://daily` URI with the `clipboard` parameter.
- The URI supports `vault`, `file`, `append`, `overwrite`, and `silent` parameters.
- The official implementation encodes `file` and `vault` with `encodeURIComponent`, appends a bare `&clipboard`, and sends behavior flags such as `overwrite=true` and `silent=true`.
- `URLSearchParams` form encoding is not compatible with this raw URI contract because it emits `+` for spaces and empty boolean values such as `clipboard=`.
- Encoding the full note into the URI is a fallback with practical URL-length limits; clipboard handoff is appropriate for long conversations.
- The Web Clipper code is MIT licensed, but its trademarks, icons, and marketing assets are excluded. This project keeps its own name and artwork.

Sources:

- https://github.com/obsidianmd/obsidian-clipper/blob/main/src/utils/obsidian-note-creator.ts
- https://github.com/obsidianmd/obsidian-clipper/blob/main/src/utils/clipboard-utils.ts
- https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI
- https://obsidian.md/help/web-clipper/troubleshoot
