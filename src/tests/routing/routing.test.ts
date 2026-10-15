import assert from "node:assert/strict";
import test from "node:test";
import { AccountRouter } from "../../routing/router.js";
import { PerAccountConcurrency } from "../../routing/semaphore.js";
import { OperationRegistry } from "../../operations/registry.js";

test("round-robin and weighted routing return complete candidate orders", () => {
  const roundRobin = new AccountRouter(["free", "pro", "plus"], "round-robin");
  assert.deepEqual(roundRobin.order(), ["free", "pro", "plus"]);
  assert.deepEqual(roundRobin.order(), ["pro", "plus", "free"]);
  const weighted = new AccountRouter(["free", "pro"], "weighted");
  const firstWeightedOrder = weighted.order();
  assert.equal(firstWeightedOrder[0], "free");
  assert.equal(firstWeightedOrder[1], "pro");
});

test("quota-aware routing prefers remaining capacity and skips exhausted accounts", () => {
  const router = new AccountRouter(["free", "pro", "plus"], "quota-aware", {
    quotas: { free: { remaining: 0 }, pro: { remaining: 3 }, plus: { remaining: 8 } },
  });
  assert.deepEqual(router.order(), ["plus", "pro"]);
});

test("per-account concurrency is independent and releases on completion", async () => {
  const limiter = new PerAccountConcurrency({ limits: { free: 1, pro: 1 } });
  const first = await limiter.acquire("free");
  let freeEntered = false;
  const waiting = limiter.run("free", () => { freeEntered = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(freeEntered, false);
  await limiter.run("pro", () => undefined);
  first.release();
  await waiting;
  assert.equal(freeEntered, true);
});

test("operation cancellation aborts the operation signal and invokes handlers", () => {
  const registry = new OperationRegistry({ idFactory: () => "test" });
  const operation = registry.create("chat");
  let invoked = false;
  registry.registerCancellation(operation.id, () => { invoked = true; });
  registry.cancel(operation.id);
  assert.equal(operation.cancelRequested, true);
  assert.equal(operation.signal.aborted, true);
  assert.equal(invoked, true);
});
