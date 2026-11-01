import { test } from "node:test";
import assert from "node:assert/strict";
import { rebootPayload, statusMessage } from "../lib/protocol.js";
import { VirtualClock } from "../lib/clock.js";
import { reopenDelayMs, modelFor } from "../lib/models.js";
import { fileVersion } from "../lib/firmware.js";
import { md5Hex } from "../lib/md5.js";
import { SimConnector } from "../lib/sim.js";
import {
  runUpgrade, upgradeOptions, CancelToken, UpgradeError, progressText, Phase,
} from "../lib/upgrade.js";

const PATH = "/dev/cu.usbmodem1101";
const VID = 0x1D76;
const PID = 0x0101;
const FW_NAME = "Ascent_Lite_Plus_1_3_0.img";

function firmware(len, name = FW_NAME) {
  const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 7 + 3) & 0xff);
  return { name, bytes, md5Hex: md5Hex(bytes), version: null };
}

/** Firmware whose file name carries version 1.3.0 (the sim device is 1.2.3). */
function firmwareV130(len) {
  const fw = firmware(len);
  fw.version = fileVersion(FW_NAME);
  assert.ok(fw.version);
  return fw;
}

const progress = (percent) => ({ percent, status: 2, detail: "OK" });

/**
 * Run an upgrade against a fresh sim. `expected` defaults to the device's own
 * firmware string and `model` to the device's model (as the page would pass).
 */
async function run(devOpts, fw, { hook = () => {}, options, expected, model } = {}) {
  const clock = new VirtualClock();
  const conn = new SimConnector(clock, PATH, VID, PID, devOpts);
  const [port] = await conn.list();
  const cancel = new CancelToken();
  const events = [];
  const logLines = [];
  const startedAt = Date.now();
  let result = null;
  let error = null;
  try {
    result = await runUpgrade({
      connector: conn,
      port,
      firmware: fw,
      expected: expected ?? conn.device.info.firmware,
      model: model !== undefined ? model : modelFor(conn.device.info.deviceName),
      cancel,
      onProgress: (p) => {
        hook(p, cancel, conn, clock);
        events.push(p);
      },
      clock,
      options,
      log: (m) => logLines.push(m),
    });
  } catch (e) {
    error = e;
  }
  return { conn, clock, result, error, events, logLines, realMs: Date.now() - startedAt };
}

const commands = (r) => r.conn.device.log.map((h) => h.command);

const rebootPayloads = (r) =>
  r.conn.device.receivedRequests.filter((x) => x.header.command === 3).map((x) => x.payload);

const startsWith = (p, s) => new TextDecoder().decode(p).startsWith(s);
const hasNormal = (r) => rebootPayloads(r).some((p) => startsWith(p, "normal"));

function strField(b, off, len) {
  const f = b.subarray(off, off + len);
  const end = f.indexOf(0);
  return new TextDecoder().decode(end < 0 ? f : f.subarray(0, end));
}

function expectError(r, kind) {
  assert.ok(r.error instanceof UpgradeError, `expected UpgradeError ${kind}, got ${r.error ?? JSON.stringify(r.result)}`);
  assert.equal(r.error.kind, kind, r.error.message);
  return r.error;
}

function expectOk(r) {
  assert.equal(r.error, null, String(r.error?.stack ?? r.error));
  return r.result;
}

function onlyCleanReboots(r) {
  const clean = rebootPayload("clean");
  for (const p of rebootPayloads(r)) assert.deepEqual(p, clean, "unexpected reboot after lock");
}

// ---- tests/upgrade.rs ----

test("reopenDelaysByVid", () => {
  assert.equal(reopenDelayMs(0x1D76), 11_500);
  assert.equal(reopenDelayMs(0x1D6C), 8_000);
  assert.equal(reopenDelayMs(0x1D78), 12_000);
  assert.equal(reopenDelayMs(0x1D75), 9_500);
  assert.equal(reopenDelayMs(0x1D7A), 10_000);
  assert.equal(reopenDelayMs(0x1D80), 8_000);
  assert.equal(reopenDelayMs(0x1D83), 9_500);
  assert.equal(reopenDelayMs(0x05AC), 8_000);
  const port = { id: PATH, vid: 0x1D76, pid: PID };
  const o = upgradeOptions(port, modelFor("ascent_lite_plus"));
  assert.equal(o.reopenDelayMs, 11_500);
  const d = upgradeOptions();
  assert.equal(d.reopenDelayMs, 8000);
  assert.equal(d.resendMs, 2000);
  assert.equal(d.giveUpMs, 8000);
  assert.equal(d.reconnectTimeoutMs, 200_000);
  assert.equal(d.reconnectRetryMs, 1000);
  assert.equal(d.statusPollMs, 1000);
  // Web: the poll budget is a backstop behind the writing limit (see report).
  assert.equal(d.maxStatusPolls, 600);
  assert.equal(d.writingTimeoutMs, 300_000);
  assert.equal(o.reconnectTimeoutMs, d.reconnectTimeoutMs);
  const vrx = upgradeOptions(port, modelFor("ascent_vrx_pro"));
  assert.equal(vrx.writingTimeoutMs, 600_000);
  assert.equal(vrx.maxStatusPolls, 1200);
});

