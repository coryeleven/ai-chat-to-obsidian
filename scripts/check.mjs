import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const sourceFiles = [
  "src/conversation.js",
  "src/html-to-markdown.js",
  "src/extract-page.js",
  "src/extract-gemini.js",
  "src/file-store.js",
  "src/export-flow.js",
  "src/download.js",
  "src/export-payload.js",
  "src/obsidian.js",
  "src/obsidian-transport.js",
  "src/providers.js",
  "src/settings.js",
  "src/webext.js",
  "src/demo-data.js",
  "background.js",
  "popup.js",
  "destination.js",
  "scripts/build.mjs",
  "scripts/firefox-smoke.mjs",
  "scripts/gemini-fixture-smoke.mjs",
];

const manifests = await Promise.all(
  ["manifest.json", "manifest.firefox.json"].map(async (file) => ({
    file,
    value: JSON.parse(await readFile(file, "utf8")),
  })),
);
for (const { file, value: manifest } of manifests) {
  if (manifest.manifest_version !== 3) throw new Error(`${file} must use Manifest V3`);
  for (const permission of ["downloads", "storage", "clipboardWrite"]) {
    if (!manifest.permissions?.includes(permission)) {
      throw new Error(`${file} needs ${permission} permission`);
    }
  }
  for (const origin of [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://gemini.google.com/*",
  ]) {
    if (!manifest.host_permissions?.includes(origin)) {
      throw new Error(`${file} needs the ${origin} host permission`);
    }
  }
  await access(manifest.action.default_popup, constants.R_OK);
}
for (const icon of Object.values(manifests[0].value.icons || {})) await access(icon, constants.R_OK);

for (const file of sourceFiles) {
  await access(file, constants.R_OK);
  await run(process.execPath, ["--check", file]);
}

console.log(`Validated ${manifests.length} manifests and ${sourceFiles.length} JavaScript files.`);
