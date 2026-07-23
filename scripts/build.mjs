import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputRoot = path.join(root, "dist");
const commonFiles = [
  "LICENSE",
  "README.md",
  "background.js",
  "popup.html",
  "popup.js",
  "styles.css",
];

const runtimeSourceFiles = [
  "conversation.js",
  "demo-data.js",
  "download.js",
  "export-payload.js",
  "extract-gemini.js",
  "extract-page.js",
  "html-to-markdown.js",
  "obsidian.js",
  "obsidian-transport.js",
  "providers.js",
  "settings.js",
  "webext.js",
];

async function buildTarget(name, manifestFile) {
  const output = path.join(outputRoot, name);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  await Promise.all(commonFiles.map((file) => cp(path.join(root, file), path.join(output, file))));
  await mkdir(path.join(output, "src"), { recursive: true });
  await Promise.all(runtimeSourceFiles.map((file) => (
    cp(path.join(root, "src", file), path.join(output, "src", file))
  )));
  await cp(path.join(root, "icons"), path.join(output, "icons"), { recursive: true });
  await cp(path.join(root, "docs"), path.join(output, "docs"), { recursive: true });
  const manifest = await readFile(path.join(root, manifestFile), "utf8");
  await writeFile(path.join(output, "manifest.json"), manifest);
  return output;
}

await rm(outputRoot, { recursive: true, force: true });
const outputs = await Promise.all([
  buildTarget("chromium", "manifest.json"),
  buildTarget("firefox", "manifest.firefox.json"),
]);

console.log(`Built ${outputs.map((output) => path.relative(root, output)).join(" and ")}.`);
