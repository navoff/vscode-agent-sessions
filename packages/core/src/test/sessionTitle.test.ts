import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SESSION_TITLE_LENGTH, normalizeSessionTitle, sessionTitleProblem } from "../util/sessionTitle.js";

test("sessionTitleProblem names what is wrong with a title", () => {
  assert.equal(sessionTitleProblem("Fix the pricing bug"), undefined);
  assert.equal(sessionTitleProblem("x".repeat(MAX_SESSION_TITLE_LENGTH)), undefined);
  assert.match(sessionTitleProblem("") ?? "", /empty/);
  assert.match(sessionTitleProblem("x".repeat(MAX_SESSION_TITLE_LENGTH + 1)) ?? "", /longer than 200 characters/);
  for (const bad of ["two\nlines", "a\rb", "tab\there", "bell\u0007", "del\u007f"]) assert.match(sessionTitleProblem(bad) ?? "", /single line/, JSON.stringify(bad));
});

test("normalizeSessionTitle trims and throws the problem", () => {
  assert.equal(normalizeSessionTitle("  New name \n"), "New name");
  assert.throws(() => normalizeSessionTitle("   "), /session title is empty/);
  assert.throws(() => normalizeSessionTitle("a\nb"), /single line/);
});
