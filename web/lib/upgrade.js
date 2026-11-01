// Firmware upgrade state machine with cancel and recovery (port of
// crates/ascent-proto/src/upgrade.rs; reconnect/sameDevice from discovery.rs).
//
// Safety rules (same as the Rust module doc):
// - REBOOT is never acked: it is sent with sendNoAck and the old link is
//   closed before reconnecting.
// - Cancel is honoured before every command until the decision to send
//   SENDFILE_END (117); after that it is ignored ({type: "cancelLocked"}).
// - Once REBOOT "clean" has been sent, a cancel or failure sends REBOOT
//   "normal" and tries to reconnect ("recovery"). After SENDFILE_END has been
//   sent, recovery happens only on a device-reported failure (negative status
//   or rejected transfer); transport errors reconnect without any reboot and
//   keep polling, and other failures end with `recovered: false`.
// - `recovered: true` means the REBOOT "normal" was seen to take effect: the
//   device's port went away (the old link errored, or the port was no longer
//   listed) and it then came back and answered FIND_DEVICE.
// - The whole post-lock phase (SENDFILE_END, status polls and reconnects) is
//   bounded by the model's writing limit. When its result can't be told, the
//   run ends with kind "outcomeUnknown", never a reboot.
// - The device must still be the one the user confirmed ("deviceChanged");
//   this is checked before anything beyond FIND_DEVICE is sent.
// - Reconnects only ever use connector.list(): the user is never asked to
//   re-pick a port mid-flash.
import { CMD, fileInfo, rebootPayload, statusMessage, decodeFileDataInfo, decodeUpgradeStatus } from "./protocol.js";
import { modelFor, reopenDelayMs } from "./models.js";
import { REMOTE_DIR, compareVersions, deviceVersion } from "./firmware.js";
import { Session, SessionTimeoutError, PayloadError } from "./session.js";
import { LinkGoneError, isLinkError } from "./link.js";
import { realClock } from "./clock.js";

/** Largest SENDFILE_DATA chunk we will send, whatever the device reports. */
export const MAX_CHUNK = 1_048_576;

const RECOVERY_HINT = "Power-cycle the VTX (unplug USB and battery). If it doesn't return to normal, recover it with the Caddx Windows tool.";
const OUTCOME_UNKNOWN_HINT = "Check the version with `ascent-flash info` (or reopen the app). If it isn't the new version, flash again.";
const EMPTY = new Uint8Array(0);

export const Phase = Object.freeze({
  rebooting: "rebooting",
  reconnecting: "reconnecting",
  enteringUpgrade: "enteringUpgrade",
  startingTransfer: "startingTransfer",
  sending: "sending",
  finishing: "finishing",
  writing: "writing",
  restarting: "restarting",
  verifying: "verifying",
});

const PHASE_TEXT = {
  rebooting: "Rebooting into upgrade mode…",
  reconnecting: "Reconnecting…",
  enteringUpgrade: "Entering upgrade mode…",
  startingTransfer: "Starting transfer…",
  sending: "Sending firmware… 0%",
  finishing: "Finishing transfer…",
  writing: "Device is writing firmware… 0%",
  restarting: "Restarting…",
  verifying: "Verifying…",
};

/**
 * Plain-words text for a progress event: {type: "phase", phase},
 * {type: "sent", bytes, total}, {type: "writing", percent}, {type: "cancelLocked"}.
 */
export function progressText(p) {
  switch (p.type) {
    case "phase":
      return PHASE_TEXT[p.phase];
    case "sent":
      return `Sending firmware… ${p.total === 0 ? 100 : Math.floor((p.bytes * 100) / p.total)}%`;
    case "writing":
      return `Device is writing firmware… ${p.percent}%`;
    case "cancelLocked":
      return "Device is writing firmware — do not unplug";
    default:
      return String(p.type);
  }
}

export class CancelToken {
  #cancelled = false;
  cancel() {
    this.#cancelled = true;
  }
  get cancelled() {
    return this.#cancelled;
  }
}

const recoveryNote = (recovered) => (recovered ? " (device was rebooted to normal mode and reconnected)" : "");

