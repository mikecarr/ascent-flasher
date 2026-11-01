# Ascent Web Flasher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static web page that flashes Ascent Lite, Lite+ and VRX Pro firmware from Chrome/Edge over Web Serial, with the same sequence and safety rules as the Rust tool; the Rust CLI stays as the backup and the Tauri app is retired.

**Architecture:** A browser port of our own Rust core (`crates/ascent-proto`), split into DOM-free ES modules under `web/lib/` that run unchanged in Node for tests. Serial I/O, time and the device are injected (`Connector`/`Link`, `Clock`), so the upgrade state machine is tested against a simulated device with a virtual clock. The page (`web/index.html`, `web/ui.js`) reuses the Mac app's UI state machine with a Web Serial backend.

**Tech Stack:** Plain HTML/CSS/JavaScript ES modules, no build step, no npm dependencies; Web Serial API; Node ≥ 20 built-in test runner (`node --test`); Rust (CLI changes only); GitHub Actions + GitHub Pages.

**Spec:** [docs/superpowers/specs/2026-11-01-web-flasher-design.md](../specs/2026-11-01-web-flasher-design.md). Behaviour reference: the Rust sources and tests named in each task (our own code; porting them is not a clean-room problem). Protocol facts: [docs/REVERSE_ENGINEERING.md](../../REVERSE_ENGINEERING.md).

## Global Constraints

