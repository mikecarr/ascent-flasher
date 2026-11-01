(() => {
  "use strict";
  const T = window.__TAURI__;
  const { invoke } = T.core;
  const { listen } = T.event;
  const dialog = T.dialog;

  const $ = (id) => document.getElementById(id);
  const el = {
    dot: $("dot"), name: $("dev-name"), port: $("dev-port"), note: $("dev-note"),
    grid: $("dev-grid"), fw: $("dev-fw"), hw: $("dev-hw"), sn: $("dev-sn"), temp: $("dev-temp"),
    drop: $("drop"), dropText: $("drop-text"), flash: $("flash"),
    progWrap: $("progress-wrap"), bar: $("bar"), fill: $("fill"), status: $("status"),
    result: $("result"), resultTitle: $("result-title"), resultMsg: $("result-msg"),
    resultHint: $("result-hint"), again: $("again"),
  };

  // Single source of truth for the UI.
  // mode: "idle" | "flashing" | "done"
  const s = {
    mode: "idle",
    device: null,        // DeviceView | null
    path: null,          // chosen firmware path
    fw: null,            // FirmwareView for the chosen path
    locked: false,       // cancelLocked
    busy: false,         // confirm dialogs / start_flash in flight
    done: null,          // FlashDone
    progress: null,      // last ProgressEvent
  };

  const flashable = () => !!(s.device && s.device.flashable);

  function render() {
    // Device card
    const d = s.device;
    el.dot.classList.toggle("on", !!d);
    if (!d) {
      el.name.textContent = "Plug in your Ascent device";
      el.port.textContent = "";
      el.grid.hidden = true;
      el.note.hidden = true;
    } else {
      el.name.textContent = d.name;
      el.port.textContent = d.port;
      el.grid.hidden = false;
      el.fw.textContent = d.firmware || "–";
      el.hw.textContent = d.hardware || "–";
      el.sn.textContent = d.serial || "–";
      el.temp.textContent = Number.isFinite(d.tempC) ? String(d.tempC) : "–";
      const notes = [];
      if (!d.flashable) notes.push("This device can't be flashed by this app");
      if (d.otherCount > 0) notes.push(`${d.otherCount} other device${d.otherCount > 1 ? "s" : ""} also connected`);
      el.note.hidden = notes.length === 0;
      el.note.textContent = notes.join(". ");
    }

    // Drop zone
    const flashing = s.mode === "flashing";
    el.drop.classList.toggle("disabled", flashing);
    el.drop.setAttribute("aria-disabled", String(flashing));
    el.drop.tabIndex = flashing ? -1 : 0;
    el.drop.classList.toggle("has-file", !!s.fw);
    if (s.fw) {
      const v = s.fw.version ? ` → ${s.fw.version}` : "";
      el.dropText.textContent = "";
      const span = document.createElement("span");
      span.className = "fname";
      span.textContent = `Selected: ${s.fw.fileName}${v}`;
      el.dropText.appendChild(span);
    } else {
      el.dropText.textContent = "Drop firmware .img here, or click to choose";
    }

    // Button
    el.flash.classList.remove("cancel");
    if (flashing) {
      if (s.locked) {
        el.flash.textContent = "Device is writing firmware — do not unplug";
        el.flash.disabled = true;
      } else {
        el.flash.textContent = "Cancel";
        el.flash.classList.add("cancel");
        el.flash.disabled = false;
      }
    } else {
      el.flash.textContent = "Flash firmware";
      el.flash.disabled = s.busy || !(flashable() && s.fw);
    }
    el.flash.hidden = s.mode === "done";

    // Progress
    el.progWrap.hidden = !flashing;
    const p = s.progress;
    const pct = p && typeof p.percent === "number" ? Math.round(p.percent * 100) : null;
    el.bar.classList.toggle("indeterminate", flashing && pct === null);
    if (flashing && pct !== null) {
      el.fill.style.width = pct + "%";
      el.bar.setAttribute("aria-valuenow", String(pct));
    } else {
      el.fill.style.width = "";
      el.bar.removeAttribute("aria-valuenow");
    }
    el.status.textContent = flashing ? (p ? p.text : "Starting…") : "";

    // Result
    const done = s.mode === "done" && s.done;
    el.result.hidden = !done;
    if (done) {
      const cancelled = !s.done.ok && /^upgrade cancelled/i.test(s.done.message || "");
      el.result.className = "result " + (s.done.ok ? "ok" : cancelled ? "neutral" : "err");
      el.result.setAttribute("role", s.done.ok || cancelled ? "status" : "alert");
      el.resultTitle.textContent = s.done.ok ? "Flash complete" : cancelled ? "Flash cancelled" : "Flash failed";
      el.resultMsg.textContent = s.done.message;
      el.resultHint.hidden = !s.done.hint;
      el.resultHint.textContent = s.done.hint || "";
    }
  }

  function showError(msg) {
    s.mode = "done";
    s.done = { ok: false, message: String(msg), hint: null };
    render();
  }

  function resetToIdle() {
    if (s.mode === "flashing") return;
    s.mode = "idle";
    s.done = null;
    s.progress = null;
    s.locked = false;
    render();
  }

  async function inspect(path) {
    try {
      s.fw = await invoke("inspect_firmware", { path });
      s.path = path;
    } catch (e) {
      s.fw = null;
      s.path = null;
      showError(e);
      return;
    }
    s.mode = "idle";
    s.done = null;
    s.progress = null;
    render();
  }

  async function chooseFile() {
    if (s.mode === "flashing" || s.busy) return;
    let picked;
    try {
      picked = await dialog.open({
        multiple: false,
        directory: false,
        filters: [{ name: "Firmware", extensions: ["img"] }],
      });
    } catch (e) {
      showError(e);
      return;
    }
    if (!picked || s.busy || s.mode === "flashing") return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) await inspect(path);
  }

  async function onFlashClick() {
    if (s.mode === "flashing") {
      if (!s.locked) {
        try { await invoke("cancel_flash"); } catch (e) { /* ignore */ }
        el.status.textContent = "Cancelling…";
      }
      return;
    }
    if (s.busy || !flashable() || !s.fw || !s.path) return;
    const path = s.path, fw = s.fw; // snapshot: what the user confirms is what is flashed
    s.busy = true;
    render();
    try {
      for (const w of fw.warnings || []) {
        const ok = await dialog.ask(w.text, { title: "Warning", kind: "warning" });
        if (!ok) return;
      }
      const go = await dialog.ask("Keep USB connected and the VTX powered. Flash now?", {
        title: "Flash firmware",
      });
      if (!go) return;
      s.mode = "flashing";
      s.locked = false;
      s.progress = null;
      s.done = null;
      render();
      await invoke("start_flash", { path });
    } catch (e) {
      s.mode = "idle";
      showError(e);
    } finally {
      s.busy = false;
      render();
    }
  }

  async function setDevice(dev) {
    s.device = dev || null;
    // Keep the file's warnings in step with the (possibly re-flashed) device.
    if (s.path && s.mode !== "flashing" && !s.busy) {
      if (!s.device) {
        render();
        return;
      }
      try {
        s.fw = await invoke("inspect_firmware", { path: s.path });
      } catch (e) { /* keep the previous inspection */ }
    }
    render();
  }

  // Events
  listen("device-changed", (ev) => {
    if (s.mode === "flashing") return; // watcher is paused; ignore strays
    setDevice(ev.payload);
  }).catch(console.error);
  listen("flash-progress", (ev) => {
    if (s.mode !== "flashing") return;
    s.progress = ev.payload;
    if (ev.payload.cancelLocked) s.locked = true;
    render();
  }).catch(console.error);
  listen("flash-done", (ev) => {
    s.mode = "done";
    s.locked = false;
    s.progress = null;
    s.done = ev.payload;
    render();
  }).catch(console.error);

  // UI wiring
  el.flash.addEventListener("click", onFlashClick);
  el.drop.addEventListener("click", chooseFile);
  el.drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      chooseFile();
    }
  });
  el.again.addEventListener("click", resetToIdle);

  // Drag and drop (Tauri webview events carry real paths)
  try {
    Promise.resolve(T.webview.getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      if (s.mode === "flashing") { el.drop.classList.remove("over"); return; }
      if (p.type === "enter" || p.type === "over") el.drop.classList.add("over");
      else if (p.type === "leave") el.drop.classList.remove("over");
      else if (p.type === "drop") {
        el.drop.classList.remove("over");
        if (p.paths && p.paths.length && !s.busy) inspect(p.paths[0]);
      }
    })).catch((e) => console.error("drag-drop failed", e));
  } catch (e) { console.error("drag-drop unavailable", e); }

  render();
  invoke("get_device").then(setDevice).catch(() => {});
})();