function errorMessage(kind, f) {
  switch (kind) {
    case "session":
      return f.sessionKind === "io" ? `I/O error: ${f.cause.message}` : f.cause.message;
    case "device":
      return `device reported error ${f.code}: ${statusMessage(f.code)}`;
    case "transferRejected":
      return `device rejected the transfer: ${f.detail}`;
    case "cancelled":
      return `upgrade cancelled${recoveryNote(f.recovered)}`;
    case "cancelledUnchanged":
      return "upgrade cancelled (device unchanged)";
    case "reconnect":
      return "could not reconnect to the device";
    case "statusPollLimit":
      return "device did not finish writing the firmware in time";
    case "deviceChanged":
      return "the connected device changed since you confirmed — nothing was written";
    case "outcomeUnknown":
      return `flash result unknown — the device now reports ${f.firmware}`;
    case "fileTooLarge":
      return `firmware file is too large (${f.size} bytes)`;
    case "failed":
      return `${f.cause.message}${recoveryNote(f.recovered)}`;
    default:
      return kind;
  }
}

/**
 * kinds: session {cause, sessionKind: "io"|"timeout"|"payload"}, device {code},
 * transferRejected {detail}, cancelled {recovered}, cancelledUnchanged,
 * reconnect, statusPollLimit, deviceChanged, outcomeUnknown {firmware},
 * fileTooLarge {size}, failed {cause: UpgradeError, recovered}.
 */
export class UpgradeError extends Error {
  constructor(kind, fields = {}) {
    super(errorMessage(kind, fields), fields.cause ? { cause: fields.cause } : undefined);
    this.name = "UpgradeError";
    this.kind = kind;
    Object.assign(this, fields);
  }

  /** What the user should do when recovery did not bring the device back. */
  get hint() {
    if ((this.kind === "cancelled" || this.kind === "failed") && !this.recovered) return RECOVERY_HINT;
    if (this.kind === "outcomeUnknown") return OUTCOME_UNKNOWN_HINT;
    return null;
  }
}

function sessionKind(e) {
  if (isLinkError(e)) return "io";
  if (e instanceof SessionTimeoutError) return "timeout";
  if (e instanceof PayloadError) return "payload";
  return null;
}

/** A Session timeout or I/O error (the cases that reconnect after the lock). */
const isTransport = (e) => {
  const k = sessionKind(e);
  return k === "io" || k === "timeout";
};

/** Protocol errors become UpgradeErrors; anything else (a bug) is rethrown as is. */
function toUpgradeError(e) {
  if (e instanceof UpgradeError) return e;
  const k = sessionKind(e);
  if (k) return new UpgradeError("session", { cause: e, sessionKind: k });
  throw e;
}

/**
 * Defaults for a port and model (Rust UpgradeOptions::default/for_port, with
 * the writing limit from the model). The poll budget is derived from the
 * writing limit so that the limit, not the budget, ends a stuck write.
 */
export function upgradeOptions(port, model, overrides = {}) {
  const o = {
    resendMs: 2000,
    giveUpMs: 8000,
    reopenDelayMs: reopenDelayMs(port?.vid),
    reconnectTimeoutMs: 200_000,
    reconnectRetryMs: 1000,
    statusPollMs: 1000,
    writingTimeoutMs: model?.writingTimeoutMs ?? 300_000,
    ...overrides,
  };
  o.maxStatusPolls = overrides.maxStatusPolls ?? 2 * Math.ceil(o.writingTimeoutMs / o.statusPollMs);
  return o;
}

/** Same VID/PID, and the same serial when both report one (discovery.rs). */
export function sameDevice(p, like) {
  return p.vid === like.vid && p.pid === like.pid && (p.serial == null || like.serial == null || p.serial === like.serial);
}

/**
 * Wait `delayMs`, then repeatedly look for a port matching `like` (its id may
 * have changed), open it and FIND_DEVICE, until it answers or `timeoutMs` has
 * passed (measured after the delay). Only connector.list() is used.
 */
export async function reconnect({ connector, like, delayMs, timeoutMs, retryMs, clock, sessionOpts = {}, log = () => {} }) {
  log(`reconnecting (delay ${delayMs} ms, timeout ${timeoutMs} ms)`);
  await clock.sleep(delayMs);
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    let ports = [];
    try {
      ports = await connector.list();
    } catch (e) {
      log(`port enumeration failed: ${e?.message ?? e}`);
    }
    for (const port of ports.filter((p) => sameDevice(p, like))) {
      let link;
      try {
        link = await connector.open(port);
      } catch (e) {
        log(`reconnect open failed on ${port.id}: ${e?.message ?? e}`);
        continue;
      }
      const session = new Session(link, clock, { ...sessionOpts, log });
      try {
        const info = await session.findDevice();
        log(`reconnected on ${port.id}`);
        return { port, session, info };
      } catch (e) {
        log(`reconnect FIND_DEVICE failed on ${port.id}: ${e?.message ?? e}`);
        await session.close();
      }
    }
    const left = Math.max(0, deadline - clock.now());
    if (left === 0) {
      log("warn: reconnect timed out");
      throw new UpgradeError("reconnect");
    }
    await clock.sleep(Math.min(retryMs, left));
  }
}

