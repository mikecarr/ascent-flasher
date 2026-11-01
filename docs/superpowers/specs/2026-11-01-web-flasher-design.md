# Ascent Web Flasher — Design

Date: 2026-11-01
Builds on: [the Mac app design](2026-10-31-caddx-macflash-design.md) (its safety rules carry over unless changed here) and [docs/REVERSE_ENGINEERING.md](../../REVERSE_ENGINEERING.md) (protocol, real-hardware results, per-device facts).

## Intent

Caddx only ships its PC Tool for Windows. We built a Rust Mac app and CLI that flash Ascent firmware, and confirmed them on the user's Ascent Lite. The user now wants a **web page** instead of a downloadable app: it runs in Chrome or Edge using Web Serial, so people just open a link. There's no installer, no Apple signing or notarization, and it works on Mac, Windows, Linux and ChromeOS. The user will publish it on GitHub.

The user also does not want to depend on Gehee's fpvOS flasher (tailored to fpvOS, and it doesn't support the VRX Pro). This is a standalone page for Caddx Ascent firmware.

A throwaway test page (`web/serial-test/`, branch `spike/web-serial`) already proved the risky part on the Lite+: FIND_DEVICE works from Chrome, and after REBOOT "clean" Chrome gave the device back **without a new port pick** (new `SerialPort` object from `getPorts()`, permission carried over; disconnect at 2.7 s, connect at 7.5 s).

Success: someone opens the link, plugs in a supported unit, picks the right `.img`, presses Flash, and the unit ends up on the new firmware, as safely as the Mac app does it.

## Goals

1. A single page that flashes the **Ascent Lite, Lite+ and VRX Pro** (the user owns all three and will confirm each on hardware).
2. Show device info for any Ascent unit, with an **Info** button to re-read it.
3. The same flash sequence, pre-flight checks, cancel rules and plain-language errors as the Mac app.
4. A downloadable session log, so users can send a log when something fails.
5. Published from this repo on GitHub Pages.

## Non-goals

- Downloading firmware. Users always bring their own `.img`.
- Safari and Firefox (no Web Serial). The page says so plainly.
- Mobile browsers.
- Other Ascent devices' flashing, gimbals, RC Mode, Cam Hub, BB-frequency, the `Ascent_R_Sky_` multi-part flow.
- Translations; English only.

## Anti-goals (failure even if it "works")

- Anything that writes to or reboots a device without an explicit click. Connecting and Info send only FIND_DEVICE.
- Flashing a model nobody has confirmed on hardware.
- Letting the user interrupt the device while it's writing flash, or making that easy by accident.
- Quietly continuing past a model/file mismatch or a downgrade.
- Copying code from Caddx's tools or from Gehee's flasher (clean-room, from our own notes and our Rust code).

## Decided by the user

- **Browser over a Rust distributable.** The web page is the product that gets published.
- **Keep the Rust CLI (`ascent-flash`) as a backup and debugging tool.** The Rust protocol core stays because the CLI uses it. The Tauri Mac app is retired.
- **Supported for flashing:** Lite, Lite+, VRX Pro. Any other Ascent unit shows its info but can't be flashed, with a note asking the owner to report what it shows; models get added once someone confirms them on hardware.
- **Info button** on the page.
- **Tested systems: macOS and Windows.** Before the first public deploy, a real flash through the page must pass on both (Chrome or Edge). Linux and ChromeOS are listed as "should work, not tested yet" on the page and in the README. Windows unknowns to settle in that test: the USB serial driver binding, and whether Chrome keeps the port permission across the reboot as it did on macOS.
- The playback was accepted as written, including: user-supplied `.img` only; hosted from this repo on GitHub Pages; "Leave site?" warning and a keep-awake request while flashing; "Download log" button; the Mac app's one-window layout; the test page stays as a diagnostic tool.

## Known per-device facts (from hardware)

| | Lite | Lite+ | VRX Pro |
|---|---|---|---|
| devicename | `Ascent_lite` | `Ascent_lite_plus` | `Ascent_VRX_pro` |
| firmware string | `Ascent_H_Sky_<ver>` | `Ascent_H_Sky_<ver>` | `Ascent_VRX_Pro_<ver>` |
| file-name prefix | `H_Sky` | `H_Sky` | `VRX_Pro` |
| VID:PID | 1D76:0101 | 1D76:0101 | 1D77:A4A2 |
| reopen delay (Windows tool) | 11.5 s | 11.5 s | 12 s |
| image size (18.21.10) | 15.6 MB | 15.6 MB | 179.8 MB |
| flashed on hardware | yes (app + CLI) | not yet (read only) | not yet (read only) |
| reconnect in Chrome | — | confirmed | not yet |
| REBOOT "normal" from clean mode | ignored | not tried | not tried (Windows tool uses it for VRX) |