test("happyPathSequence", async () => {
  const fw = firmware(10_000);
  const r = await run(
    { info: { receiveMaxSize: 4096 }, statusScript: [progress(30), { percent: 100, status: 3, detail: "OK" }] },
    fw,
  );
  const outcome = expectOk(r);
  assert.equal(outcome.port.id, PATH);
  assert.equal(outcome.info.deviceName, "ascent_lite_plus");
  assert.equal(outcome.firmware, "Ascent_Lite_Plus_1_2_3");

  assert.deepEqual(commands(r), [60, 3, 60, 114, 115, 116, 116, 116, 117, 118, 118, 60]);
  const reboots = rebootPayloads(r);
  assert.equal(reboots.length, 1);
  assert.deepEqual(reboots[0], rebootPayload("clean"));

  const d = r.conn.device;
  assert.deepEqual(d.receivedFile, fw.bytes);
  const info = d.receivedRequests.find((x) => x.header.command === 115).payload;
  assert.equal(strField(info, 0, 64), fw.md5Hex);
  assert.equal(strField(info, 72, 128), "/tmp/pc/Ascent_Lite_Plus_1_3_0.img");
  // Web: only the file name is known (no local path).
  assert.equal(strField(info, 200, 128), "Ascent_Lite_Plus_1_3_0.img");

  const lastSent = r.events.findLastIndex((e) => e.type === "sent");
  const locked = r.events.findIndex((e) => e.type === "cancelLocked");
  const firstWriting = r.events.findIndex((e) => e.type === "writing");
  assert.ok(locked >= 0, "cancelLocked emitted");
  assert.ok(lastSent < locked && locked < firstWriting);
  assert.deepEqual(r.events[lastSent], { type: "sent", bytes: 10_000, total: 10_000 });
  assert.ok(r.events.some((e) => e.type === "writing" && e.percent === 100));
  assert.ok(r.logLines.length > 0, "log callback used");
});

test("portMovesAfterReboot", async () => {
  const r = await run({ rebootMovesTo: "/dev/cu.usbmodem1201" }, firmware(10_000));
  assert.equal(expectOk(r).port.id, "/dev/cu.usbmodem1201");
});

test("deviceErrorStatus", async () => {
  const r = await run(
    { statusScript: [progress(10), { percent: 0, status: -5, detail: "WRONG" }] },
    firmware(10_000),
  );
  const e = expectError(r, "failed");
  assert.equal(e.recovered, true);
  assert.equal(e.cause.kind, "device");
  assert.equal(e.cause.code, -5);
  assert.equal(e.cause.message, `device reported error -5: ${statusMessage(-5)}`);
  assert.equal(e.hint, null);
  assert.ok(hasNormal(r), "REBOOT normal sent");
});

test("cancelBeforeEndRecovers", async () => {
  const r = await run({}, firmware(10_000), {
    hook: (p, c) => { if (p.type === "sent") c.cancel(); },
  });
  const e = expectError(r, "cancelled");
  assert.equal(e.recovered, true);
  const cmds = commands(r);
  assert.ok(!cmds.includes(117), `${cmds}`);
  assert.equal(cmds.filter((c) => c === 116).length, 1, `${cmds}`);
  assert.ok(hasNormal(r));
});

test("cancelBeforeCleanRebootIsUnchanged", async () => {
  const r = await run({}, firmware(10_000), { hook: (_, c) => c.cancel() });
  const e = expectError(r, "cancelledUnchanged");
  assert.equal(e.hint, null);
  assert.deepEqual(rebootPayloads(r), []);
});

test("cancelLockedIsEmittedBefore117Request", async () => {
  let endsAtLock = null;
  const r = await run({}, firmware(10_000), {
    hook: (p, _c, conn) => {
      if (p.type === "cancelLocked") endsAtLock = conn.device.log.filter((h) => h.command === 117).length;
    },
  });
  expectOk(r);
  assert.equal(endsAtLock, 0);
});

