import assert from "node:assert/strict";
import test from "node:test";
import { codeIn } from "../dist/native-browser-inbox-code.js";
import { profileFieldFor } from "../dist/native-browser-profile.js";

test("sign-in codes are read from messages, payment approvals are not", () => {
  assert.equal(codeIn("Your GitHub launch code is 482913"), "482913");
  assert.equal(codeIn("G-551204 is your Google verification code."), "551204");
  assert.equal(codeIn("Use 7731 as your login code for Notion"), "7731");
  assert.equal(codeIn("OTP 553311 for a transaction of Rs. 4,999 on card ending 1234"), undefined);
  assert.equal(codeIn("Your order shipped in 2026"), undefined);
});

test("form fields map to profile fields by hint, label and saved names", () => {
  const field = (label, autocomplete = "") => ({
    index: 0,
    label,
    autocomplete,
    tag: "input",
    type: "text",
  });
  assert.equal(profileFieldFor(field("Given", "given-name"), []), "firstName");
  assert.equal(profileFieldFor(field("Last name"), []), "lastName");
  assert.equal(profileFieldFor(field("ZIP / Postal code"), []), "postalCode");
  assert.equal(profileFieldFor(field("Passport city"), ["passportCity"]), "passportCity");
  assert.equal(profileFieldFor(field("Favourite colour"), []), undefined);
});
