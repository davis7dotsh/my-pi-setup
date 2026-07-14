import { Effect, Semaphore } from "effect";

/** Serializes explicit refreshes while allowing background refreshes to coalesce. */
export function makeRefreshCoordinator() {
  const semaphore = Semaphore.makeUnsafe(1);

  return {
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      semaphore.withPermit(effect),
    runIfIdle: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      semaphore.withPermitsIfAvailable(1)(effect).pipe(Effect.asVoid),
  };
}
