import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export default function rememberModel(pi: ExtensionAPI) {
  async function remember(
    ctx: ExtensionContext,
    model: ExtensionContext["model"],
  ) {
    // Background agents and one-shot CLI calls must not change the user's default.
    if (ctx.mode !== "tui" || !model) return;

    const settings = SettingsManager.create(ctx.cwd, getAgentDir());
    settings.setDefaultModelAndProvider(model.provider, model.id);
    await settings.flush();

    for (const { error } of settings.drainErrors()) {
      ctx.ui.notify(`Could not remember model: ${error.message}`, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => remember(ctx, ctx.model));
  pi.on("model_select", (event, ctx) => remember(ctx, event.model));
}
