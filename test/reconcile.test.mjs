import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deletionsToApply,
  isComplete,
  oldestId,
  checkDeletionSafety,
  DEFAULT_MAX_DELETIONS,
} from "../scripts/lib/reconcile.mjs";

// Ids in ascending age order: A oldest, E newest.
const A = "826000000000000001";
const B = "826000000000000002";
const C = "826000000000000003";
const D = "826000000000000004";
const E = "826000000000000005";
const LOCAL = [A, B, C, D, E];

test("a post missing from the fetched window is deleted", () => {
  // Window covers C..E; D is gone upstream.
  assert.deepEqual(
    deletionsToApply({ localIds: LOCAL, upstreamIds: [C, E], windowFloor: C }),
    [D],
  );
});

test("posts older than the window are never touched", () => {
  // A and B sit below the floor: not fetched, so nothing is known about them.
  const out = deletionsToApply({ localIds: LOCAL, upstreamIds: [C, D, E], windowFloor: C });
  assert.deepEqual(out, []);
});

test("a full walk judges every post, not just a window", () => {
  assert.deepEqual(
    deletionsToApply({ localIds: LOCAL, upstreamIds: [C, D, E], complete: true }),
    [A, B],
  );
});

test("without a window or a full walk it concludes nothing", () => {
  // The failure mode that matters: an empty response must delete nothing.
  assert.deepEqual(deletionsToApply({ localIds: LOCAL, upstreamIds: [] }), []);
  assert.deepEqual(
    deletionsToApply({ localIds: LOCAL, upstreamIds: [], windowFloor: null }),
    [],
  );
});

test("an empty response during a full walk is still reported, not hidden", () => {
  // complete:true is the caller's assertion that the walk really finished, so
  // this must surface as "everything is gone" for the safety cap to catch.
  assert.equal(
    deletionsToApply({ localIds: LOCAL, upstreamIds: [], complete: true }).length,
    5,
  );
});

test("ids are compared as BigInt, not as Numbers", () => {
  const near = "826000000000000001";
  const alsoNear = "826000000000000002";
  assert.equal(Number(near), Number(alsoNear)); // precondition: Numbers collapse
  assert.deepEqual(
    deletionsToApply({ localIds: [near, alsoNear], upstreamIds: [alsoNear], windowFloor: near }),
    [near],
  );
});

test("oldestId finds the floor of a page", () => {
  assert.equal(oldestId([D, B, E]), B);
  assert.equal(oldestId([]), null);
  assert.equal(oldestId(["not-a-number"]), null);
});

test("a small batch is safe, a large one stops and asks", () => {
  assert.equal(checkDeletionSafety([]).safe, true);
  assert.equal(checkDeletionSafety([A, B]).safe, true);
  const many = Array.from({ length: DEFAULT_MAX_DELETIONS + 1 }, (_, i) => String(826e15 + i));
  const verdict = checkDeletionSafety(many);
  assert.equal(verdict.safe, false);
  assert.match(verdict.reason, /Refusing to delete/);
});

test("the cap is configurable for a genuine bulk removal", () => {
  const many = Array.from({ length: 8 }, (_, i) => String(826e15 + i));
  assert.equal(checkDeletionSafety(many, { max: 10 }).safe, true);
});

test("completeness is counted, never inferred from an empty page", () => {
  // The bug this guards: an empty API response was treated as "walked the
  // whole blog", so every mirrored post read as deleted and all of them were
  // removed. Completeness must be earned by seeing as many ids as the blog
  // claims to have.
  assert.equal(isComplete({ upstreamCount: 0, totalPosts: 5 }), false);
  assert.equal(isComplete({ upstreamCount: 4, totalPosts: 5 }), false);
  assert.equal(isComplete({ upstreamCount: 5, totalPosts: 5 }), true);
  assert.equal(isComplete({ upstreamCount: 6, totalPosts: 5 }), true);
  // An unknown total can never be complete.
  assert.equal(isComplete({ upstreamCount: 20, totalPosts: null }), false);
  // The empty blog case: nothing upstream, nothing claimed.
  assert.equal(isComplete({ upstreamCount: 0, totalPosts: 0 }), true);
});
