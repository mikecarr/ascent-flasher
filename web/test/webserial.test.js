import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../lib/clock.js";
import { LinkGoneError, PortBusyError } from "../lib/link.js";
import { SimConnector, SimBus } from "../lib/sim.js";
import { CMD } from "../lib/protocol.js";
import { WebSerialConnector, DeviceWatcher, requestDevice } from "../lib/webserial.js";

class FakePort {
  constructor(vid = 0x1d76, pid = 0x1001) {
    this.vid = vid;
    this.pid = pid;
    this.openArgs = null;
    this.openError = null;
    this.closed = false;
    this.isOpen = false;
    this.readable = null;
    this.writable = null;
    this.writes = [];
  }
  #fresh() {
    this.readable = new ReadableStream({ start: (c) => (this.ctl = c) });
  }
  getInfo() {
    return { usbVendorId: this.vid, usbProductId: this.pid };
  }
  async open(opts) {
    if (this.openError) throw this.openError;
    if (this.isOpen) throw new DOMException("already open", "InvalidStateError");
    this.isOpen = true;
    this.closed = false;
    this.openArgs = opts;
    this.#fresh();
    this.writable = new WritableStream({ write: this.sink ?? ((c) => void this.writes.push(c)) });
  }
  async close() {
    if (this.readable?.locked || this.writable?.locked) {
      throw new DOMException("streams locked", "InvalidStateError");
    }
    this.isOpen = false;
    this.closed = true;
    this.readable = null;
    this.writable = null;
  }
  push(bytes) {
    this.ctl.enqueue(bytes);
  }
  /** Error the stream; non-fatal errors give the port a fresh stream, fatal ones none. */
  fail(name, fatal) {
    this.ctl.error(new DOMException("boom", name));
    if (fatal) this.readable = null;
    else this.#fresh();
  }
}

class FakeSerial extends EventTarget {
  constructor(ports) {
    super();
    this.ports = ports;
  }
  async getPorts() {
    return [...this.ports];
  }
  async requestPort(opts) {
    this.lastRequest = opts;
    if (!this.pick) throw new DOMException("none", "NotFoundError");
    return this.pick;
  }
}

test("open on a busy port gives the in-use message", async () => {
  const p = new FakePort();
  p.openError = new DOMException("already open", "InvalidStateError");
  const c = new WebSerialConnector(new FakeSerial([p]));
  const [info] = await c.list();
  await assert.rejects(c.open(info), (e) => {
    assert.ok(e instanceof PortBusyError);
    assert.match(e.message, /in use by another app or tab/);
    return true;
  });
});

test("list returns only permitted candidate ports, ids stable per object", async () => {
  const a = new FakePort(0x1d76), b = new FakePort(0x1234);
  const s = new FakeSerial([a, b]);
  const c = new WebSerialConnector(s);
  const l1 = await c.list();
  assert.equal(l1.length, 1);
  assert.equal(l1[0].vid, 0x1d76);
  assert.equal((await c.list())[0].id, l1[0].id);
  s.ports = [];
  assert.deepEqual(await c.list(), []);
  const a2 = new FakePort(0x1d76);
  s.ports = [a2];
  assert.notEqual((await c.list())[0].id, l1[0].id);
});

test("open uses 115200 baud and requestDevice filters to candidate VIDs", async () => {
  const p = new FakePort();
  const s = new FakeSerial([p]);
  const link = await new WebSerialConnector(s).open((await new WebSerialConnector(s).list())[0]);
  assert.equal(p.openArgs.baudRate, 115200);
  await link.write(Uint8Array.of(1, 2));
  assert.deepEqual([...p.writes[0]], [1, 2]);
  await link.close();
  assert.ok(p.closed);
  assert.equal(await requestDevice(s), null);
  s.pick = p;
  assert.equal((await requestDevice(s)).vid, 0x1d76);
  assert.ok(s.lastRequest.filters.some((f) => f.usbVendorId === 0x1d76));
  assert.ok(!s.lastRequest.filters.some((f) => f.usbVendorId === 0x1d7c));
});

async function openLink(p) {
  const s = new FakeSerial([p]);
  const c = new WebSerialConnector(s);
  return c.open((await c.list())[0]);
}

test("link read returns null on timeout and data otherwise, losing nothing", async () => {
  const p = new FakePort();
  const link = await openLink(p);
  assert.equal(await link.read(5), null);
  p.push(Uint8Array.of(7, 8));
  assert.deepEqual([...(await link.read(50))], [7, 8]);
  // data arriving after a timeout is returned by the next read
  assert.equal(await link.read(5), null);
  p.push(Uint8Array.of(9));
  assert.deepEqual([...(await link.read(50))], [9]);
});

test("non-fatal read errors re-acquire the reader and keep reading", async () => {
  for (const name of ["BreakError", "FramingError", "BufferOverrunError", "ParityError"]) {
    const p = new FakePort();
    const logs = [];
    const s = new FakeSerial([p]);
    const c = new WebSerialConnector(s, (m) => logs.push(m));
    const link = await c.open((await c.list())[0]);
    const r = link.read(200);
    await new Promise((res) => setTimeout(res, 5));
    p.fail(name, false);
    await new Promise((res) => setTimeout(res, 5));
    p.push(Uint8Array.of(42));
    assert.deepEqual([...(await r)], [42], name);
    assert.ok(logs.some((m) => m.includes(name)));
  }
});

