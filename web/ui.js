// The flasher page: layout and state machine from the Mac app (app/ui/main.js),
// with the Tauri backend replaced by direct calls into web/lib.
import { modelFor, canFlash, isLocalHost } from "./lib/models.js";
import { preflight, warningText, formatVersion, PreflightError, restartMismatch } from "./lib/firmware.js";
import { realClock } from "./lib/clock.js";
import { PortBusyError } from "./lib/link.js";
import { SimConnector } from "./lib/sim.js";
import { runUpgrade, CancelToken, progressText, UpgradeError } from "./lib/upgrade.js";
import { WebSerialConnector, requestDevice, DeviceWatcher } from "./lib/webserial.js";
import { SessionLog } from "./lib/session-log.js";
import { FlashGuards } from "./lib/guards.js";
import { makeAsk } from "./lib/confirm.js";

const HOST = location.hostname;
const log = new SessionLog();

const INFO_ONLY_NOTE =
  "Info only: this model hasn't been confirmed with this flasher yet. If you'd like it supported, open an issue with the info above.";
const VRX_PRO_POWER_NOTE =
  "The VRX Pro needs its own power (DC barrel, 2–6S) during the update; USB-C carries data only.";
const NO_SERIAL_NOTE =
  "This page needs Chrome or Edge on a computer (Web Serial). Safari and Firefox can't talk to USB serial devices.";

// ---- Simulated devices (?sim=…, local pages only) ---------------------------

const writingScript = (...percents) => percents.map((percent) => ({ percent, status: 2, detail: "OK" }));

// VID 0x1D6B: an 8 s reopen delay, so "Reconnecting…" lasts long enough to press Cancel.
const SIM_SCENARIOS = {
  lite: {
    vid: 0x1d6b, pid: 0x0101,
    device: {
      info: { deviceName: "ascent_lite", firmware: "Ascent_H_Sky_18_21_8", serialNumber: "SIMLITE01", hardwareVersion: "V1.0" },
      statusScript: writingScript(5, 20, 40, 60, 80, 95),
      firmwareAfterSelfReboot: "Ascent_H_Sky_18_21_10",
    },
  },
  vrxpro: {
    vid: 0x1d6b, pid: 0x0102,
    device: {
      info: { deviceName: "ascent_vrx_pro", firmware: "Ascent_VRX_Pro_18_21_8", serialNumber: "SIMVRX01", hardwareVersion: "V2.0" },
      statusScript: writingScript(5, 20, 40, 60, 80, 95),
      firmwareAfterSelfReboot: "Ascent_VRX_Pro_18_21_10",
    },
  },
  // The device reports a write error; the recovery reboot is ignored, so the
  // result carries the power-cycle hint.
  error: {
    vid: 0x1d6b, pid: 0x0101,
    device: {
      info: { deviceName: "ascent_lite", firmware: "Ascent_H_Sky_18_21_8", serialNumber: "SIMERR01", hardwareVersion: "V1.0" },
      statusScript: [...writingScript(10, 30), { percent: 30, status: -11, detail: "write failed" }],
      ignoredRebootModes: ["normal"],
    },
  },
  // An Ascent unit the flasher doesn't know: info only.
  other: {
    vid: 0x1d6b, pid: 0x0103,
    device: { info: { deviceName: "ascent_mystery", firmware: "Ascent_Mystery_1_0_0", serialNumber: "SIMOTH01" } },
  },
  // The port is held by another tab for the first four opens (~3 s).
  busy: {
    vid: 0x1d6b, pid: 0x0101,
    device: { info: { deviceName: "ascent_lite", firmware: "Ascent_H_Sky_18_21_8", serialNumber: "SIMBSY01" }, busyOpens: 4 },
  },
};

function pickSim() {
  const name = new URLSearchParams(location.search).get("sim");
  if (name === null) return null;
  if (!isLocalHost(HOST)) {
    log.line(`?sim=${name} ignored: only honoured on a local page (host ${HOST})`);
    return null;
  }
  const scenario = SIM_SCENARIOS[name];
  if (!scenario) {
    log.line(`?sim=${name} ignored: unknown scenario (known: ${Object.keys(SIM_SCENARIOS).join(", ")})`);
    return null;
  }
  return { name, scenario };
}

// ---- Elements and state ----------------------------------------------------

