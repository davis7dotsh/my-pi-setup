"use strict";

// This file is launched by sandbox.ts in Node permission mode. It deliberately
// has no filesystem/network/child-process permissions and receives workflow
// source only over a validated IPC channel.
const vm = require("node:vm");
const sendIpc =
  typeof process.send === "function" ? process.send.bind(process) : undefined;
// If a future V8 escape exposes `process`, remove the convenient bridges to
// builtins, native bindings, parent signalling, and addons before any workflow
// source is compiled. The parent still enforces the authenticated IPC protocol.
for (const capability of [
  "getBuiltinModule",
  "binding",
  "_linkedBinding",
  "dlopen",
  "kill",
  "abort",
  "send",
]) {
  try {
    Object.defineProperty(process, capability, {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {
    // The VM boundary and permission mode remain mandatory controls.
  }
}

const BOOTSTRAP = String.raw`
(function bootstrapWorkflowApi() {
  "use strict";
  const callHost = globalThis.__hostBridge;
  delete globalThis.__hostBridge;
  let nextRequestId = 0;
  const unconsumed = new Set();
  const inFlight = new Set();

  function deepFreeze(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 32 || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], depth + 1);
    return value;
  }

  function requestAgent(promptValue, optionsValue = {}) {
    const id = ++nextRequestId;
    unconsumed.add(id);
    let started;
    const begin = () => {
      unconsumed.delete(id);
      if (!started) {
        let payload;
        try {
          payload = JSON.stringify({
            id,
            prompt: typeof promptValue === "string" ? promptValue : String(promptValue ?? ""),
            options: optionsValue && typeof optionsValue === "object" ? optionsValue : {},
          });
        } catch (error) {
          started = Promise.reject(new Error("agent() arguments must be serializable: " + error.message));
          return started;
        }
        inFlight.add(id);
        started = callHost("agent", payload)
          .then((json) => JSON.parse(json))
          .finally(() => inFlight.delete(id));
      }
      return started;
    };
    return Object.freeze({
      then(resolve, reject) {
        return begin().then(resolve, reject);
      },
      catch(reject) {
        return begin().catch(reject);
      },
      finally(callback) {
        return begin().finally(callback);
      },
      get [Symbol.toStringTag]() {
        return "Promise";
      },
    });
  }

  async function mapLimited(items, concurrency, invoke) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await invoke(items[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function parallel(items, options = {}) {
    if (!Array.isArray(items)) throw new Error("parallel() expects an array of zero-argument agent thunks");
    const requested = options && typeof options.concurrency === "number"
      ? Math.floor(options.concurrency)
      : 4;
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("parallel(): concurrency must be a positive integer");
    }
    const concurrency = Math.min(4, requested);
    return mapLimited(items, concurrency, (item) => {
      if (typeof item !== "function") {
        throw new Error("parallel() items must be zero-argument functions");
      }
      return item();
    });
  }

  function phase(title) {
    callHost("phase", JSON.stringify({ title: String(title) }));
  }

  const argsEnvelope = JSON.parse(globalThis.__argsJson);
  const args = argsEnvelope.defined ? deepFreeze(argsEnvelope.value) : undefined;
  delete globalThis.__argsJson;
  const stringify = JSON.stringify;
  function serializeResult(value) {
    const seen = new WeakSet();
    return stringify(value === undefined ? null : value, (_key, item) => {
      if (typeof item === "bigint") return item.toString() + "n";
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
  }
  Object.defineProperties(globalThis, {
    agent: { value: requestAgent, writable: false, configurable: false },
    parallel: { value: parallel, writable: false, configurable: false },
    phase: { value: phase, writable: false, configurable: false },
    args: { value: args, writable: false, configurable: false },
    __workflowCheck: {
      value: Object.freeze(() => ({
        unconsumed: unconsumed.size,
        inFlight: inFlight.size,
      })),
      writable: false,
      configurable: false,
    },
    __workflowSerialize: {
      value: Object.freeze(serializeResult),
      writable: false,
      configurable: false,
    },
  });
})();
`;

let initialized = false;
let token;
const pendingAgents = new Map();

function send(message) {
  sendIpc?.({ token, ...message });
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ kind: "error", error: message.slice(0, 16 * 1024) });
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (!initialized) {
    if (
      message.kind !== "init" ||
      typeof message.token !== "string" ||
      typeof message.source !== "string" ||
      typeof message.argsJson !== "string"
    ) {
      process.exitCode = 1;
      return;
    }
    initialized = true;
    token = message.token;
    run(message.source, message.argsJson);
    return;
  }
  if (message.token !== token || message.kind !== "agentResult") return;
  const pending = pendingAgents.get(message.id);
  if (!pending) return;
  pendingAgents.delete(message.id);
  if (typeof message.resultJson === "string")
    pending.resolve(message.resultJson);
  else
    pending.reject(
      new Error(
        typeof message.error === "string" ? message.error : "Agent IPC failed",
      ),
    );
});

function run(source, argsJson) {
  try {
    const sandbox = Object.create(null);
    sandbox.__argsJson = argsJson;
    sandbox.__hostBridge = (kind, payloadJson) => {
      if (kind === "phase") {
        send({ kind: "phase", payloadJson });
        return undefined;
      }
      if (kind !== "agent")
        return Promise.reject(new Error("Unknown workflow operation"));
      let id;
      try {
        id = JSON.parse(payloadJson).id;
      } catch {
        return Promise.reject(new Error("Invalid agent request"));
      }
      return new Promise((resolve, reject) => {
        pendingAgents.set(id, { resolve, reject });
        send({ kind: "agent", payloadJson });
      });
    };

    const context = vm.createContext(sandbox, {
      name: "pi-workflow",
      codeGeneration: { strings: false, wasm: false },
    });
    new vm.Script(BOOTSTRAP, {
      filename: "workflow-bootstrap.js",
    }).runInContext(context, { timeout: 1000 });
    const workflow = vm.compileFunction(
      `"use strict";\nreturn (async function workflow() {\n${source}\n})();`,
      ["agent", "parallel", "phase", "args"],
      { filename: "workflow-script.js", parsingContext: context },
    );
    context.__workflowBody = workflow;
    const invoke = `
      (() => {
        const workflowBody = globalThis.__workflowBody;
        delete globalThis.__workflowBody;
        globalThis.__workflowPromise = Promise.resolve(
          workflowBody(agent, parallel, phase, args),
        ).then(async (value) => {
          await Promise.resolve();
          const pending = __workflowCheck();
          if (pending.unconsumed > 0) {
            throw new Error("Workflow created " + pending.unconsumed + " unawaited agent() call(s)");
          }
          if (pending.inFlight > 0) {
            throw new Error("Workflow returned before " + pending.inFlight + " agent call(s) settled");
          }
          return __workflowSerialize(value);
        });
      })();
    `;
    new vm.Script(invoke, { filename: "workflow-invoke.js" }).runInContext(
      context,
      { timeout: 1000 },
    );
    Promise.resolve(context.__workflowPromise)
      .then((resultJson) => {
        if (typeof resultJson !== "string")
          throw new Error("Workflow result was not serializable");
        send({ kind: "result", resultJson });
      })
      .catch(fail);
  } catch (error) {
    fail(error);
  }
}