- Static files only, servable as-is (no bundler, no `npm install`). *(Builder's choice in the spec; decided here.)*
- Tests: `node --test web/test/` must pass; `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` must stay green.
- Never copy code from Caddx's tools or from Gehee's flasher. Never commit `reference/`, firmware, `*.zip`, `*.exe`, fonts or PDFs.
- Supported for flashing: `ascent_lite`, `ascent_lite_plus`, `ascent_vrx_pro` (device name, case-insensitive). Every other Ascent unit: info only, with a note asking the owner to report what it shows.
- A model whose `confirmed` flag is false may be flashed **only when `location.hostname` is `localhost` or `127.0.0.1`**. No URL switch or setting unlocks it elsewhere.
- Connecting and Info send only FIND_DEVICE (cmd 60). Nothing else is sent without a Flash click.
- File-size cap: **256 MiB** (268435456 bytes), page and CLI.
- Writing-phase limit: **300 s** for Lite/Lite+, **600 s** for VRX Pro.
- Reopen delays: the Windows tool's per-VID table, as in `crates/ascent-proto/src/discovery.rs` `reopen_delay_for_vid` (1D76 → 11500 ms, 1D77 → 12000 ms).
- Resend at 2 s, give up at 8 s; reconnect timeout 200 s; status poll every 1 s.
- Cancel locks before SENDFILE_END is sent; no reboot after the lock except on a negative status or a rejected transfer; "recovered" only when the unit was seen to drop off USB and return.
- No mid-flash port re-pick: reconnect uses only `navigator.serial.getPorts()`.
- The page says it is unofficial and not affiliated with Caddx. English only.
- Branch: `feat/web-flasher`, created from `spike/web-serial`. Local commits are fine; never push without the user asking.

## Review Focus

1. **Wrong model's file** (a 180 MB `Ascent_VRX_Pro_…img` picked for a Lite): a name-mismatch warning the user must confirm, never a silent flash. Test: `preflight warns name mismatch for VRX Pro file on a Lite` (Task 2).
2. **Port already held by another tab or app** (seen on hardware: Chrome held it): opening fails with plain words ("The VTX is in use by another app or tab — close it and try again"), not a raw DOMException. Test: `open on a busy port gives the in-use message` (Task 4).
3. **USB pulled mid-transfer**: the Rust outcome rules apply (reconnect, recovery only before the lock). Test: port of `unplug_mid_transfer` (Task 3).
4. **Tab closed or reloaded while flashing**: a "Leave site?" prompt is armed only while a flash runs, and removed afterwards. Test: `leave guard is armed only while flashing` (Task 5).
5. **Unconfirmed model on the public site**: info shows, the Flash button never enables. Test: `unconfirmed model can flash only on localhost` (Task 2).

---

### Task 0: Branch and commit the design

- [ ] **Step 1:** `git switch spike/web-serial && git switch -c feat/web-flasher`
- [ ] **Step 2:** Commit the spec and this plan.

```bash
git add docs/superpowers/specs/2026-11-01-web-flasher-design.md docs/superpowers/plans/2026-11-01-web-flasher.md
git commit -m "docs: web flasher design and implementation plan"
```

---

### Task 1: Protocol library (frames, reader, payloads)

**Files:**
- Create: `web/lib/protocol.js`
- Create: `web/test/protocol.test.js`
- Modify: `web/serial-test/serial-test.js` (import from `../lib/protocol.js`)
- Delete: `web/serial-test/ar-protocol.js`

**Interfaces:**
- Produces (all exported from `web/lib/protocol.js`):
  - `MAGIC`, `HEADER_LEN = 36`, `MAX_FRAME_LEN = 5120`
  - `CMD = { REBOOT: 3, FIND_DEVICE: 60, REMOTE_UPGRADE: 114, SENDFILE_START: 115, SENDFILE_DATA: 116, SENDFILE_END: 117, UPGRADE_STATUS: 118 }`
  - `crc32(...parts: Uint8Array[]) -> number`
  - `encodeRequest(cmd, payload, seq, retry) -> Uint8Array`, `encodeAck(cmd, payload, seq) -> Uint8Array`
  - `decodeHeader(bytes) -> Header | null` where `Header = {type, command, format, length, seq, retry, crc32}`
  - `class FrameReader { push(chunk); next() -> {header, payload} | null }`
  - `decodeDeviceInfo(b) -> DeviceInfo` / `encodeDeviceInfo(info) -> Uint8Array` (300 bytes; fields `receiveMaxSize, sdkVersion, deviceName, cpuTemp, firmware, serialNumber, hardwareVersion, status, detail`)
  - `fileInfo(md5Hex, length, remotePath, localDir) -> Uint8Array` (328 bytes)
  - `decodeFileDataInfo(b) -> {length, cursize, totalsize, status, detail}` / `encodeFileDataInfo(x)`
  - `decodeUpgradeStatus(b) -> {percent, status, detail}` / `encodeUpgradeStatus(x)`
  - `rebootPayload(mode) -> Uint8Array(32)`, `statusMessage(code) -> string`

Byte layouts: copy from `crates/ascent-proto/src/frame.rs` and `payload.rs`. The test page's `ar-protocol.js` already has the frame, reader and device-info parts, checked against an independent encoder; move them here.

- [ ] **Step 1: Write the failing tests** in `web/test/protocol.test.js`, one `test()` per Rust test in `crates/ascent-proto/tests/frame.rs`, `reader.rs` and `payload.rs`, same names in camelCase and the same byte values (e.g. `crcMatchesStandardVector`: `crc32(ascii("123456789")) === 0xCBF43926`; `deviceInfoDecodesOffsets`, `fileInfoLayout`, `rebootModePads`, `skipsOversizedLength`, `twoFramesInOnePush`, …).
- [ ] **Step 2:** `node --test web/test/` → FAIL (module missing).
- [ ] **Step 3:** Implement `web/lib/protocol.js`; make `serial-test.js` import it; delete `ar-protocol.js`.
- [ ] **Step 4:** `node --test web/test/` → PASS. Serve `web/` locally and confirm the test page still loads with no console errors.
- [ ] **Step 5:** Commit: `feat(web): shared AR protocol library with ported tests`

---

### Task 2: Models, firmware checks and MD5

**Files:**
- Create: `web/lib/models.js`, `web/lib/firmware.js`, `web/lib/md5.js`
- Create: `web/test/models.test.js`, `web/test/firmware.test.js`, `web/test/md5.test.js`

**Interfaces:**
- Consumes: `DeviceInfo` (Task 1).
- Produces:
  - `models.js`: `MODELS` (array of `{name, label, filePrefix, power: "usb"|"external", writingTimeoutMs, confirmed}`) with exactly:
    - `{name: "ascent_lite", label: "Ascent Lite", filePrefix: "H_Sky", power: "usb", writingTimeoutMs: 300000, confirmed: false}`
    - `{name: "ascent_lite_plus", label: "Ascent Lite+", filePrefix: "H_Sky", power: "usb", writingTimeoutMs: 300000, confirmed: false}`
    - `{name: "ascent_vrx_pro", label: "Ascent VRX Pro", filePrefix: "VRX_Pro", power: "external", writingTimeoutMs: 600000, confirmed: false}`
  - `modelFor(deviceName) -> Model | null` (case-insensitive), `isLocalHost(hostname) -> boolean`, `canFlash(model, hostname) -> boolean` (`model.confirmed || isLocalHost(hostname)`), `isCandidateVid(vid)`, `CANDIDATE_VIDS`, `reopenDelayMs(vid) -> number` (table from `discovery.rs`).
  - `md5.js`: `md5Hex(bytes: Uint8Array) -> string` (lowercase hex). Own implementation (RFC 1321); no dependency.
  - `firmware.js`: `MAX_FIRMWARE_BYTES = 268435456`, `REMOTE_DIR = "/tmp/pc/"`, `fileVersion(name)`, `deviceVersion(firmware)`, `compareVersions(a, b) -> -1|0|1`, `formatVersion(v)`, `nameMatches(fileName, firmware)`, `warningText(w)`, `class PreflightError extends Error { kind }` with kinds `notFlashable | notImg | badFileName | empty | tooLarge | unreadable`, and
    `async preflight(info, file, hostname) -> {firmware: {name, bytes, md5Hex, version}, warnings}` where `file` is File-like `{name, size, arrayBuffer()}`. Warnings: `{kind: "downgrade", from, to}`, `{kind: "nameMismatch", expected}`, `{kind: "unknownVersion"}`.

Rules: port `crates/ascent-proto/src/firmware.rs`, minus the path-length check (a browser has no path). `notFlashable` when `modelFor` is null or `!canFlash(model, hostname)`. Check `file.size` against the cap **before** `arrayBuffer()`, and the byte length again after. `tooLarge` message: `firmware file is too large (N MB) — Ascent images are at most about 180 MB; is this the right file?`

- [ ] **Step 1: Write the failing tests:**
  - Port each test in `crates/ascent-proto/tests/firmware.rs` (`parsesFileVersions`, `parsesDeviceVersion`, `nameMatchRules`, `preflightRejects`, `preflightWarnsDowngrade`, `preflightCleanUpgrade`, `preflightNameMismatchWarns`, `preflightUnknownVersionWarns`, `preflightRejectsOversize`, `preflightRejectsLongFileName`, `preflightRejectsNonAsciiFileName`).
  - `md5 known vectors`: `md5Hex(ascii("")) === "d41d8cd98f00b204e9800998ecf8427e"`, `md5Hex(ascii("abc")) === "900150983cd24fb0d6963f7d28e17f72"`, `md5Hex(ascii("The quick brown fox jumps over the lazy dog")) === "9e107d9d372bb6826bd81d3542a419d6"`, plus a 1 000 001-byte buffer of `0x61` checked against `node:crypto` (test-only).
  - `VRX Pro file matches VRX Pro firmware`: `nameMatches("Ascent_VRX_Pro_18_21_10.img", "Ascent_VRX_Pro_18_21_10") === true`.
  - `preflight warns name mismatch for VRX Pro file on a Lite` (Review Focus 1): Lite info on `Ascent_H_Sky_18_21_10`, file `Ascent_VRX_Pro_18_21_10.img` → warnings include `{kind: "nameMismatch", expected: "H_Sky"}`.
  - `oversize is rejected before reading`: `{name: "Ascent_H_Sky_18_21_10.img", size: 268435457, arrayBuffer: () => assert.fail("read")}` → `tooLarge`.
  - `unconfirmed model can flash only on localhost` (Review Focus 5): `canFlash(lite, "localhost") === true`, `canFlash(lite, "127.0.0.1") === true`, `canFlash(lite, "mikecarr.github.io") === false`, `canFlash({...lite, confirmed: true}, "mikecarr.github.io") === true`; and `preflight` with hostname `mikecarr.github.io` → `notFlashable`.
  - `models`: `modelFor("Ascent_VRX_pro").name === "ascent_vrx_pro"`, `modelFor("Ascent") === null`, `reopenDelayMs(0x1D76) === 11500`, `reopenDelayMs(0x1D77) === 12000`.
- [ ] **Step 2:** `node --test web/test/` → FAIL.
- [ ] **Step 3:** Implement the three modules.
- [ ] **Step 4:** `node --test web/test/` → PASS.
- [ ] **Step 5:** Commit: `feat(web): models, firmware preflight and MD5`

---

### Task 3: Session, simulated device and upgrade state machine

**Files:**
- Create: `web/lib/clock.js`, `web/lib/link.js`, `web/lib/session.js`, `web/lib/sim.js`, `web/lib/upgrade.js`
- Create: `web/test/session.test.js`, `web/test/upgrade.test.js`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `clock.js`: `realClock = {now() -> ms, sleep(ms) -> Promise}`; `class VirtualClock` with the same methods, where `sleep` advances virtual time and resolves on the next microtask (tests run with no real waiting).
  - `link.js` (the transport contract, mirrors `crates/ascent-proto/src/link.rs`):
    - `PortInfo = {id: string, vid, pid, serial?: string}`
    - `Connector = {list() -> Promise<PortInfo[]>, open(PortInfo) -> Promise<Link>}`
    - `Link = {write(bytes) -> Promise<void>, read(timeoutMs) -> Promise<Uint8Array | null>, close() -> Promise<void>}`; `read` resolves `null` on timeout.
    - `class LinkGoneError extends Error` (device unplugged or rebooting), `class PortBusyError extends Error`.
  - `session.js`: `class Session { constructor(link, clock, {resendMs = 2000, giveUpMs = 8000} = {}); request(cmd, payload) -> Promise<{header, payload}>; sendNoAck(cmd, payload) -> Promise<void>; findDevice() -> Promise<DeviceInfo>; echoesSeq: boolean | null }`. Seq starts at 1; port `crates/ascent-proto/src/session.rs` (seq-echo learning, stale-ack skipping).
  - `sim.js`: `class SimDevice` and `class SimConnector` (port of `crates/ascent-proto/src/sim.rs`, driven by a `VirtualClock`): device name/firmware/VID/PID configurable, `log` of request headers, reboot drop/return timing, scripted status sequence, error injection (unplug after N chunks, negative status, transfer rejection, ignoring REBOOT "normal", busy port).
  - `upgrade.js`: `Phase` names (`rebooting, reconnecting, enteringUpgrade, startingTransfer, sending, finishing, writing, restarting, verifying`), `class CancelToken { cancel(); get cancelled }`, `progressText(p) -> string` (exact strings from `upgrade.rs` `progress_text`), `class UpgradeError extends Error { kind, recovered?, code?, firmware? ; get hint }` (kinds and messages from the Rust `UpgradeError`; `hint` from `recovery_hint`), and
    `async runUpgrade({connector, port, firmware, expected, model, cancel, onProgress, clock}) -> {firmware: string}`. `expected` is the device firmware string the user confirmed. Options come from `model.writingTimeoutMs` and `reopenDelayMs(port.vid)`; reconnect timeout 200 s; status poll 1 s.

Port `crates/ascent-proto/src/upgrade.rs` behaviour-for-behaviour (its module doc lists the invariants).

- [ ] **Step 1: Write the failing tests:**
  - `session.test.js`: one test per Rust test in `crates/ascent-proto/tests/session.rs`.
  - `upgrade.test.js`: one test per Rust test in `crates/ascent-proto/tests/upgrade.rs` (`reopenDelaysByVid` … `ioFailureReconnectsBeforeRecoveryReboot`; `unplugMidTransfer` covers Review Focus 3), with the same assertions on the simulated device's request log and the error kinds. Plus:
    - `VRX Pro uses a 600 s writing limit`: model `ascent_vrx_pro`, sim status stuck at 50 % → `outcomeUnknown` after virtual 600 s, not 300 s.
    - `progress text matches the app`: e.g. `progressText({type: "sent", bytes: 45, total: 100}) === "Sending firmware… 45%"`.
- [ ] **Step 2:** `node --test web/test/` → FAIL.
- [ ] **Step 3:** Implement the five modules.
- [ ] **Step 4:** `node --test web/test/` → PASS (whole suite in a few seconds of real time).
- [ ] **Step 5:** Commit: `feat(web): session, simulated device and upgrade state machine`

---

### Task 4: Web Serial transport and device watcher

**Files:**
- Create: `web/lib/webserial.js`
- Create: `web/test/webserial.test.js` (with a fake `navigator.serial`)

**Interfaces:**
- Consumes: `Connector`/`Link`/`PortInfo`/errors (Task 3), `CANDIDATE_VIDS`, `isCandidateVid` (Task 2), `Session` (Task 3).
- Produces:
  - `class WebSerialConnector { constructor(serial = navigator.serial) }` implementing `Connector`: `list()` returns permitted ports from `serial.getPorts()` with candidate VIDs (id stable per `SerialPort` object); `open()` opens at 115200 baud and returns a `Link`. An `InvalidStateError`/`NetworkError` from `port.open` becomes `PortBusyError("The VTX is in use by another app or tab — close it and try again.")`; a read/write failure after the device leaves becomes `LinkGoneError`.
  - `async requestDevice(serial = navigator.serial) -> PortInfo | null` (the picker, filtered to `CANDIDATE_VIDS`; null if dismissed).
  - `class DeviceWatcher { constructor(connector, clock, onChange); start(); stop(); pause(); resume(); rescan() }`: probes (FIND_DEVICE) only when the set of permitted candidate ports changes, on `rescan()`, or for up to 4 early retries while a candidate hasn't answered; never while paused (a flash pauses it). Listens to `connect`/`disconnect` events and also polls `getPorts()` every 1 s. `onChange({port, info} | null)`. Same rules as `spawn_watcher` in `app/src-tauri/src/state.rs`.

- [ ] **Step 1: Write the failing tests:**
  - `open on a busy port gives the in-use message` (Review Focus 2): fake port whose `open` rejects with `DOMException("…", "InvalidStateError")` → `PortBusyError` with that message.
  - `list returns only permitted candidate ports`: fake `getPorts()` with VIDs 0x1D76, 0x1234 → only 0x1D76.
  - `watcher probes only on change`: two ticks with the same ports → one FIND_DEVICE in the sim log; a third tick after a `disconnect` → `onChange(null)`.
  - `watcher sends nothing while paused`.
  - `link read returns null on timeout and data otherwise` (fake readable stream).
- [ ] **Step 2:** `node --test web/test/` → FAIL.
- [ ] **Step 3:** Implement `web/lib/webserial.js`.
- [ ] **Step 4:** `node --test web/test/` → PASS.
- [ ] **Step 5:** Commit: `feat(web): Web Serial connector and device watcher`

---

### Task 5: The flasher page

**Files:**
- Create: `web/index.html`, `web/style.css`, `web/ui.js`, `web/lib/session-log.js`, `web/lib/guards.js`
- Create: `web/test/guards.test.js`, `web/test/session-log.test.js`
- Reference (do not modify): `app/ui/index.html`, `app/ui/style.css`, `app/ui/main.js` (layout, state machine, copy)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `session-log.js`: `class SessionLog { line(msg); text() -> string; download(filename) }` (timestamps relative to page load; `download` saves a `.txt` via a Blob URL). All lib modules accept an optional `log(msg)` callback; `ui.js` passes `sessionLog.line`.
  - `guards.js`: `class FlashGuards { constructor(win = window, nav = navigator); arm(); disarm(); get armed }`: `arm()` adds the `beforeunload` handler and requests a screen wake lock (ignore failure); `disarm()` removes both.

Page behaviour (layout A from the Mac app: device card, file drop zone, Flash/Cancel button, progress, result):
- No Web Serial → a notice: "This page needs Chrome or Edge on a computer (Web Serial). Safari and Firefox can't talk to USB serial devices." All controls disabled.
- **Connect…** (`requestDevice`) and **Info** (re-runs FIND_DEVICE, read-only). The `DeviceWatcher` keeps the card current after the first pick.
- Device card shows the `DeviceInfo` fields. Unsupported model → "Info only: this model hasn't been confirmed with this flasher yet. If you'd like it supported, open an issue with the info above." Supported but `!canFlash` → the same "not confirmed yet" note. VRX Pro → "The VRX Pro needs its own power (DC barrel, 2–6S) during the update; USB-C carries data only."
- File: `<input type="file" accept=".img">` plus drag-and-drop; runs `preflight` and shows version and warnings.
- Flash: the confirm sequence and snapshot rules from `app/ui/main.js` (downgrade confirm, name-mismatch confirm, final "keep USB connected and the unit powered" confirm; refuse if the device firmware or warnings changed since confirming). Pause the watcher, `guards.arm()`, `runUpgrade` with `realClock`, then `guards.disarm()` and resume in `finally`.
- Cancel and lock: the rules from `app/ui/main.js` including the "Cancelling…" state (commit `4499308`).
- Result: "Flash complete", "Flash cancelled", "Result unknown" (for `outcomeUnknown`), or "Flash failed", plus `UpgradeError.hint`.
- **Download log** button, always visible.
- Footer: "Unofficial. Not affiliated with Caddx." and a link to the GitHub repo.
- `?sim=lite|vrxpro|error` uses `SimConnector` with `realClock`, **only when `isLocalHost(location.hostname)`**; ignored elsewhere.

- [ ] **Step 1: Write the failing tests:**
  - `leave guard is armed only while flashing` (Review Focus 4): fake `win` records `addEventListener("beforeunload")`/`removeEventListener`; fake `nav.wakeLock.request` resolves a sentinel with `release()`. `arm()` adds the handler and requests the lock; `disarm()` removes the handler and releases; the handler sets `event.returnValue` only while armed.
  - `wake lock failure is ignored`: `request` rejects → `arm()` still resolves, `armed === true`.
  - `session log text has relative timestamps and keeps order`.
- [ ] **Step 2:** `node --test web/test/` → FAIL.
- [ ] **Step 3:** Implement `guards.js`, `session-log.js`, then the page.
- [ ] **Step 4:** `node --test web/test/` → PASS. Then serve locally (`python3 -m http.server 8766 --bind 127.0.0.1` from `web/`) and check in a browser, using the in-app browser pane:
  - `http://localhost:8766/?sim=lite`: connect, Info, choose a file, flash to "Flash complete"; Cancel during "Reconnecting…" shows "Cancelling…", then "Flash cancelled".
  - `?sim=vrxpro`: the power note shows.
  - `?sim=error`: "Flash failed" with a hint.
  - No console errors.
- [ ] **Step 5:** Commit: `feat(web): flasher page`

---

### Task 6: CLI covers the VRX Pro

**Files:**
- Modify: `crates/ascent-proto/src/discovery.rs` (`is_flashable_name`)
- Modify: `crates/ascent-proto/src/firmware.rs` (`MAX_FIRMWARE_BYTES`, `TooLarge` message)
- Modify: `crates/ascent-proto/src/upgrade.rs` (`UpgradeOptions::for_port` → also takes the device name)
- Modify: `crates/ascent-cli/src/main.rs` (pass the device name)
- Test: `crates/ascent-proto/tests/discovery.rs`, `tests/firmware.rs`, `tests/upgrade.rs`

**Interfaces:**
- Produces: `is_flashable_name("Ascent_VRX_pro") == true`; `MAX_FIRMWARE_BYTES = 256 * 1024 * 1024`; `UpgradeOptions::for_device(port: &PortInfo, device_name: &str) -> UpgradeOptions` with `writing_timeout` 600 s for `ascent_vrx_pro`, 300 s otherwise (replaces `for_port`; update all callers).

- [ ] **Step 1: Write the failing tests:** extend `flashable_names` with `Ascent_VRX_pro`; `preflight_rejects_oversize` at 256 MiB + 1; `vrx_pro_writing_timeout` (`for_device(&port, "Ascent_VRX_pro").writing_timeout == Duration::from_secs(600)`, and 300 s for `Ascent_lite`).
- [ ] **Step 2:** `cargo test --workspace` → FAIL.
- [ ] **Step 3:** Implement. `TooLarge` message: same text as the page's.
- [ ] **Step 4:** `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` → PASS.
- [ ] **Step 5:** Commit: `feat(cli): VRX Pro support, 256 MiB cap, per-model writing limit`

---

### Task 7: Hardware confirmation (done by the user, guided)

No code until a step passes; each passing model gets `confirmed: true` in `web/lib/models.js`.

- [ ] **Step 1: Lite on macOS** (local page, Chrome): flash `Ascent_H_Sky_18_21_10.img` (same version). Save the downloaded log under `docs/hardware-logs/` (no firmware in it), and add a short entry to `docs/REVERSE_ENGINEERING.md`.
- [ ] **Step 2: Lite on Windows** (local page served the same way, Chrome or Edge): the same flash. Record the driver and whether the permission survived the reboot.
- [ ] **Step 3:** Set Lite `confirmed: true`; commit: `feat(web): Lite confirmed on macOS and Windows`.
- [ ] **Step 4: Lite+** on macOS: one same-version flash → `confirmed: true`, commit.
- [ ] **Step 5: VRX Pro** on its own power supply: reconnect test (`web/serial-test/`, after enabling its reboot button for `ascent_vrx_pro`), then one same-version flash with the 180 MB image → record the write time and whether REBOOT "normal" was needed → `confirmed: true`, commit. If the reconnect test fails, the VRX Pro stays info-only (spec: no mid-flash re-pick).

---

### Task 8: Retire the Mac app, README, and Pages deploy

Start only after Task 7 Step 3 (Lite confirmed on macOS and Windows).

**Files:**
- Delete: `app/`
- Modify: `Cargo.toml` (workspace `members = ["crates/*"]`), `.gitignore` (drop Tauri entries)
- Modify: `README.md`
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1:** Delete `app/` and remove it from the workspace; `cargo test --workspace` and clippy → PASS.
- [ ] **Step 2:** Rewrite `README.md` around the web page:
  - the link `https://mikecarr.github.io/ascent-flasher/`;
  - supported models and how a model gets confirmed;
  - tested systems: macOS and Windows; Linux and ChromeOS "should work, not tested yet";
  - the VRX Pro power note;
  - the CLI as the backup (build and usage);
  - "Unofficial; not affiliated with Caddx"; MIT.
- [ ] **Step 3:** `pages.yml`, triggered by **`workflow_dispatch` only** (deploys never happen on push). Steps:
  1. Check out the repo.
  2. Run `node --test web/test/`.
  3. Copy `web/` to `_site/` without `web/test/` and `web/serial-test/`.
  4. Upload with `actions/upload-pages-artifact`.
  5. Deploy with `actions/deploy-pages`.
- [ ] **Step 4:** Commit: `chore: retire the Tauri app; README for the web flasher; manual Pages deploy`.
- [ ] **Step 5:** Hand over to the user. Enabling Pages ("GitHub Actions" as the source), merging, pushing and running the workflow are the user's calls.
