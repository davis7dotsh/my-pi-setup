export type ViewerInputCommand =
  | { readonly action: "send"; readonly text: string }
  | { readonly action: "abort" | "focus-parent" | "close" };

export type ViewerEscapeState =
  "none" | "escape" | "csi" | "osc" | "osc-escape";

export function consumeViewerInput(
  current: string,
  chunk: string,
  initialEscapeState: ViewerEscapeState = "none",
) {
  let input = current;
  let escapeState = initialEscapeState;
  const commands: ViewerInputCommand[] = [];
  for (const character of chunk) {
    // Keyboard actions always win over an incomplete terminal escape sequence
    // so a malformed or split sequence can never trap the viewer.
    if (character === "\u0004" || character === "\u0003") {
      commands.push({ action: "close" });
      escapeState = "none";
      continue;
    }
    if (character === "\u0018") {
      commands.push({ action: "abort" });
      escapeState = "none";
      continue;
    }
    if (character === "\u0010") {
      commands.push({ action: "focus-parent" });
      escapeState = "none";
      continue;
    }
    if (character === "\r" || character === "\n") {
      const text = input.trim();
      if (text) commands.push({ action: "send", text });
      input = "";
      escapeState = "none";
      continue;
    }
    if (character === "\u007f" || character === "\b") {
      input = [...input].slice(0, -1).join("");
      escapeState = "none";
      continue;
    }
    if (escapeState === "escape") {
      escapeState =
        character === "[" || character === "O"
          ? "csi"
          : character === "]"
            ? "osc"
            : "none";
      continue;
    }
    if (escapeState === "csi") {
      if (/^[\u0040-\u007e]$/.test(character)) escapeState = "none";
      continue;
    }
    if (escapeState === "osc") {
      if (character === "\u0007") escapeState = "none";
      else if (character === "\u001b") escapeState = "osc-escape";
      continue;
    }
    if (escapeState === "osc-escape") {
      escapeState = character === "\\" ? "none" : "osc";
      continue;
    }
    if (character === "\u001b") {
      escapeState = "escape";
      continue;
    }
    if (/^[\u0000-\u001f\u007f]$/.test(character)) continue;
    if (Buffer.byteLength(input + character, "utf8") <= 32 * 1024) {
      input += character;
    }
  }
  return { input, commands, escapeState };
}
