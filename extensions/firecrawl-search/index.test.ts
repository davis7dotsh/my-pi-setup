import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { crawlEffect, type CrawlClient } from "./index.ts";

test("cancels the remote crawl when polling is interrupted", async () => {
  let pollingStarted!: () => void;
  const startedPolling = new Promise<void>((resolve) => {
    pollingStarted = resolve;
  });
  const cancelledJobs: string[] = [];

  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-123", url }),
    getCrawlStatus: async () => {
      pollingStarted();
      return new Promise(() => undefined);
    },
    cancelCrawl: async (jobId) => {
      cancelledJobs.push(jobId);
      return true;
    },
  };

  const controller = new AbortController();
  const running = Effect.runPromise(
    crawlEffect(client, "https://example.com", { limit: 1 }),
    { signal: controller.signal },
  );
  const interrupted = assert.rejects(running);

  await startedPolling;
  controller.abort();
  await interrupted;

  assert.deepEqual(cancelledJobs, ["crawl-123"]);
});