const $ = (id) => document.getElementById(id);
const el = {
  noSerial: $("no-serial"), simTag: $("sim-tag"),
  dot: $("dot"), name: $("dev-name"), port: $("dev-port"), connect: $("connect"), info: $("info"),
  devError: $("dev-error"), grid: $("dev-grid"), note: $("dev-note"), power: $("dev-power"),
  fw: $("dev-fw"), hw: $("dev-hw"), sn: $("dev-sn"), sdk: $("dev-sdk"), temp: $("dev-temp"),
  devStatus: $("dev-status"), rx: $("dev-rx"),
  file: $("file"), drop: $("drop"), dropText: $("drop-text"), warnings: $("warnings"), fileError: $("file-error"),
  flash: $("flash"), progWrap: $("progress-wrap"), bar: $("bar"), fill: $("fill"), status: $("status"),
  result: $("result"), resultTitle: $("result-title"), resultMsg: $("result-msg"), resultHint: $("result-hint"),
  again: $("again"), downloadLog: $("download-log"),
  ask: $("ask"), askTitle: $("ask-title"), askText: $("ask-text"), askOk: $("ask-ok"), askCancel: $("ask-cancel"),
};

// Single source of truth for the UI.
// mode: "idle" | "flashing" | "done"
const s = {
  supported: false,    // Web Serial (or a simulated device) available
  mode: "idle",
  connected: false,    // a port was picked; the watcher runs
  connecting: false,   // Connect… or Info in flight
  device: null,        // {port, info} | null
  deviceError: null,   // why the last scan found nothing (e.g. port busy)
  file: null,          // chosen File
  checkedFor: null,    // device key the current check/result belongs to
  checking: false,     // preflight (MD5) running
  fw: null,            // preflight result {firmware, warnings}
  fileError: null,     // PreflightError message
  locked: false,       // cancelLocked: past the point of no return
  cancelling: false,   // Cancel pressed; waiting for the flasher to stop
  busy: false,         // confirm dialogs / flash start in flight
  done: null,          // {kind, title, message, hint}
  progress: null,      // last progress event
};

const sim = pickSim();
const baseConnector = sim
  ? new SimConnector(realClock, "sim-1", sim.scenario.vid, sim.scenario.pid, sim.scenario.device)
  : new WebSerialConnector(globalThis.navigator?.serial, log.line);
s.supported = !!sim || !!globalThis.navigator?.serial;

// The watcher's probes swallow open errors; record a busy port so the card can
// show it. Only the watcher uses this wrapper (runUpgrade gets the base one).
let scanErrors = [];
const watcherConnector = {
  async list() {
    scanErrors = [];
    return baseConnector.list();
  },
  async open(port) {
    try {
      return await baseConnector.open(port);
    } catch (e) {
      if (e instanceof PortBusyError) scanErrors.push(e);
      throw e;
    }
  },
  subscribe: baseConnector.subscribe ? (cb) => baseConnector.subscribe(cb) : undefined,
};

const watcher = new DeviceWatcher(watcherConnector, realClock, onDeviceChanged, log.line);
const guards = new FlashGuards(window, navigator);
let cancelToken = null;

const modelOf = (d) => (d ? modelFor(d.info.deviceName) : null);
// Always the real hostname: unconfirmed models flash only on a local page.
const flashable = () => {
  const m = modelOf(s.device);
  return !!m && canFlash(m, HOST);
};
const deviceKey = (d) => (d ? `${d.port.id}\n${d.info.deviceName}\n${d.info.firmware}` : null);
const hex4 = (n) => (typeof n === "number" ? n.toString(16).toUpperCase().padStart(4, "0") : "?");
const capitalise = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
// After the next paint; a timer backs it up, since a tab that isn't being
// painted (hidden or occluded) never runs animation frames.
const afterPaint = (fn) => {
  let done = false;
  const run = () => {
    if (!done) {
      done = true;
      fn();
    }
  };
  requestAnimationFrame(() => setTimeout(run, 0));
  setTimeout(run, 100);
};
const nextFrame = () => new Promise((r) => afterPaint(r));

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// Rebuild a node's children only when what it shows changed (progress renders
// often, and #file-details is a live region that must not re-announce).
const shown = new Map();
function rebuild(node, key, build) {
  if (shown.get(node) === key) return;
  shown.set(node, key);
  node.replaceChildren(...build());
}

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  afterPaint(() => {
    renderQueued = false;
    render();
  });
}

