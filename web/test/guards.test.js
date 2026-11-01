import { test } from "node:test";
import assert from "node:assert/strict";
import { FlashGuards } from "../lib/guards.js";

/** A window that records its beforeunload listeners. */
function fakeWindow() {
  const listeners = new Map();
  return {
    listeners,
    added: [],
    removed: [],
    addEventListener(type, fn) {
      this.added.push(type);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this.removed.push(type);
      listeners.get(type)?.delete(fn);
    },
    fire(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function fakeNavigator({ reject = false } = {}) {
  const nav = { requests: [], sentinels: [] };
  nav.wakeLock = {
    async request(type) {
      nav.requests.push(type);
      if (reject) throw new DOMException("not allowed", "NotAllowedError");
      const sentinel = {
        released: false,
        async release() {
          this.released = true;
        },
      };
      nav.sentinels.push(sentinel);
      return sentinel;
    },
  };
  return nav;
}

const unloadEvent = () => ({
  returnValue: undefined,
  prevented: false,
  preventDefault() {
    this.prevented = true;
  },
});

test("leave guard is armed only while flashing", async () => {
  const win = fakeWindow();
  const nav = fakeNavigator();
  const g = new FlashGuards(win, nav);
  assert.equal(g.armed, false);
  assert.equal(win.listeners.get("beforeunload")?.size ?? 0, 0);

  await g.arm();
  assert.equal(g.armed, true);
  assert.equal(win.listeners.get("beforeunload").size, 1);
  assert.deepEqual(nav.requests, ["screen"]);
  const [handler] = win.listeners.get("beforeunload");

  const during = unloadEvent();
  win.fire("beforeunload", during);
  assert.ok(during.returnValue, "returnValue set while armed");
  assert.equal(during.prevented, true);

  g.disarm();
  assert.equal(g.armed, false);
  assert.equal(win.listeners.get("beforeunload").size, 0, "handler removed");
  assert.equal(nav.sentinels[0].released, true, "wake lock released");

  // Even a stale reference to the handler no longer asks.
  const after = unloadEvent();
  handler(after);
  assert.equal(after.returnValue, undefined);
  assert.equal(after.prevented, false);

  // Re-arming works (a second flash).
  await g.arm();
  assert.equal(win.listeners.get("beforeunload").size, 1);
  assert.equal(nav.requests.length, 2);
  g.disarm();
  assert.equal(nav.sentinels[1].released, true);
});

test("wake lock failure is ignored", async () => {
  const win = fakeWindow();
  const g = new FlashGuards(win, fakeNavigator({ reject: true }));
  await g.arm();
  assert.equal(g.armed, true);
  assert.equal(win.listeners.get("beforeunload").size, 1);
  g.disarm();
  assert.equal(g.armed, false);
});

test("no wake lock API: arm still guards leaving", async () => {
  const win = fakeWindow();
  const g = new FlashGuards(win, {});
  await g.arm();
  assert.equal(g.armed, true);
  const e = unloadEvent();
  win.fire("beforeunload", e);
  assert.ok(e.returnValue);
  g.disarm();
});

test("disarm before the wake lock arrives releases it", async () => {
  const win = fakeWindow();
  const nav = fakeNavigator();
  const g = new FlashGuards(win, nav);
  const arming = g.arm();
  g.disarm();
  await arming;
  assert.equal(g.armed, false);
  assert.equal(nav.sentinels[0].released, true);
});
