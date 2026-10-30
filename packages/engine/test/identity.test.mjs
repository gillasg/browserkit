import assert from "node:assert/strict";
import test from "node:test";
import { pacScript } from "../dist/native-browser-identity.js";

test("a proxy for some sites leaves the rest direct", () => {
  const script = pacScript("socks5://10.0.0.2:1080", ["example.com"]);
  assert.match(script, /SOCKS5 10\.0\.0\.2:1080/);
  assert.match(script, /DIRECT/);
  assert.doesNotMatch(pacScript("proxy.local:3128", []), /DIRECT/);
});
