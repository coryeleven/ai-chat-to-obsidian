import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(projectRoot, "fixtures", "gemini-dom-fixture.html");
const virtualizedFixturePath = path.join(projectRoot, "fixtures", "gemini-virtualized-chat.html");
const suppliedPort = process.argv[2] || process.env.FIREFOX_BIDI_PORT || "";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

async function availablePort() {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function staticServer() {
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      let target;
      if (pathname === "/app/gemini-fixture-smoke") {
        target = fixturePath;
      } else if (pathname === "/app/gemini-virtualized-smoke") {
        target = virtualizedFixturePath;
      } else if (pathname.startsWith("/src/") || pathname.startsWith("/fixtures/")) {
        target = path.resolve(projectRoot, `.${pathname}`);
      }

      const insideProject = target === projectRoot || target?.startsWith(`${projectRoot}${path.sep}`);
      if (!target || !insideProject) {
        response.writeHead(404).end("Not found");
        return;
      }

      const body = await readFile(target);
      const contentType = target.endsWith(".html")
        ? "text/html; charset=utf-8"
        : target.endsWith(".js") || target.endsWith(".mjs")
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": contentType,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end("Fixture server error");
    }
  });
}

async function firefoxBinary() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Firefox.app/Contents/MacOS/firefox"]
    : process.platform === "win32"
      ? [
        "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
        "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
      ]
      : ["/usr/bin/firefox", "/usr/local/bin/firefox"];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional installation path.
    }
  }
  if (process.platform !== "win32" && process.platform !== "darwin") return "firefox";
  throw new Error("Firefox was not found. Set FIREFOX_BIN or pass an existing BiDi port.");
}

function openSocket(url, timeout = 1_500) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeout);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to ${url}`));
    }, { once: true });
  });
}

async function connectBidi(port, timeout = 12_000) {
  const url = `ws://127.0.0.1:${port}/session`;
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await openSocket(url);
    } catch (error) {
      lastError = error;
      await delay(120);
    }
  }
  throw new Error(`${lastError?.message || `Could not connect to ${url}`} after ${timeout} ms.`);
}

function bidiClient(socket) {
  const pending = new Map();
  const logErrors = [];
  let commandId = 0;

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "success" && pending.has(message.id)) {
      pending.get(message.id).resolve(message.result);
      pending.delete(message.id);
      return;
    }
    if (message.type === "error" && pending.has(message.id)) {
      pending.get(message.id).reject(new Error(`${message.error}: ${message.message}`));
      pending.delete(message.id);
      return;
    }
    if (message.type === "event" && message.method === "log.entryAdded") {
      if (message.params?.level === "error") logErrors.push(message.params.text || "Unknown browser error");
    }
  });

  return {
    logErrors,
    send(method, params = {}) {
      const id = ++commandId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
  };
}

async function stopFirefox(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(2_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(1_000)]);
  }
}

