import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CMD, encodeAck, FrameReader, fileInfo, decodeFileDataInfo, decodeUpgradeStatus, rebootPayload,
} from "../lib/protocol.js";
import { VirtualClock } from "../lib/clock.js";
import { LinkGoneError, PortBusyError } from "../lib/link.js";
import { Session, SessionTimeoutError } from "../lib/session.js";
import { SimConnector } from "../lib/sim.js";

const ascii = (s) => new TextEncoder().encode(s);

async function setup(devOpts = {}) {
  const clock = new VirtualClock();
  const c = new SimConnector(clock, "/dev/sim0", 0x1234, 0x5678, devOpts);
  const [port] = await c.list();
  const link = await c.open(port);
  return { clock, c, s: new Session(link, clock) };
}

// ---- tests/session.rs ----

test("findDeviceRoundtrip", async () => {
  const { c, s } = await setup();
  const info = await s.findDevice();
  assert.deepEqual(info, c.device.info);
  assert.equal(info.deviceName, "ascent_lite_plus");
  const log = c.device.log;
  assert.equal(log.length, 1);
  assert.equal(log[0].command, 60);
  assert.equal(log[0].retry, 0);
});

test("resendsSameSeqWithRetry", async () => {
  const { c, s, clock } = await setup({ dropFirstRequests: 1 });
  await s.request(CMD.FIND_DEVICE, new Uint8Array(0));
  const log = c.device.log;
  assert.equal(log.length, 2);
  assert.equal(log[0].seq, log[1].seq);
  assert.deepEqual([log[0].retry, log[1].retry], [0, 1]);
  assert.ok(clock.now() >= 2000, "resend after 2 s");
});

test("timesOut", async () => {
  const { s, clock } = await setup({ dropFirstRequests: 100 });
  const t = clock.now();
  await assert.rejects(s.request(CMD.FIND_DEVICE, new Uint8Array(0)), (e) => {
    assert.ok(e instanceof SessionTimeoutError, String(e));
    assert.equal(e.cmd, CMD.FIND_DEVICE);
    assert.equal(e.message, "timed out waiting for reply to FindDevice");
    return true;
  });
  const elapsed = clock.now() - t;
  assert.ok(elapsed >= 8000 && elapsed <= 8100, `${elapsed}`);
});

test("seqIncrementsPerRequest", async () => {
  const { c, s } = await setup();
  await s.request(CMD.FIND_DEVICE, new Uint8Array(0));
  await s.request(CMD.FIND_DEVICE, new Uint8Array(0));
  const log = c.device.log;
  assert.equal(log[1].seq, log[0].seq + 1);
});

test("fileTransferAndStatus", async () => {
  const { c, s } = await setup();
  await s.request(CMD.SENDFILE_START, fileInfo("ab", 5, "/r", "l"));
  let f = await s.request(CMD.SENDFILE_DATA, ascii("abc"));
  const i = decodeFileDataInfo(f.payload);
  assert.deepEqual([i.length, i.cursize, i.status], [3, 3, 0]);
  await s.request(CMD.SENDFILE_DATA, ascii("de"));
  f = await s.request(CMD.SENDFILE_END, new Uint8Array(0));
  assert.equal(decodeFileDataInfo(f.payload).detail, "OK");
  assert.deepEqual(c.device.receivedFile, ascii("abcde"));
  assert.equal(c.device.receivedRequests[0].payload.length, 328);
  f = await s.request(CMD.UPGRADE_STATUS, new Uint8Array(0));
  assert.equal(decodeUpgradeStatus(f.payload).percent, 100);
});

test("rebootTakesDeviceOfflineThenBackMoved", async () => {
  const { c, s, clock } = await setup({ rebootMovesTo: "/dev/sim1", offlineForMs: 60 });
  await s.sendNoAck(CMD.REBOOT, rebootPayload("clean"));
  assert.deepEqual(await c.list(), []);
  await assert.rejects(s.findDevice(), LinkGoneError);
  assert.deepEqual(c.device.rebootModes, ["clean"]);
  await clock.sleep(80);
  const l = await c.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].id, "/dev/sim1");
  assert.deepEqual([l[0].vid, l[0].pid], [0x1234, 0x5678]);
  await c.open(l[0]);
});

test("unplugAfterChunks", async () => {
  const { c, s } = await setup({ unplugAfterDataChunks: 1 });
  await s.request(CMD.SENDFILE_DATA, ascii("x"));
  await assert.rejects(s.request(CMD.SENDFILE_DATA, ascii("y")), LinkGoneError);
  assert.deepEqual(await c.list(), []);
});

