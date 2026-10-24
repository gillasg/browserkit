// browser.fetch failures: the kind read from a net:: code, a block page recognised, and the
// readable message with the fields browser_code parses back.
import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosisOf,
  failureMessage,
  hostOf,
  kindOfNetError,
  looksLikeBlockPage,
} from "../packages/engine/dist/native-browser-fetch-errors.js";

test("net:: codes become the kind an agent acts on", () => {
  assert.equal(kindOfNetError("net::ERR_NAME_NOT_RESOLVED"), "dns");
  assert.equal(kindOfNetError("net::ERR_CERT_AUTHORITY_INVALID"), "tls");
  assert.equal(kindOfNetError("net::ERR_SSL_PROTOCOL_ERROR"), "tls");
  assert.equal(kindOfNetError("net::ERR_CONNECTION_REFUSED"), "refused");
  assert.equal(kindOfNetError("net::ERR_CONNECTION_RESET"), "reset");
  assert.equal(kindOfNetError("net::ERR_EMPTY_RESPONSE"), "reset");
  assert.equal(kindOfNetError("net::ERR_CONNECTION_TIMED_OUT"), "timeout");
  assert.equal(kindOfNetError("net::ERR_BLOCKED_BY_CLIENT"), "blocked-page");
  assert.equal(kindOfNetError("net::ERR_UNKNOWN_THING"), undefined);
  assert.equal(kindOfNetError(undefined), undefined);
});

test("an ISP or filter page is a block page, an ordinary page is not", () => {
  const blocked = {
    finalUrl: "http://blocked.example.net/",
    title: "Access denied",
    text: "This site has been blocked by your ISP.",
  };
  assert.equal(looksLikeBlockPage(blocked, "shop.example"), true);
  assert.equal(
    looksLikeBlockPage({ title: "Shop", text: "Lamps and chairs" }, "shop.example"),
    false,
  );
  // A name that resolves to a sinkhole host is a block even without the words.
  assert.equal(
    looksLikeBlockPage({ finalUrl: "https://sinkhole.isp.example/warning" }, "shop.example"),
    true,
  );
  assert.equal(looksLikeBlockPage({ finalUrl: "https://shop.example/" }, "shop.example"), false);
});

test("dns and blocked-page say when the block is the network's, others do not", () => {
  const page = {
    finalUrl: "http://blocked.example.net/",
    title: "Access denied",
    text: "Blocked by your network administrator.",
  };
  const dns = diagnosisOf("dns", "shop.example", page);
  assert.equal(dns.networkBlock, true);
  assert.match(dns.readable, /DNS lookup failed for shop\.example/);
  assert.match(dns.readable, /network-level block/);

  const plainDns = diagnosisOf("dns", "typo.invalid");
  assert.equal(plainDns.networkBlock, undefined);
  assert.match(plainDns.readable, /the name does not resolve/);

  const blocked = diagnosisOf("blocked-page", "shop.example", page);
  assert.equal(blocked.networkBlock, true);

  const reset = diagnosisOf("reset", "x.com", page);
  assert.equal(reset.networkBlock, undefined);
  assert.equal(reset.readable, "connection reset talking to x.com");
});

test("the message is readable first and carries the fields after it", () => {
  const message = failureMessage({ kind: "tls", readable: "TLS failed talking to x.com" }, "x.com");
  assert.equal(message, "TLS failed talking to x.com [fetch kind=tls host=x.com]");
  const blocked = failureMessage(
    {
      kind: "dns",
      readable: "DNS lookup failed for x.com",
      networkBlock: true,
      detail: "net::ERR_NAME_NOT_RESOLVED",
    },
    "x.com",
  );
  assert.match(
    blocked,
    /\[fetch kind=dns host=x\.com networkBlock=true detail=net::ERR_NAME_NOT_RESOLVED\]/,
  );
  assert.equal(hostOf("https://shop.example/a?b=1"), "shop.example");
  assert.equal(hostOf("not a url"), undefined);
});
