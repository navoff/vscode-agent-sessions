import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionKey } from "../types.js";

test("sessionKey joins agent and id", () => {
  assert.equal(sessionKey({ agent: "claude", id: "abc" }), "claude:abc");
});
