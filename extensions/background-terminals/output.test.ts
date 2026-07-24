import assert from "node:assert/strict";
import test from "node:test";
import { OutputBuffer } from "./src/output.ts";

test("push/view roundtrip preserves text and counts bytes", () => {
  const buf = new OutputBuffer(1024);
  buf.push("hello ");
  buf.push("world\n");
  const view = buf.view();
  assert.equal(view.text, "hello world\n");
  assert.equal(view.totalBytes, Buffer.byteLength("hello world\n"));
  assert.equal(view.truncatedBytes, 0);
});

test("head chunks are evicted past the cap and accounted as truncated", () => {
  const buf = new OutputBuffer(10);
  buf.push("aaaa"); // 4 bytes
  buf.push("bbbb"); // 8 bytes
  buf.push("cccc"); // 12 bytes -> evict "aaaa" (8 retained)
  const view = buf.view();
  assert.equal(view.text, "bbbbcccc");
  assert.equal(view.totalBytes, 12);
  assert.equal(view.truncatedBytes, 4);
});

test("a single chunk larger than the cap is trimmed to its tail — retention stays bounded", () => {
  const buf = new OutputBuffer(4);
  buf.push("0123456789");
  // Only the newest cap-worth of bytes is retained; the head is truncated.
  assert.equal(buf.view().text, "6789");
  assert.equal(buf.view().totalBytes, 10);
  assert.equal(buf.view().truncatedBytes, 6);
  buf.push("x");
  // "6789" + "x" exceeds the cap; the older whole chunk is evicted.
  assert.equal(buf.view().text, "x");
  assert.equal(buf.view().totalBytes, 11);
  assert.equal(buf.view().truncatedBytes, 10);
});

test("an oversized chunk evicts everything retained before it", () => {
  const buf = new OutputBuffer(8);
  buf.push("abcd");
  buf.push("0123456789"); // 10 bytes > cap: "abcd" evicted, chunk tail-trimmed
  const view = buf.view();
  assert.equal(view.text, "23456789");
  assert.equal(view.totalBytes, 14);
  assert.equal(view.truncatedBytes, 6);
});

test("an oversized chunk cut lands on a UTF-8 code point boundary", () => {
  const buf = new OutputBuffer(5);
  buf.push("ééééé"); // 10 bytes; naive cut at byte 5 would split an é
  const view = buf.view();
  assert.equal(view.text, "éé"); // 4 bytes retained (5 would split)
  assert.equal(view.totalBytes, 10);
  assert.equal(view.truncatedBytes, 6);
  assert.ok(!view.text.includes("�"));
});

test("spill receives the complete oversized chunk before trimming", () => {
  const spilled: string[] = [];
  const buf = new OutputBuffer(4, (chunk) => spilled.push(chunk));
  buf.push("0123456789");
  assert.deepEqual(spilled, ["0123456789"]);
  assert.equal(buf.view().text, "6789");
});

test("push reports spill backpressure while retaining the chunk", () => {
  const buf = new OutputBuffer(1024, () => false);
  assert.equal(buf.push("queued"), false);
  assert.equal(buf.view().text, "queued");
});

test("byte accounting uses UTF-8 byte length, not string length", () => {
  const buf = new OutputBuffer(1024);
  buf.push("héllo"); // é is 2 bytes
  assert.equal(buf.view().totalBytes, 6);
});

test("multibyte chunks are never split by eviction", () => {
  const buf = new OutputBuffer(8);
  buf.push("ééé"); // 6 bytes
  buf.push("üüü"); // 6 bytes -> evicts the first chunk whole
  const view = buf.view();
  assert.equal(view.text, "üüü");
  assert.equal(view.truncatedBytes, 6);
});

test("spill callback receives every chunk in order, even after eviction", () => {
  const spilled: string[] = [];
  const buf = new OutputBuffer(4, (chunk) => spilled.push(chunk));
  buf.push("aaaa");
  buf.push("bbbb");
  buf.push("cccc");
  assert.deepEqual(spilled, ["aaaa", "bbbb", "cccc"]);
  assert.equal(buf.view().text, "cccc");
});

test("view text is cached between pushes and version increments per push", () => {
  const buf = new OutputBuffer(1024);
  buf.push("a");
  const first = buf.view();
  const second = buf.view();
  assert.equal(first.text, second.text);
  const versionBefore = buf.version;
  buf.push("b");
  assert.equal(buf.version, versionBefore + 1);
  assert.equal(buf.view().text, "ab");
});