/** Chunk size from receiveMaxSize, capped at 1 MiB; <= 0 means "use the cap". */
const chunkSize = (n) => (n <= 0 ? MAX_CHUNK : Math.min(n, MAX_CHUNK));

/** After the lock, only a device-reported failure makes REBOOT "normal" safe. */
const deviceStoppedWriting = (e) => e.kind === "device" || e.kind === "transferRejected";

/** Status 0-3 (VERIFY_IMAGE, START, IN_PROGRESS, DONE) and a sane percent. */
const isProgress = (st) => st.status >= 0 && st.status <= 3 && st.percent >= 0 && st.percent <= 100;

const sameVersion = (a, b) => a != null && b != null && compareVersions(a, b) === 0;

const CANCELLED = Symbol("cancelled");

class Upgrade {
  constructor({ connector, port, firmware, expected, model, cancel, onProgress, clock, opts, log }) {
    Object.assign(this, { connector, port, firmware, expected, model, cancel, onProgress, clock, opts, log });
    this.session = null;
    this.fileVersion = firmware.version ?? null;
    this.preVersion = null; // device version before anything was sent
    this.lastInfo = null; // most recent FIND_DEVICE reply
    this.locked = false; // SENDFILE_END decided: cancel ignored
    this.deadline = null; // end of the post-lock phase
  }

  emit(p) {
    this.onProgress(p);
  }

  phase(phase) {
    this.log(`upgrade phase: ${phase} (port ${this.port.id})`);
    this.emit({ type: "phase", phase });
  }

  checkpoint() {
    if (!this.locked && this.cancel.cancelled) {
      this.log("cancel requested");
      throw CANCELLED;
    }
  }

  sess() {
    if (!this.session) throw new UpgradeError("reconnect");
    return this.session;
  }

  async dropSession() {
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }

  /** Cancel checkpoint, then a request on the current session. */
  async request(cmd, payload) {
    this.checkpoint();
    return this.sess().request(cmd, payload);
  }

  sessionOpts() {
    return { resendMs: this.opts.resendMs, giveUpMs: this.opts.giveUpMs, log: this.log };
  }

  async reconnect(delayMs, timeoutMs = this.opts.reconnectTimeoutMs) {
    await this.dropSession();
    const r = await reconnect({
      connector: this.connector, like: this.port, delayMs, timeoutMs, retryMs: this.opts.reconnectRetryMs,
      clock: this.clock, sessionOpts: this.sessionOpts(), log: this.log,
    });
    this.port = r.port;
    this.session = r.session;
    this.lastInfo = r.info;
    return r.info;
  }

  timeLeft() {
    return this.deadline === null ? Infinity : Math.max(0, this.deadline - this.clock.now());
  }

  outcomeUnknown() {
    const firmware = this.lastInfo?.firmware ?? "unknown";
    this.log(`warn: flash result unknown (device reports ${firmware})`);
    return new UpgradeError("outcomeUnknown", { firmware });
  }

  /** Step 1: open the port and FIND_DEVICE; check it is the confirmed device. */
  async findFirst() {
    this.phase(Phase.rebooting);
    this.checkpoint();
    let link;
    try {
      link = await this.connector.open(this.port);
    } catch (e) {
      throw isLinkError(e) ? e : new LinkGoneError(String(e?.message ?? e), { cause: e });
    }
    this.session = new Session(link, this.clock, this.sessionOpts());
    this.checkpoint();
    const info = await this.session.findDevice();
    this.log(`device found: ${info.deviceName} ${info.firmware}`);
    const found = modelFor(info.deviceName);
    const same = found !== null && this.model != null && found.name === this.model.name && info.firmware === this.expected;
    if (!same) {
      this.log(`warn: device changed since confirmation (found ${info.deviceName} ${info.firmware}, expected ${this.model?.name} ${this.expected})`);
      throw new UpgradeError("deviceChanged");
    }
    this.preVersion = deviceVersion(info.firmware);
    this.lastInfo = info;
    this.checkpoint();
  }

