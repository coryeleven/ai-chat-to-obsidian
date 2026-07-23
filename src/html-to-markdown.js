const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "DIV", "FIGCAPTION", "FIGURE", "FOOTER", "HEADER",
  "MAIN", "NAV", "SECTION",
]);

function compact(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function childrenToMarkdown(node, context) {
  return [...node.childNodes].map((child) => nodeToMarkdown(child, context)).join("");
}

function fencedCode(text, language = "") {
  const matches = text.match(/`+/g) || [];
  const longest = Math.max(2, ...matches.map((match) => match.length));
  const fence = "`".repeat(longest + 1);
  return `\n\n${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
}

function codeText(element) {
  const editor = element.matches?.(".cm-content") ? element : element.querySelector?.(".cm-content");
  if (editor) {
    const lines = [...editor.querySelectorAll(":scope > .cm-line, .cm-line")];
    if (lines.length > 0) return lines.map((line) => line.textContent || "").join("\n");
  }

  const clone = element.cloneNode(true);
  clone.querySelectorAll?.(".code-block-decoration, button, svg, [aria-hidden='true']")
    .forEach((node) => node.remove());
  clone.querySelectorAll?.("br").forEach((br) => br.replaceWith("\n"));
  return clone.textContent || "";
}

function codeLanguage(element, code) {
  const declared = element.getAttribute("data-language")
    || element.getAttribute("language")
    || element.getAttribute("lang")
    || code?.getAttribute("data-language")
    || code?.getAttribute("language")
    || code?.getAttribute("lang");
  if (declared) return declared.replace(/^language-/, "").trim();
  return [...(code?.classList || []), ...element.classList]
    .find((name) => name.startsWith("language-"))?.slice(9) || "";
}

function renderMath(element) {
  const tag = element.tagName;
  const scriptMath = tag === "SCRIPT" && /^math\/tex/i.test(element.getAttribute("type") || "");
  const isMathRoot = scriptMath || tag === "MATH" || tag === "MJX-CONTAINER"
    || element.matches(".katex, .katex-display, [data-math]");
  if (!isMathRoot) return "";

  const annotation = element.matches("annotation[encoding*='tex' i]")
    ? element
    : element.querySelector("annotation[encoding*='tex' i]");
  const tex = annotation?.textContent
    || (scriptMath ? element.textContent : "")
    || element.getAttribute("data-math")
    || "";
  if (!tex.trim()) return "";
  const display = element.matches(".katex-display, mjx-container[display='true'], [data-display='block'], .math-display")
    || /mode=display/i.test(element.getAttribute("type") || "");
  return display ? `\n\n$$\n${tex.trim()}\n$$\n\n` : `$${tex.trim()}$`;
}

function safeLink(value, type = "link") {
  const href = String(value || "").trim();
  if (!href) return "";
  if (href.startsWith("#")) return type === "link" ? href : "";
  if (/^https?:\/\//i.test(href)) return href;
  if (type === "link" && /^mailto:/i.test(href)) return href;
  if (type === "image" && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(href)) return href;
  return "";
}

function renderList(list, context) {
  const ordered = list.tagName === "OL";
  const start = Number(list.getAttribute("start")) || 1;
  const items = [...list.children].filter((child) => child.tagName === "LI");
  return `\n${items.map((item, index) => {
    const marker = ordered ? `${start + index}. ` : "- ";
    const content = compact(childrenToMarkdown(item, { ...context, listDepth: context.listDepth + 1 }));
    const indented = content.replace(/\n/g, `\n${"  ".repeat(context.listDepth + 1)}`);
    return `${"  ".repeat(context.listDepth)}${marker}${indented}`;
  }).join("\n")}\n\n`;
}

function renderTable(table) {
  const rows = [...table.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) =>
      compact(childrenToMarkdown(cell, { listDepth: 0 })).replace(/\|/g, "\\|").replace(/\n/g, " "),
    ),
  ).filter((row) => row.length > 0);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
  if (!table.querySelector("th")) normalized.unshift(Array.from({ length: width }, (_, i) => `Column ${i + 1}`));
  const separator = Array(width).fill("---");
  return `\n\n${[normalized[0], separator, ...normalized.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n")}\n\n`;
}

function nodeToMarkdown(node, context = { listDepth: 0 }) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node;
  const tag = element.tagName;
  const math = renderMath(element);
  if (math) return math;
  if (["BUTTON", "SCRIPT", "STYLE", "SVG", "NOSCRIPT"].includes(tag)) return "";
  if (element.getAttribute("aria-hidden") === "true") return "";

  const content = () => childrenToMarkdown(element, context);
  if (/^H[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${compact(content())}\n\n`;
  if (tag === "P") return `\n\n${content()}\n\n`;
  if (tag === "BR") return "\n";
  if (tag === "HR") return "\n\n---\n\n";
  if (tag === "STRONG" || tag === "B") return `**${content()}**`;
  if (tag === "EM" || tag === "I") return `*${content()}*`;
  if (tag === "DEL" || tag === "S" || tag === "STRIKE") return `~~${content()}~~`;
  if (tag === "PRE" || tag === "CODE-BLOCK") {
    const code = element.querySelector(".cm-content")
      || element.querySelector("pre code")
      || element.querySelector("code")
      || element.querySelector("pre")
      || element;
    return fencedCode(codeText(code), codeLanguage(element, code));
  }
  if (tag === "CODE") {
    const value = element.textContent || "";
    const delimiter = value.includes("`") ? "``" : "`";
    return `${delimiter}${value}${delimiter}`;
  }
  if (tag === "A") {
    const href = safeLink(element.getAttribute("href"));
    const label = compact(content()) || href;
    return href ? `[${label.replace(/([\\[\]])/g, "\\$1")}](${href})` : label;
  }
  if (tag === "IMG") {
    const src = safeLink(element.getAttribute("src"), "image");
    const alt = element.getAttribute("alt") || "Image";
    return src ? `![${alt.replace(/]/g, "\\]")}](${src})` : "";
  }
  if (tag === "BLOCKQUOTE") {
    return `\n\n${compact(content()).split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  }
  if (tag === "UL" || tag === "OL") return renderList(element, context);
  if (tag === "TABLE") return renderTable(element);
  if (tag === "SUP") return `^${compact(content())}^`;
  if (tag === "SUB") return `~${compact(content())}~`;
  if (BLOCK_ELEMENTS.has(tag)) return `\n${content()}\n`;
  return content();
}

export function htmlToMarkdown(html) {
  if (!html) return "";
  const document = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  return compact(childrenToMarkdown(document.querySelector("main"), { listDepth: 0 }));
}