test("status100SelfReboots", async () => {
  const { c, s, clock } = await setup({ offlineForMs: 50 });
  await s.request(CMD.UPGRADE_STATUS, new Uint8Array(0));
  assert.deepEqual(await c.list(), []);
  await clock.sleep(70);
  assert.equal((await c.list()).length, 1);
});

/** Link that parses requests and replies via a function producing ack bytes. */
class FakeLink {
  constructor(clock, reply) {
    this.clock = clock;
    this.reader = new FrameReader();
    this.rx = [];
    this.reply = reply;
  }
  async write(buf) {
    this.reader.push(buf);
    for (let f; (f = this.reader.next());) this.rx.push(...this.reply(f.header));
  }
  async read(timeoutMs) {
    if (this.rx.length === 0) {
      await this.clock.sleep(timeoutMs);
      return null;
    }
    return this.rx.shift();
  }
  async close() {}
}

function fake(reply) {
  const clock = new VirtualClock();
  return new Session(new FakeLink(clock, reply), clock);
}

test("staleDuplicateAckIsSkipped", async () => {
  let n = 0;
  const s = fake((h) => {
    n += 1;
    // Distinguish replies by payload; first request is acked twice.
    const a = encodeAck(h.command, Uint8Array.of(n), h.seq);
    return n === 1 ? [a, a] : [a];
  });
  const a = await s.request(CMD.SENDFILE_DATA, ascii("a"));
  assert.equal(a.header.seq, 1);
  const b = await s.request(CMD.SENDFILE_DATA, ascii("b"));
  assert.equal(b.header.seq, 2);
  assert.deepEqual(b.payload, Uint8Array.of(2));
  assert.equal(s.echoesSeq, true);
});

test("staleAckWithOldSeqIsSkippedOnceEchoLearned", async () => {
  let n = 0;
  const s = fake((h) => {
    n += 1;
    if (n === 2) {
      // Late ack for seq 1 arrives ahead of B's own reply.
      return [encodeAck(h.command, Uint8Array.of(9), h.seq - 1), encodeAck(h.command, Uint8Array.of(2), h.seq)];
    }
    return [encodeAck(h.command, Uint8Array.of(n), h.seq)];
  });
  await s.request(CMD.SENDFILE_DATA, ascii("a"));
  const b = await s.request(CMD.SENDFILE_DATA, ascii("b"));
  assert.deepEqual(b.payload, Uint8Array.of(2));
});

test("commandOnlyWhenDeviceDoesNotEchoSeq", async () => {
  const s = fake((h) => [encodeAck(h.command, new Uint8Array(0), 0)]);
  await s.request(CMD.FIND_DEVICE, new Uint8Array(0));
  await s.request(CMD.FIND_DEVICE, new Uint8Array(0));
  assert.equal(s.echoesSeq, false);
});

test("seqStartsAtOne", async () => {
  const { c, s } = await setup();
  assert.equal(s.echoesSeq, null);
  await s.request(CMD.FIND_DEVICE, new Uint8Array(0));
  assert.equal(c.device.log[0].seq, 1);
});

// ---- web-only ----

test("virtual clock sleeps without real waiting", async () => {
  const clock = new VirtualClock();
  const t = Date.now();
  await clock.sleep(600_000);
  assert.equal(clock.now(), 600_000);
  assert.ok(Date.now() - t < 100);
});

test("sim busy port rejects open", async () => {
  const clock = new VirtualClock();
  const c = new SimConnector(clock, "/dev/sim0", 0x1234, 0x5678, { busyOpens: 1 });
  const [port] = await c.list();
  await assert.rejects(c.open(port), PortBusyError);
  await c.open(port);
});

test("session log records learned seq echo and FIND_DEVICE reply", async () => {
  const clock = new VirtualClock();
  const c = new SimConnector(clock, "/dev/sim0", 0x1234, 0x5678);
  const [port] = await c.list();
  const lines = [];
  const s = new Session(await c.open(port), clock, { log: (m) => lines.push(m) });
  await s.findDevice();
  assert.ok(lines.some((l) => l.includes("echoes seq: true")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("FIND_DEVICE reply") && l.includes("ascent_lite_plus")), lines.join("\n"));
});

test("throwing log does not break a request", async () => {
  const clock = new VirtualClock();
  const c = new SimConnector(clock, "/dev/sim0", 0x1234, 0x5678);
  const [port] = await c.list();
  const s = new Session(await c.open(port), clock, { log: () => { throw new Error("log broke"); } });
  const info = await s.findDevice();
  assert.equal(info.deviceName, "ascent_lite_plus");
});
