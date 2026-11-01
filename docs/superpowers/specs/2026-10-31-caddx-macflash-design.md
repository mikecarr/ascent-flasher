# Caddx Mac Flash — Design

Date: 2026-10-31
Protocol reference: [docs/REVERSE_ENGINEERING.md](../../REVERSE_ENGINEERING.md). All wire formats, command numbers, struct layouts and error codes are there. This document doesn't repeat them.

## Intent

Caddx only ships its "PC Tool" for Windows. The user wants to flash firmware onto their **Caddx Ascent Lite+ VTX** from a **Mac**, without needing Windows. We reverse-engineered the Windows tool (a .NET app). The device is a USB CDC serial device that speaks a small binary protocol (Artosyn "AR" frames). This project re-implements the flashing part of that tool in Rust, with a native-feeling Mac window.

Success: the user plugs in the Lite+, picks a `.img` file, presses Flash, and the VTX ends up on the new firmware. The flow should be as safe as the Windows tool's, or safer.

## Goals

1. Detect an Ascent device on USB and show its identity: name, firmware version, hardware version, serial number, CPU temperature.
2. Flash a user-selected `.img` firmware file using the same sequence as the Windows tool.
3. Give clear progress, and plain-language errors that use the device's own failure codes.
4. Provide a command-line tool built on the same core, used first to prove the protocol against real hardware, and kept afterwards as a debugging aid.

## Non-goals (for now)

- Linux packaging. The core should not block Linux later, but only macOS is built and tested.
- Devices other than Ascent Lite/Lite+. Other Ascent devices use the same protocol and may just work, but they aren't a target and aren't tested.
- Gimbal, RC Mode, Cam Hub, BB-frequency (Update channel) and CLI screens.
- Downloading firmware. The user always supplies the `.img`.
- Auto-update, translations (English only), the password-gated "user levels".

## Anti-goals (failure even if it "works")

- **Anything that writes to or reboots the device without an explicit user action.** Detecting a device and reading its info must never send REBOOT, REMOTE_UPGRADE or any SENDFILE command.
- Letting the user interrupt the device while it is writing flash (the UPGRADE_STATUS polling phase), or making that easy to do by accident.
- Quietly continuing past a model/filename mismatch or a downgrade without asking.
- Copying decompiled Caddx C# code. Re-implement from the protocol notes (clean-room).

## Constraints