  /** Steps 2-4: REBOOT "clean" (no ack), drop the link, reconnect. */
  async rebootClean() {
    this.log("sending REBOOT clean (no ack)");
    await this.sess().sendNoAck(CMD.REBOOT, rebootPayload("clean"));
    await this.dropSession();
    this.phase(Phase.reconnecting);
    const info = await this.reconnect(this.opts.reopenDelayMs);
    const chunk = chunkSize(info.receiveMaxSize);
    this.log(`device back after clean reboot (receiveMaxSize ${info.receiveMaxSize}, chunk ${chunk})`);
    return chunk;
  }

  /** Step 5: REMOTE_UPGRADE. */
  async enterUpgrade() {
    this.phase(Phase.enteringUpgrade);
    await this.request(CMD.REMOTE_UPGRADE, EMPTY);
  }

  /** Step 6: SENDFILE_START with remote path /tmp/pc/<name>. */
  async startTransfer() {
    this.phase(Phase.startingTransfer);
    const fw = this.firmware;
    const remote = REMOTE_DIR + fw.name;
    this.log(`SENDFILE_START ${remote} md5 ${fw.md5Hex} len ${fw.bytes.length}`);
    // The browser knows only the file name, so it is also the "local path".
    await this.request(CMD.SENDFILE_START, fileInfo(fw.md5Hex, fw.bytes.length, remote, fw.name));
  }

  /** Step 7: SENDFILE_DATA chunks, stop-and-wait. */
  async sendChunks(chunk) {
    this.phase(Phase.sending);
    const bytes = this.firmware.bytes;
    const total = bytes.length;
    let sent = 0;
    for (let off = 0; off < total; off += chunk) {
      const part = bytes.subarray(off, Math.min(off + chunk, total));
      await this.request(CMD.SENDFILE_DATA, part);
      sent += part.length;
      this.emit({ type: "sent", bytes: sent, total });
    }
  }

  /** The file version is known, differs from the pre-flash one, and the device reports it. */
  showsNewVersion(info) {
    if (this.fileVersion === null) return false;
    return !sameVersion(this.preVersion, this.fileVersion) && sameVersion(deviceVersion(info.firmware), this.fileVersion);
  }

  /**
   * After the lock: reconnect WITHOUT any reboot within the writing deadline.
   * Returns {rebooted: info} (already on the new version), "done" (100 %),
   * or null (keep polling); otherwise throws outcomeUnknown. Never reboots.
   */
  async reconnectAfterLock(why) {
    this.log(`warn: transport error after lock (${why.message}); reconnecting without reboot`);
    await this.dropSession();
    const left = this.timeLeft();
    if (left === 0) throw this.outcomeUnknown();
    const delay = Math.min(this.opts.reopenDelayMs, left);
    const timeout = Math.min(this.opts.reconnectTimeoutMs, left - delay);
    let info;
    try {
      info = await this.reconnect(delay, timeout);
    } catch (e) {
      if (this.timeLeft() === 0) throw this.outcomeUnknown();
      throw e;
    }
    this.log(`reconnected after lock: ${info.firmware}`);
    if (this.showsNewVersion(info)) {
      this.log(`device already reports the new version ${info.firmware}`);
      return { rebooted: info };
    }
    let st;
    try {
      const f = await this.sess().request(CMD.UPGRADE_STATUS, EMPTY);
      st = decodeUpgradeStatus(f.payload);
    } catch (e) {
      this.log(`warn: no usable status after reconnect (${e?.message ?? e})`);
      throw this.outcomeUnknown();
    }
    this.log(`upgrade status after reconnect: ${st.percent}% status ${st.status} ${st.detail}`);
    if (!isProgress(st)) throw this.outcomeUnknown();
    this.emit({ type: "writing", percent: st.percent });
    return st.percent >= 100 ? "done" : null;
  }