function assertFixture(state, logErrors) {
  const fixture = state.fixture;
  assert.ok(fixture, "The fixture did not publish window.__fixtureResult.");
  const extractedMarkdown = fixture.conversation?.messages
    ?.map((message) => message.markdown)
    .join("\n") || "";
  assert.equal(
    fixture.passed,
    true,
    `Fixture checks failed: ${JSON.stringify(fixture.checks || fixture.error)}\nMarkdown:\n${extractedMarkdown}`,
  );
  assert.equal(state.resultAttribute, "true", "The visible fixture result was not PASS.");

  const { conversation } = fixture;
  assert.equal(conversation.provider, "gemini");
  assert.equal(conversation.id, "gemini-fixture-smoke");
  assert.equal(conversation.title, "Gemini DOM 提取测试");
  assert.equal(conversation.stats.messageCount, 12);
  assert.equal(conversation.stats.roundCount, 6);
  assert.deepEqual(
    conversation.messages.map((message) => message.role),
    [
      "user", "assistant", "user", "assistant", "user", "assistant",
      "user", "assistant", "user", "assistant", "user", "assistant",
    ],
  );
  assert.deepEqual(
    conversation.messages.slice(0, 4).map((message) => message.id),
    ["g-u-1", "g-a-1", "g-u-2", "g-a-2"],
  );
  assert.equal(
    new Set(conversation.messages.slice(4, 8).map((message) => message.id)).size,
    4,
    "Repeated messages without semantic IDs must remain distinct.",
  );

  const markdown = extractedMarkdown;
  assert.match(markdown, /```ts\nconst ready = true;/);
  assert.match(markdown, /```js\nconst first = 1;\nconst second = 2;/);
  assert.match(markdown, /\| 状态 \| 值 \|/);
  assert.match(markdown, /\$E = mc\^2\$/);
  assert.equal(conversation.messages[1].sources.length, 1);
  assert.equal(conversation.messages[1].sources[0].url, "https://ai.google.dev/gemini-api/docs");
  assert.equal(conversation.incomplete, true);
  assert.equal(conversation.messages.at(-1).status, "in_progress");
  assert.doesNotMatch(markdown, /复制代码|复制回答|你说：|javascript:/);
  assert.doesNotMatch(markdown, /隐藏草稿不应导出/);
  assert.match(markdown, /危险链接/);
  assert.match(markdown, /旧版用户节点/);
  assert.match(markdown, /新版模型节点/);
  assert.match(markdown, /!\[生成的像素\]\(data:image\/gif;base64,/);
  assert.equal(logErrors.length, 0, `Browser errors: ${logErrors.join(" | ")}`);

  return {
    messages: conversation.stats.messageCount,
    rounds: conversation.stats.roundCount,
    title: conversation.title,
    roles: conversation.messages.map((message) => message.role),
    sourceCount: conversation.messages[1].sources.length,
    richText: {
      code: markdown.includes("```ts"),
      codeMirror: markdown.includes("```js\nconst first = 1;\nconst second = 2;"),
      table: markdown.includes("| 状态 | 值 |"),
      math: markdown.includes("$E = mc^2$"),
      unsafeLinkRemoved: !markdown.includes("javascript:"),
      repeatedMessages: conversation.messages.filter((message) => /重复问题|重复回答/.test(message.markdown)).length === 4,
      mixedDom: markdown.includes("旧版用户节点") && markdown.includes("新版模型节点"),
      imageOnly: markdown.includes("![生成的像素](data:image/gif;base64,"),
      hiddenDraftRemoved: !markdown.includes("隐藏草稿不应导出"),
      generating: conversation.incomplete && conversation.messages.at(-1).status === "in_progress",
    },
  };
}

function assertVirtualizedFixture(state) {
  const fixture = state.fixture;
  assert.ok(fixture, "The virtualized fixture did not publish a result.");
  assert.equal(
    fixture.passed,
    true,
    `Virtualized checks failed: ${JSON.stringify(fixture.checks || fixture.error)}\nIDs: ${fixture.ids?.join(",")}`,
  );
  assert.equal(state.resultAttribute, "true");
  assert.equal(fixture.ids.length, 20);
  assert.equal(new Set(fixture.ids).size, 20);
  assert.equal(fixture.markdownMessages[0], "Gemini 第 1 个问题");
  assert.equal(fixture.markdownMessages.at(-1), "Gemini 第 10 个回答");
  assert.equal(fixture.scroll.complete, true);
  return {
    messages: fixture.ids.length,
    rounds: fixture.ids.length / 2,
    complete: fixture.scroll.complete,
    restoredBottomDistance: fixture.restoredBottomDistance,
  };
}

async function readFixture(client, context) {
  const evaluated = await client.send("script.evaluate", {
    expression: `(async () => {
      for (let attempt = 0; attempt < 240 && !window.__fixtureResult; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return JSON.stringify({
        fixture: window.__fixtureResult || null,
        documentTitle: document.title,
        href: location.href,
        resultAttribute: document.querySelector('#result')?.dataset.passed || '',
        resultText: document.querySelector('#result')?.textContent || ''
      });
    })()`,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (evaluated.result?.type !== "string") {
    throw new Error(`Unexpected browser result: ${JSON.stringify(evaluated)}`);
  }
  return JSON.parse(evaluated.result.value);
}

async function main() {
  await access(fixturePath);
  await access(virtualizedFixturePath);
  const server = staticServer();
  const fixturePort = await listen(server);
  let browserProcess;
  let browserOutput = "";
  let profilePath;
  let socket;
  let client;
  let session;
  let context;

  try {
    let bidiPort;
    if (suppliedPort) {
      bidiPort = Number(suppliedPort);
      if (!Number.isInteger(bidiPort) || bidiPort <= 0 || bidiPort > 65_535) {
        throw new Error(`Invalid Firefox BiDi port: ${suppliedPort}`);
      }
    } else {
      bidiPort = await availablePort();
      profilePath = await mkdtemp(path.join(os.tmpdir(), "ai-chat-gemini-smoke-"));
      browserProcess = spawn(await firefoxBinary(), [
        "--headless",
        "--remote-debugging-port", String(bidiPort),
        "--profile", profilePath,
        "about:blank",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const collectOutput = (chunk) => {
        browserOutput = `${browserOutput}${chunk}`.slice(-12_000);
      };
      browserProcess.stdout.on("data", collectOutput);
      browserProcess.stderr.on("data", collectOutput);
    }

    try {
      socket = await connectBidi(bidiPort);
    } catch (error) {
      const details = browserOutput.trim() ? `\nFirefox output:\n${browserOutput.trim()}` : "";
      throw new Error(`${error.message}${details}`);
    }

    client = bidiClient(socket);
    session = await client.send("session.new", { capabilities: { alwaysMatch: {} } });
    await client.send("session.subscribe", { events: ["log.entryAdded"] });
    const created = await client.send("browsingContext.create", { type: "tab" });
    context = created.context;
    const fixtureUrl = `http://127.0.0.1:${fixturePort}/app/gemini-fixture-smoke`;
    await client.send("browsingContext.navigate", { context, url: fixtureUrl, wait: "complete" });

    const state = await readFixture(client, context);
    const summary = assertFixture(state, client.logErrors);
    const virtualizedUrl = `http://127.0.0.1:${fixturePort}/app/gemini-virtualized-smoke`;
    await client.send("browsingContext.navigate", { context, url: virtualizedUrl, wait: "complete" });
    const virtualizedState = await readFixture(client, context);
    const virtualized = assertVirtualizedFixture(virtualizedState);
    assert.equal(client.logErrors.length, 0, `Browser errors: ${client.logErrors.join(" | ")}`);
    console.log(JSON.stringify({
      passed: true,
      browserVersion: session.capabilities?.browserVersion,
      fixtureUrl,
      ...summary,
      virtualizedUrl,
      virtualized,
      logErrors: client.logErrors,
    }, null, 2));
  } finally {
    if (context && client) {
      try { await client.send("browsingContext.close", { context }); } catch {}
    }
    if (session && client) {
      try { await client.send("session.end"); } catch {}
    }
    socket?.close();
    await closeServer(server);
    await stopFirefox(browserProcess);
    if (profilePath) await rm(profilePath, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
