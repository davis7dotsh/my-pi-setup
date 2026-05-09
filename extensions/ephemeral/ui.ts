import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { CatalogData, CatalogItem, EphemeralCategory, ManifestEntry, ProjectState } from "./types.ts";
import { renderPreviewLines, renderPreviewMeta } from "./preview.ts";
import { getLiveWarnings, getManagedEntriesByCategory } from "./project-state.ts";
import { categoryLabel, clamp, pluralize } from "./util.ts";

export interface EphemeralUiApplyResult {
  action: "apply" | "cancel";
  desiredKeys: Set<string>;
  lastCategory: EphemeralCategory;
}

export async function showEphemeralUi(
  ctx: ExtensionContext,
  catalog: CatalogData,
  state: ProjectState,
  initialCategory: EphemeralCategory,
): Promise<EphemeralUiApplyResult> {
  const initialDesiredKeys = new Set<string>(Object.keys(state.manifest.items));

  const managedByCategory = getManagedEntriesByCategory(state, catalog);

  const result = await ctx.ui.custom<EphemeralUiApplyResult>(
    (tui, theme, _keybindings, done) =>
      new EphemeralOverlayComponent(tui, theme, catalog, state, managedByCategory, initialDesiredKeys, initialCategory, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "92%",
        maxHeight: "88%",
        minWidth: 90,
      },
    },
  );

  return result;
}

type ManagedByCategory = ReturnType<typeof getManagedEntriesByCategory>;

class EphemeralOverlayComponent {
  private readonly categories: EphemeralCategory[] = ["skills", "prompts", "extensions", "mcp"];
  private readonly desiredKeys: Set<string>;
  private readonly searchByCategory: Record<EphemeralCategory, string> = {
    skills: "",
    prompts: "",
    extensions: "",
    mcp: "",
  };
  private readonly selectionByCategory: Record<EphemeralCategory, number> = {
    skills: 0,
    prompts: 0,
    extensions: 0,
    mcp: 0,
  };
  private currentCategory: EphemeralCategory;
  private previewItem: CatalogItem | undefined;
  private previewScroll = 0;

  constructor(
    private readonly tui: { terminal: { rows?: number }; requestRender(): void },
    private readonly theme: Theme,
    private readonly catalog: CatalogData,
    private readonly state: ProjectState,
    private readonly managedByCategory: ManagedByCategory,
    initialDesiredKeys: Set<string>,
    initialCategory: EphemeralCategory,
    private readonly done: (result: EphemeralUiApplyResult) => void,
  ) {
    this.desiredKeys = new Set(initialDesiredKeys);
    this.currentCategory = initialCategory;
  }

