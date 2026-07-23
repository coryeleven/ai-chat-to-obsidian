// This function is serialized and executed in Gemini's main world.
// Keep every helper inside the function so scripting.executeScript can inject it intact.
export async function extractCurrentGemini() {
  const wait = (milliseconds = 90) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const sourceUrl = window.location.href;
  const conversationId = window.location.pathname.match(/\/app\/([^/?#]+)/)?.[1] || "";
  const messagesById = new Map();
  const edges = new Map();
  const firstSeen = new Map();
  const fallbackRecords = [];
  let previousSnapshot = [];
  let snapshotNumber = 0;
  let fallbackCounter = 0;

  const cleanTitle = (value) => String(value || "")
    .replace(/\s*[|\-]\s*Google Gemini\s*$/i, "")
    .replace(/\s*[|\-]\s*Gemini\s*$/i, "")
    .trim();

  const hashValue = (value) => {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  };

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || 1) !== 0
      && (style.display === "contents" || (bounds.width > 0 && bounds.height > 0));
  };

  const removeUi = (clone) => {
    clone.querySelectorAll("canvas, video, audio").forEach((node) => {
      const placeholder = clone.ownerDocument.createElement("span");
      placeholder.setAttribute("data-export-media", node.tagName.toLowerCase());
      placeholder.textContent = node.tagName === "CANVAS"
        ? "_[Canvas or generated diagram]_"
        : `_[${node.tagName[0]}${node.tagName.slice(1).toLowerCase()} attachment]_`;
      node.replaceWith(placeholder);
    });
    clone.querySelectorAll([
      "button", "script", "style", "svg", "form",
      "input", "textarea", "select", "message-actions", "model-response-actions",
      "[contenteditable='true']", "[aria-hidden='true']", ".cdk-visually-hidden",
      ".screen-reader-user-query-label", ".code-block-decoration",
      "[class*='screen-reader']", "[class*='visually-hidden']",
    ].join(",")).forEach((node) => node.remove());
    return clone;
  };

  const roleFor = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "user-query") return "user";
    if (tag === "model-response") return "assistant";
    const declared = element.getAttribute("data-message-author-role")
      || element.getAttribute("data-author")
      || element.getAttribute("data-sender")
      || element.getAttribute("data-role");
    if (/^(user|human)$/i.test(declared || "")) return "user";
    if (/^(assistant|model|gemini)$/i.test(declared || "")) return "assistant";
    return "";
  };

  const contentFor = (element, role) => {
    if (role === "user") {
      return element.querySelector("user-query-content .query-text, .query-text, user-query-content") || element;
    }
    return element.querySelector([
      "message-content", ".model-response-text", "structured-content-container",
      "response-container .response-container-content", ".response-container-content",
      "response-container", ".response-container", ".markdown", ".prose",
    ].join(",")) || element;
  };

  const messageElements = () => {
    const candidates = [...document.querySelectorAll([
      "user-query", "model-response",
      "[data-test-id='conversation-turn']", "[data-testid='conversation-turn']",
      "[data-message-author-role]",
    ].join(","))];
    return candidates
      .filter((element) => {
        if (!roleFor(element) || !isVisible(element)) return false;
        const tag = element.tagName.toLowerCase();
        return tag === "user-query"
          || tag === "model-response"
          || !element.querySelector("user-query, model-response");
      })
      .sort((left, right) => {
        if (left === right) return 0;
        return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
  };

  const semanticIdFor = (element, role) => {
    const container = element.closest([
      "[data-turn-id]", "[data-message-id]", ".conversation-container",
      "[data-test-id='conversation-turn']", "[data-testid='conversation-turn']",
    ].join(","));
    const semanticId = element.getAttribute("data-message-id")
      || element.getAttribute("data-turn-id")
      || element.id
      || contentFor(element, role).id
      || container?.getAttribute("data-message-id")
      || container?.getAttribute("data-turn-id")
      || container?.id;
    return semanticId || "";
  };

  const readRenderedMessages = () => {
    snapshotNumber += 1;
    const sequence = [];
    const drafts = messageElements().flatMap((element) => {
      const role = roleFor(element);
      if (!role) return [];
      const clone = removeUi(contentFor(element, role).cloneNode(true));
      const text = clone.textContent?.replace(/\s+/g, " ").trim() || "";
      const hasMedia = Boolean(clone.querySelector("img, [data-export-media]"));
      if (!text && !hasMedia) return [];
      const seenSources = new Set();
      const sources = role === "assistant"
        ? [...element.querySelectorAll([
          "sources-list a[href]", "[data-test-id*='citation' i] a[href]",
          "[data-testid*='citation' i] a[href]", "[class*='citation'] a[href]",
        ].join(","))].flatMap((link) => {
          const href = link.href;
          if (!/^https?:\/\//i.test(href) || seenSources.has(href)) return [];
          seenSources.add(href);
          return [{ title: link.textContent?.trim() || href, url: href }];
        })
        : [];
      return [{
        element,
        role,
        clone,
        text: text || "_[Image or attachment]_",
        contentKey: text || clone.innerHTML,
        semanticId: semanticIdFor(element, role),
        sources,
      }];
    });
    const signatures = drafts.map((draft) => `${draft.role}:${hashValue(draft.contentKey)}`);
    let overlap = 0;
    for (let size = Math.min(previousSnapshot.length, signatures.length); size > 0; size -= 1) {
      const previousStart = previousSnapshot.length - size;
      const matches = signatures.slice(0, size).every(
        (signature, index) => previousSnapshot[previousStart + index].signature === signature,
      );
      if (matches) {
        overlap = size;
        break;
      }
    }
    const previousOverlapStart = previousSnapshot.length - overlap;
    const usedFallbackIds = new Set();
    const currentSnapshot = [];
    drafts.forEach((draft, index) => {
      let id = draft.semanticId;
      if (!id && index < overlap) {
        id = previousSnapshot[previousOverlapStart + index].id;
      }
      if (!id) {
        const signature = signatures[index];
        const previous = signatures[index - 1] || "";
        const next = signatures[index + 1] || "";
        const candidates = fallbackRecords
          .filter((record) => record.signature === signature && !usedFallbackIds.has(record.id))
          .map((record) => ({
            record,
            score: (previous && record.previous.has(previous) ? 2 : 0)
              + (next && record.next.has(next) ? 2 : 0),
          }))
          .sort((left, right) => right.score - left.score);
        let record = candidates[0]?.score > 0 ? candidates[0].record : null;
        if (!record) {
          fallbackCounter += 1;
          record = {
            id: `gemini-${draft.role}-${hashValue(draft.contentKey)}-${fallbackCounter}`,
            signature,
            previous: new Set(),
            next: new Set(),
          };
          fallbackRecords.push(record);
        }
        if (previous) record.previous.add(previous);
        if (next) record.next.add(next);
        usedFallbackIds.add(record.id);
        id = record.id;
      } else if (!draft.semanticId) {
        usedFallbackIds.add(id);
        const record = fallbackRecords.find((candidate) => candidate.id === id);
        if (record) {
          const previous = signatures[index - 1] || "";
          const next = signatures[index + 1] || "";
          if (previous) record.previous.add(previous);
          if (next) record.next.add(next);
        }
      }
      const key = `${id}:${draft.role}`;
      sequence.push(key);
      currentSnapshot.push({ id, signature: signatures[index] });
      if (!firstSeen.has(key)) firstSeen.set(key, snapshotNumber);
      messagesById.set(key, {
        id,
        role: draft.role,
        html: draft.clone.innerHTML,
        text: draft.text,
        sources: draft.sources,
      });
      if (!edges.has(key)) edges.set(key, new Set());
    });
    for (let index = 0; index < sequence.length - 1; index += 1) {
      if (sequence[index] !== sequence[index + 1]) edges.get(sequence[index]).add(sequence[index + 1]);
    }
    previousSnapshot = currentSnapshot;
    return sequence;
  };

  const findScrollContainer = () => {
    const explicit = document.querySelector("infinite-scroller[data-test-id='chat-history-container']");
    if (explicit && explicit.scrollHeight > explicit.clientHeight + 20) return explicit;
    let candidate = messageElements()[0]?.parentElement;
    while (candidate && candidate !== document.body) {
      const style = getComputedStyle(candidate);
      if (/(auto|scroll)/.test(style.overflowY)
        && candidate.scrollHeight > candidate.clientHeight + 20) return candidate;
      candidate = candidate.parentElement;
    }
    const root = document.scrollingElement;
    return root && root.scrollHeight > root.clientHeight + 20 ? root : null;
  };

  const settleAndRead = async (milliseconds = 130) => {
    await wait(milliseconds);
    const before = messagesById.size;
    readRenderedMessages();
    await wait(45);
    readRenderedMessages();
    return messagesById.size !== before;
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
    const originalBottomDistance = Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight - originalTop,
    );
    const originalBehavior = scrollContainer.style.scrollBehavior;
    scrollContainer.style.scrollBehavior = "auto";
    const moveTo = async (top) => {
      scrollContainer.scrollTop = top;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      await settleAndRead();
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const before = scrollContainer.scrollTop;
      await moveTo(0);
      if (scrollContainer.scrollTop <= 1) {
        await settleAndRead(180);
        if (scrollContainer.scrollTop <= 1 && before === scrollContainer.scrollTop) {
          scrollState.reachedTop = true;
          break;
        }
        if (scrollContainer.scrollTop <= 1) {
          scrollState.reachedTop = true;
          break;
        }
      }
    }

    if (scrollState.reachedTop) {
      let unchangedAtEnd = 0;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const step = Math.max(320, Math.floor(scrollContainer.clientHeight * 0.74));
        const maximum = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        const beforeTop = scrollContainer.scrollTop;
        const beforeHeight = scrollContainer.scrollHeight;
        const beforeCount = messagesById.size;
        await moveTo(Math.min(maximum, beforeTop + step));
        const updatedMaximum = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        const atEnd = scrollContainer.scrollTop >= updatedMaximum - 1;
        const unchanged = beforeHeight === scrollContainer.scrollHeight
          && beforeCount === messagesById.size
          && (atEnd || beforeTop === scrollContainer.scrollTop);
        unchangedAtEnd = atEnd && unchanged ? unchangedAtEnd + 1 : 0;
        if (unchangedAtEnd >= 2) {
          scrollState.reachedBottom = true;
          break;
        }
      }
    }

    const restoredMaximum = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    scrollContainer.scrollTop = Math.max(0, restoredMaximum - originalBottomDistance);
    scrollContainer.style.scrollBehavior = originalBehavior;
    scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
  }

  const indegree = new Map([...messagesById.keys()].map((key) => [key, 0]));
  edges.forEach((targets) => targets.forEach((target) => {
    if (indegree.has(target)) indegree.set(target, indegree.get(target) + 1);
  }));
  // The top of a virtualized list is discovered after the initial viewport.
  // Prefer later-discovered disconnected components so the oldest turn stays first.
  const earlierFirst = (a, b) => (firstSeen.get(b) || 0) - (firstSeen.get(a) || 0);
  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([key]) => key)
    .sort(earlierFirst);
  const orderedKeys = [];
  while (ready.length > 0) {
    const key = ready.shift();
    orderedKeys.push(key);
    for (const target of edges.get(key) || []) {
      if (!indegree.has(target)) continue;
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort(earlierFirst);
      }
    }
  }
  const remaining = [...messagesById.keys()]
    .filter((key) => !orderedKeys.includes(key))
    .sort(earlierFirst);
  const messages = [...orderedKeys, ...remaining].map((key) => messagesById.get(key));

  const stopControls = [...document.querySelectorAll([
    "button[aria-label*='Stop' i]", "button[aria-label*='停止']",
    "[data-test-id*='stop' i]", "[data-testid*='stop' i]",
  ].join(","))];
  const lastModel = [...document.querySelectorAll("model-response")].filter(isVisible).at(-1);
  const progressSelector = [
    "[role='progressbar']", "[aria-busy='true']", "[data-is-generating='true']",
  ].join(",");
  const lastModelProgress = lastModel && (
    (lastModel.matches(progressSelector) && isVisible(lastModel))
    || [...lastModel.querySelectorAll(progressSelector)].some(isVisible)
  );
  const isGenerating = stopControls.some(isVisible) || Boolean(lastModelProgress);

  const firstUserText = messages.find((message) => message.role === "user")?.text || "";
  const pageTitle = cleanTitle(document.title);
  const title = (/^(?:(?:Google )?Gemini|New chat|Untitled)$/i.test(pageTitle) ? "" : pageTitle)
    || firstUserText.replace(/\s+/g, " ").slice(0, 80)
    || "Untitled Gemini conversation";

  return {
    kind: "dom",
    payload: {
      provider: "gemini",
      conversationId,
      sourceUrl,
      title,
      messages,
      isGenerating,
      scroll: {
        ...scrollState,
        complete: scrollState.reachedTop && scrollState.reachedBottom,
        collected: messages.length,
      },
    },
  };
}
