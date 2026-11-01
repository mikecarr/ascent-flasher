import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAsk } from "../lib/confirm.js";

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type, extra = {}) {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
    return e;
  }
}

/** A <dialog> whose close event, like Chromium's, arrives later (here: on demand). */
class FakeDialog extends FakeTarget {
  constructor() {
    super();
    this.open = false;
    this.returnValue = "";
    this.shows = 0;
    this.pendingClose = [];
  }
  showModal() {
    if (this.open) return; // a no-op on an open dialog
    this.open = true;
    this.shows += 1;
  }
  close(value) {
    if (!this.open) return;
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    this.pendingClose.push(() => this.dispatch("close"));
  }
  flushClose() {
    for (const f of this.pendingClose.splice(0)) f();
  }
}

function setup() {
  const dialog = new FakeDialog();
  const form = new FakeTarget();
  const shown = [];
  const ask = makeAsk({ dialog, form, show: (c) => shown.push(c) });
  /** A button press: submit, then (unless prevented) the browser's method=dialog close. */
  const press = (value) => {
    const e = form.dispatch("submit", { submitter: { value } });
    if (!e.defaultPrevented) dialog.close(value);
  };
  return { dialog, form, shown, ask, press };
}

const tick = () => new Promise((r) => setImmediate(r));

test("each ask waits for its own answer (no stale close carries over)", async () => {
  const { dialog, shown, ask, press } = setup();
  const answers = [];
  const run = (async () => {
    answers.push(await ask("one"));
    answers.push(await ask("two")); // asked from the first answer's continuation
    answers.push(await ask("three"));
  })();
  await tick();
  assert.equal(dialog.open, true);
  press("ok");
  await tick();
  dialog.flushClose(); // the first dialog's late close event
  await tick();
  assert.deepEqual(answers, [true], "second ask still pending");
  assert.equal(dialog.open, true, "second dialog is showing");
  assert.equal(dialog.shows, 2);
  press("cancel");
  await tick();
  dialog.flushClose();
  await tick();
  assert.deepEqual(answers, [true, false]);
  press("ok");
  await run;
  assert.deepEqual(answers, [true, false, true]);
  assert.deepEqual(shown, ["one", "two", "three"]);
});

test("Escape (cancel event) answers no and closes the dialog", async () => {
  const { dialog, ask } = setup();
  const p = ask("q");
  await tick();
  dialog.dispatch("cancel");
  assert.equal(await p, false);
  assert.equal(dialog.open, false);
});

test("a late close after the answer never resolves a later ask", async () => {
  const { dialog, ask, press } = setup();
  const first = ask("a");
  press("ok");
  assert.equal(await first, true);
  const second = ask("b");
  let settled = false;
  second.then(() => (settled = true));
  dialog.flushClose();
  dialog.dispatch("close");
  await tick();
  assert.equal(settled, false);
  press("ok");
  assert.equal(await second, true);
});