  /**
   * Step 8: SENDFILE_END; must reply status 0 / "OK". Locks cancel and starts
   * the writing deadline. A lost or garbled reply is not a rejection: we go
   * on polling. Non-null = the writing phase already ended.
   */
  async finish() {
    this.phase(Phase.finishing);
    this.checkpoint();
    this.locked = true;
    this.deadline = this.clock.now() + this.opts.writingTimeoutMs;
    // Announce the lock BEFORE the request: cancel is already ignored.
    this.emit({ type: "cancelLocked" });
    const s = this.sess();
    let frame;
    try {
      frame = await s.request(CMD.SENDFILE_END, EMPTY);
    } catch (e) {
      if (isTransport(e)) return this.reconnectAfterLock(e);
      if (e instanceof PayloadError) {
        this.log(`warn: SENDFILE_END reply unusable (${e.message}); polling status anyway`);
        return null;
      }
      throw e;
    }
    this.log("SENDFILE_END sent; cancel is now locked");
    let reply;
    try {
      reply = decodeFileDataInfo(frame.payload);
    } catch (e) {
      this.log(`warn: SENDFILE_END reply undecodable (${e.message}); polling status anyway`);
      return null;
    }
    if (reply.status !== 0 || reply.detail !== "OK") {
      this.log(`warn: transfer rejected (status ${reply.status}, ${reply.detail})`);
      throw new UpgradeError("transferRejected", { detail: reply.detail });
    }
    return null;
  }

  /** Step 9: poll UPGRADE_STATUS until 100 %; transport errors reconnect (no reboot). */
  async pollStatus() {
    this.phase(Phase.writing);
    for (let n = 1; n <= this.opts.maxStatusPolls; n++) {
      const left = this.timeLeft();
      if (left === 0) {
        this.log(`warn: writing timeout reached at poll ${n}`);
        throw this.outcomeUnknown();
      }
      await this.clock.sleep(Math.min(this.opts.statusPollMs, left));
      const s = this.sess();
      let f;
      try {
        f = await s.request(CMD.UPGRADE_STATUS, EMPTY);
      } catch (e) {
        if (isTransport(e)) {
          const w = await this.reconnectAfterLock(e);
          if (w) return w;
          continue;
        }
        if (e instanceof PayloadError) {
          this.log(`warn: unusable status reply at poll ${n} (${e.message})`);
          continue;
        }
        throw e;
      }
      let st;
      try {
        st = decodeUpgradeStatus(f.payload);
      } catch (e) {
        this.log(`warn: undecodable status reply at poll ${n} (${e.message})`);
        continue;
      }
      this.log(`upgrade status (poll ${n}): ${st.percent}% status ${st.status} ${st.detail}`);
      this.emit({ type: "writing", percent: Math.min(100, Math.max(0, st.percent)) });
      if (st.status < 0) throw new UpgradeError("device", { code: st.status });
      if (st.percent >= 100) return "done";
    }
    throw new UpgradeError("statusPollLimit");
  }

  /** Step 10: the device reboots itself; reconnect and FIND_DEVICE. */
  async verify() {
    this.phase(Phase.restarting);
    await this.dropSession();
    await this.clock.sleep(this.opts.reopenDelayMs);
    this.phase(Phase.verifying);
    const info = await this.reconnect(0);
    this.log(`upgrade complete: ${info.firmware} on ${this.port.id}`);
    return { port: this.port, info };
  }

  /** Everything from REBOOT "clean" onwards (steps 2-10). */
  async afterClean() {
    const chunk = await this.rebootClean();
    await this.enterUpgrade();
    await this.startTransfer();
    await this.sendChunks(chunk);
    const written = (await this.finish()) ?? (await this.pollStatus());
    if (written === "done") return this.verify();
    this.phase(Phase.verifying);
    await this.dropSession();
    this.log(`upgrade complete (self-reboot seen on reconnect): ${written.rebooted.firmware} on ${this.port.id}`);
    return { port: this.port, info: written.rebooted };
  }

  /**
   * After REBOOT "normal": wait up to the reopen delay for the port to go
   * away (no longer listed, or the old link errors; probed with FIND_DEVICE
   * only). False if the old link keeps working (the reboot was ignored).
   */
  async waitForDrop() {
    const deadline = this.clock.now() + this.opts.reopenDelayMs;
    for (;;) {
      try {
        const ports = await this.connector.list();
        if (!ports.some((p) => p.id === this.port.id)) {
          this.log(`recovery: port ${this.port.id} went away`);
          return true;
        }
      } catch (e) {
        this.log(`recovery: port enumeration failed: ${e?.message ?? e}`);
      }
      if (this.session) {
        try {
          await this.session.findDevice();
          this.log("recovery: old link still answers");
        } catch (e) {
          if (isLinkError(e)) {
            this.log(`recovery: old link dropped (${e.message})`);
            return true;
          }
          this.log(`recovery: old link probe failed: ${e?.message ?? e}`);
        }
      }
      const left = Math.max(0, deadline - this.clock.now());
      if (left === 0) return false;
      await this.clock.sleep(Math.min(this.opts.reconnectRetryMs, left));
    }
  }

