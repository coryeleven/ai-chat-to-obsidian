# Popup design specification v3

## Product and context

ChatGPT to Obsidian is a narrow, repeated-use browser tool rather than a marketing surface. Its job is to let someone inspect the active ChatGPT conversation, confirm that the export is complete, choose an Obsidian destination, and send or download the Markdown without leaving the current popup. The existing screenshot shows the right functions but gives every row and icon the same visual weight. A fixed 500 px height also leaves a large inactive region below the actions, so the popup feels unfinished even though the controls themselves are polished.

## Design intent

The visual temperature is calm, precise, and crafted. The conversation title is the primary entry point; product branding and utility controls are deliberately quieter. The interface uses one neutral canvas, one grouped transfer surface, one blue action color, and semantic green only for a small completeness signal. Repeated card shadows and nested rounded tiles are removed. The custom product mark remains because this is an independent extension and should not imply official ChatGPT or Obsidian ownership.

The audience views the popup from roughly 10 cm at a CSS width between 320 and 400 px. Closed-state height must be driven by content, targeting roughly 350 px at 400 px width. Loading and error views may reserve approximately 260 px, while opening the Markdown preview is the only action allowed to expand the popup substantially. All action targets remain stable and at least 40-44 px where space permits. Chinese headings use strict line breaking and a maximum of two lines.

## Information hierarchy

1. Compact product bar with the custom mark, product name, settings, and refresh.
2. Conversation heading with message count, round count, and a quiet completeness signal.
3. One transfer group containing the Obsidian destination row and the Markdown preview row, separated by a single hairline.
4. A full-strength primary Obsidian action plus quiet copy and download actions.
5. An inline status message that does not overlap controls or permanently reserve space.

The preview row displays measured payload information such as message-section count and UTF-8 size. This is functional confidence, not decorative data: it makes an empty or title-only export visible before saving. The application also blocks transport when the generated document does not contain the expected number of User/Assistant sections.

## Visual system

Light mode uses a slightly warm neutral canvas, white transfer surface, graphite text, restrained hairlines, and Apple blue for the single primary action. Dark mode uses a near-black canvas and a lifted graphite group with low-contrast borders; normal panels have no shadow. Only the modal uses a deeper shadow. Corners are 12 px for controls and 15 px for the transfer group. The status indicator is text and a dot rather than a filled pill. Motion is limited to the initial reveal, disclosure rotation, press feedback, and modal transition, all disabled by reduced-motion preferences.

Images are not content-required for this operational tool. No decorative imagery, gradients, bokeh, or invented statistics are introduced.