test("cancelAfterEndIgnored", async () => {
  const r = await run({}, firmware(10_000), {
    hook: (p, c) => { if (p.type === "cancelLocked") c.cancel(); },
  });
  expectOk(r);
  assert.ok(!hasNormal(r));
});

// Review Focus 3: USB pulled mid-transfer.
test("unplugMidTransfer", async () => {
  const r = await run({ unplugAfterDataChunks: 1 }, firmware(10_000));
  assert.ok(r.realMs <= 2000, `${r.realMs} ms real time`);
  const e = expectError(r, "failed");
  assert.equal(e.recovered, false);
  assert.ok(e.hint);
  assert.equal(e.cause.kind, "session");
  assert.equal(e.cause.sessionKind, "io");
  // Before the lock: a recovery reconnect was attempted (no reboot could be
  // sent to a unit that never came back) and gave up after 200 s.
  assert.ok(!r.conn.device.log.some((h) => h.command === 117));
  assert.ok(r.clock.now() >= 200_000 && r.clock.now() < 230_000, `${r.clock.now()}`);
});

test("chunkSizeClamped", async () => {
  let fw = firmware(10_000);
  let r = await run({ info: { receiveMaxSize: 0 } }, fw);
  expectOk(r);
  assert.equal(commands(r).filter((c) => c === 116).length, 1);
  assert.deepEqual(r.conn.device.receivedFile, fw.bytes);

  fw = firmware(1_048_576 + 10);
  r = await run({ info: { receiveMaxSize: 50_000_000 } }, fw);
  expectOk(r);
  const chunks = r.conn.device.receivedRequests.filter((x) => x.header.command === 116).map((x) => x.payload.length);
  assert.deepEqual(chunks, [1_048_576, 10]);
  assert.deepEqual(r.conn.device.receivedFile, fw.bytes);
});

test("transferRejected", async () => {
  const r = await run({ endDetail: "BAD" }, firmware(10_000));
  const e = expectError(r, "failed");
  assert.equal(e.cause.kind, "transferRejected");
  assert.equal(e.cause.detail, "BAD");
  assert.equal(e.cause.message, "device rejected the transfer: BAD");
});

test("pollTimeoutAfterLockReconnectsWithoutReboot", async () => {
  const r = await run({ ignoreUntilFindDevice: 118 }, firmware(10_000));
  expectOk(r);
  onlyCleanReboots(r);
  const cmds = commands(r);
  // initial, after clean reboot, the poll reconnect, final verify
  assert.equal(cmds.filter((c) => c === 60).length, 4, `${cmds}`);
  const end = cmds.indexOf(117);
  assert.ok(cmds.slice(end).includes(60), `${cmds}`);
});

test("lost117ReplyKeepsPolling", async () => {
  const r = await run({ ignoreUntilFindDevice: 117 }, firmware(10_000));
  if (r.error) {
    const e = expectError(r, "failed");
    assert.equal(e.recovered, false);
  }
  onlyCleanReboots(r);
  assert.ok(commands(r).includes(118));
});

test("pollBudgetExhaustedAfterLockNoReboot", async () => {
  const r = await run(
    { statusScript: Array.from({ length: 50 }, () => progress(10)) },
    firmware(10_000),
    { options: { maxStatusPolls: 5 } },
  );
  const e = expectError(r, "failed");
  assert.equal(e.recovered, false);
  assert.equal(e.cause.kind, "statusPollLimit");
  assert.ok(e.hint);
  onlyCleanReboots(r);
  assert.equal(commands(r).filter((c) => c === 118).length, 5);
});

test("finalReconnectFailureSkipsRecovery", async () => {
  // Back only after the final reconnect (11.5 s + 200 s) has given up, but
  // within the window a (wrong) recovery reconnect would still be searching.
  const r = await run({ selfRebootOfflineForMs: 300_000 }, firmware(10_000));
  const e = expectError(r, "failed");
  assert.equal(e.recovered, false);
  assert.equal(e.cause.kind, "reconnect");
  onlyCleanReboots(r);
});

test("recoveryRequiresLinkDrop", async () => {
  const r = await run({ ignoredRebootModes: ["normal"] }, firmware(10_000), {
    hook: (p, c) => { if (p.type === "sent") c.cancel(); },
  });
  const e = expectError(r, "cancelled");
  assert.equal(e.recovered, false);
  assert.ok(e.hint);
  // REBOOT normal was sent (and ignored by the device).
  assert.ok(hasNormal(r));
});