// ---- Render ----------------------------------------------------------------

function render() {
  const flashing = s.mode === "flashing";
  const d = s.device;
  const model = modelOf(d);

  el.noSerial.hidden = s.supported;
  el.simTag.hidden = !sim;
  if (sim) el.simTag.textContent = `simulated device: ${sim.name}`;

  // Device card
  el.dot.classList.toggle("on", !!d);
  if (!d) {
    setText(el.name, s.connected ? "No Ascent device found" : "Connect your Ascent device");
    const hint = s.connected
      ? "Plug it in by USB. It shows up here once it answers."
      : "Plug it in by USB, then press Connect…";
    rebuild(el.port, `text:${hint}`, () => [document.createTextNode(hint)]);
  } else {
    setText(el.name, model ? model.label : d.info.deviceName || "Unknown device");
    const portText = `${d.info.deviceName} · USB ${hex4(d.port.vid)}:${hex4(d.port.pid)}`;
    rebuild(el.port, `code:${portText}`, () => {
      const code = document.createElement("code");
      code.textContent = portText;
      return [code];
    });
  }
  el.grid.hidden = !d;
  if (d) {
    const i = d.info;
    setText(el.fw, i.firmware || "–");
    setText(el.hw, i.hardwareVersion || "–");
    setText(el.sn, i.serialNumber || "–");
    setText(el.sdk, i.sdkVersion || "–");
    setText(el.temp, Number.isFinite(i.cpuTemp) ? String(i.cpuTemp) : "–");
    setText(el.devStatus, `${i.status}${i.detail ? ` ${i.detail}` : ""}`);
    setText(el.rx, Number.isFinite(i.receiveMaxSize) ? String(i.receiveMaxSize) : "–");
  }
  el.note.hidden = !d || flashable();
  setText(el.note, INFO_ONLY_NOTE);
  el.power.hidden = !(model && model.power === "external");
  setText(el.power, VRX_PRO_POWER_NOTE);
  el.devError.hidden = !s.deviceError || flashing;
  setText(el.devError, s.deviceError || "");

  const controlsOff = !s.supported || flashing || s.busy;
  el.connect.disabled = controlsOff || s.connecting;
  setText(el.connect, s.connecting && !s.connected ? "Connecting…" : "Connect…");
  el.info.disabled = controlsOff || s.connecting || !s.connected;
  setText(el.info, s.connecting && s.connected ? "Reading…" : "Info");

  // File
  el.drop.disabled = controlsOff;
  el.drop.classList.toggle("has-file", !!s.file);
  if (!s.file) {
    rebuild(el.dropText, "empty", () => [document.createTextNode("Drop firmware .img here, or click to choose")]);
  } else {
    const sub = s.checking ? "Checking file…"
      : s.fw ? `Version ${s.fw.firmware.version ? formatVersion(s.fw.firmware.version) : "unknown"} · ${(s.file.size / 1e6).toFixed(1)} MB · click to change`
      : !d ? "Connect the device to check this file"
      : !flashable() ? "This device can't be flashed here"
      : "Click to choose another file";
    rebuild(el.dropText, `${s.file.name}\n${sub}`, () => {
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = s.file.name;
      const small = document.createElement("span");
      small.className = "sub";
      small.textContent = sub;
      return [name, small];
    });
  }
  const warnings = (!s.checking && s.fw ? s.fw.warnings : []).map(warningText);
  el.warnings.hidden = warnings.length === 0;
  rebuild(el.warnings, warnings.join("\n"), () => warnings.map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));
  el.fileError.hidden = !s.fileError;
  setText(el.fileError, s.fileError || "");

  // Button
  el.flash.classList.remove("cancel");
  if (flashing) {
    if (s.locked) {
      setText(el.flash, "Device is writing firmware — do not unplug");
      el.flash.disabled = true;
    } else if (s.cancelling) {
      setText(el.flash, "Cancelling…");
      el.flash.disabled = true;
    } else {
      setText(el.flash, "Cancel");
      el.flash.classList.add("cancel");
      el.flash.disabled = false;
    }
  } else {
    setText(el.flash, s.checking ? "Checking file…" : "Flash firmware");
    el.flash.disabled = s.busy || s.checking || !(flashable() && s.fw);
  }
  el.flash.hidden = s.mode === "done";

  // Progress
  el.progWrap.hidden = !flashing;
  const pct = flashing ? progressPercent(s.progress) : null;
  el.bar.classList.toggle("indeterminate", flashing && pct === null);
  if (pct !== null) {
    el.fill.style.width = `${pct}%`;
    el.bar.setAttribute("aria-valuenow", String(pct));
  } else {
    el.fill.style.width = "";
    el.bar.removeAttribute("aria-valuenow");
  }
  setText(el.status, !flashing ? ""
    : s.cancelling && !s.locked ? "Cancelling — finishing the current step, then restoring the device…"
    : s.progress ? progressText(s.progress) : "Starting…");

  // Result
  const done = s.mode === "done" && s.done;
  el.result.hidden = !done;
  if (done) {
    el.result.className = `result ${done.kind}`;
    el.result.setAttribute("role", done.kind === "err" ? "alert" : "status");
    setText(el.resultTitle, done.title);
    setText(el.resultMsg, done.message);
    el.resultHint.hidden = !done.hint;
    setText(el.resultHint, done.hint || "");
  }
}

