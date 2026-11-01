# Ascent Flasher (unofficial)

**Flash Caddx Ascent firmware from a web page: <https://mikecarr.github.io/ascent-flasher/>**

Open the page in Chrome or Edge, plug in the device over USB, choose a
firmware `.img` file and click Flash. Nothing is installed and no firmware
leaves your computer: the page talks to the device directly over USB serial
(Web Serial). The protocol was reverse-engineered.

The Rust command-line tool `ascent-flash` is kept as a backup (see
[Command-line tool](#command-line-tool-backup)). The earlier Mac desktop app
was retired in favour of the web page.

**Unofficial: not affiliated with or endorsed by Caddx or Artosyn.**

**Use at your own risk.** Flashing firmware can brick your hardware. This
project comes with no warranty (see [License](#license)).

## Supported devices

| Device | Status |
|---|---|
| Ascent Lite | confirmed on hardware |
| Ascent Lite+ | confirmed on hardware |
| Ascent VRX Pro | confirmed on hardware |

A model is **confirmed** once a real flash of that model has worked through
the page on real hardware. Any other Ascent device is shown with its details
(info only) but the page refuses to flash it. If you have one, please open an
issue with the info the page shows; once someone has flashed it successfully,
it can be confirmed.

**VRX Pro power:** the VRX Pro needs its own power (DC barrel, 2-6S). Its
USB-C port carries data only and does not power the unit.

## Requirements

- Chrome or Edge on a computer (they provide Web Serial). Safari and Firefox
  can't be used, and neither can phones or tablets.
- A USB cable to the device (and external power for the VRX Pro).
- The firmware `.img` file for your model.

**Tested systems:** macOS and Windows. Linux and ChromeOS should work, but
are not tested yet. On Linux you may need serial-port permissions: add
yourself to the `dialout` group (or `uucp` on some distributions) and, if
ModemManager grabs the port, add a udev rule that makes it ignore the device.

## Flashing

1. Open the page, plug in the device and pick its serial port when Chrome asks.
2. Choose the firmware `.img` file; the page checks it against the device.
3. Click **Flash**, answer any warnings, and wait.

Typical times: a VTX (Lite, Lite+) takes about 30 seconds; the VRX Pro about
3 minutes.

**Safety:**

- Don't unplug the device (or power) while the page says "Device is writing
  firmware".
- If a flash fails and the device doesn't come back, power-cycle it (unplug
  USB and power, then reconnect). If it still doesn't return to normal mode,
  recover it with the Caddx Windows tool.

## Running the page locally

The page is static. From the repository root:

```sh
cd web
python3 -m http.server 8766 --bind 127.0.0.1
```

Then open <http://localhost:8766> in Chrome or Edge.

## Command-line tool (backup)

You need a Rust toolchain (stable, via [rustup](https://rustup.rs)).

```sh
cargo build -p ascent-cli --release   # binary: target/release/ascent-flash
```

```sh
ascent-flash list                    # candidate serial ports (by USB VID)
ascent-flash info                    # read-only FIND_DEVICE on each candidate
ascent-flash info --port /dev/cu.usbmodemXXXX
ascent-flash flash <file.img>
ascent-flash flash <file.img> --port /dev/cu.usbmodemXXXX
```

- `flash` finds the single flashable device (use `--port` if there are
  several), checks the file, shows any warnings (downgrade, file name that
  doesn't match the device, unknown version) and asks for confirmation.
- `--yes` / `-y` skips all questions (warnings are printed, not asked).
- `--debug` turns on trace logging with hex dumps of every frame.
- `--simulate` runs against a built-in simulated device instead of hardware.
- Ctrl-C cancels the flash until the file transfer is complete. After that
  the device is writing firmware and the cancel is ignored: wait for it to
  finish.
- Firmware files must be `.img`, at most 64 MiB.

Every run writes a log file. On macOS it is in
`~/Library/Logs/AscentFlasher/`; on Linux in `~/.local/share/AscentFlasher/logs/`.
Attach it when reporting a problem.

## How it works

The device speaks a framed binary protocol over USB serial: the tool asks the
device to reboot into a clean mode, streams the firmware file in chunks,
polls the upgrade status while the device writes it, and checks the new
version after the device restarts itself. The web page and the CLI implement
the same sequence. The wire format, the upgrade sequence and what was
observed on real hardware are documented in
[docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md).

## Development

- `web/`: the static page (`index.html`, `style.css`, `ui.js`, `lib/*.js`).
- `crates/ascent-proto`: protocol library (with a simulator behind feature `sim`).
- `crates/ascent-cli`: the `ascent-flash` command-line tool.

```sh
node --test web/test/                                    # web tests
cargo test --workspace                                   # Rust tests
cargo clippy --workspace --all-targets -- -D warnings
```

`.github/workflows/pages.yml` publishes `web/` (without its tests) to GitHub
Pages. It runs only when started by hand from the Actions tab.

## License

MIT. See [LICENSE](LICENSE).
