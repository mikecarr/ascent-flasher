// Web Serial transport (Connector/Link over navigator.serial) and the device
// watcher (port of spawn_watcher/should_probe in app/src-tauri/src/state.rs).
// Nothing here touches the DOM or navigator at import time.
import { LinkGoneError, PortBusyError } from "./link.js";
import { CANDIDATE_VIDS, isCandidateVid } from "./models.js";
import { Session } from "./session.js";
import { guardLog } from "./upgrade.js";

export const BAUD = 115200;
export const BUSY_MESSAGE = "The VTX is in use by another app or tab — close it and try again.";

/** Read errors Web Serial documents as recoverable: the port stays usable. */
const NON_FATAL_READ_ERRORS = new Set(["BreakError", "FramingError", "BufferOverrunError", "ParityError"]);
/** Consecutive non-fatal errors without any data before we call the link gone. */
const MAX_NON_FATAL_IN_A_ROW = 50;

// A port's id is stable for as long as the same SerialPort object exists.
const portIds = new WeakMap();
let nextPortId = 1;
function idFor(port) {
  let id = portIds.get(port);
  if (!id) {
    id = `webserial-${nextPortId++}`;
    portIds.set(port, id);
  }
  return id;
}

function infoFor(port) {
  const { usbVendorId, usbProductId } = port.getInfo?.() ?? {};
  return { id: idFor(port), vid: usbVendorId, pid: usbProductId };
}

const errName = (e) => e?.name ?? "";

class WebSerialLink {
  constructor(port, log) {
    this.port = port;
    this.log = log;
    this.closed = false;
    this.buf = [];
    this.pending = null; // in-flight reader.read(), kept across timeouts
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
  }

  async write(bytes) {
    if (this.closed) throw new LinkGoneError();
    try {
      await this.writer.write(bytes);
    } catch (e) {
      throw new LinkGoneError(`write failed: ${e?.message ?? e}`, { cause: e });
    }
  }

  #startRead() {
    this.pending = this.reader.read().then(
      (r) => ({ r }),
      (error) => ({ error }),
    );
  }

  /** Re-acquire a reader after a non-fatal error (the port gets a new stream). */
  #reacquire() {
    try {
      this.reader.releaseLock();
    } catch {
      // already released
    }
    if (!this.port.readable) throw new LinkGoneError("port is no longer readable");
    try {
      this.reader = this.port.readable.getReader();
    } catch (e) {
      throw new LinkGoneError(`cannot re-acquire reader: ${e?.message ?? e}`, { cause: e });
    }
  }

  /** Bytes, or null after `timeoutMs`; bytes arriving later are kept for the next call. */
  async read(timeoutMs) {
    if (this.buf.length) return this.buf.shift();
    if (this.closed) throw new LinkGoneError();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs), null);
    });
    let nonFatal = 0;
    try {
      for (;;) {
        if (!this.pending) this.#startRead();
        const res = await Promise.race([this.pending, timeout]);
        if (res === null) return null; // timed out; this.pending stays in flight
        this.pending = null;
        if (res.error) {
          const e = res.error;
          if (this.closed) throw new LinkGoneError();
          if (!NON_FATAL_READ_ERRORS.has(errName(e)) || ++nonFatal > MAX_NON_FATAL_IN_A_ROW) {
            throw new LinkGoneError(`read failed: ${e?.message ?? e}`, { cause: e });
          }
          this.log(`serial read error ${errName(e)} (non-fatal), continuing`);
          this.#reacquire();
          continue;
        }
        if (res.r.done) throw new LinkGoneError("port closed");
        nonFatal = 0;
        if (res.r.value?.length) return res.r.value;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const step of [
      () => this.reader.cancel(),
      () => this.reader.releaseLock(),
      () => this.writer.releaseLock(),
      () => this.port.close(),
    ]) {
      try {
        await step();
      } catch {
        // best effort
      }
    }
  }
}

export class WebSerialConnector {
  constructor(serial = globalThis.navigator?.serial, log = () => {}) {
    this.serial = serial;
    this.log = guardLog(log);
  }

