// In-memory device simulator (port of crates/ascent-proto/src/sim.rs), for
// tests (VirtualClock) and the page's ?sim demo mode (realClock).
//
// Observability: `log` holds the header of every request received (including
// dropped ones, in order); `receivedRequests` holds {header, payload} for the
// same requests. Offline windows use the clock. A device that goes offline
// (REBOOT, or self-reboot after reporting percent >= 100) breaks every link
// that was open at that time (LinkGoneError once buffered replies are
// drained), even after the device reappears; reopen via the connector.
//
// Knobs (constructor options, same meaning as the Rust fields):
// info (partial DeviceInfo), statusScript, dropFirstRequests, endDetail,
// rebootMovesTo, offlineForMs, unplugAfterDataChunks, ignoreUntilFindDevice,
// selfRebootOfflineForMs, ignoredRebootModes, breakLinkAfterDataChunks,
// silentSelfRebootAtPoll, firmwareAfterSelfReboot, statusSilentAfterSelfReboot;
// web-only: busyOpens (that many opens fail with PortBusyError),
// newPortIdEachReboot (every reboot lists the port under a fresh id, as
// Chrome gives a new SerialPort object each time; `reboots` counts them).
// SimConnector.list() reports no USB serial (Web Serial has none); SimBus
// puts several simulated units behind one connector.
import {
  CMD, HEADER_LEN, encodeAck, FrameReader, encodeDeviceInfo, encodeFileDataInfo, encodeUpgradeStatus,
} from "./protocol.js";
import { LinkGoneError, PortBusyError } from "./link.js";

/** Largest SENDFILE_DATA payload the simulated device accepts. */
const SIM_MAX_CHUNK = 1_048_576;

export const LITE_PLUS_INFO = Object.freeze({
  receiveMaxSize: 4096,
  sdkVersion: "1.0.0",
  deviceName: "ascent_lite_plus",
  cpuTemp: 42,
  firmware: "Ascent_Lite_Plus_1_2_3",
  serialNumber: "SIM0001",
  hardwareVersion: "V1.0",
  status: 0,
  detail: "OK",
});

export class SimDevice {
  constructor(clock, opts = {}) {
    const { info = {}, ...rest } = opts;
    this.clock = clock;
    this.info = { ...LITE_PLUS_INFO, ...info };
    /** Shifted front-first for UPGRADE_STATUS; when empty replies {100, 3, "OK"}. */
    this.statusScript = [];
    this.dropFirstRequests = 0;
    this.endDetail = "OK";
    this.rebootMovesTo = null;
    this.offlineForMs = 3000;
    this.unplugAfterDataChunks = null;
    this.ignoreUntilFindDevice = null;
    this.selfRebootOfflineForMs = null;
    this.ignoredRebootModes = [];
    this.breakLinkAfterDataChunks = null;
    this.silentSelfRebootAtPoll = null;
    this.firmwareAfterSelfReboot = null;
    this.statusSilentAfterSelfReboot = false;
    this.busyOpens = 0;
    this.newPortIdEachReboot = false;
    Object.assign(this, rest);
    this.statusScript = [...this.statusScript];

    this.log = [];
    this.receivedRequests = [];
    this.receivedFile = new Uint8Array(0);
    /** NUL-trimmed mode strings of REBOOT requests. */
    this.rebootModes = [];
    this.path = "";
    this.statusPolls = 0;
    this.selfRebooted = false;
    this.chunksAcked = 0;
    this.ignoredAny = false;
    this.offlineUntil = null;
    this.gone = false;
    this.epoch = 0;
    this.reboots = 0;
    this.basePath = "";
  }

  online() {
    if (this.offlineUntil !== null && this.clock.now() >= this.offlineUntil) this.offlineUntil = null;
    return !this.gone && this.offlineUntil === null;
  }

  goOffline() {
    this.epoch += 1;
    this.offlineUntil = this.clock.now() + this.offlineForMs;
    this.reboots += 1;
    if (this.rebootMovesTo) this.path = this.rebootMovesTo;
    if (this.newPortIdEachReboot) this.path = `${this.basePath}#${this.reboots}`;
  }

  /** The device reboots itself after writing the firmware. */
  selfReboot() {
    this.selfRebooted = true;
    this.goOffline();
    if (this.selfRebootOfflineForMs !== null) this.offlineUntil = this.clock.now() + this.selfRebootOfflineForMs;
    if (this.firmwareAfterSelfReboot) this.info.firmware = this.firmwareAfterSelfReboot;
  }

