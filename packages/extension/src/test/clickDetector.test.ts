import { test } from "node:test";
import assert from "node:assert/strict";
import { DoubleClickDetector } from "../tree/clickDetector.js";

test("two clicks on the same key within the window make a double click", () => {
  let t = 1000;
  const d = new DoubleClickDetector(500, () => t);
  assert.equal(d.click("a"), false);
  t += 300;
  assert.equal(d.click("a"), true);
  t += 100;
  assert.equal(d.click("a"), false, "a third click starts over");
});

test("slow clicks and clicks on different keys are single clicks", () => {
  let t = 1000;
  const d = new DoubleClickDetector(500, () => t);
  assert.equal(d.click("a"), false);
  t += 600;
  assert.equal(d.click("a"), false);
  t += 100;
  assert.equal(d.click("b"), false);
  t += 100;
  assert.equal(d.click("b"), true);
});
