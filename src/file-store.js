const DATABASE_NAME = "chatgpt-to-obsidian";
const STORE_NAME = "handles";
const DESTINATION_KEY = "destination";
const CONVERSATION_FILE_PREFIX = "conversation-file:";
const PENDING_EXPORT_PREFIX = "pending-export:";
const PENDING_EXPORT_TTL_MS = 30 * 60 * 1000;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const COMPLETED_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, callback) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      let request;
      let result;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error || new Error("IndexedDB transaction failed."));
      };
      try {
        request = callback(transaction.objectStore(STORE_NAME));
      } catch (error) {
        transaction.abort();
        fail(error);
        return;
      }
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || request.error);
    });
  } finally {
    database.close();
  }
}

function pendingExportKey(requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new Error("A pending export request ID is required.");
  }
  return `${PENDING_EXPORT_PREFIX}${requestId}`;
}

async function mutatePendingExport(requestId, mutator) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const key = pendingExportKey(requestId);
      const request = store.get(key);
      let result;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error || new Error("IndexedDB transaction failed."));
      };

      request.onsuccess = () => {
        try {
          const mutation = mutator(request.result);
          result = mutation.result;
          if (mutation.deleteValue) store.delete(key);
          if (Object.hasOwn(mutation, "value")) store.put(mutation.value, key);
        } catch (error) {
          transaction.abort();
          fail(error);
        }
      };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || request.error);
    });
  } finally {
    database.close();
  }
}

export function getDestinationHandle() {
  return withStore("readonly", (store) => store.get(DESTINATION_KEY));
}

export function setDestinationHandle(handle) {
  return withStore("readwrite", (store) => store.put(handle, DESTINATION_KEY));
}

export function getConversationFilename(conversationId) {
  return withStore("readonly", (store) => store.get(`${CONVERSATION_FILE_PREFIX}${conversationId}`));
}

export function setConversationFilename(conversationId, filename) {
  return withStore(
    "readwrite",
    (store) => store.put(filename, `${CONVERSATION_FILE_PREFIX}${conversationId}`),
  );
}

export function getPendingExport(requestId) {
  return withStore("readonly", (store) => store.get(pendingExportKey(requestId)));
}

export async function setPendingExport(pendingExport) {
  await prunePendingExports();
  return withStore(
    "readwrite",
    (store) => store.put(pendingExport, pendingExportKey(pendingExport?.id)),
  );
}

export async function prunePendingExports(now = Date.now()) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      let cleaned = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error || new Error("IndexedDB transaction failed."));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key);
        const stored = cursor.value;
        if (key.startsWith(PENDING_EXPORT_PREFIX) && stored) {
          const completedAt = Date.parse(stored.completedAt || stored.expiredAt || "");
          const createdAt = Date.parse(stored.createdAt || "");
          if (new Set(["completed", "expired"]).has(stored.status)
            && Number.isFinite(completedAt)
            && now - completedAt > COMPLETED_EXPORT_TTL_MS) {
            cursor.delete();
            cleaned += 1;
          } else if (!new Set(["completed", "expired"]).has(stored.status)
            && Number.isFinite(createdAt)
            && now - createdAt > PENDING_EXPORT_TTL_MS) {
            const { markdown: _markdown, ...metadata } = stored;
            cursor.update({
              ...metadata,
              status: "expired",
              ownerId: null,
              claimedAt: null,
              expiredAt: new Date(now).toISOString(),
            });
            cleaned += 1;
          }
        }
        cursor.continue();
      };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(cleaned);
      };
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || request.error);
    });
  } finally {
    database.close();
  }
}

export function clearPendingExport(requestId) {
  return withStore("readwrite", (store) => store.delete(pendingExportKey(requestId)));
}

export function claimPendingExport(requestId, ownerId, now = Date.now()) {
  if (typeof ownerId !== "string" || !ownerId) throw new Error("A pending export owner ID is required.");
  return mutatePendingExport(requestId, (stored) => {
    if (!stored) return { result: null };
    if (stored.status === "completed" || stored.status === "expired") return { result: stored };

    const createdAt = Date.parse(stored.createdAt);
    if (Number.isFinite(createdAt) && now - createdAt > PENDING_EXPORT_TTL_MS) {
      const { markdown: _markdown, ...metadata } = stored;
      const expired = { ...metadata, status: "expired", expiredAt: new Date(now).toISOString() };
      return { value: expired, result: expired };
    }

    const claimedAt = Date.parse(stored.claimedAt || "");
    const activeLease = stored.status === "processing"
      && stored.ownerId !== ownerId
      && Number.isFinite(claimedAt)
      && now - claimedAt < PROCESSING_LEASE_MS;
    if (activeLease) return { result: stored };

    const claimed = {
      ...stored,
      status: "processing",
      ownerId,
      claimedAt: new Date(now).toISOString(),
      attempts: Number(stored.attempts || 0) + 1,
      lastError: "",
    };
    return { value: claimed, result: claimed };
  });
}