test("fatal read errors and a closed stream become LinkGoneError", async () => {
  const p = new FakePort();
  const link = await openLink(p);
  const r = link.read(200);
  await new Promise((res) => setTimeout(res, 5));
  p.fail("NetworkError", true);
  await assert.rejects(r, LinkGoneError);

  const p2 = new FakePort();
  const l2 = await openLink(p2);
  p2.ctl.close();
  await assert.rejects(l2.read(50), LinkGoneError);

  // a non-fatal error whose port is no longer readable is still gone
  const p3 = new FakePort();
  const l3 = await openLink(p3);
  const r3 = l3.read(200);
  await new Promise((res) => setTimeout(res, 5));
  p3.fail("BreakError", true);
  await assert.rejects(r3, LinkGoneError);
});

test("write failure after the device leaves is LinkGoneError", async () => {
  const p = new FakePort();
  const link = await openLink(p);
  const bad = await openLink(Object.assign(new FakePort(), {
    sink() { throw new DOMException("gone", "NetworkError"); },
  }));
  await assert.rejects(bad.write(Uint8Array.of(1)), LinkGoneError);
  await link.close();
});

test("open, read, close, reopen, read works (reboot path)", async () => {
  const p = new FakePort();
  const s = new FakeSerial([p]);
  const c = new WebSerialConnector(s);
  const [info] = await c.list();
  const l1 = await c.open(info);
  p.push(Uint8Array.of(1));
  assert.deepEqual([...(await l1.read(50))], [1]);
  await l1.close();
  assert.ok(p.closed);
  const l2 = await c.open(info);
  p.push(Uint8Array.of(2));
  assert.deepEqual([...(await l2.read(50))], [2]);
  await l2.close();
  assert.ok(p.closed);
});

test("close while a read is pending rejects it with LinkGoneError and closes the port", async () => {
  const p = new FakePort();
  const link = await openLink(p);
  const r = link.read(5000);
  const assertion = assert.rejects(r, LinkGoneError);
  await new Promise((res) => setTimeout(res, 5));
  await link.close();
  await assertion;
  assert.ok(p.closed);
});

test("close finishes even when a write never completes", async () => {
  const p = Object.assign(new FakePort(), { sink: () => new Promise(() => {}) });
  const link = await openLink(p);
  void link.write(Uint8Array.of(1)).catch(() => {});
  await new Promise((res) => setTimeout(res, 5));
  await link.close();
  assert.ok(p.closed);
});

// ---- watcher ----

const FIND = (c) => c.device.log.filter((h) => h.command === CMD.FIND_DEVICE).length;

function watcherSetup(devOpts = {}) {
  const clock = new VirtualClock();
  const c = new SimConnector(clock, "/dev/sim0", 0x1d76, 0x1001, devOpts);
  const changes = [];
  const w = new DeviceWatcher(c, clock, (v) => changes.push(v));
  return { clock, c, w, changes };
}

test("watcher probes only on change", async () => {
  const { c, w, changes } = watcherSetup();
  await w.tick();
  await w.tick();
  assert.equal(FIND(c), 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].info.deviceName, "ascent_lite_plus");
  c.device.gone = true; // unplugged
  await w.tick();
  assert.deepEqual(changes, [changes[0], null]);
  assert.equal(FIND(c), 1);
});

test("watcher sends nothing while paused, and rescans after resume", async () => {
  const { c, w, changes } = watcherSetup();
  await w.pause();
  await w.tick();
  await w.rescan();
  assert.equal(FIND(c), 0);
  assert.equal(changes.length, 0);
  w.resume();
  await w.tick();
  assert.equal(FIND(c), 1);
  assert.equal(changes.length, 1);
});

test("watcher retries an unanswered candidate at most 4 times, rescan forces a probe", async () => {
  const { c, w, changes } = watcherSetup({ dropFirstRequests: 1000 });
  for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(changes.length, 0);
  assert.equal(FIND(c) > 0, true);
  const n = FIND(c);
  await w.tick();
  assert.equal(FIND(c), n, "stops retrying");
  c.device.dropFirstRequests = 0;
  await w.rescan();
  assert.equal(changes.length, 1);
});

test("watcher: connect/disconnect events trigger a scan; throwing callbacks are harmless", async () => {
  const s = new FakeSerial([]);
  const conn = new WebSerialConnector(s);
  const slow = { now: () => Date.now(), sleep: () => new Promise((r) => setTimeout(r, 20)) };
  const w = new DeviceWatcher(conn, slow, () => {
    throw new Error("ui broke");
  }, () => {
    throw new Error("log broke");
  });
  let ticks = 0;
  const orig = w.tick.bind(w);
  w.tick = () => (ticks++, orig());
  w.start();
  await new Promise((r) => setTimeout(r, 5));
  const before = ticks;
  s.dispatchEvent(new Event("disconnect"));
  s.dispatchEvent(new Event("connect"));
  assert.equal(ticks, before + 2);
  w.stop();
  s.dispatchEvent(new Event("connect"));
  assert.equal(ticks, before + 2, "unsubscribed after stop");
});

test("watcher survives a throwing onChange and log", async () => {
  const { w, c } = watcherSetup();
  w.onChange = () => {
    throw new Error("ui broke");
  };
  await w.tick();
  c.device.gone = true;
  await w.tick();
});

test("watcher prefers any flashable model, VRX Pro included, over another Ascent unit", async () => {
  const clock = new VirtualClock();
  const other = new SimConnector(clock, "/dev/sim0", 0x1d76, 0x0103, { info: { deviceName: "ascent_mystery" } });
  const vrx = new SimConnector(clock, "/dev/sim1", 0x1d77, 0x0102, { info: { deviceName: "ascent_vrx_pro" } });
  const changes = [];
  const w = new DeviceWatcher(new SimBus(other, vrx), clock, (v) => changes.push(v));
  await w.tick();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].info.deviceName, "ascent_vrx_pro");
});
