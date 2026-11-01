import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionLog } from "../lib/session-log.js";

test("session log text has relative timestamps and keeps order", () => {
  let t = 5000; // page loaded at 5 s on this clock
  const log = new SessionLog({ now: () => t });
  t = 5000;
  log.line("first");
  t = 6234.4;
  log.line("second");
  t = 65000;
  log.line("third");
  const lines = log.text().trimEnd().split("\n").filter((l) => l.startsWith("["));
  assert.deepEqual(lines, [
    "[    0.000s] first",
    "[    1.234s] second",
    "[   60.000s] third",
  ]);
});

test("line is usable as a detached callback", () => {
  const log = new SessionLog({ now: () => 0 });
  const { line } = log;
  line("detached");
  [1, 2].forEach((n) => log.line(`n=${n}`));
  assert.match(log.text(), /detached[\s\S]*n=1[\s\S]*n=2/);
});

test("download saves the text as a .txt via a Blob URL", async () => {
  const log = new SessionLog({ now: () => 0 });
  log.line("hello");
  const clicked = [];
  const doc = {
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        click() {
          clicked.push({ href: this.href, download: this.download });
        },
        remove() {},
      };
    },
  };
  let blob = null;
  const revoked = [];
  const urlApi = {
    createObjectURL(b) {
      blob = b;
      return "blob:fake";
    },
    revokeObjectURL(u) {
      revoked.push(u);
    },
  };
  log.download("session.txt", { doc, urlApi });
  assert.deepEqual(clicked, [{ href: "blob:fake", download: "session.txt" }]);
  assert.equal(blob.type, "text/plain");
  assert.match(await blob.text(), /hello/);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(revoked, ["blob:fake"]);
});
