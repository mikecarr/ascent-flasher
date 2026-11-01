// Web Serial test page: Info (FIND_DEVICE, read-only) and a reconnect test
// (REBOOT "clean", then see whether Chrome gets the port back on its own).
// Sends nothing else; never sends firmware.

import {
  CMD, CANDIDATE_VIDS, FrameReader, decodeDeviceInfo, encodeRequest,
  isLiteFamily, rebootPayload,
} from "./ar-protocol.js";

const BAUD = 115200;
const RESEND_MS = 2000;
const GIVE_UP_MS = 8000;
const REOPEN_DELAY_MS = 11500; // what the tools wait for VID 0x1D76
const RECONNECT_TIMEOUT_MS = 60000;

const $ = (id) => document.getElementById(id);
const el = {
  connect: $("connect"), info: $("info"), disconnect: $("disconnect"), port: $("port"),
  device: $("device"), reboot: $("reboot"), result: $("result"), log: $("log"),
  copy: $("copy"), unsupported: $("unsupported"),
};

const t0 = performance.now();
function log(msg) {
  const s = ((performance.now() - t0) / 1000).toFixed(3).padStart(8);
  el.log.textContent += `${s}s  ${msg}\n`;
  el.log.scrollTop = el.log.scrollHeight;
}
const hex4 = (n) => (n ?? 0).toString(16).toUpperCase().padStart(4, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One open serial port with a background read loop. */
class Link {
  constructor(port) {
    this.port = port;
    this.frames = new FrameReader((w) => log(`warn: ${w}`));
    this.waiters = [];
    this.seq = 0;
    this.closed = false;
  }

  async open() {
    await this.port.open({ baudRate: BAUD });
    this.writer = this.port.writable.getWriter();
    this.reading = this.readLoop();
  }

  async readLoop() {
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.frames.push(value);
        for (let f; (f = this.frames.next()); ) {
          for (const w of [...this.waiters]) w(f);
        }
      }
    } catch (e) {
      if (!this.closed) log(`read stopped: ${e.message || e}`);
    } finally {
      this.reader.releaseLock();
    }
  }

  async send(command, payload, seq, retry) {
    await this.writer.write(encodeRequest(command, payload, seq, retry));
  }

  /** Send a request and wait for its ack: resend every 2 s, give up at 8 s. */
  async request(command, payload = new Uint8Array(0)) {
    const seq = ++this.seq;
    const started = performance.now();
    let resolve;
    const got = new Promise((r) => (resolve = r));
    const waiter = (f) => {
      const h = f.header;
      if (h.type === 2 && h.command === command && (h.seq === seq || h.seq === 0)) resolve(f);
    };
    this.waiters.push(waiter);
    try {
      for (let retry = 0; ; retry++) {
        if (retry > 0) log(`resend cmd ${command} seq ${seq} (retry ${retry})`);
        await this.send(command, payload, seq, retry);
        const left = GIVE_UP_MS - (performance.now() - started);
        if (left <= 0) throw new Error(`no reply to cmd ${command} after ${GIVE_UP_MS / 1000} s`);
        const f = await Promise.race([got, sleep(Math.min(RESEND_MS, left)).then(() => null)]);
        if (f) {
          log(`cmd ${command} reply in ${Math.round(performance.now() - started)} ms (seq ${f.header.seq}, ${f.payload.length} bytes)`);
          return f;
        }
      }
    } finally {
      this.waiters = this.waiters.filter((w) => w !== waiter);
    }
  }

  async findDevice() {
    const f = await this.request(CMD.FIND_DEVICE);
    return decodeDeviceInfo(f.payload);
  }

  async close() {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* device may be gone */ }
    try { await this.reading; } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* device may be gone */ }
  }
}

let link = null;   // open Link, if any
let lastInfo = null;
let busy = false;

function portLabel(port) {
  const i = port.getInfo();
  return `USB ${hex4(i.usbVendorId)}:${hex4(i.usbProductId)}`;
}

function render() {
  const has = !!link;
  el.connect.disabled = busy;
  el.info.disabled = busy || !has;
  el.disconnect.disabled = busy || !has;
  el.reboot.disabled = busy || !has || !lastInfo || !isLiteFamily(lastInfo.deviceName);
  el.port.textContent = has ? `Connected: ${portLabel(link.port)}` : "No port selected";
}

function showInfo(info, port) {
  const i = port.getInfo();
  const rows = [
    ["USB VID:PID", `${hex4(i.usbVendorId)}:${hex4(i.usbProductId)}`],
    ["device name", info.deviceName],
    ["firmware", info.firmware],
    ["hardware", info.hardwareVersion],
    ["serial number", info.serialNumber || "(empty)"],
    ["SDK version", info.sdkVersion || "(empty)"],
    ["chunk size", `${info.receiveMaxSize} bytes`],
    ["CPU temp", `${info.cpuTemp} °C`],
    ["status / detail", `${info.status} / ${info.detail}`],
    ["mode", info.cpuTemp === 0 && !isLiteFamily(info.deviceName) ? "upgrade (clean) mode" : "normal"],
  ];
  const tb = el.device.querySelector("tbody");
  tb.replaceChildren(...rows.map(([k, v]) => {
    const tr = document.createElement("tr");
    for (const t of [k, v]) {
      const td = document.createElement("td");
      td.textContent = t;
      tr.appendChild(td);
    }
    return tr;
  }));
  el.device.hidden = false;
}

