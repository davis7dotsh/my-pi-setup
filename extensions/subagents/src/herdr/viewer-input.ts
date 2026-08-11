export type ViewerInputCommand =
  | { readonly action: "send"; readonly text: string }
  | { readonly action: "abort" | "focus-parent" | "close" };

export function consumeViewerInput(current: string, chunk: string) {
  let input = current;
  const commands: ViewerInputCommand[] = [];
  for (const character of chunk) {
    if (character === "\u001b") break;
    if (character === "\u0004" || character === "\u0003") {
      commands.push({ action: "close" });
      continue;
    }
    if (character === "\u0018") {
      commands.push({ action: "abort" });
      continue;
    }
    if (character === "\u0010") {
      commands.push({ action: "focus-parent" });
      continue;
    }
    if (character === "\r" || character === "\n") {
      const text = input.trim();
      if (text) commands.push({ action: "send", text });
      input = "";
      continue;
    }
    if (character === "\u007f" || character === "\b") {
      input = [...input].slice(0, -1).join("");
      continue;
    }
    if (/^[\u0000-\u001f\u007f]$/.test(character)) continue;
    if (Buffer.byteLength(input + character, "utf8") <= 32 * 1024) {
      input += character;
    }
  }
  return { input, commands };
}