Power: the VTXs run on USB power for updates; the **VRX Pro needs its own supply** (DC barrel, 2–6S). Its USB-C port is data only. The page must tell VRX Pro users this before flashing.

## How a flash runs

Same sequence as the Mac app (`crates/ascent-proto/src/upgrade.rs`):

1. FIND_DEVICE; check it's a supported model.
2. REBOOT "clean" (no ack); close the port.
3. Wait the per-VID reopen delay, then find the port again among `navigator.serial.getPorts()` by the same VID/PID, reopen, FIND_DEVICE (clean mode answers as `Ascent`, cpu temp 0).
4. REMOTE_UPGRADE (114), SENDFILE_START (115, MD5 hex of the file, `/tmp/pc/<basename>`), SENDFILE_DATA (116) in `receiveMaxSize` chunks, stop-and-wait.
5. SENDFILE_END (117) must return status 0 / `"OK"`. **Cancel locks before this request is sent.**
6. Poll UPGRADE_STATUS (118) every 1 s until 100 %; a negative status is a failure.
7. Wait for the self-reboot, reconnect, FIND_DEVICE, and compare the new version with the file's.

Carry over unchanged from the app: resend at 2 s / give up at 8 s; seq echo learning; device re-check (the unit must still be the one the user confirmed); no reboot after the lock except on a negative status or a rejected transfer; recovery REBOOT "normal" only before the lock, and "recovered" claimed only when the unit was seen to drop off USB and return; a bounded writing phase that ends in "result unknown", never a reboot.

## Pre-flight checks

As the app: version from the filename; downgrade → confirm; name mismatch (whole `_`-token prefix match) → warn, user may continue; a final confirmation to keep USB (and, for the VRX Pro, its power supply) connected. Snapshot what the user confirmed and refuse to start if the device or the warnings changed.

The file-size cap rises from 64 MiB so the VRX Pro image fits.

## Left to the builder

- Language and structure: plain ES modules with no build step (as the test page) or TypeScript with a build. Either is fine; it must be servable as static files.
- Where the page lives in the repo, and how Pages publishes it (Actions workflow or a branch).
- MD5: a small dependency or our own implementation; must be tested against known vectors.
- How to test the upgrade state machine without hardware (a fake Web Serial port is expected, as the Rust `sim` does).
- Visual polish, within the Mac app's layout.

## Builder's calls (marked as decided by the designer, not the user)

- **Retire the Tauri app** by deleting `app/` once the web flasher has flashed a Lite on hardware. Its UI (`app/ui/`) is the starting point for the web page's markup and state machine.
- **The CLI gains VRX Pro support too** (allowlist, size cap), so the backup tool covers the same units as the page.
- **New size cap: 256 MiB**, for both page and CLI.
- **Writing phase limit:** 300 s for the VTXs as now; **600 s for the VRX Pro** until a real flash tells us how long its 180 MB write takes.
- **Reconnect:** keep the Windows tool's per-VID delays (known to work). Starting earlier on the `connect` event is a later optimisation.
- **Keep-awake:** Screen Wake Lock API while flashing. Plus a `beforeunload` prompt, which can't block closing, only warn.
- **Hardware confirmation order before a model is enabled in the published page:** Lite: one flash through the page. Lite+: reconnect (done) and one flash. VRX Pro: the reconnect test, then one same-version flash. The VRX Pro stays info-only in the published page until its flash succeeds.
- **How unconfirmed models get their confirmation flash:** the supported-model list is in code, with a per-model "confirmed" flag. A model that isn't confirmed yet can be flashed **only when the page is served from `localhost`/`127.0.0.1`** (the user's local copy), never from the public host; no URL switch or setting unlocks it publicly. **The first public deploy waits until the Lite has been flashed through the page**, so the public page always has at least one flashable model.
- **No mid-flash port re-pick.** If a model doesn't come back under a permitted port after a reboot (as the Lite+ did), it isn't supported: the flash ends with the normal "power-cycle / use the Windows tool" outcome, and the model stays info-only. So the VRX Pro needs a passing reconnect test before its confirmation flash.
- **The test page is not deployed.** `web/serial-test/` stays in the repo for local use only (it can send REBOOT "clean" outside the flasher's safety flow); the Pages deploy includes only the flasher.
- **README** is rewritten around the web page, with the CLI as the backup; it states the page is unofficial and not affiliated with Caddx.