async function withBusy(fn) {
  busy = true;
  render();
  try { await fn(); } catch (e) { log(`error: ${e.message || e}`); }
  finally { busy = false; render(); }
}

async function openPort(port) {
  if (link) await link.close();
  link = null;
  const l = new Link(port);
  await l.open();
  link = l;
  log(`opened ${portLabel(port)} at ${BAUD} baud`);
}

async function doInfo() {
  lastInfo = await link.findDevice();
  log(`device: ${lastInfo.deviceName}, firmware ${lastInfo.firmware}, hw ${lastInfo.hardwareVersion}`);
  showInfo(lastInfo, link.port);
}

el.connect.addEventListener("click", () => withBusy(async () => {
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: CANDIDATE_VIDS.map((v) => ({ usbVendorId: v })) });
  } catch (e) {
    log("no port picked");
    return;
  }
  await openPort(port);
  await doInfo();
}));

el.info.addEventListener("click", () => withBusy(doInfo));

el.disconnect.addEventListener("click", () => withBusy(async () => {
  await link.close();
  link = null;
  lastInfo = null;
  el.device.hidden = true;
  log("port closed");
}));

el.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(el.log.textContent);
    log("log copied");
  } catch {
    log("copy failed: select the log text instead");
  }
});

function resultLine(text, cls) {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.className = cls;
  el.result.appendChild(li);
  el.result.hidden = false;
}

el.reboot.addEventListener("click", () => withBusy(async () => {
  const ok = confirm(
    "Send REBOOT \"clean\" to this VTX?\n\n" +
    "It reboots into upgrade mode and stays there. No firmware is sent. " +
    "Afterwards, power-cycle it (unplug USB and battery) to return to normal.",
  );
  if (!ok) return;
  el.result.replaceChildren();

  const oldPort = link.port;
  const { usbVendorId: vid, usbProductId: pid } = oldPort.getInfo();
  const events = [];
  const onDisc = (e) => { events.push(["disconnect", performance.now(), e.target]); log(`serial disconnect event (${portLabel(e.target)})`); };
  const onConn = (e) => { events.push(["connect", performance.now(), e.target]); log(`serial connect event (${portLabel(e.target)})`); };
  navigator.serial.addEventListener("disconnect", onDisc);
  navigator.serial.addEventListener("connect", onConn);

  try {
    const sentAt = performance.now();
    await link.send(CMD.REBOOT, rebootPayload("clean"), ++link.seq, 0);
    log('sent REBOOT "clean" (no ack expected)');
    await sleep(200);
    await link.close();
    link = null;
    lastInfo = null;
    render();
    log(`waiting ${REOPEN_DELAY_MS / 1000} s before looking for the device`);
    await sleep(REOPEN_DELAY_MS);

    const deadline = performance.now() + RECONNECT_TIMEOUT_MS;
    let found = null;
    while (!found && performance.now() < deadline) {
      const ports = (await navigator.serial.getPorts()).filter((p) => {
        const i = p.getInfo();
        return i.usbVendorId === vid && i.usbProductId === pid;
      });
      for (const p of ports) {
        try {
          await openPort(p);
          const info = await link.findDevice();
          found = { port: p, info };
          break;
        } catch (e) {
          log(`not answering yet: ${e.message || e}`);
          if (link) { await link.close(); link = null; }
        }
      }
      if (!found) await sleep(1000);
    }

    const disc = events.find(([k]) => k === "disconnect");
    const conn = events.find(([k]) => k === "connect");
    const secs = (t) => `${((t - sentAt) / 1000).toFixed(1)} s`;
    resultLine(disc ? `VTX left USB after ${secs(disc[1])}` : "Chrome saw no disconnect (the VTX may not have rebooted)", disc ? "" : "bad");
    resultLine(conn ? `Chrome saw it return after ${secs(conn[1])}, without a prompt` : "Chrome reported no returning port", conn ? "ok" : "bad");

    if (found) {
      lastInfo = found.info;
      showInfo(found.info, found.port);
      resultLine(`Reconnected and answered without a new port pick: ${found.info.deviceName}, ${found.info.firmware}`, "ok");
      resultLine(found.port === oldPort ? "Same port object as before the reboot" : "A new port object (permission carried over)");
      resultLine("Power-cycle the VTX now to return it to normal.");
      log("RESULT: reconnect works without re-picking the port");
    } else {
      resultLine("Chrome did not give the VTX back on its own. Click Connect… and pick it again, then Info.", "bad");
      resultLine("Power-cycle the VTX afterwards to return it to normal.");
      log("RESULT: no permitted port answered; a re-pick is needed");
    }
  } finally {
    navigator.serial.removeEventListener("disconnect", onDisc);
    navigator.serial.removeEventListener("connect", onConn);
  }
}));

if (!("serial" in navigator)) {
  el.unsupported.hidden = false;
  el.connect.disabled = true;
} else {
  render();
  log("ready: click Connect… and pick the VTX");
}