  /** Process one request; returns reply bytes or null. */
  handle(header, payload) {
    this.log.push(header);
    this.receivedRequests.push({ header, payload });
    if (this.dropFirstRequests > 0) {
      this.dropFirstRequests -= 1;
      return null;
    }
    if (header.command === CMD.FIND_DEVICE && this.ignoredAny) {
      this.ignoreUntilFindDevice = null;
      this.ignoredAny = false;
    } else if (this.ignoreUntilFindDevice === header.command) {
      this.ignoredAny = true;
      return null;
    }
    const ack = (p) => encodeAck(header.command, p, header.seq);
    const fd = (length, cursize, detail) =>
      encodeFileDataInfo({ length, cursize, totalsize: 0, status: 0, detail });
    switch (header.command) {
      case CMD.REBOOT: {
        const end = payload.indexOf(0);
        const mode = new TextDecoder().decode(end < 0 ? payload : payload.subarray(0, end));
        const ignored = this.ignoredRebootModes.includes(mode);
        this.rebootModes.push(mode);
        if (!ignored) this.goOffline();
        return null;
      }
      case CMD.FIND_DEVICE:
        return ack(encodeDeviceInfo(this.info));
      case CMD.REMOTE_UPGRADE:
        return ack(new Uint8Array(0));
      case CMD.SENDFILE_START:
        this.receivedFile = new Uint8Array(0);
        return ack(new Uint8Array(0));
      case CMD.SENDFILE_DATA: {
        const f = new Uint8Array(this.receivedFile.length + payload.length);
        f.set(this.receivedFile);
        f.set(payload, this.receivedFile.length);
        this.receivedFile = f;
        const reply = ack(fd(payload.length, f.length, "OK"));
        this.chunksAcked += 1;
        if (this.unplugAfterDataChunks !== null && this.chunksAcked >= this.unplugAfterDataChunks) {
          this.gone = true;
          this.epoch += 1;
        }
        if (this.breakLinkAfterDataChunks === this.chunksAcked) this.epoch += 1;
        return reply;
      }
      case CMD.SENDFILE_END:
        return ack(fd(0, 0, this.endDetail));
      case CMD.UPGRADE_STATUS: {
        if (this.selfRebooted && this.statusSilentAfterSelfReboot) return null;
        this.statusPolls += 1;
        if (this.silentSelfRebootAtPoll === this.statusPolls) {
          this.selfReboot();
          return null;
        }
        const st = this.statusScript.length ? this.statusScript.shift() : { percent: 100, status: 3, detail: "OK" };
        const reply = ack(encodeUpgradeStatus(st));
        if (st.percent >= 100) this.selfReboot();
        return reply;
      }
      default:
        return null; // unknown command ignored
    }
  }
}

export class SimConnector {
  /** @param devOpts a SimDevice, or options for a new one */
  constructor(clock, id, vid, pid, devOpts = {}) {
    this.device = devOpts instanceof SimDevice ? devOpts : new SimDevice(clock, devOpts);
    this.device.path = id;
    this.device.basePath = id;
    this.clock = clock;
    this.vid = vid;
    this.pid = pid;
  }

  async list() {
    const d = this.device;
    if (!d.online()) return [];
    // No `serial`: Web Serial doesn't report the USB serial number.
    return [{ id: d.path, vid: this.vid, pid: this.pid }];
  }

  async open(port) {
    const d = this.device;
    if (!d.online() || d.path !== port.id) throw new LinkGoneError("no such port");
    if (d.busyOpens > 0) {
      d.busyOpens -= 1;
      throw new PortBusyError("The VTX is in use by another app or tab — close it and try again");
    }
    return new SimLink(d, this.clock);
  }
}

/** Several simulated units behind one connector (e.g. two identical VTXs). */
export class SimBus {
  constructor(...connectors) {
    this.connectors = connectors;
  }

  /** Plug in another unit. */
  add(connector) {
    this.connectors.push(connector);
  }

  async list() {
    const out = [];
    for (const c of this.connectors) out.push(...(await c.list()));
    return out;
  }

  async open(port) {
    const c = this.connectors.find((x) => x.device.path === port.id);
    if (!c) throw new LinkGoneError("no such port");
    return c.open(port);
  }
}

class SimLink {
  constructor(device, clock) {
    this.device = device;
    this.clock = clock;
    this.epoch = device.epoch;
    // Device side: accepts chunks up to the 1 MiB protocol cap.
    this.reader = new FrameReader(() => {}, HEADER_LEN + SIM_MAX_CHUNK);
    this.rx = [];
    this.closed = false;
  }

  alive() {
    return !this.closed && this.device.online() && this.device.epoch === this.epoch;
  }

  async write(bytes) {
    if (!this.alive()) throw new LinkGoneError();
    this.reader.push(bytes);
    for (let f; (f = this.reader.next());) {
      const reply = this.device.handle(f.header, f.payload);
      if (reply) this.rx.push(reply);
    }
  }

  async read(timeoutMs) {
    if (this.rx.length === 0) {
      // Always let time pass, so a polling caller cannot spin forever.
      await this.clock.sleep(timeoutMs);
      if (this.rx.length === 0) {
        if (!this.alive()) throw new LinkGoneError();
        return null;
      }
    }
    return this.rx.shift();
  }

  async close() {
    this.closed = true;
  }
}