test("deviceChangedBeforeCleanRebootSendsNothing", async () => {
  const fw = firmware(10_000);
  let r = await run({}, fw, { expected: "Ascent_Lite_Plus_1_2_2" });
  const e = expectError(r, "deviceChanged");
  assert.equal(e.message, "the connected device changed since you confirmed — nothing was written");
  assert.equal(e.hint, null);
  assert.deepEqual(commands(r), [60]);

  // A different device name (model) is refused the same way.
  r = await run({}, fw, { model: modelFor("ascent_lite") });
  expectError(r, "deviceChanged");
  assert.deepEqual(commands(r), [60]);

  // So is a device that is not flashable, even if it matches `expected`.
  r = await run({ info: { deviceName: "ascent_vrx" } }, fw);
  expectError(r, "deviceChanged");
  assert.deepEqual(commands(r), [60]);
});

test("selfRebootMissedCountsAsSuccessWhenVersionChanged", async () => {
  const r = await run(
    { statusScript: [progress(40)], silentSelfRebootAtPoll: 2, firmwareAfterSelfReboot: "Ascent_Lite_Plus_1_3_0" },
    firmwareV130(10_000),
  );
  const outcome = expectOk(r);
  assert.equal(outcome.info.firmware, "Ascent_Lite_Plus_1_3_0");
  assert.equal(outcome.firmware, "Ascent_Lite_Plus_1_3_0");
  onlyCleanReboots(r);
  const cmds = commands(r);
  // The 100 % status was never seen: two polls, then the reconnect's 60.
  assert.deepEqual(cmds.slice(-3), [118, 118, 60], `${cmds}`);
});

test("missedSelfRebootSameVersionIsOutcomeUnknown", async () => {
  // Poll 1: 40 %. Poll 2: no reply, self-reboot (same version). The one
  // status request after the reconnect gets a non-progress answer.
  const r = await run(
    { statusScript: [progress(40), { percent: 0, status: -7, detail: "" }], silentSelfRebootAtPoll: 2 },
    firmwareV130(10_000),
  );
  const e = expectError(r, "outcomeUnknown");
  assert.equal(e.firmware, "Ascent_Lite_Plus_1_2_3");
  assert.equal(e.message, "flash result unknown — the device now reports Ascent_Lite_Plus_1_2_3");
  assert.equal(e.hint, "Check the version with `ascent-flash info` (or reopen the app). If it isn't the new version, flash again.");
  onlyCleanReboots(r);
  const cmds = commands(r);
  assert.deepEqual(cmds.slice(-4), [118, 118, 60, 118], `${cmds}`);
});

test("outcomeUnknownWhenStatusAfterReconnectIsSilent", async () => {
  const r = await run(
    { statusScript: [progress(40)], silentSelfRebootAtPoll: 2, statusSilentAfterSelfReboot: true },
    firmwareV130(10_000),
  );
  const e = expectError(r, "outcomeUnknown");
  assert.equal(e.firmware, "Ascent_Lite_Plus_1_2_3");
  onlyCleanReboots(r);
  const cmds = commands(r);
  // After the reconnect: one status request (plus its same-seq resends),
  // nothing else.
  const lastFind = cmds.lastIndexOf(60);
  assert.equal(cmds[lastFind - 1], 118, `${cmds}`);
  const tail = cmds.slice(lastFind + 1);
  assert.ok(tail.length > 0 && tail.every((c) => c === 118), `${cmds}`);
});

test("unknownFileVersionIsNeverSuccessByVersionAlone", async () => {
  // File version unknown: the reconnect can't prove success, so one status
  // request decides (here the sim's default 100 %), then the normal verify.
  const r = await run(
    { statusScript: [progress(40)], silentSelfRebootAtPoll: 2, firmwareAfterSelfReboot: "Ascent_Lite_Plus_1_3_0" },
    firmware(10_000),
  );
  expectOk(r);
  const cmds = commands(r);
  assert.deepEqual(cmds.slice(-5), [118, 118, 60, 118, 60], `${cmds}`);
  onlyCleanReboots(r);
});

test("writingTimeoutReturnsOutcomeUnknown", async () => {
  let lockedAt = null;
  const r = await run(
    { statusScript: Array.from({ length: 10_000 }, () => progress(10)) },
    firmwareV130(10_000),
    {
      options: { maxStatusPolls: 100_000 },
      hook: (p, _c, _conn, clock) => { if (p.type === "cancelLocked") lockedAt = clock.now(); },
    },
  );
  assert.ok(r.realMs < 2000, `${r.realMs} ms real time`);
  const e = expectError(r, "outcomeUnknown");
  assert.equal(e.firmware, "Ascent_Lite_Plus_1_2_3");
  assert.ok(e.hint);
  const writing = r.clock.now() - lockedAt;
  assert.ok(writing >= 300_000 && writing < 302_000, `${writing}`);
  onlyCleanReboots(r);
});

