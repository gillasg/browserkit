import assert from "node:assert/strict";
import test from "node:test";
import { privateAddress, privateTarget, resolvedTarget } from "../dist/native-browser-policy.js";
import { privateTabRules } from "../dist/native-browser-private-rules.js";
import { summarize } from "../dist/native-browser-network-format.js";

test("private, metadata and local names are recognised", () => {
  assert.ok(privateTarget("http://10.1.2.3/"));
  assert.ok(privateTarget("http://192.168.1.1/"));
  assert.ok(privateTarget("http://169.254.169.254/latest"));
  assert.ok(privateTarget("http://metadata.google.internal/"));
  assert.ok(privateTarget("http://printer.local/"));
  assert.ok(privateAddress("::1"));
  assert.ok(privateAddress("fd00:ec2::254"));
  assert.ok(privateAddress("100.100.100.200"));
  assert.equal(privateTarget("https://example.com/"), undefined);
});

test("the localhost port allowlist keeps local development working", () => {
  assert.equal(privateTarget("http://127.0.0.1:3000/app", [3000]), undefined);
  assert.ok(privateTarget("http://127.0.0.1:8080/app", [3000]));
  assert.equal(privateTarget("http://localhost:8787/", [8787]), undefined);
  assert.ok(privateTarget("http://10.0.0.2:3000/app", [3000]));
});

test("a public-looking hostname that resolves private is refused", () => {
  assert.ok(resolvedTarget("127.0.0.1.nip.io", ["127.0.0.1"]));
  assert.ok(resolvedTarget("localhost.example.com", ["::1"]));
  assert.ok(resolvedTarget("metadata.example.com", ["169.254.169.254"]));
  assert.equal(resolvedTarget("example.com", ["93.184.216.34"]), undefined);
});

test("the private DNR rules use their own id band and cover literals", () => {
  const rules = privateTabRules(42);
  for (const rule of rules) assert.ok(rule.id >= 790_000 && rule.id < 799_000, String(rule.id));
  assert.equal(rules[0].condition.tabIds[0], 42);
  assert.match(rules[0].condition.regexFilter, /127\\\./);
  assert.match(rules[0].condition.regexFilter, /192\\\.168\\\./);
  assert.ok(rules[1].condition.requestDomains.includes("169.254.169.254"));
  assert.equal(rules[0].action.type, "block");
});

test("a response from a private address reports the rebinding note", () => {
  const note = "PRIVATE_NETWORK: the request reached private address 127.0.0.1";
  const summary = summarize({
    id: "1",
    url: "http://rebind.example/",
    method: "GET",
    type: "Document",
    startedAt: 1,
    requestHeaders: {},
    remoteIPAddress: "127.0.0.1",
    privateNetwork: note,
    done: true,
  });
  assert.equal(summary.remoteIPAddress, "127.0.0.1");
  assert.equal(summary.privateNetwork, note);
});

test("the DNR loopback exemption follows the allowlist ports", () => {
  const rules = privateTabRules(7, [3000]);
  assert.match(rules[0].condition.regexFilter, /localhost\|127/);
  assert.match(rules[0].condition.regexFilter, /3000/);
});
