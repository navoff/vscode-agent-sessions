import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, daemonVersionAction, parseDaemonProtocol, protocolMismatchAction } from "../connection/daemonUpgrade.js";

test("compareVersions orders semver and ignores build metadata", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0+aaaa", "1.0.0+bbbb"), 0);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("garbage", "1.0.0"), undefined);
});

test("daemonVersionAction restarts only an older or unorderable daemon", () => {
  const bundled = "0.2.0+f3f7bc4d5c6e";
  assert.equal(daemonVersionAction(bundled, bundled), "keep");
  assert.equal(daemonVersionAction("0.1.0+aaaaaaaaaaaa", bundled), "restart");
  assert.equal(daemonVersionAction("0.3.0+aaaaaaaaaaaa", bundled), "newer");
  assert.equal(daemonVersionAction("0.2.1", bundled), "newer");
  // Another build of the same version cannot be ordered: replaced as before.
  assert.equal(daemonVersionAction("0.2.0+aaaaaaaaaaaa", bundled), "restart");
  assert.equal(daemonVersionAction("", bundled), "restart");
});

test("protocolMismatchAction restarts only a daemon with an older protocol", () => {
  assert.equal(parseDaemonProtocol("unsupported protocol 2, daemon speaks 1"), 1);
  assert.equal(parseDaemonProtocol("connection closed"), undefined);
  assert.equal(parseDaemonProtocol(undefined), undefined);
  assert.equal(protocolMismatchAction("unsupported protocol 2, daemon speaks 1", 2), "restart");
  assert.equal(protocolMismatchAction("daemon error: unsupported protocol 2, daemon speaks 3", 2), "newer");
  assert.equal(protocolMismatchAction("unsupported protocol 2, daemon speaks 2", 2), "keep");
  assert.equal(protocolMismatchAction("unsupported protocol 2", 2), undefined);
});
