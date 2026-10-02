import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFirstPrompt } from "../util/firstPrompt.js";

test("normalizeFirstPrompt keeps line breaks, drops blank lines and cuts to 200 characters", () => {
  assert.equal(normalizeFirstPrompt("  fix\r\n\n the   bug\t now \n"), "fix\nthe bug now");
  assert.equal(normalizeFirstPrompt(""), undefined);
  assert.equal(normalizeFirstPrompt(" \n "), undefined);
  assert.equal(normalizeFirstPrompt(undefined), undefined);
  assert.equal(normalizeFirstPrompt("x".repeat(200)), "x".repeat(200));
  assert.equal(normalizeFirstPrompt("x".repeat(201)), "x".repeat(199) + "…");
  // A cut that lands on a line break leaves no empty last line.
  assert.equal(normalizeFirstPrompt("x".repeat(198) + "\nyy"), "x".repeat(198) + "…");
});
