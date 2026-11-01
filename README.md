# Ascent Flasher (unofficial)

A small tool for flashing Caddx Ascent VTX firmware over USB serial, from macOS
(and, untested, Linux). It comes as a command-line tool (`ascent-flash`) and a
desktop app, both built on the same Rust protocol library. The protocol was
reverse-engineered.

**Unofficial: not affiliated with or endorsed by Caddx or Artosyn.**

**Use at your own risk.** Flashing firmware can brick your hardware. This
project comes with no warranty (see [License](#license)).

## Supported devices

Only devices whose FIND_DEVICE reply reports the device name `ascent_lite` or
`ascent_lite_plus` (case-insensitive) can be flashed. Other Ascent devices are
shown with their details, but flashing them is refused.

Tested on an **Ascent Lite VTX** with firmware **17.5.8**
(`Ascent_H_Sky_17_5_8`).

## Build

You need a Rust toolchain (stable, via [rustup](https://rustup.rs)).

CLI:

```sh
cargo build -p ascent-cli            # binary: target/debug/ascent-flash
cargo build -p ascent-cli --release  # binary: target/release/ascent-flash
```

Desktop app (Tauri 2):

```sh
cargo install tauri-cli --version "^2" --locked
cd app/src-tauri && cargo tauri build
```

Local builds are unsigned.

## CLI usage

```sh
ascent-flash list                    # candidate serial ports (by USB VID)
ascent-flash info                    # read-only FIND_DEVICE on each candidate
ascent-flash info --port /dev/cu.usbmodemXXXX
ascent-flash flash Ascent_H_Sky_17_5_8.img
ascent-flash flash <file.img> --port /dev/cu.usbmodemXXXX
```

- `flash` finds the single flashable device (use `--port` if there are
  several), checks the file, shows any warnings (downgrade, file name that
  doesn't match the device, unknown version) and asks for confirmation.
  Nothing beyond FIND_DEVICE is sent before you confirm.
- `--yes` / `-y` skips all questions (warnings are printed, not asked).
- `--debug` turns on trace logging with hex dumps of every frame.
- `--simulate` runs against a built-in simulated device instead of hardware.
- Ctrl-C (or closing the terminal, or SIGTERM) cancels the flash until the
  file transfer is complete. After that the device is writing firmware and
  the cancel is ignored: wait for it to finish.
- Firmware files must be `.img`, at most 64 MiB, with a printable ASCII file
  name short enough for the device's `/tmp/pc/<name>` path.

## App usage

1. Plug in the VTX over USB. The device card shows its name, port, firmware,
   hardware version, serial number and temperature.
2. Drop a firmware `.img` onto the window, or click to choose one.
3. Click **Flash firmware**, answer any warnings, and confirm.
4. Keep USB connected and the VTX powered until it says it is done.

**Cancel** works until the file transfer is complete. After that the button
reads "Device is writing firmware — do not unplug". While a flash is running
the window won't close and Quit (Cmd+Q) is refused, with a note saying why.

`ASCENT_SIM=1` starts the app against the simulated device; `ASCENT_DEBUG=1`
turns on debug logging.

## Logs

Every run writes a log file (INFO level; full hex in debug mode):

- macOS: `~/Library/Logs/AscentFlasher/`
- Linux: `~/.local/share/AscentFlasher/logs/`

Attach the log when reporting a problem.

## Linux notes (untested)

Linux support is untested. You will probably need:

- Serial port access: add yourself to the `dialout` group (or `uucp` on some
  distributions), then log out and back in:

  ```sh
  sudo usermod -aG dialout "$USER"
  ```

- ModemManager can grab new USB ACM ports and send them modem commands. A udev
  rule like this one (untested) asks it to ignore Ascent devices, in
  `/etc/udev/rules.d/99-ascent.rules`:

  ```
  # Untested. Ascent VIDs 0x1D6B-0x1D84 (note 0x1D6B is also the Linux Foundation's ID).
  SUBSYSTEM=="tty", ATTRS{idVendor}=="1d6b", ENV{ID_MM_DEVICE_IGNORE}="1"
  SUBSYSTEM=="tty", ATTRS{idVendor}=="1d76", ENV{ID_MM_DEVICE_IGNORE}="1"
  ```

  Add a line for your device's VID (see `ascent-flash list`), then run
  `sudo udevadm control --reload-rules` and replug the device.

## Recovery

If a flash fails or is cancelled after the device has entered upgrade mode,
the tool tries to reboot it back to normal mode, and tells you if that
didn't work. If the device doesn't come back:

1. Power-cycle the VTX: unplug USB and the battery, then reconnect.
2. If it still doesn't return to normal, recover it with the official
   Caddx/Artosyn tools (the Caddx PC tool on Windows, or Artosyn's macOS
   tool).
3. If that fails too, contact Caddx support.

If the tool says the flash result is unknown, check the version with
`ascent-flash info` (or reopen the app). If it isn't the new version, flash
again.

## How it works

The wire format, the upgrade sequence and what was observed on real hardware
are documented in [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md).

Workspace layout:

- `crates/ascent-proto`: protocol, session, device discovery, firmware
  checks, the upgrade state machine and a simulator (feature `sim`).
- `crates/ascent-cli`: the `ascent-flash` command-line tool.
- `app/src-tauri`, `app/ui`: the Tauri 2 desktop app (plain JavaScript UI).

Run the tests with `cargo test --workspace`.

## License

MIT. See [LICENSE](LICENSE).
