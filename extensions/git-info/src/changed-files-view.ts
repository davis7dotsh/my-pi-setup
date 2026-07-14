import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { runCommand } from "./process.ts";

const DIFF_SCROLL_STEP = 5;
const MAX_DIFF_LINES = 20_000;

interface ChangedPath {
  path: string;
  status: string;
}

export interface ChangedFile {
  additions: number | null;
  deletions: number | null;
  diff: string[];
  name: string;
  path: string;
}

function parseChangedPaths(output: string) {
  const records = output.split("\0");
  const paths: ChangedPath[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;

    const status = record.slice(0, 2);
    const path = record.slice(3);
    paths.push({ path, status });

    // In porcelain v1 -z output, rename/copy records are followed by the old path.
    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
}

function parseNumstat(output: string) {
  const line = output.split("\n").find(Boolean);
  if (!line) return { additions: 0, deletions: 0 };

  const [added, deleted] = line.split("\t");
  return {
    additions: added === "-" ? null : Number.parseInt(added ?? "0", 10),
    deletions: deleted === "-" ? null : Number.parseInt(deleted ?? "0", 10),
  };
}

function cleanDisplayPath(path: string) {
  return path.replace(/[\r\n\t]/g, " ");
}

const run = (cwd: string, args: string[]) =>
  runCommand("git", args, cwd, 10_000);

const loadFile = Effect.fn("git-info.loadFile")(function* (
  repoRoot: string,
  changedPath: ChangedPath,
  hasHead: boolean,
) {
  const useNoIndex = changedPath.status === "??" || !hasHead;
  const diffArguments = useNoIndex
    ? [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "--",
        "/dev/null",
        changedPath.path,
      ]
    : [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "HEAD",
        "--",
        changedPath.path,
      ];
  const statArguments = useNoIndex
    ? ["diff", "--no-index", "--numstat", "--", "/dev/null", changedPath.path]
    : ["diff", "--numstat", "HEAD", "--", changedPath.path];
  const [diffResult, statResult] = yield* Effect.all(
    [run(repoRoot, diffArguments), run(repoRoot, statArguments)],
    { concurrency: "unbounded" },
  );
  const stats = parseNumstat(statResult.stdout);
  const allDiffLines = diffResult.stdout.trimEnd().split("\n");
  const diff =
    allDiffLines.length > MAX_DIFF_LINES
      ? [
          ...allDiffLines.slice(0, MAX_DIFF_LINES),
          `… diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines …`,
        ]
      : allDiffLines;

  return {
    ...stats,
    diff:
      diff.length === 1 && diff[0] === ""
        ? ["No textual diff available."]
        : diff,
    name: cleanDisplayPath(basename(changedPath.path)),
    path: cleanDisplayPath(changedPath.path),
  } satisfies ChangedFile;
});

export const loadChangedFiles = Effect.fn("git-info.loadChangedFiles")(
  function* (cwd: string) {
    const rootResult = yield* run(cwd, ["rev-parse", "--show-toplevel"]);
    if (rootResult.code !== 0) return null;

    const repoRoot = rootResult.stdout.trim();
    const [statusResult, headResult] = yield* Effect.all(
      [
        run(repoRoot, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
        run(repoRoot, ["rev-parse", "--verify", "HEAD"]),
      ],
      { concurrency: "unbounded" },
    );
    if (statusResult.code !== 0) return null;

    const changedPaths = parseChangedPaths(statusResult.stdout);
    const files: ChangedFile[] = [];
    for (const changedPath of changedPaths) {
      files.push(yield* loadFile(repoRoot, changedPath, headResult.code === 0));
    }

    return files;
  },
);

function padToWidth(text: string, width: number) {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export async function showChangedFiles(
  ctx: ExtensionContext,
  files: ChangedFile[],
) {
  if (ctx.mode !== "tui") return;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let focus: "files" | "diff" = "files";
      let selectedIndex = 0;
      let sidebarOffset = 0;
      let diffOffset = 0;

      function bodyHeight() {
        return Math.max(8, Math.floor(tui.terminal.rows * 0.8) - 2);
      }

      function ensureSelectedFileVisible() {
        const visibleFiles = Math.max(1, Math.floor(bodyHeight() / 2));
        if (selectedIndex < sidebarOffset) sidebarOffset = selectedIndex;
        if (selectedIndex >= sidebarOffset + visibleFiles) {
          sidebarOffset = selectedIndex - visibleFiles + 1;
        }
      }

      function moveFile(amount: number) {
        selectedIndex = (selectedIndex + amount + files.length) % files.length;
        diffOffset = 0;
        ensureSelectedFileVisible();
        tui.requestRender();
      }

      function moveDiff(amount: number) {
        const maxOffset = Math.max(
          0,
          files[selectedIndex]!.diff.length - bodyHeight(),
        );
        diffOffset = Math.max(0, Math.min(maxOffset, diffOffset + amount));
        tui.requestRender();
      }

      function styleDiffLine(line: string) {
        const expanded = line.replaceAll("\t", "    ");
        if (
          expanded.startsWith("diff --git") ||
          expanded.startsWith("index ")
        ) {
          return theme.fg("accent", theme.bold(expanded));
        }
        if (expanded.startsWith("@@")) return theme.fg("mdHeading", expanded);
        if (expanded.startsWith("---") || expanded.startsWith("+++")) {
          return theme.fg("muted", expanded);
        }
        if (expanded.startsWith("+")) return theme.fg("success", expanded);
        if (expanded.startsWith("-")) return theme.fg("error", expanded);
        if (expanded.startsWith("…")) return theme.fg("warning", expanded);
        return theme.fg("text", expanded);
      }

      function border(width: number, label: string, top: boolean) {
        const left = top ? "┌" : "└";
        const right = top ? "┐" : "┘";
        const text = `─ ${label} `;
        const remaining = Math.max(0, width - visibleWidth(text) - 2);
        return theme.fg(
          "borderAccent",
          truncateToWidth(
            `${left}${text}${"─".repeat(remaining)}${right}`,
            width,
            "",
          ),
        );
      }

      function handleInput(data: string) {
        if (focus === "files") {
          if (matchesKey(data, Key.escape)) {
            done(undefined);
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            moveFile(1);
            return;
          }
          if (matchesKey(data, Key.up) || data === "k") {
            moveFile(-1);
            return;
          }
          if (matchesKey(data, Key.home) || data === "g") {
            selectedIndex = 0;
            diffOffset = 0;
            ensureSelectedFileVisible();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.end) || data === "G") {
            selectedIndex = files.length - 1;
            diffOffset = 0;
            ensureSelectedFileVisible();
            tui.requestRender();
            return;
          }
          if (
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.space) ||
            matchesKey(data, Key.right) ||
            data === "l"
          ) {
            focus = "diff";
            tui.requestRender();
          }
          return;
        }

        if (
          matchesKey(data, Key.escape) ||
          matchesKey(data, Key.left) ||
          data === "h"
        ) {
          focus = "files";
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          moveDiff(DIFF_SCROLL_STEP);
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          moveDiff(-DIFF_SCROLL_STEP);
          return;
        }
        if (matchesKey(data, Key.ctrl("d"))) {
          moveDiff(Math.max(1, Math.floor(bodyHeight() / 2)));
          return;
        }
        if (matchesKey(data, Key.ctrl("u"))) {
          moveDiff(-Math.max(1, Math.floor(bodyHeight() / 2)));
          return;
        }
        if (matchesKey(data, Key.home) || data === "g") {
          diffOffset = 0;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.end) || data === "G") {
          diffOffset = Math.max(
            0,
            files[selectedIndex]!.diff.length - bodyHeight(),
          );
          tui.requestRender();
        }
      }

      function render(width: number) {
        const height = bodyHeight();
        const sidebarWidth = Math.min(
          48,
          Math.max(24, Math.floor(width * 0.34)),
        );
        const diffWidth = Math.max(1, width - sidebarWidth - 3);
        const selectedFile = files[selectedIndex]!;
        const title = `local changes · ${files.length} ${files.length === 1 ? "file" : "files"} · ${focus === "files" ? "FILES" : "DIFF"}`;
        const lines = [border(width, title, true)];

        for (let row = 0; row < height; row += 1) {
          const fileIndex = sidebarOffset + Math.floor(row / 2);
          const file = files[fileIndex];
          let sidebar = "";

          if (file) {
            const isSelected = fileIndex === selectedIndex;
            if (row % 2 === 0) {
              const marker = isSelected ? "› " : "  ";
              const isBinary =
                file.additions === null || file.deletions === null;
              const stats = isBinary
                ? "binary"
                : `+${file.additions} -${file.deletions}`;
              const styledStats = isBinary
                ? theme.fg("success", stats)
                : `${theme.fg("success", `+${file.additions}`)} ${theme.fg("error", `-${file.deletions}`)}`;
              const nameWidth = Math.max(
                1,
                sidebarWidth - visibleWidth(marker) - visibleWidth(stats) - 1,
              );
              const name = truncateToWidth(file.name, nameWidth, "…");
              const gap = " ".repeat(
                Math.max(
                  1,
                  sidebarWidth -
                    visibleWidth(marker) -
                    visibleWidth(name) -
                    visibleWidth(stats),
                ),
              );
              sidebar = `${marker}${name}${gap}${styledStats}`;
            } else {
              sidebar = `  ${theme.fg("dim", truncateToWidth(file.path, Math.max(1, sidebarWidth - 2), "…"))}`;
            }

            sidebar = padToWidth(sidebar, sidebarWidth);
            if (isSelected) {
              sidebar = theme.bg(
                focus === "files" ? "selectedBg" : "customMessageBg",
                sidebar,
              );
            }
          } else {
            sidebar = " ".repeat(sidebarWidth);
          }

          const diffLine = selectedFile.diff[diffOffset + row];
          const diff = padToWidth(
            diffLine === undefined ? "" : styleDiffLine(diffLine),
            diffWidth,
          );
          const separator = theme.fg(
            focus === "diff" ? "borderAccent" : "borderMuted",
            "│",
          );
          lines.push(
            `${theme.fg("borderMuted", "│")}${sidebar}${separator}${diff}${theme.fg("borderMuted", "│")}`,
          );
        }

        const help =
          focus === "files"
            ? "j/k or ↑/↓ select · enter/space/l open diff · esc close"
            : "j/k or ↑/↓ scroll · ctrl-d/u page · g/G top/bottom · esc/h files";
        lines.push(border(width, help, false));
        return lines;
      }

      return {
        handleInput,
        invalidate() {},
        render,
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        margin: 1,
        maxHeight: "90%",
        minWidth: 60,
        width: "95%",
      },
    },
  );
}
