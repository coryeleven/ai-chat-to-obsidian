import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  destinationLabel,
  loadSettings,
  normalizeSettings,
  saveSettings,
  SETTINGS_KEY,
} from "../src/settings.js";

test("normalizes Vault settings and removes unsafe relative path segments", () => {
  assert.deepEqual(normalizeSettings({
    vault: "  Research   Vault  ",
    folder: " /ChatGPT\\Projects/../Notes/ ",
    silentOpen: false,
    detailedMetadata: true,
  }), {
    vault: "Research Vault",
    folder: "ChatGPT/Projects/Notes",
    silentOpen: false,
    detailedMetadata: true,
  });
});

test("loads defaults and persists one normalized settings record", async () => {
  const values = {};
  const api = {
    storage: {
      local: {
        async get(key) { return { [key]: values[key] }; },
        async set(record) { Object.assign(values, record); },
      },
    },
  };

  assert.deepEqual(await loadSettings(api), DEFAULT_SETTINGS);
  const saved = await saveSettings(api, { vault: " Work ", folder: "Clips\\AI" });
  assert.deepEqual(values[SETTINGS_KEY], saved);
  assert.equal(destinationLabel(await loadSettings(api)), "Work / Clips/AI");
});

test("describes an omitted Vault as the currently active Vault", () => {
  assert.equal(destinationLabel({ folder: "ChatGPT" }), "当前 Vault / ChatGPT");
  assert.equal(destinationLabel({ folder: "" }), "当前 Vault");
});
