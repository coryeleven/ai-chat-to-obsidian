export const SETTINGS_KEY = "obsidian-save-settings";

export const DEFAULT_SETTINGS = Object.freeze({
  vault: "",
  folder: "AI Chats",
  silentOpen: true,
  detailedMetadata: false,
});

function cleanSingleLine(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeFolder(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => cleanSingleLine(part, 96))
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 240);
}

export function normalizeSettings(value = {}) {
  return {
    vault: cleanSingleLine(value.vault, 120),
    folder: normalizeFolder(value.folder),
    silentOpen: value.silentOpen !== false,
    detailedMetadata: value.detailedMetadata === true,
  };
}

export async function loadSettings(api) {
  if (!api?.storage?.local?.get) return { ...DEFAULT_SETTINGS };
  const stored = await api.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored?.[SETTINGS_KEY] || DEFAULT_SETTINGS);
}

export async function saveSettings(api, value) {
  const normalized = normalizeSettings(value);
  if (!api?.storage?.local?.set) return normalized;
  await api.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export function destinationLabel(settings) {
  const normalized = normalizeSettings(settings);
  const vault = normalized.vault || "当前 Vault";
  return normalized.folder ? `${vault} / ${normalized.folder}` : vault;
}