  async #ports() {
    if (!this.serial) return [];
    const out = [];
    for (const port of await this.serial.getPorts()) {
      const info = infoFor(port);
      if (isCandidateVid(info.vid)) out.push({ port, info });
    }
    return out;
  }

  async list() {
    return (await this.#ports()).map((p) => p.info);
  }

  async open(portInfo) {
    const found = (await this.#ports()).find((p) => p.info.id === portInfo.id);
    if (!found) throw new LinkGoneError("no such port");
    try {
      await found.port.open({ baudRate: BAUD });
    } catch (e) {
      this.log(`port.open failed: ${errName(e)} ${e?.message ?? e}`);
      if (errName(e) === "InvalidStateError" || errName(e) === "NetworkError") {
        throw new PortBusyError(BUSY_MESSAGE, { cause: e });
      }
      throw e;
    }
    try {
      return new WebSerialLink(found.port, this.log);
    } catch (e) {
      try {
        await found.port.close();
      } catch {
        // ignored
      }
      throw new LinkGoneError(`port not usable: ${e?.message ?? e}`, { cause: e });
    }
  }

  /** Subscribe to connect/disconnect; returns an unsubscribe function. */
  subscribe(cb) {
    const s = this.serial;
    if (!s?.addEventListener) return () => {};
    s.addEventListener("connect", cb);
    s.addEventListener("disconnect", cb);
    return () => {
      s.removeEventListener("connect", cb);
      s.removeEventListener("disconnect", cb);
    };
  }
}

/** Show the browser's port picker, filtered to candidate VIDs; null if dismissed. */
export async function requestDevice(serial = globalThis.navigator?.serial) {
  if (!serial) return null;
  try {
    const port = await serial.requestPort({ filters: CANDIDATE_VIDS.map((usbVendorId) => ({ usbVendorId })) });
    return infoFor(port);
  } catch (e) {
    if (errName(e) === "NotFoundError") return null;
    throw e;
  }
}

const isFlashableName = (n) => ["ascent_lite", "ascent_lite_plus"].includes(String(n).toLowerCase());
const setKey = (ports) => ports.map((p) => `${p.id}:${p.vid}:${p.pid}`).sort().join("|");
const viewKey = (v) => (v ? `${v.port.id}\n${JSON.stringify(v.info)}` : "");

export class DeviceWatcher {
  constructor(connector, clock, onChange, log = () => {}) {
    this.connector = connector;
    this.clock = clock;
    this.onChange = onChange;
    this.log = guardLog(log);
    this.running = false;
    this.paused = false;
    this.forced = false;
    this.lastSet = null;
    this.unanswered = 0;
    this.emitted = null;
    this.chain = Promise.resolve();
    this.unsubscribe = null;
    this.generation = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    this.unsubscribe = this.connector.subscribe?.(() => void this.tick()) ?? null;
    void (async () => {
      while (this.running && this.generation === gen) {
        await this.tick();
        await this.clock.sleep(1000);
      }
    })();
  }

  stop() {
    this.running = false;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once any probe in flight has finished; no probe starts after this. */
  async pause() {
    this.paused = true;
    await this.chain;
  }

  /** Re-scan next (a finished flash changes the device). */
  resume() {
    this.paused = false;
    this.forced = true;
  }

  rescan() {
    this.forced = true;
    return this.tick();
  }

  /** One poll: serialised, and a no-op while paused or stopped-and-never-started. */
  tick() {
    const run = this.chain.then(() => this.#scan());
    this.chain = run.catch(() => {});
    return run.catch((e) => this.log(`watcher scan failed: ${e?.message ?? e}`));
  }

  async #scan() {
    if (this.paused) return;
    let ports;
    try {
      ports = await this.connector.list();
    } catch (e) {
      this.log(`port enumeration failed: ${e?.message ?? e}`);
      return;
    }
    if (this.paused) return;
    const key = setKey(ports);
    const forced = this.forced;
    const retry = this.unanswered > 0 && this.unanswered < 5;
    if (!(forced || retry || this.lastSet !== key)) return;
    this.forced = false;
    const found = [];
    for (const port of ports) {
      if (this.paused) return; // never probe once a flash has begun
      const f = await this.#probe(port);
      if (f) found.push(f);
    }
    if (this.paused) return;
    this.lastSet = key;
    const chosen = found.find((f) => isFlashableName(f.info.deviceName)) ?? found[0] ?? null;
    this.unanswered = !chosen && ports.length ? this.unanswered + 1 : 0;
    if (viewKey(chosen) !== viewKey(this.emitted) || forced) {
      this.emitted = chosen;
      try {
        this.onChange(chosen);
      } catch (e) {
        this.log(`onChange threw: ${e?.message ?? e}`);
      }
    }
  }

  async #probe(port) {
    let link;
    try {
      link = await this.connector.open(port);
    } catch (e) {
      this.log(`watcher open failed on ${port.id}: ${e?.message ?? e}`);
      return null;
    }
    const session = new Session(link, this.clock, { log: this.log });
    try {
      return { port, info: await session.findDevice() };
    } catch (e) {
      this.log(`watcher FIND_DEVICE failed on ${port.id}: ${e?.message ?? e}`);
      return null;
    } finally {
      await session.close();
    }
  }
}
