import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { ViewServer } from "../dist/view.js";

test("the viewer rejects a bad token and streams frames to a good client", async () => {
  const inputs = [];
  let requested = 0;
  const view = new ViewServer(
    7,
    (message) => inputs.push(message),
    () => {
      requested += 1;
    },
  );
  const port = await view.start(0);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/view?token=bad`)).status, 401);
    assert.equal((await fetch(view.url)).status, 200);
    const good = view.url.replace("http://", "ws://").replace("/view?token=", "/view/ws?token=");
    const socket = new WebSocket(good);
    await new Promise((done, fail) => {
      socket.once("open", done);
      socket.once("error", fail);
    });
    assert.equal(requested, 1);
    const frame = new Promise((done) => socket.once("message", (raw) => done(JSON.parse(String(raw)))));
    view.frame("abc");
    assert.equal((await frame).data, "data:image/jpeg;base64,abc");
    socket.send(JSON.stringify({ action: "key", key: "a" }));
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(inputs[0].tabId, 7);
    socket.close();
  } finally {
    await view.stop();
  }
});