function progressPercent(p) {
  if (!p) return null;
  if (p.type === "sent") return p.total === 0 ? 100 : Math.floor((p.bytes * 100) / p.total);
  if (p.type === "writing") return Math.min(100, Math.max(0, Math.round(p.percent)));
  if (p.type === "phase" && (p.phase === "sending" || p.phase === "writing")) return 0;
  return null;
}

// ---- Device ----------------------------------------------------------------

function onDeviceChanged(chosen) {
  if (s.mode === "flashing") return; // watcher is paused; ignore strays
  s.device = chosen;
  const busy = scanErrors.find((e) => e instanceof PortBusyError);
  s.deviceError = chosen ? null : busy ? busy.message : null;
  log.line(chosen
    ? `device: ${chosen.info.deviceName} ${chosen.info.firmware} on ${chosen.port.id}`
    : `device: none${s.deviceError ? ` (${s.deviceError})` : ""}`);
  render();
  void syncFile();
}

async function connect() {
  if (!s.supported || s.connecting || s.busy || s.mode === "flashing") return;
  s.connecting = true;
  s.deviceError = null;
  render();
  try {
    if (!sim) {
      // The browser's picker; only FIND_DEVICE is sent afterwards.
      const picked = await requestDevice(navigator.serial);
      if (!picked) {
        log.line("connect: picker dismissed");
        return;
      }
      log.line(`connect: picked ${picked.id} (USB ${hex4(picked.vid)}:${hex4(picked.pid)})`);
    } else {
      log.line(`connect: simulated device (${sim.name})`);
    }
    s.connected = true;
    // Rescan before start(), so the loop's first tick finds nothing new and
    // connecting sends a single FIND_DEVICE.
    const scan = watcher.rescan();
    watcher.start();
    await scan;
  } catch (e) {
    log.line(`connect failed: ${e?.name ?? ""} ${e?.message ?? e}`);
    s.deviceError = e instanceof PortBusyError ? e.message : `Couldn't connect: ${e?.message ?? e}`;
  } finally {
    s.connecting = false;
    render();
  }
}

async function readInfo() {
  if (!s.connected || s.connecting || s.busy || s.mode === "flashing") return;
  s.connecting = true;
  render();
  try {
    log.line("info: re-reading device");
    await watcher.rescan(); // FIND_DEVICE only
  } finally {
    s.connecting = false;
    render();
  }
}

// ---- File ------------------------------------------------------------------

function chooseFile(file) {
  if (!file || s.mode === "flashing" || s.busy) return;
  log.line(`file: ${file.name} (${file.size} bytes)`);
  s.file = file;
  s.fw = null;
  s.fileError = null;
  s.checkedFor = null;
  if (s.mode === "done") {
    s.mode = "idle";
    s.done = null;
  }
  render();
  void syncFile();
}

let checkSeq = 0;

