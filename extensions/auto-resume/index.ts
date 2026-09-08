import {
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

function formatSession(session: {
  id: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: Date;
  path: string;
}) {
  const time = new Date(session.modified).toLocaleString();
  const title = (session.name ?? session.firstMessage.trim()) || "<no message>";
  const preview = title.length > 80 ? `${title.slice(0, 80)}…` : title;
  return `${preview} (${session.messageCount} msgs, ${time})`;
}

function sortByModifiedDesc<T extends { modified: Date }>(sessions: T[]): T[] {
  return [...sessions].sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
  );
}

function latestSession(sessions: { modified: Date }[]) {
  if (sessions.length === 0) return undefined;
  return sortByModifiedDesc(sessions)[0];
}

export default function autoResume(pi: ExtensionAPI) {
  pi.registerCommand("auto-resume", {
    description:
      "Resume latest session for this folder, pick a specific one, or create a fresh session",

    getArgumentCompletions: (prefix) => {
      const options = ["latest", "list", "new", "create"];
      const filtered = options
        .filter((item) => item.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value }));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      const sessions = await SessionManager.list(ctx.cwd);
      const latest = latestSession(sessions) as
        (typeof sessions)[number] | undefined;
      const command = args.trim().toLowerCase();

      if (command === "new" || command === "create") {
        const result = await ctx.newSession({
          withSession: async (replacementCtx) => {
            replacementCtx.ui.notify("Started a fresh session.", "info");
          },
        });
        if (result.cancelled)
          ctx.ui.notify("Session creation cancelled.", "warning");
        return;
      }

      if (command === "latest" || command === "" || sessions.length === 0) {
        if (sessions.length === 0 || !latest) {
          await ctx.newSession({
            withSession: async (replacementCtx) => {
              replacementCtx.ui.notify(
                "No saved sessions found; started new session.",
                "info",
              );
            },
          });
          return;
        }

        const result = await ctx.switchSession(latest.path, {
          withSession: async (replacementCtx) => {
            replacementCtx.ui.notify(
              `Resumed latest: ${formatSession(latest)}.`,
              "info",
            );
          },
        });
        if (result.cancelled)
          ctx.ui.notify("Session resume cancelled.", "warning");
        return;
      }

      if (command === "list") {
        if (!ctx.hasUI) {
          ctx.ui.notify("Session picker requires interactive mode.", "warning");
          return;
        }
        if (sessions.length === 0) {
          ctx.ui.notify("No sessions found for this folder.", "info");
          return;
        }

        const sorted = sortByModifiedDesc(sessions);
        const choices = ["🆕 Create new session", ...sorted.map(formatSession)];
        const selected = await ctx.ui.select(
          "Pick a session to resume",
          choices,
        );
        if (!selected) {
          ctx.ui.notify("Auto-resume cancelled.", "warning");
          return;
        }
        if (selected.startsWith("🆕")) {
          await ctx.newSession({
            withSession: async (replacementCtx) => {
              replacementCtx.ui.notify("Started a fresh session.", "info");
            },
          });
          return;
        }

        const idx = choices.indexOf(selected) - 1;
        if (idx < 0 || idx >= sorted.length) {
          ctx.ui.notify("Could not resolve the selected session.", "error");
          return;
        }

        const selectedSession = sorted[idx];
        const result = await ctx.switchSession(selectedSession.path, {
          withSession: async (replacementCtx) => {
            replacementCtx.ui.notify(
              `Resumed: ${formatSession(selectedSession)}.`,
              "info",
            );
          },
        });
        if (result.cancelled)
          ctx.ui.notify("Session resume cancelled.", "warning");
        return;
      }

      ctx.ui.notify(
        "Usage: /auto-resume [latest|list|new]. Running without args resumes the latest session.",
        "info",
      );
    },
  });
}