export function recordPendingExportFilename(requestId, ownerId, resolvedFilename) {
  return mutatePendingExport(requestId, (stored) => {
    if (!stored || stored.status !== "processing" || stored.ownerId !== ownerId) {
      throw new Error("The pending export is no longer owned by this page.");
    }
    const updated = { ...stored, resolvedFilename };
    return { value: updated, result: updated };
  });
}

export function releasePendingExport(requestId, ownerId, errorMessage = "") {
  return mutatePendingExport(requestId, (stored) => {
    if (!stored || stored.status === "completed" || stored.status === "expired") {
      return { result: stored || null };
    }
    if (stored.status !== "processing" || stored.ownerId !== ownerId) return { result: stored };
    const released = {
      ...stored,
      status: "pending",
      ownerId: null,
      claimedAt: null,
      lastError: String(errorMessage || ""),
    };
    return { value: released, result: released };
  });
}

export async function finalizePendingExport(requestId, ownerId, resolvedFilename) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const key = pendingExportKey(requestId);
      const request = store.get(key);
      let completed;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error || new Error("IndexedDB transaction failed."));
      };

      request.onsuccess = () => {
        try {
          const stored = request.result;
          if (!stored || stored.status !== "processing" || stored.ownerId !== ownerId) {
            throw new Error("The pending export is no longer owned by this page.");
          }
          const { markdown: _markdown, ownerId: _ownerId, claimedAt: _claimedAt, ...metadata } = stored;
          completed = {
            ...metadata,
            status: "completed",
            filename: resolvedFilename,
            resolvedFilename,
            completedAt: new Date().toISOString(),
          };
          store.put(resolvedFilename, `${CONVERSATION_FILE_PREFIX}${stored.conversationId}`);
          store.put(completed, key);
        } catch (error) {
          transaction.abort();
          fail(error);
        }
      };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(completed);
      };
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || request.error);
    });
  } finally {
    database.close();
  }
}

export async function chooseDestination() {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("Direct folder access is unavailable in this browser.");
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await setDestinationHandle(handle);
  return handle;
}

export async function ensureWritePermission(handle) {
  if (!handle) return false;
  const options = { mode: "readwrite" };
  if (await handle.queryPermission(options) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

export async function queryWritePermission(handle) {
  if (!handle) return "prompt";
  return handle.queryPermission({ mode: "readwrite" });
}

function conversationIdFromMarkdown(markdown) {
  const rawValue = String(markdown).match(/^conversation_id:\s*(.+)$/m)?.[1]?.trim();
  if (!rawValue) return "";
  try {
    return String(JSON.parse(rawValue));
  } catch {
    return rawValue.replace(/^["']|["']$/g, "");
  }
}

async function readExistingFile(handle, filename) {
  try {
    const fileHandle = await handle.getFileHandle(filename, { create: false });
    const file = await fileHandle.getFile();
    return { exists: true, content: await file.text() };
  } catch (error) {
    if (error?.name === "NotFoundError") return { exists: false, content: "" };
    throw error;
  }
}

async function collisionSafeFilename(handle, preferredFilename, markdown) {
  const incomingId = conversationIdFromMarkdown(markdown);
  const existing = await readExistingFile(handle, preferredFilename);
  if (!existing.exists || (incomingId && conversationIdFromMarkdown(existing.content) === incomingId)) {
    return preferredFilename;
  }

  const extensionIndex = preferredFilename.toLowerCase().endsWith(".md")
    ? preferredFilename.length - 3
    : preferredFilename.length;
  const stem = preferredFilename.slice(0, extensionIndex);
  const extension = preferredFilename.slice(extensionIndex) || ".md";
  for (let number = 2; number <= 100; number += 1) {
    const candidate = `${stem} (${number})${extension}`;
    const candidateFile = await readExistingFile(handle, candidate);
    if (!candidateFile.exists) return candidate;
    if (incomingId && conversationIdFromMarkdown(candidateFile.content) === incomingId) return candidate;
  }
  throw new Error("Could not find a safe filename after 100 collision attempts.");
}

export async function writeMarkdownFile(handle, filename, markdown) {
  if ((await queryWritePermission(handle)) !== "granted") {
    throw new Error("Write access to the selected folder was not granted.");
  }
  const resolvedFilename = await collisionSafeFilename(handle, filename, markdown);
  const fileHandle = await handle.getFileHandle(resolvedFilename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(markdown);
    await writable.close();
  } catch (error) {
    if (typeof writable.abort === "function") {
      try { await writable.abort(); } catch {}
    }
    throw error;
  }
  return resolvedFilename;
}
