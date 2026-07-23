// This function is serialized and executed in the ChatGPT page's main world.
// Keep every helper inside the function so chrome.scripting can inject it intact.
export async function extractCurrentChat() {
  const cleanTitle = (value) => String(value || "")
    .replace(/\s*[|\-]\s*ChatGPT\s*$/i, "")
    .replace(/\s*[|\-]\s*OpenAI\s*$/i, "")
    .trim();

  const path = window.location.pathname;
  const conversationMatch = path.match(/\/c\/([a-zA-Z0-9-]{8,})/);
  const shareMatch = path.match(/\/share\/([a-zA-Z0-9-]{8,})/);
  const conversationId = conversationMatch?.[1] || shareMatch?.[1] || "";
  const endpoints = shareMatch
    ? [`/backend-api/share/${conversationId}`, `/backend-api/shared_conversation/${conversationId}`]
    : conversationMatch
      ? [`/backend-api/conversation/${conversationId}`]
      : [];
  const apiErrors = [];
  const requestHeaders = { accept: "application/json" };

  if (conversationMatch) {
    try {
      const sessionResponse = await fetch("/api/auth/session", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (sessionResponse.ok) {
        const session = await sessionResponse.json();
        const accessToken = session?.accessToken || session?.access_token;
        if (accessToken) requestHeaders.authorization = `Bearer ${accessToken}`;
      }
    } catch {
      // Cookie-authenticated requests may still work, so continue without a token.
    }
  }

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        credentials: "include",
        headers: requestHeaders,
      });
      if (!response.ok) {
        apiErrors.push(`${endpoint}: HTTP ${response.status}`);
        continue;
      }
      const payload = await response.json();
      if (payload?.mapping || payload?.conversation?.mapping || payload?.data?.mapping) {
        return {
          kind: "api",
          payload,
          context: {
            conversationId,
            sourceUrl: window.location.href,
            pageTitle: cleanTitle(document.title),
          },
        };
      }
      apiErrors.push(`${endpoint}: response contained no message graph`);
    } catch (error) {
      apiErrors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const waitForRender = (milliseconds = 80) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const messagesById = new Map();
  const edges = new Map();
  const firstSeen = new Map();
  let snapshotNumber = 0;

  const fallbackId = (role, text) => {
    let hash = 5381;
    const value = `${role}:${text}`;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    }
    return `dom-${role}-${(hash >>> 0).toString(36)}`;
  };

  const readRenderedMessages = () => {
    snapshotNumber += 1;
    const sequence = [];
    const messageElements = [...document.querySelectorAll("[data-message-author-role]")];
    messageElements.forEach((element) => {
      const role = element.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") return;

      const content = role === "assistant"
        ? element.querySelector(".markdown.prose, .markdown-new-styling, .markdown, .prose") || element
        : element.querySelector(".whitespace-pre-wrap, [class*='whitespace-pre-wrap']") || element;
      const clone = content.cloneNode(true);
      clone.querySelectorAll("button, script, style, svg, [aria-hidden='true']").forEach((node) => node.remove());
      const text = clone.textContent?.trim() || "";
      if (!text) return;

      const container = element.closest(
        "section[data-turn-id], section[data-testid^='conversation-turn'], article[data-turn-id], article[data-testid^='conversation-turn'], [data-message-id]",
      );
      const turnId = container?.getAttribute("data-turn-id")
        || container?.getAttribute("data-message-id")
        || container?.getAttribute("data-testid")
        || element.getAttribute("data-message-id")
        || fallbackId(role, text);
      const id = `${turnId}:${role}`;
      sequence.push(id);
      if (!firstSeen.has(id)) firstSeen.set(id, snapshotNumber);
      messagesById.set(id, { id: turnId, role, html: clone.innerHTML, text });
      if (!edges.has(id)) edges.set(id, new Set());
    });

    for (let index = 0; index < sequence.length - 1; index += 1) {
      if (sequence[index] !== sequence[index + 1]) edges.get(sequence[index]).add(sequence[index + 1]);
    }
    return sequence;
  };

  const findScrollContainer = () => {
    const message = document.querySelector("section[data-turn-id], [data-message-author-role]");
    let candidate = message?.parentElement;
    while (candidate && candidate !== document.body) {
      const style = getComputedStyle(candidate);
      const canScroll = /(auto|scroll)/.test(style.overflowY)
        && candidate.scrollHeight > candidate.clientHeight + 20;
      if (canScroll) return candidate;
      candidate = candidate.parentElement;
    }
    const root = document.scrollingElement;
    return root && root.scrollHeight > root.clientHeight + 20 ? root : null;
  };

  readRenderedMessages();
  const scrollContainer = findScrollContainer();
  const scrollState = {
    attempted: Boolean(scrollContainer),
    reachedTop: !scrollContainer,
    reachedBottom: !scrollContainer,
  };

  if (scrollContainer) {
    const originalTop = scrollContainer.scrollTop;
    const originalBehavior = scrollContainer.style.scrollBehavior;
    scrollContainer.style.scrollBehavior = "auto";
    const step = Math.max(320, Math.floor(scrollContainer.clientHeight * 0.72));

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const before = scrollContainer.scrollTop;
      if (before <= 1) {
        await waitForRender(160);
        readRenderedMessages();
        if (scrollContainer.scrollTop <= 1) {
          scrollState.reachedTop = true;
          break;
        }
      }
      scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - step);
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForRender();
      readRenderedMessages();
    }

    if (scrollState.reachedTop) {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const maximum = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        if (scrollContainer.scrollTop >= maximum - 1) {
          await waitForRender(160);
          readRenderedMessages();
          const updatedMaximum = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
          if (scrollContainer.scrollTop >= updatedMaximum - 1) {
            scrollState.reachedBottom = true;
            break;
          }
        }
        scrollContainer.scrollTop = Math.min(maximum, scrollContainer.scrollTop + step);
        scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
        await waitForRender();
        readRenderedMessages();
      }
    }

    scrollContainer.scrollTop = Math.min(
      originalTop,
      Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight),
    );
    scrollContainer.style.scrollBehavior = originalBehavior;
    scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
  }

  const indegree = new Map([...messagesById.keys()].map((id) => [id, 0]));
  edges.forEach((targets) => targets.forEach((target) => {
    if (indegree.has(target)) indegree.set(target, indegree.get(target) + 1);
  }));
  const earlierFirst = (a, b) => (firstSeen.get(b) || 0) - (firstSeen.get(a) || 0);
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort(earlierFirst);
  const orderedIds = [];
  while (ready.length > 0) {
    const id = ready.shift();
    orderedIds.push(id);
    for (const target of edges.get(id) || []) {
      if (!indegree.has(target)) continue;
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort(earlierFirst);
      }
    }
  }
  const missingIds = [...messagesById.keys()].filter((id) => !orderedIds.includes(id)).sort(earlierFirst);
  const messages = [...orderedIds, ...missingIds].map((id) => messagesById.get(id));

  const isGenerating = Boolean(
    document.querySelector("[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']"),
  );

  return {
    kind: "dom",
    payload: {
      conversationId,
      sourceUrl: window.location.href,
      title: cleanTitle(document.title),
      messages,
      isGenerating,
      apiErrors,
      scroll: {
        ...scrollState,
        complete: scrollState.reachedTop && scrollState.reachedBottom,
        collected: messages.length,
      },
    },
  };
}