test("ioFailureReconnectsBeforeRecoveryReboot", async () => {
  // The link breaks after the first chunk; the device stays online.
  const r = await run({ breakLinkAfterDataChunks: 1 }, firmware(10_000));
  const e = expectError(r, "failed");
  assert.equal(e.recovered, true);
  assert.equal(e.cause.kind, "session");
  assert.equal(e.cause.sessionKind, "io");
  const cmds = commands(r);
  const normal = cmds.lastIndexOf(3);
  // A fresh FIND_DEVICE (reconnect) right before REBOOT normal.
  assert.equal(cmds[normal - 1], 60, `${cmds}`);
  assert.ok(hasNormal(r));
});

// ---- web-only ----

test("VRX Pro uses a 600 s writing limit", async () => {
  let lockedAt = null;
  const r = await run(
    {
      info: { deviceName: "ascent_vrx_pro", firmware: "Ascent_VRX_Pro_1_0_0" },
      statusScript: Array.from({ length: 5_000 }, () => progress(50)),
    },
    firmware(10_000, "Ascent_VRX_Pro_1_1_0.img"),
    { hook: (p, _c, _conn, clock) => { if (p.type === "cancelLocked") lockedAt = clock.now(); } },
  );
  const e = expectError(r, "outcomeUnknown");
  assert.equal(e.firmware, "Ascent_VRX_Pro_1_0_0");
  const writing = r.clock.now() - lockedAt;
  assert.ok(writing >= 600_000 && writing < 602_000, `${writing}`);
  onlyCleanReboots(r);
  assert.ok(r.realMs < 3000, `${r.realMs} ms real time`);
});

test("progress text matches the app", () => {
  assert.equal(progressText({ type: "sent", bytes: 45, total: 100 }), "Sending firmware… 45%");
  assert.equal(progressText({ type: "sent", bytes: 0, total: 0 }), "Sending firmware… 100%");
  assert.equal(progressText({ type: "sent", bytes: 999, total: 1000 }), "Sending firmware… 99%");
  assert.equal(progressText({ type: "writing", percent: 30 }), "Device is writing firmware… 30%");
  assert.equal(progressText({ type: "cancelLocked" }), "Device is writing firmware — do not unplug");
  const phases = {
    [Phase.rebooting]: "Rebooting into upgrade mode…",
    [Phase.reconnecting]: "Reconnecting…",
    [Phase.enteringUpgrade]: "Entering upgrade mode…",
    [Phase.startingTransfer]: "Starting transfer…",
    [Phase.sending]: "Sending firmware… 0%",
    [Phase.finishing]: "Finishing transfer…",
    [Phase.writing]: "Device is writing firmware… 0%",
    [Phase.restarting]: "Restarting…",
    [Phase.verifying]: "Verifying…",
  };
  assert.equal(Object.keys(phases).length, 9);
  for (const [phase, text] of Object.entries(phases)) {
    assert.equal(progressText({ type: "phase", phase }), text);
  }
});

test("error messages and hints match the app", () => {
  const cancelled = new UpgradeError("cancelled", { recovered: true });
  assert.equal(cancelled.message, "upgrade cancelled (device was rebooted to normal mode and reconnected)");
  assert.equal(cancelled.hint, null);
  const stuck = new UpgradeError("cancelled", { recovered: false });
  assert.equal(stuck.message, "upgrade cancelled");
  assert.equal(stuck.hint, "Power-cycle the VTX (unplug USB and battery). If it doesn't return to normal, recover it with the Caddx Windows tool.");
  assert.equal(new UpgradeError("cancelledUnchanged").message, "upgrade cancelled (device unchanged)");
  assert.equal(new UpgradeError("reconnect").message, "could not reconnect to the device");
  assert.equal(new UpgradeError("statusPollLimit").message, "device did not finish writing the firmware in time");
  assert.equal(new UpgradeError("fileTooLarge", { size: 5 }).message, "firmware file is too large (5 bytes)");
  const failed = new UpgradeError("failed", { cause: new UpgradeError("reconnect"), recovered: false });
  assert.equal(failed.message, "could not reconnect to the device");
  assert.ok(failed.hint);
});