/** Keep the file check in step with the (possibly re-flashed) device. */
async function syncFile() {
  if (!s.file || !s.device || s.mode === "flashing" || s.busy) return;
  if (!flashable()) {
    s.fw = null;
    s.fileError = null;
    s.checkedFor = null;
    render();
    return;
  }
  const key = deviceKey(s.device);
  if (key === s.checkedFor) return; // same device and firmware: still valid
  const seq = ++checkSeq;
  const { file, device } = s;
  s.checkedFor = key;
  s.checking = true;
  s.fw = null;
  s.fileError = null;
  render();
  // MD5 of a large image runs on this thread: let "Checking file…" paint first.
  await nextFrame();
  let fw = null;
  let err = null;
  try {
    fw = await preflight(device.info, file, HOST);
  } catch (e) {
    err = e;
  }
  if (seq !== checkSeq) return; // superseded by a newer check
  s.checking = false;
  if (err) {
    s.fileError = err instanceof PreflightError ? capitalise(err.message) : `Couldn't check the file: ${err?.message ?? err}`;
    log.line(`file check failed: ${err?.message ?? err}`);
  } else {
    s.fw = fw;
    log.line(`file check: md5 ${fw.firmware.md5Hex}, version ${fw.firmware.version ? formatVersion(fw.firmware.version) : "unknown"}, warnings [${fw.warnings.map((w) => w.kind).join(", ")}]`);
  }
  render();
  // The device may have changed while hashing.
  if (deviceKey(s.device) !== key) void syncFile();
}

// ---- Confirm dialog --------------------------------------------------------

const askDialog = makeAsk({
  dialog: el.ask,
  form: el.ask.querySelector("form"),
  show: ({ title, text, okLabel }) => {
    el.askTitle.textContent = title;
    el.askText.textContent = text;
    el.askOk.textContent = okLabel;
  },
});

async function ask(title, text, okLabel) {
  const answer = askDialog({ title, text, okLabel });
  el.askCancel.focus(); // the safe choice is the default
  return answer;
}

// ---- Flash -----------------------------------------------------------------

async function onFlashClick() {
  if (s.mode === "flashing") {
    if (!s.locked && !s.cancelling && cancelToken) {
      // The flasher stops at its next safe point, which can be ~12 s away
      // (e.g. while waiting for the VTX to come back), so keep showing it.
      s.cancelling = true;
      log.line("cancel pressed");
      cancelToken.cancel();
      render();
    }
    return;
  }
  if (s.busy || s.checking || !flashable() || !s.fw || !s.file) return;
  // Snapshot: what the user confirms is what is flashed.
  const fw = s.fw;
  const device = s.device;
  const model = modelOf(device);
  const confirmedKey = deviceKey(device);
  const confirmedFirmware = device.info.firmware;
  const confirmedWarnings = fw.warnings.map((w) => w.kind).join(",");
  s.busy = true;
  render();
  let go = false;
  try {
    go = await confirmAll(fw, model);
    if (!go) {
      log.line("flash not confirmed");
      return;
    }
    // Refuse if the device or the file's warnings changed while confirming.
    const nowWarnings = s.fw ? s.fw.warnings.map((w) => w.kind).join(",") : null;
    if (deviceKey(s.device) !== confirmedKey || s.fw !== fw || nowWarnings !== confirmedWarnings) {
      log.line("flash refused: device or file changed while confirming");
      go = false;
      finish({
        kind: "err", title: "Flash failed",
        message: "The device or the file changed while you were confirming — nothing was written. Check the details and press Flash again.",
        hint: null,
      });
      return;
    }
  } finally {
    if (!go) {
      s.busy = false;
      render();
      void syncFile();
    }
  }
  await flash({ fw, device, model, confirmedFirmware });
}

async function confirmAll(fw, model) {
  for (const w of fw.warnings) {
    if (!(await ask("Warning", `${warningText(w)} Continue anyway?`, "Continue"))) return false;
  }
  const power = model.power === "external" ? ` ${VRX_PRO_POWER_NOTE}` : "";
  return ask("Flash firmware", `Keep USB connected and the unit powered until it finishes.${power} Flash now?`, "Flash now");
}

