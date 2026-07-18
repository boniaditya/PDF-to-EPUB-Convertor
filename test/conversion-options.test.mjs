import assert from "node:assert/strict";
import {
  parsePageRange,
  recommendedRenderWorkerCount,
  safeRenderScaleForViewport
} from "../src/conversion-options.js";

assert.deepEqual(parsePageRange("", 4), [1, 2, 3, 4]);
assert.deepEqual(parsePageRange("all", 3), [1, 2, 3]);
assert.deepEqual(parsePageRange("3, 1-2, 2", 5), [1, 2, 3]);

assert.throws(() => parsePageRange("0", 5), /between 1 and 5/);
assert.throws(() => parsePageRange("4-2", 5), /between 1 and 5/);
assert.throws(() => parsePageRange("abc", 5), /must look like/);

assert.equal(safeRenderScaleForViewport(100, 100, 2), 2);
assert.equal(Math.round(safeRenderScaleForViewport(5000, 5000, 2)), 1);

assert.equal(recommendedRenderWorkerCount(7, 12, 16), 1);
assert.equal(recommendedRenderWorkerCount(536, 2, 16), 1);
assert.equal(recommendedRenderWorkerCount(536, 4, 16), 2);
assert.equal(recommendedRenderWorkerCount(536, 8, 16), 4);
assert.equal(recommendedRenderWorkerCount(536, 16, 4), 2);
assert.equal(recommendedRenderWorkerCount(536, 16, 16), 4);

console.log("conversion-options tests passed");
