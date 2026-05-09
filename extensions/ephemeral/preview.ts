import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { CatalogItem } from "./types.ts";

export function renderPreviewLines(item: CatalogItem, width: number): string[] {
  const innerWidth = Math.max(10, width);
  if (item.previewFormat === "markdown") {
    const markdown = new Markdown(item.previewContent, 0, 0, getMarkdownTheme());
    return markdown.render(innerWidth);
  }

  return item.previewContent
    .split(/\r?\n/)
    .flatMap((line) => wrapTextWithAnsi(line, innerWidth));
}

export function renderPreviewMeta(item: CatalogItem, theme: Theme): string[] {
  const lines = [
    `${theme.fg("accent", item.label)}${item.description ? theme.fg("muted", ` — ${item.description}`) : ""}`,
    theme.fg("dim", item.sourcePath),
  ];

  if (item.type === "extension") {
    lines.push(theme.fg("muted", `Mode: ${item.extensionKind === "single-file" ? "single-file extension" : "package extension"}`));
  }
  if (item.type === "mcp") {
    lines.push(theme.fg("muted", `Server: ${item.serverName}`));
  }

  return lines;
}