async function flash({ fw, device, model, confirmedFirmware }) {
  s.mode = "flashing";
  s.locked = false;
  s.cancelling = false;
  s.progress = null;
  s.done = null;
  cancelToken = new CancelToken();
  render();
  log.line(`flash confirmed: ${fw.firmware.name} → ${device.info.deviceName} ${confirmedFirmware} on ${device.port.id}`);
  if (sim) {
    // A fresh write sequence for every simulated flash.
    baseConnector.device.statusScript = [...(sim.scenario.device.statusScript ?? [])];
  }
  let done;
  try {
    await watcher.pause(); // no probe may touch the port during the flash
    void guards.arm(); // the leave prompt is armed at once; the wake lock is best effort
    const r = await runUpgrade({
      connector: baseConnector,
      port: device.port,
      firmware: fw.firmware,
      expected: confirmedFirmware,
      model,
      cancel: cancelToken,
      onProgress,
      clock: realClock,
      log: log.line,
    });
    log.line(`flash complete: device reports ${r.firmware}`);
    const mismatch = restartMismatch(r.firmware, fw.firmware.version);
    if (mismatch) {
      log.line(`warn: ${mismatch}`);
      done = {
        kind: "warn", title: "Check the version", message: mismatch,
        hint: "Press Info to re-read the unit. If it still reports the old version, flash the file again.",
      };
    } else {
      done = { kind: "ok", title: "Flash complete", message: `The device now reports ${r.firmware}.`, hint: null };
    }
  } catch (e) {
    done = resultFor(e);
    log.line(`flash ended: ${e?.kind ?? e?.name ?? "error"}: ${e?.message ?? e}`);
  } finally {
    guards.disarm();
    cancelToken = null;
    finish(done ?? { kind: "err", title: "Flash failed", message: "Unexpected error.", hint: null });
    watcher.resume(); // re-scan: a finished flash changes the device
  }
}

function onProgress(p) {
  if (s.mode !== "flashing") return;
  s.progress = p;
  if (p.type === "cancelLocked") s.locked = true;
  if (p.type === "cancelLocked") render();
  else renderSoon();
}

function resultFor(e) {
  if (!(e instanceof UpgradeError)) {
    return { kind: "err", title: "Flash failed", message: capitalise(String(e?.message ?? e)), hint: null };
  }
  const message = capitalise(e.message);
  switch (e.kind) {
    case "cancelled":
    case "cancelledUnchanged":
      return { kind: "neutral", title: "Flash cancelled", message, hint: e.hint };
    case "outcomeUnknown":
      return { kind: "warn", title: "Result unknown", message, hint: e.hint };
    case "twoUnits":
      return { kind: "err", title: "Flash not started", message, hint: null };
    default:
      return { kind: "err", title: "Flash failed", message, hint: e.hint };
  }
}

function finish(done) {
  s.mode = "done";
  s.done = done;
  s.locked = false;
  s.cancelling = false;
  s.progress = null;
  s.busy = false;
  render();
}

function resetToIdle() {
  if (s.mode === "flashing") return;
  s.mode = "idle";
  s.done = null;
  s.progress = null;
  render();
  el.flash.focus();
  void syncFile();
}

// ---- Wiring ----------------------------------------------------------------

el.connect.addEventListener("click", connect);
el.info.addEventListener("click", readInfo);
el.flash.addEventListener("click", onFlashClick);
el.again.addEventListener("click", resetToIdle);
el.downloadLog.addEventListener("click", () => {
  const t = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  log.download(`ascent-flasher-log-${t}.txt`);
});

el.drop.addEventListener("click", () => {
  if (el.drop.disabled) return;
  el.file.click();
});
el.file.addEventListener("change", () => {
  const f = el.file.files && el.file.files[0];
  el.file.value = ""; // picking the same file again still fires change
  chooseFile(f);
});

// Drag and drop. Dropping anywhere else must not navigate away to the file.
const canDrop = () => s.supported && s.mode !== "flashing" && !s.busy;
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
el.drop.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (canDrop()) el.drop.classList.add("over");
});
el.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = canDrop() ? "copy" : "none";
});
el.drop.addEventListener("dragleave", () => el.drop.classList.remove("over"));
el.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  el.drop.classList.remove("over");
  if (!canDrop()) return;
  const f = e.dataTransfer?.files?.[0];
  if (f) chooseFile(f);
});

log.line(`page loaded: ${location.href}`);
log.line(`user agent: ${navigator.userAgent}`);
log.line(sim ? `simulated device: ${sim.name}` : s.supported ? "Web Serial available" : `no Web Serial: ${NO_SERIAL_NOTE}`);
render();
