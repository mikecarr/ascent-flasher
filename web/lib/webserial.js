// Web Serial transport (Connector/Link over navigator.serial) and the device
// watcher (rules ported from the retired Tauri app's device watcher).
// Nothing here touches the DOM or navigator at import time.
import { LinkGoneError, PortBusyError } from "./link.js";
import { CANDIDATE_VIDS, isCandidateVid, modelFor } from "./models.js";
import { Session } from "./session.js";
import { guardLog } from "./upgrade.js";

export const BAUD = 115200;
export const BUSY_MESSAGE = "The VTX is in use by another app or tab — close it and try again.";

/** Read errors Web Serial documents as recoverable: the port stays usable. */
const NON_FATAL_READ_ERRORS = new Set(["BreakError", "FramingError", "BufferOverrunError", "ParityError"]);
/** Consecutive non-fatal errors without any data before we call the link gone. */
const MAX_NON_FATAL_IN_A_ROW = 50;
/** Upper bound for each awaited step of Link.close(). */
const CLOSE_STEP_MS = 2000;

// A port's id is stable for as long as the browser lists it. Chrome caches
// SerialPort objects only weakly, so an unreferenced one is collected and the
// next getPorts() returns a new object for the same port; holding every listed
// port here keeps its object (and id) until the port is really gone.
const heldPorts = new WeakMap(); // serial -> Map<SerialPort, id>
let nextPortId = 1;
function held(serial) {
  let ports = heldPorts.get(serial);
  if (!ports) heldPorts.set(serial, (ports = new Map()));
  return ports;
}

function idFor(serial, port) {
  const ports = held(serial);
  let id = ports.get(port);
  if (!id) {
    id = `webserial-${nextPortId++}`;
    ports.set(port, id);
  }
  return id;
}

/** Drop ports the browser no longer lists, so a returning device gets a new id. */
function forgetUnlisted(serial, listed) {
  const ports = held(serial);
  const keep = new Set(listed);
  for (const port of ports.keys()) if (!keep.has(port)) ports.delete(port);
}

function infoFor(serial, port) {
  const { usbVendorId, usbProductId } = port.getInfo?.() ?? {};
  return { id: idFor(serial, port), vid: usbVendorId, pid: usbProductId };
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
    try {
      this.reader = port.readable.getReader();
    } catch (e) {
      this.writer.releaseLock();
      throw e;
    }
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
    // Never await anything that can wait on the device: a stalled write would
    // otherwise hang close (and the watcher pause / flash reconnect behind it).
    const bounded = (p) => Promise.race([p, new Promise((r) => setTimeout(r, CLOSE_STEP_MS))]);
    const steps = [
      () => bounded(this.reader.cancel()),
      () => this.reader.releaseLock(),
      () => {
        this.writer.abort().catch(() => {}); // not awaited: waits for an in-flight write
      },
      () => this.writer.releaseLock(),
      () => bounded(this.port.close()),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (e) {
        this.log(`close step failed: ${e?.message ?? e}`);
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
    const listed = await this.serial.getPorts();
    forgetUnlisted(this.serial, listed);
    const out = [];
    for (const port of listed) {
      const info = infoFor(this.serial, port);
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
    return infoFor(serial, port);
  } catch (e) {
    if (errName(e) === "NotFoundError") return null;
    throw e;
  }
}

const isFlashableName = (n) => modelFor(n) !== null;
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
