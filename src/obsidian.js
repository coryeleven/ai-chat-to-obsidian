function normalizeRelativePath(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }

  const path = value.trim().replace(/\\/g, "/");
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new Error(`${label} cannot contain control characters.`);
  }

  const segments = [];
  for (const rawSegment of path.split("/")) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new Error(`${label} must stay inside the Obsidian vault.`);
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function normalizeObsidianFolder(folder = "") {
  if (folder == null) return "";
  return normalizeRelativePath(folder, "Obsidian folder");
}

export function buildObsidianNewUri({
  file,
  vault = "",
  clipboard = true,
  overwrite = false,
  silent = false,
  clipboardFallback = "",
} = {}) {
  const normalizedFile = normalizeRelativePath(file, "Obsidian file");
  if (!normalizedFile) throw new Error("Obsidian file is required.");

  const normalizedVault = typeof vault === "string" ? vault.trim() : "";
  if (vault != null && typeof vault !== "string") {
    throw new TypeError("Obsidian vault must be a string.");
  }
  if (clipboardFallback != null && typeof clipboardFallback !== "string") {
    throw new TypeError("Clipboard fallback content must be a string.");
  }

  let uri = `obsidian://new?file=${encodeURIComponent(normalizedFile)}`;
  if (overwrite) uri += "&overwrite=true";
  if (normalizedVault) uri += `&vault=${encodeURIComponent(normalizedVault)}`;
  if (silent) uri += "&silent=true";
  if (clipboard) {
    uri += "&clipboard";
    if (clipboardFallback) uri += `&content=${encodeURIComponent(clipboardFallback)}`;
  }

  return uri;
}

export function isObsidianNewUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "obsidian:" && url.hostname === "new";
  } catch {
    return false;
  }
}