  handleInput(data: string): void {
    if (this.previewItem) {
      this.handlePreviewInput(data);
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ action: "cancel", desiredKeys: new Set(this.desiredKeys), lastCategory: this.currentCategory });
      return;
    }


    if (matchesKey(data, Key.tab)) {
      this.switchCategory(1);
      return;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      this.switchCategory(-1);
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }

    if (matchesKey(data, Key.space)) {
      const selected = this.getSelectedItem();
      if (!selected) return;
      if (this.desiredKeys.has(selected.key)) this.desiredKeys.delete(selected.key);
      else this.desiredKeys.add(selected.key);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.done({ action: "apply", desiredKeys: new Set(this.desiredKeys), lastCategory: this.currentCategory });
      return;
    }

    if (data === "p" || data === "P") {
      const selected = this.getSelectedItem();
      if (!selected) return;
      this.previewItem = selected;
      this.previewScroll = 0;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      const current = this.searchByCategory[this.currentCategory];
      if (current.length > 0) {
        this.searchByCategory[this.currentCategory] = Array.from(current).slice(0, -1).join("");
        this.selectionByCategory[this.currentCategory] = 0;
        this.tui.requestRender();
      }
      return;
    }

    if (isPrintableInput(data)) {
      this.searchByCategory[this.currentCategory] += data;
      this.selectionByCategory[this.currentCategory] = 0;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    return this.previewItem ? this.renderPreview(width) : this.renderMain(width);
  }

  invalidate(): void {}

  private renderMain(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const leftWidth = Math.max(28, Math.floor(innerWidth * 0.46));
    const rightWidth = Math.max(28, innerWidth - leftWidth - 1);
    const panelHeight = this.getPanelHeight();
    const bodyHeight = Math.max(12, panelHeight - 8);

    const topLine = this.frameLine(this.renderHeader(innerWidth), innerWidth);
    const divider = this.frameLine(this.theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth);

    const leftLines = this.renderLeftPane(leftWidth, bodyHeight);
    const rightLines = this.renderRightPane(rightWidth, bodyHeight);
    const bodyLines = combineColumns(leftLines, rightLines, leftWidth, rightWidth, this.theme.fg("borderMuted", "│"));

    const footerLines = [
      this.frameLine(this.theme.fg("dim", "type to search • space toggle • p preview • tab category • enter apply"), innerWidth),
      this.frameLine(this.theme.fg("dim", "esc close"), innerWidth),
    ];

    const topBorder = this.theme.fg("borderAccent", `┌${"─".repeat(innerWidth)}┐`);
    const bottomBorder = this.theme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`);

    return [topBorder, topLine, divider, ...bodyLines.map((line) => this.wrapBodyLine(line, innerWidth)), divider, ...footerLines, bottomBorder];
  }

  private renderPreview(width: number): string[] {
    const item = this.previewItem!;
    const innerWidth = Math.max(20, width - 2);
    const panelHeight = this.getPanelHeight();
    const metaLines = renderPreviewMeta(item, this.theme);
    const contentLines = renderPreviewLines(item, innerWidth - 2);
    const viewportHeight = Math.max(8, panelHeight - metaLines.length - 6);
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    this.previewScroll = clamp(this.previewScroll, 0, maxScroll);
    const visibleContent = contentLines.slice(this.previewScroll, this.previewScroll + viewportHeight);

    const header = this.frameLine(
      `${this.theme.fg("accent", item.previewTitle)}${this.theme.fg("dim", "  (preview — esc back)")}`,
      innerWidth,
    );
    const divider = this.frameLine(this.theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth);
    const body = [
      ...metaLines.map((line) => this.frameLine(line, innerWidth)),
      this.frameLine("", innerWidth),
      ...visibleContent.map((line) => this.frameLine(` ${line}`, innerWidth)),
    ];
    while (body.length < panelHeight - 3) {
      body.push(this.frameLine("", innerWidth));
    }
    const footer = this.frameLine(
      this.theme.fg(
        "dim",
        `↑↓ scroll • esc back${contentLines.length > viewportHeight ? ` • ${this.previewScroll + 1}-${Math.min(contentLines.length, this.previewScroll + viewportHeight)}/${contentLines.length}` : ""}`,
      ),
      innerWidth,
    );

    return [
      this.theme.fg("borderAccent", `┌${"─".repeat(innerWidth)}┐`),
      header,
      divider,
      ...body,
      divider,
      footer,
      this.theme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`),
    ];
  }

  private renderHeader(innerWidth: number): string {
    const title = this.theme.fg("accent", this.theme.bold("Pi Ephemeral"));
    const tabs = this.categories
      .map((category) => {
        const selected = category === this.currentCategory;
        const label = `[${categoryLabel(category)}]`;
        return selected ? this.theme.fg("accent", this.theme.bold(label)) : this.theme.fg("muted", label);
      })
      .join(" ");

    const spacing = Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(tabs));
    return `${title}${" ".repeat(spacing)}${tabs}`;
  }

  private renderLeftPane(width: number, height: number): string[] {
    const lines: string[] = [];
    const search = this.searchByCategory[this.currentCategory];
    lines.push(this.theme.fg("muted", `Search: ${search || this.theme.fg("dim", "(type to filter)")}`));
    lines.push("");

    const items = this.getFilteredItems();
    if (items.length === 0) {
      lines.push(this.theme.fg("dim", "No catalog items in this category"));
      return padLines(lines, height, width);
    }

    const selectedIndex = clamp(this.selectionByCategory[this.currentCategory], 0, Math.max(0, items.length - 1));
    this.selectionByCategory[this.currentCategory] = selectedIndex;
    const visibleCount = Math.max(5, height - 3);
    const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), Math.max(0, items.length - visibleCount)));
    const end = Math.min(items.length, start + visibleCount);

    for (let index = start; index < end; index += 1) {
      const item = items[index]!;
      lines.push(this.renderCatalogItem(item, index === selectedIndex, width));
      if (item.description) {
        lines.push(this.theme.fg("dim", `   ${item.description}`));
      }
    }

    if (end < items.length) {
      lines.push(this.theme.fg("dim", `… ${items.length - end} more ${pluralize(items.length - end, "item")}`));
    }

    return padLines(lines, height, width);
  }

  private renderRightPane(width: number, height: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Managed in this project")));
    lines.push("");

    for (const category of this.categories) {
      lines.push(this.theme.fg("muted", categoryLabel(category)));
      const entries = this.managedByCategory[category];
      if (entries.length === 0) {
        lines.push(this.theme.fg("dim", "  • none"));
      } else {
        for (const entry of entries) {
          lines.push(`  ${this.theme.fg("text", "•")} ${entry.label}`);
        }
      }
      lines.push("");
    }

    const pending = this.renderPendingLines();
    lines.push(this.theme.fg("accent", this.theme.bold("Pending")));
    if (pending.length === 0) {
      lines.push(this.theme.fg("dim", "  none"));
    } else {
      lines.push(...pending);
    }
    lines.push("");

    const warnings = getLiveWarnings(this.state, this.catalog, this.desiredKeys);
    lines.push(this.theme.fg("accent", this.theme.bold("Warnings")));
    if (warnings.length === 0) {
      lines.push(this.theme.fg("dim", "  none"));
    } else {
      for (const warning of warnings.slice(0, 8)) {
        lines.push(this.theme.fg("warning", `  ! ${warning}`));
      }
      if (warnings.length > 8) {
        lines.push(this.theme.fg("dim", `  … ${warnings.length - 8} more`));
      }
    }

    return padLines(lines, height, width);
  }

  private renderCatalogItem(item: CatalogItem, selected: boolean, width: number): string {
    const isManaged = Boolean(this.state.manifest.items[item.key]);
    const desired = this.desiredKeys.has(item.key);

    let marker = "○";
    let markerStyled = this.theme.fg("dim", marker);
    if (isManaged && !desired) {
      marker = "-";
      markerStyled = this.theme.fg("warning", marker);
    } else if (!isManaged && desired) {
      marker = "+";
      markerStyled = this.theme.fg("success", marker);
    } else if (desired) {
      marker = "●";
      markerStyled = this.theme.fg("accent", marker);
    }

    const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
    const line = `${prefix}${markerStyled} ${this.theme.fg(selected ? "accent" : "text", item.label)}`;
    return truncateToWidth(line, width);
  }

  private renderPendingLines(): string[] {
    const additions: string[] = [];
    const removals: string[] = [];

    for (const item of this.catalog.items) {
      const isManaged = Boolean(this.state.manifest.items[item.key]);
      const desired = this.desiredKeys.has(item.key);
      if (!isManaged && desired) additions.push(`  ${this.theme.fg("success", "+")} ${item.label}`);
      if (isManaged && !desired) removals.push(`  ${this.theme.fg("warning", "-")} ${item.label}`);
    }

    return [...additions, ...removals];
  }

  private getFilteredItems(): CatalogItem[] {
    const query = this.searchByCategory[this.currentCategory].trim().toLowerCase();
    const items = this.catalog.byCategory[this.currentCategory];
    if (!query) return items;
    return items.filter((item) => {
      const haystack = `${item.label}\n${item.description}\n${item.id}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  private getSelectedItem(): CatalogItem | undefined {
    const items = this.getFilteredItems();
    if (items.length === 0) return undefined;
    const index = clamp(this.selectionByCategory[this.currentCategory], 0, items.length - 1);
    this.selectionByCategory[this.currentCategory] = index;
    return items[index];
  }

  private moveSelection(direction: number): void {
    const items = this.getFilteredItems();
    if (items.length === 0) return;
    const next = clamp(this.selectionByCategory[this.currentCategory] + direction, 0, items.length - 1);
    this.selectionByCategory[this.currentCategory] = next;
    this.tui.requestRender();
  }

  private switchCategory(delta: number): void {
    const currentIndex = this.categories.indexOf(this.currentCategory);
    const nextIndex = (currentIndex + delta + this.categories.length) % this.categories.length;
    this.currentCategory = this.categories[nextIndex]!;
    this.tui.requestRender();
  }

  private handlePreviewInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.previewItem = undefined;
      this.previewScroll = 0;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.previewScroll = Math.max(0, this.previewScroll - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.previewScroll += 1;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, "pageUp")) {
      this.previewScroll = Math.max(0, this.previewScroll - 10);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.right) || matchesKey(data, "pageDown")) {
      this.previewScroll += 10;
      this.tui.requestRender();
    }
  }

  private getPanelHeight(): number {
    const rows = this.tui.terminal.rows ?? 28;
    return Math.max(18, Math.floor(rows * 0.82));
  }

  private frameLine(content: string, innerWidth: number): string {
    const clipped = truncateToWidth(content, innerWidth);
    const padding = Math.max(0, innerWidth - visibleWidth(clipped));
    return `${this.theme.fg("borderAccent", "│")}${clipped}${" ".repeat(padding)}${this.theme.fg("borderAccent", "│")}`;
  }

  private wrapBodyLine(content: string, innerWidth: number): string {
    const clipped = truncateToWidth(content, innerWidth);
    const padding = Math.max(0, innerWidth - visibleWidth(clipped));
    return `${this.theme.fg("borderAccent", "│")}${clipped}${" ".repeat(padding)}${this.theme.fg("borderAccent", "│")}`;
  }
}

function combineColumns(left: string[], right: string[], leftWidth: number, rightWidth: number, separator: string): string[] {
  const rowCount = Math.max(left.length, right.length);
  const rows: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const leftLine = truncateAndPad(left[index] ?? "", leftWidth);
    const rightLine = truncateAndPad(right[index] ?? "", rightWidth);
    rows.push(`${leftLine}${separator}${rightLine}`);
  }
  return rows;
}

function truncateAndPad(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  const padding = Math.max(0, width - visibleWidth(clipped));
  return `${clipped}${" ".repeat(padding)}`;
}

function padLines(lines: string[], targetHeight: number, width: number): string[] {
  const output = lines.map((line) => truncateToWidth(line, width));
  while (output.length < targetHeight) {
    output.push("");
  }
  return output;
}

function isPrintableInput(data: string): boolean {
  if (!data) return false;
  if (data.includes("\u001b")) return false;
  if (data === "\r" || data === "\n" || data === "\t") return false;
  const codePoints = Array.from(data);
  return codePoints.every((char) => char >= " ");
}