  /**
   * REBOOT "normal" and reconnect. Returns whether the device was seen to
   * reboot (its port went away) and then came back. `linkBroken`: the
   * failure was an I/O error on the current link, so it is reopened first.
   */
  async recover(linkBroken) {
    this.log("recovery: sending REBOOT normal");
    if (linkBroken && this.session) {
      this.log("recovery: dropping the broken link before REBOOT normal");
      await this.dropSession();
    }
    const normal = rebootPayload("normal");
    let sent = false;
    if (this.session) {
      try {
        await this.session.sendNoAck(CMD.REBOOT, normal);
        sent = true;
      } catch (e) {
        this.log(`recovery: current link unusable (${e?.message ?? e}); reconnecting first`);
      }
    }
    if (!sent) {
      try {
        await this.reconnect(0);
        await this.sess().sendNoAck(CMD.REBOOT, normal);
      } catch (e) {
        this.log(`warn: recovery failed: ${e?.message ?? e}`);
        await this.dropSession();
        return false;
      }
    }
    const sentAt = this.clock.now();
    const dropped = await this.waitForDrop();
    await this.dropSession();
    if (!dropped) {
      this.log("warn: recovery: the device kept its link after REBOOT normal (reboot ignored?)");
      return false;
    }
    const delay = Math.max(0, this.opts.reopenDelayMs - (this.clock.now() - sentAt));
    try {
      const info = await this.reconnect(delay);
      this.log(`recovery: device rebooted and is back (${info.firmware})`);
      await this.dropSession();
      return true;
    } catch (e) {
      this.log(`warn: recovery failed: ${e?.message ?? e}`);
      return false;
    }
  }
}

/**
 * Flash `firmware` ({name, bytes, md5Hex, version}) to the device on `port`.
 * `expected` is the device firmware string the user confirmed and `model`
 * the confirmed model; if the first FIND_DEVICE differs, nothing else is
 * sent ("deviceChanged"). `options` overrides upgradeOptions() (tests).
 * Resolves {firmware, port, info} (the device after the final reconnect).
 */
export async function runUpgrade({
  connector, port, firmware, expected, model, cancel = new CancelToken(), onProgress = () => {},
  clock = realClock, options = {}, log = () => {},
}) {
  log(`starting upgrade on ${port.id} with ${firmware.name}`);
  if (firmware.bytes.length > 0xffffffff) throw new UpgradeError("fileTooLarge", { size: firmware.bytes.length });
  const opts = upgradeOptions(port, model, options);
  const u = new Upgrade({ connector, port, firmware, expected, model, cancel, onProgress, clock, opts, log });
  try {
    // Before REBOOT "clean": nothing has changed, so no recovery.
    try {
      await u.findFirst();
    } catch (e) {
      if (e === CANCELLED) throw new UpgradeError("cancelledUnchanged");
      throw toUpgradeError(e);
    }
    let outcome;
    try {
      outcome = await u.afterClean();
    } catch (err) {
      if (err === CANCELLED) {
        throw new UpgradeError("cancelled", { recovered: await u.recover(false) });
      }
      const e = toUpgradeError(err);
      // Never a reboot: the device may be writing or already done.
      if (e.kind === "outcomeUnknown") throw e;
      if (u.locked && !deviceStoppedWriting(e)) {
        // The device may still be writing flash: never send REBOOT "normal".
        log(`warn: upgrade failed after lock: ${e.message}; no recovery reboot`);
        throw new UpgradeError("failed", { cause: e, recovered: false });
      }
      log(`warn: upgrade failed: ${e.message}`);
      const linkBroken = e.kind === "session" && e.sessionKind === "io";
      throw new UpgradeError("failed", { cause: e, recovered: await u.recover(linkBroken) });
    }
    return { firmware: outcome.info.firmware, port: outcome.port, info: outcome.info };
  } finally {
    await u.dropSession();
  }
}
