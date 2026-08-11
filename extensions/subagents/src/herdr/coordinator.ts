import type { SubagentSnapshot } from "../domain.ts";
import type { SubagentReadModel } from "../manager.ts";
import type { MirrorBridgeEndpoint } from "./bridge.ts";

export interface HerdrParentIdentity {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly sessionId?: string;
}

export interface MirrorLaunch {
  readonly subagentId: string;
  readonly title: string;
  readonly model: string;
  readonly cwd: string;
  readonly parent: HerdrParentIdentity;
  readonly socketPath: string;
  readonly token: string;
  readonly viewerPath: string;
}

export interface MirrorHandle {
  readonly paneId: string;
  readonly tabId: string;
}

export interface HerdrMirrorAdapter {
  readonly parent: HerdrParentIdentity;
  createMirror(launch: MirrorLaunch): Promise<MirrorHandle>;
  closeMirror(handle: MirrorHandle): Promise<void>;
  focusParent(): Promise<void>;
}

export interface HerdrMirrorCoordinator {
  close(): Promise<void>;
}

function shouldMirror(snapshot: SubagentSnapshot) {
  return snapshot.origin === "model" && snapshot.backend === "claude";
}

export async function startHerdrMirrorCoordinator(options: {
  readonly view: SubagentReadModel;
  readonly adapter: HerdrMirrorAdapter;
  readonly bridge: MirrorBridgeEndpoint;
  readonly viewerPath: string;
}): Promise<HerdrMirrorCoordinator> {
  const attempted = new Set<string>();
  const handles = new Map<string, MirrorHandle>();
  let closed = false;
  let pending = Promise.resolve();

  const reconcile = async () => {
    if (closed) return;
    const candidates = options.view
      .list()
      .filter(shouldMirror)
      .filter((snapshot) => !attempted.has(snapshot.id));
    await Promise.all(
      candidates.map(async (snapshot) => {
        attempted.add(snapshot.id);
        try {
          const handle = await options.adapter.createMirror({
            subagentId: snapshot.id,
            title: snapshot.title,
            model: snapshot.meta.modelLabel ?? "Fable",
            cwd: snapshot.cwd,
            parent: options.adapter.parent,
            socketPath: options.bridge.socketPath,
            token: options.bridge.credentialFor(snapshot.id),
            viewerPath: options.viewerPath,
          });
          if (closed) {
            await options.adapter.closeMirror(handle).catch(() => undefined);
            return;
          }
          handles.set(snapshot.id, handle);
        } catch {
          // Herdr is an optional frontend. Pane failures never reach the manager.
        }
      }),
    );
  };

  const scheduleReconcile = () => {
    pending = pending.then(reconcile).catch(() => undefined);
  };
  const unsubscribe = options.view.subscribe(scheduleReconcile);
  await reconcile();

  return {
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      await pending;
      await Promise.all(
        [...handles.values()].map((handle) =>
          options.adapter.closeMirror(handle).catch(() => undefined),
        ),
      );
      handles.clear();
    },
  };
}
