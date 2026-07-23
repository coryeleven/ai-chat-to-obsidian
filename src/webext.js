export function getWebExtensionApi() {
  return globalThis.browser || globalThis.chrome || null;
}

export async function detectBrowserKind() {
  const api = getWebExtensionApi();
  if (typeof api?.runtime?.getBrowserInfo === "function") {
    try {
      const info = await api.runtime.getBrowserInfo();
      if (/firefox/i.test(info?.name || "")) return "firefox";
    } catch {
      // Fall back to the user agent when the privileged API is unavailable.
    }
  }

  const userAgent = globalThis.navigator?.userAgent || "";
  if (/firefox\//i.test(userAgent)) return "firefox";
  if (/edg\//i.test(userAgent)) return "edge";
  if (/chrom(?:e|ium)\//i.test(userAgent)) return "chromium";
  return "unknown";
}
