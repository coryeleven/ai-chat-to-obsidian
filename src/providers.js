const PROVIDER_LIST = Object.freeze([
  Object.freeze({
    id: "chatgpt",
    label: "ChatGPT",
    tag: "chatgpt",
    hostnames: Object.freeze(["chatgpt.com", "chat.openai.com"]),
  }),
  Object.freeze({
    id: "gemini",
    label: "Gemini",
    tag: "gemini",
    hostnames: Object.freeze(["gemini.google.com"]),
  }),
]);

export const PROVIDERS = Object.freeze(Object.fromEntries(
  PROVIDER_LIST.map((provider) => [provider.id, provider]),
));

export function providerById(id) {
  return PROVIDERS[String(id || "").toLowerCase()] || null;
}

export function providerForUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return PROVIDER_LIST.find((provider) => provider.hostnames.includes(url.hostname)) || null;
  } catch {
    return null;
  }
}

export function isSupportedProviderUrl(value) {
  return Boolean(providerForUrl(value));
}
