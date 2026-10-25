import assert from "node:assert/strict";
import test from "node:test";
import { affirmativeIndex, classifyGate } from "../dist/gates.js";

test("age walls are recognised from fixtures, not only one site's wording", () => {
  assert.equal(classifyGate("You must be 18 or older to enter this site."), "age");
  assert.equal(classifyGate("Age verification required: enter your date of birth"), "age");
  assert.equal(classifyGate("This site contains mature content. Are you 18?"), "age");
});

test("terms, region and enter walls are distinct; cookies stay consent", () => {
  assert.equal(classifyGate("By entering you agree to the terms of use and site rules"), "terms");
  assert.equal(classifyGate("This content is not available in your country"), "region");
  assert.equal(classifyGate("Click to enter the site"), "enter");
  assert.equal(classifyGate("We value your privacy and use tracking technologies"), "consent");
  assert.equal(classifyGate("A normal article about gardening"), "none");
});

test("the affirmative control is chosen across languages and structures", () => {
  assert.equal(
    affirmativeIndex(["No, I am under 18", "I am 18 or older"]),
    1,
    "the leaving control is never first",
  );
  assert.equal(affirmativeIndex(["Sign in", "I agree"]), 1);
  assert.equal(
    affirmativeIndex(["Sign in", "Subscribe", "Leave site"]),
    -1,
    "no affirmative control is better than a paid or leaving one",
  );
  assert.equal(affirmativeIndex(["Continue to site"]), 0);
  assert.equal(affirmativeIndex(["Enter site"]), 0);
  assert.equal(affirmativeIndex(["Accept all"]), 0);
});