- macOS first (Apple Silicon is the user's machine). Use `/dev/cu.*` ports, not `tty.*`.
- The language is Rust. The GUI uses **Tauri**, with a small HTML/TypeScript front end over a Rust core.
- Recovery path: the user has Windows with the original Caddx tool if a flash goes wrong.
- Nothing has been checked against hardware yet. Every protocol detail is an inference from static decompilation until the user's Lite+ confirms it.
- The project folder is a fresh git repo (`caddx-macflash`). Work on feature branches. Commit only when the user asks.
- **Distribution (user's decision):** build for the user's own Mac first. If it works well, the user will publish it on GitHub. So:
  - Keep the repo publishable from day one. No Caddx code, fonts, PDFs, firmware or other assets are ever committed (`reference/`, `*.zip`, `*.exe` are git-ignored).
  - Add an open-source license and a README stating it's unofficial and not affiliated with Caddx.
  - Signing/notarization is **not** in the first three milestones (unsigned local builds via `cargo tauri build`).
  - A later "publish" milestone adds GitHub Releases. Whether to use a Developer ID (signed and notarized) or ship unsigned with instructions is decided then.

## Decided: how it's built

**Delivery order** (each milestone is checked on the user's Lite+ before the next one starts):

1. **Read-only:** Rust core + CLI `list` and `info`. Enumerate ports, then open the Lite+ and send FIND_DEVICE (cmd 60) only, and print the reply.
2. **Flash via CLI:** `flash <file.img>` runs the full upgrade sequence.
3. **GUI:** a Tauri window on the same core.

**Upgrade sequence** (mirror the Windows tool's UI path, `UpgradeProcessFSM`):

1. FIND_DEVICE.
2. REBOOT `"clean"`, sent without waiting for an ack.
3. Close the port, wait, re-find the device by USB VID/PID and reopen it.
4. FIND_DEVICE.
5. REMOTE_UPGRADE.
6. SENDFILE_START with remote path `/tmp/pc/<basename>`.
7. SENDFILE_DATA chunks, stop-and-wait. Chunk size = `receiveMaxSize` from the latest FIND_DEVICE reply, in bytes, as the original does.
8. SENDFILE_END, which must return status 0 with detail `"OK"`.
9. Poll UPGRADE_STATUS every 1 s, at most 200 times, until percent ≥ 100. A negative status is a failure.
10. Wait for the device to reboot, reopen, and FIND_DEVICE to show the new version.

Retry and timeout values follow the Windows tool:
- Resend after 2 s, give up after 8 s total.
- Reconnect timeout 200 s.
- Reopen delay 8 s for the Lite family.

**Pre-flight checks before Flash** (taken from the Windows tool):
- Read the firmware version from the filename (`…X_Y_Z.img`, optionally with `_z8_N`/`_z40_N`/`_hub_N`).
- Read the device version from the trailing `X_Y_Z` of its firmware string.
- **Downgrade** (file older than device): confirm with the user, warning that it usually fails.
- **Name mismatch:** the filename must contain the device's firmware-name prefix (the firmware string minus its trailing version and the word "Ascent"). If not, warn and let the user continue or cancel.
- Path longer than 200 characters: refuse.
- Then a final confirmation reminding the user to keep USB connected and the device powered.

**Window (layout A, chosen by the user):** a single focused window, top to bottom:
- **Device card:** name, connected/disconnected status, port, FW/HW versions, serial number, temperature. If nothing is connected, it shows "Plug in your Ascent device".
- **Drop zone:** drag in or click to pick a `.img`. Shows the filename and the parsed version.
- **Flash firmware** button, enabled only when a device and file are present.
- **Progress bar** with step text: "Rebooting into upgrade mode…", "Sending firmware… 45%", "Device is writing firmware… 70%", "Done — now on V1.3.0".
- **Errors:** in plain words, using the device's error code (wrong model, version too low, image CRC error, etc.).

**Device detection:**
- List serial ports with USB info.
- Treat a port as a candidate if its VID is in the Ascent table (0x1D6B–0x1D84).
- Confirm it's an Ascent device with FIND_DEVICE before showing it as connected. (0x1D6B is also the Linux Foundation's generic gadget ID.)
- Watch for plug and unplug.

## Left to the builder

- Crate layout (e.g. `caddx-proto` core library, `caddx-cli`, `caddx-app` for Tauri), the async-vs-threads choice, and the serial crate (`serialport` is the expected choice).
- Front-end framework inside Tauri. Plain TypeScript is fine; keep it small.
- How to unit-test the protocol without hardware: frame encode/decode, CRC, and the upgrade state machine driven by a fake transport.
- CLI argument style and output format.
- Logging: a verbose/debug mode that hex-dumps frames is strongly recommended, for diagnosing the first hardware runs.
- Visual polish, app icon, app name in the window title. Pick a name that doesn't use Caddx's branding as the product name (e.g. "Ascent Flasher (unofficial)"), since it will go public. The repo/folder name `caddx-macflash` can stay.
- Choice of open-source license (MIT or Apache-2.0 are both fine).

## Builder's calls (marked as decided by the designer, not the user)

- **Cancel:** allowed until SENDFILE_END has been sent. After that the button is disabled, with the text "Device is writing firmware — do not unplug".
- **No-ack REBOOT:** the original sends REBOOT without waiting for an ack and then reconnects. Mirror that exactly.
- **Logs:** keep a per-run session log file (frames summarized; full hex in debug mode) so failed hardware runs can be diagnosed.
- **Flash only Lite/Lite+:** the Flash button and `flash` command are enabled only when FIND_DEVICE reports `devicename` `ascent_lite` or `ascent_lite_plus` (case-insensitive). Other Ascent devices show their info but can't be flashed, which avoids untested per-device reboot and recovery differences. A hidden `--force-any-ascent` CLI flag can come later if needed.
- **Recovery after cancel/failure:** once REBOOT `"clean"` has been sent, a cancel or a failure sends REBOOT `"normal"` and tries to reconnect. If that doesn't bring the device back, the app says: "Power-cycle the VTX (unplug USB and battery). If it doesn't return to normal, recover it with the Caddx Windows tool." This recovery reboot is part of the Flash action the user started, so it doesn't break the "no writes without a user action" anti-goal. The Windows tool only does this for VRX/GT Pro. For the Lite family it's my addition, so check it on hardware (cancel once on purpose during milestone 2).
- **Firmware-name check:** compare the filename and the device's firmware-name prefix after normalizing both: lowercase, and treat `-`, spaces and `.` as `_`. Then require the prefix to match on **whole `_`-separated tokens, followed by the version digits**, so a `lite` prefix doesn't match `lite_plus_…`. Like the original, a mismatch is a warning the user can override. The exact strings get confirmed from milestone 1 output (record the Lite+'s real `firmwareInfo`/`devicename` in the reverse-engineering notes); the parser's tests use those real values.
- **Remote path:** `/tmp/pc/<basename>`, keeping the `.img` extension, as the original does.
- **Clean-room line:** the builder *may read* the decompiled source to settle facts (timeouts, field contents, rules), but must not copy code from it. It's kept locally in the git-ignored `reference/` folder (`reference/decompiled/` for the C#, `reference/app/` for the original app files) and is never committed.
