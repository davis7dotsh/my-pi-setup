/**
 * Deferred one-shot delivery map: a settled
 * terminal's result is held here until it is either drained into a follow-up
 * message or consumed by a tool call (bg_kill / bg_status) that already
 * returned the settlement itself. Keyed by id, so double delivery is
 * structurally impossible — whoever drains first wins.
 */
export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>();

  return {
    defer(result: T) {
      pending.set(result.id, result);
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear() {
      pending.clear();
    },
  };
}
