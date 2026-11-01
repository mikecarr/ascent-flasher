// Browser-only stand-in for the Tauri runtime. Loaded by index.html only when
// window.__TAURI__ is absent. Scenarios: ?scenario=nodevice|notflashable|error|changed
// (changed: start_flash refuses as if the device or warnings changed).
// Console: __mockCloseRequest() simulates closing the window.
(() => {
  const scenario = new URLSearchParams(location.search).get("scenario") || "";
  const listeners = {};
  const emit = (name, payload) => (listeners[name] || []).forEach((f) => f({ event: name, payload }));

  const device = {
    port: "/dev/cu.usbmodemCX201", name: "Ascent_lite", firmware: "Ascent_H_Sky_17_5_8",
    hardware: "HW 1.2", serial: "CX2012345678", tempC: 41, flashable: true, otherCount: 0,
  };
  let current = scenario === "nodevice" ? null
    : scenario === "notflashable" ? { ...device, name: "Ascent_VRX", flashable: false }
    : { ...device };

  let timers = [];
  let cancelled = false;
  let locked = false;
  let flashing = false;

  function parse(path) {
    const fileName = String(path).split(/[\\/]/).pop();
    const m = fileName.match(/_(\d+)_(\d+)_(\d+)\.img$/i);
    const version = m ? `V${m[1]}.${m[2]}.${m[3]}` : null;
    const warnings = [];
    if (!m) warnings.push({ kind: "unknownVersion", text: "Can't read a version from this file name. Flash anyway?" });
    if (/VRX/i.test(fileName)) warnings.push({ kind: "nameMismatch", text: "This file looks like it is for a different device ('Ascent_lite'). Flash anyway?" });
    if (m && +m[1] < 17) warnings.push({ kind: "downgrade", text: `This would downgrade the device to ${version}. Flash anyway?` });
    return { fileName, version, warnings };
  }

  function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function progress(phase, text, percent, cancelLocked) {
    if (cancelLocked) locked = true;
    emit("flash-progress", { phase, text, percent, cancelLocked: locked });
  }

  function runFlash() {
    cancelled = false; locked = false; flashing = true;
    let t = 0;
    const step = (ms, fn) => { t += ms; later(t, () => { if (!cancelled) fn(); }); };
    step(300, () => progress("rebooting", "Rebooting into upgrade mode…", null));
    step(900, () => progress("reconnecting", "Reconnecting…", null));
    step(700, () => progress("enteringUpgrade", "Entering upgrade mode…", null));
    step(500, () => progress("startingTransfer", "Starting transfer…", null));
    for (let i = 1; i <= 20; i++) step(150, () => progress("sending", `Sending firmware… ${i * 5}%`, i / 20));
    step(100, () => progress("cancelLocked", "Finishing transfer…", null, true));
    step(400, () => progress("finishing", "Finishing transfer…", null, true));
    for (let i = 1; i <= 10; i++) step(250, () => progress("writing", `Writing firmware… ${i * 10}%`, i / 10, true));
    step(400, () => progress("restarting", "Restarting device…", null, true));
    step(800, () => progress("verifying", "Verifying…", null, true));
    step(500, () => {
      flashing = false;
      if (scenario === "error") {
        emit("flash-done", { ok: false, message: "device did not come back after upgrade",
          hint: "Unplug the VTX, wait 10 seconds, plug it back in and try again." });
      } else {
        emit("flash-done", { ok: true, message: "Done — now on V1.3.0", hint: null });
      }
    });
  }

  const commands = {
    get_device: async () => current,
    inspect_firmware: async ({ path }) => {
      if (!current) throw "No device connected";
      return parse(path);
    },
    start_flash: async ({ path, confirmedFirmware, confirmedWarnings }) => {
      if (!current || !current.flashable) throw "No flashable device connected";
      if (!path || typeof confirmedFirmware !== "string" || !Array.isArray(confirmedWarnings)) {
        throw "start_flash: missing arguments";
      }
      if (scenario === "changed" || confirmedFirmware !== current.firmware) {
        throw `The device changed since you confirmed (it now reports ${current.firmware}) — nothing was written. Check it and try again.`;
      }
      const now = parse(path).warnings.map((w) => w.kind).sort();
      if (JSON.stringify(now) !== JSON.stringify([...confirmedWarnings].sort())) {
        throw "The file's warnings changed since you confirmed — nothing was written. Choose the file again.";
      }
      runFlash();
    },
    cancel_flash: async () => {
      if (locked) return;
      cancelled = true;
      timers.forEach(clearTimeout); timers = [];
      later(300, () => { flashing = false; });
      later(300, () => emit("flash-done", { ok: false, message: "upgrade cancelled (device unchanged)", hint: null }));
    },
  };

  window.__TAURI__ = {
    core: {
      invoke: (cmd, args) => (commands[cmd] ? commands[cmd](args || {}) : Promise.reject("unknown command " + cmd)),
    },
    event: {
      listen: async (name, fn) => {
        (listeners[name] = listeners[name] || []).push(fn);
        return () => { listeners[name] = listeners[name].filter((f) => f !== fn); };
      },
    },
    dialog: {
      open: async () => window.prompt("Firmware path:", "/Users/me/Downloads/Ascent_H_Sky_17_5_8.img") || null,
      ask: async (text) => window.confirm(text),
    },
    webview: {
      getCurrentWebview: () => ({
        onDragDropEvent: (fn) => {
          // Browser stand-in: real file drops provide no path, so use the file name.
          addEventListener("dragover", (e) => e.preventDefault());
          addEventListener("drop", (e) => {
            e.preventDefault();
            const f = e.dataTransfer && e.dataTransfer.files[0];
            if (f) fn({ payload: { type: "drop", paths: [f.name] } });
          });
          return Promise.resolve(() => {});
        },
      }),
    },
  };

  // Like the backend's close/quit guard: blocked (with an event) while flashing.
  window.__mockCloseRequest = () => {
    if (flashing) { emit("close-blocked", { locked }); return false; }
    return true;
  };

  // Let the page toggle device presence in the console: __mockDevice(null|{...})
  window.__mockDevice = (d) => { current = d === undefined ? { ...device } : d; emit("device-changed", current); };
})();
