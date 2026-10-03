import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);

test(
  "all portable extensions load together in an isolated Pi SDK session",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-extension-smoke-"));
    let session;
    const originalPath = process.env.PATH;
    const lifecycleErrors = [];
    try {
      // Startup should exercise lifecycle handlers without downloading binaries.
      for (const [name, version] of [
        ["fd", "fd 10.2.0"],
        ["rg", "ripgrep 15.1.0"],
      ]) {
        const path = resolve(directory, name);
        await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
        await chmod(path, 0o755);
      }
      process.env.PATH = `${directory}:${originalPath ?? ""}`;
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        noThemes: true,
        additionalExtensionPaths: manifest.workspaces.map((path) =>
          resolve(root, path, "index.ts"),
        ),
        additionalThemePaths: [
          resolve(root, "themes/github-dark-default.json"),
        ],
      });
      await resourceLoader.reload();
      const extensions = resourceLoader.getExtensions();
      assert.deepEqual(extensions.errors, [], "extension loading errors");
      assert.equal(extensions.extensions.length, manifest.workspaces.length);
      assert.deepEqual(resourceLoader.getThemes().diagnostics, []);
      assert.equal(resourceLoader.getThemes().themes.length, 1);

      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(directory),
        noTools: "builtin",
      }));
      await session.bindExtensions({
        mode: "json",
        onError: (error) => lifecycleErrors.push(error),
      });
      assert.deepEqual(lifecycleErrors, [], "extension startup errors");
      const tools = new Set(session.getAllTools().map((tool) => tool.name));
      for (const name of [
        "ask_user",
        "bg_start",
        "bg_status",
        "bg_list",
        "bg_kill",
        "fd",
        "rg",
        "search",
        "scrape",
        "crawl",
        "parse-file",
        "subagent_spawn",
        "subagent_check",
        "subagent_list",
        "subagent_wait",
        "subagent_cancel",
      ]) {
        assert.ok(tools.has(name), `missing tool: ${name}`);
      }
      await session.extensionRunner?.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      assert.deepEqual(lifecycleErrors, [], "extension shutdown errors");
    } finally {
      session?.dispose();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
