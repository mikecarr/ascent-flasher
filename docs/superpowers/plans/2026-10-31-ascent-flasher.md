# Ascent Flasher (unofficial) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS tool, CLI first and then a Tauri window, that detects a Caddx Ascent Lite/Lite+ VTX over USB serial and flashes a user-selected `.img` firmware using the reverse-engineered Artosyn "AR" protocol.

**Architecture:**
- A Cargo workspace with three members:
  - `ascent-proto`: a pure Rust library for framing, the session/ack layer, discovery, firmware pre-flight and the upgrade state machine.
  - `ascent-cli`: the `ascent-flash` binary.
  - `app/src-tauri`: the Tauri 2 shell, plus a no-bundler HTML/CSS/JS front end in `app/ui`.
- I/O sits behind two small traits, `Link` (a byte pipe) and `Connector` (list and open ports). An in-crate simulator (`sim` feature) lets every protocol path be tested without hardware, and lets the GUI run without a device.

**Tech Stack:** Rust 1.99, `serialport` 4, `crc32fast`, `md-5` 0.10, `regex`, `thiserror` 2, `tracing` + `tracing-subscriber` + `tracing-appender`, `clap` 4 (derive), Tauri 2 + `tauri-plugin-dialog` 2, `serde`.

**Spec:** `docs/superpowers/specs/2026-10-31-caddx-macflash-design.md`. Wire formats are in `docs/REVERSE_ENGINEERING.md` §3. Executors read both.

## Global Constraints

- **Branch:** work on `feat/ascent-flasher`. Show `git status` and `git diff` before each commit. **Commit only after the user says to** (user's global rule). The commit steps below are where to ask.
- **Clean-room:** you may read `reference/decompiled/` to settle facts. Never copy code from it. Never commit `reference/`, `*.zip`, `*.exe`, firmware, fonts or PDFs.
- **macOS first:** only `/dev/cu.*` ports. Nothing may block Linux later (no macOS-only APIs in `ascent-proto`).
- **Product name** is "Ascent Flasher (unofficial)". README says it's not affiliated with Caddx. License: MIT.
- **No device writes without an explicit user action:** detect/`list`/`info` send only FIND_DEVICE (60). Only `flash` / the Flash button sends REBOOT, REMOTE_UPGRADE or SENDFILE_*.
- **Flashable only if** `devicename` (case-insensitive) is `ascent_lite` or `ascent_lite_plus`.
- **Values from the spec:**

  | Setting | Value |
  |---|---|
  | Baud | 115200 8N1 |
  | Ack resend interval | 2 s |
  | Ack total timeout | 8 s |
  | Reopen delay (Lite family) | 8 s |
  | Reconnect timeout | 200 s |
  | Reconnect retry interval | 1 s |
  | UPGRADE_STATUS poll | every 1 s, max 200 |
  | Max received frame | 5120 bytes incl. 36-byte header |
  | Remote path | `/tmp/pc/<basename>` |
  | Max local path | 200 chars |

- **Candidate USB VIDs:** `0x1D6B..=0x1D74`, `0x1D75..=0x1D7B`, `0x1D80..=0x1D84`.
- **Cancel** is honoured only until SENDFILE_END has been sent. After a cancel or failure that follows REBOOT `"clean"`, send REBOOT `"normal"` and attempt a reconnect.

## Review Focus

1. **Boot noise / partial frames on the serial line** after a reboot: the reader must resync on the magic, not error out. The test is in Task 2.
2. **Port path changes after reboot** (`/dev/cu.usbmodem1101` → `…1201`): reconnect re-finds the device by VID/PID (+ serial if present). The test is in Task 7.
3. **USB unplugged mid-transfer:** the flash returns a `UpgradeError` with the recovery message. No panic, no hang beyond the ack timeout. The test is in Task 7.
4. **Firmware file unreadable, empty or not `.img`:** rejected by pre-flight *before* any device write. The file is read fully into memory and hashed before REBOOT. The test is in Task 6.
5. **`receiveMaxSize` of 0 or absurdly large** in FIND_DEVICE: chunk size is clamped to `1..=1_048_576`, with 0 → 1 MiB. The test is in Task 7.

---

## File Structure

```
Cargo.toml                         # workspace: crates/*, app/src-tauri
LICENSE, README.md
crates/ascent-proto/
  Cargo.toml                       # features: sim
  src/lib.rs                       # pub mod re-exports
  src/frame.rs                     # Header, Frame, encode, CRC
  src/reader.rs                    # FrameReader (stream resync)
  src/payload.rs                   # DeviceInfo, FileInfo, FileDataInfo, UpgradeStatus, AckInfo, reboot_mode()
  src/command.rs                   # Command enum + status_message()
  src/link.rs                      # Link, Connector, PortInfo traits/types
  src/session.rs                   # Session: request/ack/retry, send_no_ack
  src/serial.rs                    # SerialConnector (serialport impl)
  src/discovery.rs                 # is_candidate(), find_devices(), reconnect()
  src/firmware.rs                  # versions, name check, preflight()
  src/upgrade.rs                   # run_upgrade(), Progress, CancelToken, UpgradeError
  src/sim.rs                       # SimDevice, SimConnector (cfg feature "sim")
  tests/*.rs                       # integration tests (dev-dep on self with "sim")
crates/ascent-cli/
  src/main.rs                      # clap: list | info | flash; logging setup
app/
  src-tauri/{Cargo.toml,tauri.conf.json,build.rs,src/main.rs,src/state.rs}
  ui/{index.html,style.css,main.js}
```

---

### Task 1: Workspace, repo hygiene, frame encoding + CRC

**Files:**
- Create: `Cargo.toml`, `LICENSE`, `README.md`, `crates/ascent-proto/Cargo.toml`, `crates/ascent-proto/src/{lib.rs,frame.rs}`, `crates/ascent-proto/tests/frame.rs`

**Interfaces:**
- Produces:
  - `pub const MAGIC: u32 = 0x4152_544F; pub const VERSION: u16 = 0x0CDC; pub const UNUSED: u16 = 0xABCD; pub const HEADER_LEN: usize = 36; pub const MAX_FRAME_LEN: usize = 5120;`
  - `pub struct Header { pub msg_type: u16, pub command: u32, pub format: u16, pub length: u32, pub seq: u32, pub retry: u32, pub crc32: u32 }`. msgid, userid = 0 and unused = 0xABCD are implied.
  - `pub struct Frame { pub header: Header, pub payload: Vec<u8> }`
  - `pub fn encode_request(command: u32, payload: &[u8], seq: u32, retry: u32) -> Vec<u8>` (type 1, format 2)
  - `pub fn decode_header(bytes: &[u8; 36]) -> Option<Header>`. Returns `None` if the magic is wrong.
  - `pub fn frame_crc(header36_with_crc_zeroed: &[u8], payload: &[u8]) -> u32`. Uses `crc32fast` (standard CRC-32).

- [ ] **Step 1:** `git checkout -b feat/ascent-flasher`. Create the workspace `Cargo.toml` (`members = ["crates/*", "app/src-tauri"]`, `resolver = "2"`). Temporarily exclude `app/src-tauri` until Task 9 creates it. Add the MIT `LICENSE` and a `README.md` (name, "unofficial, not affiliated with Caddx", status: experimental, use at your own risk). Add the `ascent-proto` crate with deps `crc32fast`, `thiserror`, `tracing`, and feature `sim = []`. Add `[dev-dependencies] ascent-proto = { path = ".", features = ["sim"] }`.
- [ ] **Step 2: Write failing tests** in `tests/frame.rs`:
  - `crc_matches_standard_vector`: `frame_crc(b"123456789", &[]) == 0xCBF4_3926`.
  - `encodes_find_device_header`: `encode_request(60, &[], 7, 0)` has length 36. The first 32 bytes equal `4F 54 52 41 DC 0C 01 00 00 00 CD AB 3C 00 00 00 02 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00`. The bytes `[32..36]` equal LE `frame_crc(&first32 ++ [0;4], &[])`.
  - `roundtrip_with_payload`: encode cmd 115 with a 328-byte payload, seq 3, retry 1. `decode_header` gives `command 115, length 328, seq 3, retry 1, msg_type 1`. Recomputing the CRC over (header with crc zeroed + payload) equals `crc32`.
  - `rejects_bad_magic`: flip byte 0 → `decode_header` returns `None`.
- [ ] **Step 3:** Run `cargo test -p ascent-proto --test frame`. Expected: compile FAIL (items missing).
- [ ] **Step 4:** Implement `frame.rs` with little-endian field writes at the offsets in REVERSE_ENGINEERING §3 (no `unsafe`/transmute).
- [ ] **Step 5:** Run `cargo test -p ascent-proto --test frame`. Expected: 4 passed.
- [ ] **Step 6: Commit (ask first):** `feat(proto): workspace, AR frame encoding and CRC`

### Task 2: Stream frame reader with resync

**Files:**
- Create: `crates/ascent-proto/src/reader.rs`, `crates/ascent-proto/tests/reader.rs`

**Interfaces:**
- Consumes: `decode_header`, `HEADER_LEN`, `MAX_FRAME_LEN`, `Frame`
- Produces: `pub struct FrameReader`, `FrameReader::new()`, `pub fn push(&mut self, bytes: &[u8])`, `pub fn next_frame(&mut self) -> Option<Frame>`

- [ ] **Step 1: Write failing tests:**
  - `reads_frame_split_across_pushes`: push an encoded 100-byte-payload frame in 3 pieces (10, 30, rest). `next_frame` is `None` until the last push, then `Some` with an equal payload.
  - `skips_leading_garbage` (Review Focus 1): push `b"U-Boot 2020\r\n\x00\xff"` followed by a valid frame → returns that frame.
  - `skips_oversized_length`: a header claiming `length = 6000` followed by a valid frame → the reader drops a byte, resyncs, and returns the valid frame.
  - `two_frames_in_one_push`: both are returned, in order.
- [ ] **Step 2:** Run `cargo test -p ascent-proto --test reader`. Expected: FAIL.
- [ ] **Step 3:** Implement: keep a `Vec<u8>` buffer. On a bad magic, or `36 + length > 5120`, drain 1 byte and retry. Wait while incomplete. CRC is **not** verified on receive: log a `tracing::warn!` on mismatch but still return the frame. (The original doesn't check it for most commands, and we don't yet know whether the device fills it.)
- [ ] **Step 4:** Run `cargo test -p ascent-proto --test reader`. Expected: 4 passed.
- [ ] **Step 5: Commit (ask first):** `feat(proto): frame reader with resync`

### Task 3: Payload structs and command table

**Files:**
- Create: `crates/ascent-proto/src/{payload.rs,command.rs}`, `crates/ascent-proto/tests/payload.rs`

**Interfaces:**
- Produces:
  - `#[repr(u32)] pub enum Command { Reboot = 3, FindDevice = 60, RemoteUpgrade = 114, SendFileStart = 115, SendFileData = 116, SendFileEnd = 117, UpgradeStatus = 118 }`
  - `pub struct DeviceInfo { pub receive_max_size: i32, pub sdk_version: String, pub device_name: String, pub cpu_temp: i32, pub firmware: String, pub serial_number: String, pub hardware_version: String, pub status: i32, pub detail: String }`
  - `DeviceInfo::decode(&[u8]) -> Result<DeviceInfo, PayloadError>`. Needs ≥ 300 bytes. Strings are NUL-trimmed ASCII (lossy).
  - `pub fn file_info(md5_hex_lower: &str, length: u32, remote_path: &str, local_path: &str) -> Vec<u8>`. 328 bytes: `md5[64]`, `i32 length`, `i32 saveAsFile = 1`, `filePath[128]`, `fileDir[128]` = last 128 chars of `local_path`.
  - `pub struct FileDataInfo { pub length: i32, pub cursize: i32, pub totalsize: i32, pub status: i32, pub detail: String }` + `decode` (≥ 80 bytes)
  - `pub struct UpgradeStatus { pub percent: i32, pub status: i32, pub detail: String }` + `decode` (≥ 72 bytes)
  - `pub fn reboot_mode(mode: &str) -> [u8; 32]`
  - `pub enum PayloadError { TooShort { need: usize, got: usize } }`
  - `pub fn status_message(code: i32) -> &'static str`, using the strings from REVERSE_ENGINEERING §3, e.g. `-5 → "Wrong model: this firmware is for a different device"`, `-6 → "Firmware version is too old for this device"`, `-9 → "Firmware image CRC error"`. Unknown negative codes → `"Upgrade failed (unknown error)"`.
- [ ] **Step 1: Write failing tests:**
  - `device_info_decodes_offsets`: build 300 bytes by hand. `receive_max_size = 4096` at 0, `"1.0.0"` at 4, `"ascent_lite_plus"` at 36, `cpu_temp = 42` at 100, `"Ascent_Lite_Plus_1_2_3"` at 104, `"SN123"` at 168, `"V1.0"` at 200, `status 0` at 232, `"OK"` at 236 → all fields equal.
  - `device_info_too_short` → `Err(TooShort{need:300, got:10})`.
  - `file_info_layout`: `file_info("d41d…", 5, "/tmp/pc/a.img", "/Users/x/a.img")`. Length 328; bytes `64..68 == 5u32 LE`; `68..72 == 1`; the `filePath` field starts at 72; the `fileDir` field starts at 200.
  - `file_info_truncates_long_local_path`: a 300-char local path → the `fileDir` field holds the last 128 chars.
  - `reboot_mode_pads`: `reboot_mode("clean")[..5] == *b"clean"` and the rest are zeros.
  - `status_messages_cover_codes`: every code `-12..=-1` returns a non-generic string.
- [ ] **Step 2:** Run `cargo test -p ascent-proto --test payload`. Expected: FAIL.
- [ ] **Step 3:** Implement with explicit offset reads/writes.
- [ ] **Step 4:** Run the same test. Expected: 6 passed.
- [ ] **Step 5: Commit (ask first):** `feat(proto): payload structs and command table`

### Task 4: Link/Connector traits, Session with ack/retry, simulator

**Files:**
- Create: `crates/ascent-proto/src/{link.rs,session.rs,sim.rs}`, `crates/ascent-proto/tests/session.rs`

**Interfaces:**
- Consumes: `encode_request`, `FrameReader`, `Frame`, `Command`, payload types
- Produces:
  - `pub trait Link: Send { fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()>; fn read_some(&mut self, buf: &mut [u8], timeout: Duration) -> std::io::Result<usize>; }`. `Ok(0)` means a timeout with no data.
  - `#[derive(Clone, Debug, PartialEq)] pub struct PortInfo { pub path: String, pub vid: u16, pub pid: u16, pub serial: Option<String> }`
  - `pub trait Connector: Send + Sync { fn list(&self) -> std::io::Result<Vec<PortInfo>>; fn open(&self, path: &str) -> std::io::Result<Box<dyn Link>>; }`
  - `#[derive(Clone, Copy)] pub struct AckTiming { pub resend_every: Duration, pub give_up_after: Duration }`. `impl Default` = 2 s / 8 s.
  - `pub struct Session { … }`
    - `Session::new(link: Box<dyn Link>, timing: AckTiming)`
    - `pub fn request(&mut self, cmd: Command, payload: &[u8]) -> Result<Frame, SessionError>`. Sends with a new seq. Waits for a frame whose `command == cmd`; frames for other commands are logged and ignored. Every `resend_every`, re-sends the **same seq** with `retry + 1`. After `give_up_after` → `Timeout`.
    - `pub fn send_no_ack(&mut self, cmd: Command, payload: &[u8]) -> Result<(), SessionError>`
    - `pub fn find_device(&mut self) -> Result<DeviceInfo, SessionError>`
  - `pub enum SessionError { Io(std::io::Error), Timeout { cmd: Command }, Payload(PayloadError) }` (`thiserror`)
  - `sim` (feature `sim`):
    - `pub struct SimDevice` with pub fields `info: DeviceInfo`, `status_script: Vec<UpgradeStatus>`, `drop_first_requests: u32`, `log: Vec<Header>`, `received_file: Vec<u8>`, `reboot_moves_to: Option<String>`, `offline_for: Duration`, `unplug_after_data_chunks: Option<u32>`.
    - `pub struct SimConnector { pub device: Arc<Mutex<SimDevice>> }`, constructed with `SimConnector::new(path: &str, vid: u16, pid: u16, device: SimDevice)`. Implements `Connector`. While offline, `list()` omits the device. REBOOT takes it offline for `offline_for`, then it reappears at `reboot_moves_to` if set.
    - SimDevice answers: 60 → `DeviceInfo` bytes; 114/115 → empty ack; 116 → appends to `received_file` and acks a `FileDataInfo`; 117 → `FileDataInfo{status 0, detail "OK"}`; 118 → pops `status_script`, otherwise `{100, 3}`.
- [ ] **Step 1: Write failing tests** (timing `AckTiming{resend_every: 20ms, give_up_after: 100ms}`):
  - `find_device_roundtrip`: a SimConnector opened link → `find_device()` returns the sim's info. `log` shows one header with cmd 60, retry 0.
  - `resends_same_seq_with_retry`: `drop_first_requests = 1` → `request(FindDevice)` succeeds. `log` has 2 headers with an equal seq and retry `0` then `1`.
  - `times_out`: `drop_first_requests = 100` → `Err(Timeout{cmd: FindDevice})` within ≤ 300 ms.
  - `seq_increments_per_request`: two requests → seqs differ by 1.
- [ ] **Step 2:** Run `cargo test -p ascent-proto --test session`. Expected: FAIL.
- [ ] **Step 3:** Implement. `tracing::debug!` logs one line per frame sent/received (cmd, seq, retry, len); `tracing::trace!` logs the hex dump.
- [ ] **Step 4:** Run the same test. Expected: 4 passed.
- [ ] **Step 5: Commit (ask first):** `feat(proto): session ack/retry and device simulator`

### Task 5: Serial connector, discovery, CLI `list`/`info` (Milestone 1, read-only)

**Files:**
- Create: `crates/ascent-proto/src/{serial.rs,discovery.rs}`, `crates/ascent-proto/tests/discovery.rs`, `crates/ascent-cli/{Cargo.toml,src/main.rs}`
- Modify: `docs/REVERSE_ENGINEERING.md` (record real strings in §2)

**Interfaces:**
- Consumes: `Connector`, `PortInfo`, `Session`, `DeviceInfo`
- Produces:
  - `pub struct SerialConnector;` implements `Connector`. `list()` uses `serialport::available_ports()`, keeps only `UsbPort` entries and, on macOS, only paths starting with `/dev/cu.`. `open()` opens at 115200 8N1 with a 50 ms read timeout.
  - `pub fn is_candidate(vid: u16) -> bool` (the VID table in Global Constraints)
  - `pub struct FoundDevice { pub port: PortInfo, pub info: DeviceInfo }`, `pub fn is_flashable(&self) -> bool` (`ascent_lite` / `ascent_lite_plus`, case-insensitive)
  - `pub fn find_devices(conn: &dyn Connector, timing: AckTiming) -> Vec<Result<FoundDevice, (PortInfo, SessionError)>>`. Opens each candidate, sends FIND_DEVICE only, then closes.
- [ ] **Step 1: Write failing tests:**
  - `candidate_vids`: `is_candidate(0x1D6B)`, `(0x1D74)`, `(0x1D7B)`, `(0x1D80)` and `(0x1D84)` are true; `(0x1A86)`, `(0x1D7C)` and `(0x05AC)` are false.
  - `find_devices_sends_only_find_device` (anti-goal): over a SimConnector, the result is Ok, and the sim `log` contains only cmd 60.
  - `flashable_names`: `ascent_lite_plus`, `ASCENT_LITE` → true; `ascent_vrx` → false.
- [ ] **Step 2:** Run `cargo test -p ascent-proto --test discovery`. Expected: FAIL. Then implement. Expected: 3 passed.
- [ ] **Step 3:** Implement `ascent-flash` (clap):
  - `ascent-flash list` prints each candidate port: path, VID:PID, serial.
  - `ascent-flash info [--port PATH]` runs FIND_DEVICE and prints every `DeviceInfo` field plus `flashable: yes/no`. With several devices and no `--port`, print them all.
  - Global flags: `--debug` (trace-level hex dumps) and `--simulate` (uses `SimConnector` with a Lite+ fixture; feature `sim` enabled by default in the CLI's dependency on `ascent-proto`).
  - Logging writes to stderr and to `~/Library/Logs/AscentFlasher/<YYYYmmdd-HHMMSS>.log` (`tracing-appender`, non-rolling, one file per run). Implement it as `ascent_proto::logging::init(debug: bool) -> WorkerGuard` (new file `crates/ascent-proto/src/logging.rs`, behind feature `logging`, enabled by the CLI and app) so Task 9 reuses it.
- [ ] **Step 4:** Run `cargo run -p ascent-cli -- --simulate info`. Expected: prints `device_name: ascent_lite_plus … flashable: yes`.
- [ ] **Step 5: HARDWARE CHECKPOINT (user):** with the Lite+ plugged in, the user runs `cargo run -p ascent-cli -- --debug info`.
  - Pass: it prints the real device info.
  - Copy the real `devicename`, `firmwareInfo`, `hardwareVersion` and `receiveMaxSize` into REVERSE_ENGINEERING §2, plus the log's first RX hex line. Also record the real VID:PID.
  - If it fails: stop and debug with the log, using superpowers:systematic-debugging. Don't continue to Task 6 until this passes.
- [ ] **Step 6: Commit (ask first):** `feat: serial discovery and read-only CLI (list, info)`

### Task 6: Firmware pre-flight

**Files:**
- Create: `crates/ascent-proto/src/firmware.rs`, `crates/ascent-proto/tests/firmware.rs`

**Interfaces:**
- Consumes: `DeviceInfo`, `FoundDevice::is_flashable`
- Produces:
  - `#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)] pub struct FwVersion { pub major: u32, pub minor: u32, pub patch: u32, pub extra: Option<u32> }`, with `Display` as `V1.3.0` (or `V1.3.0.2`)
  - `pub fn file_version(file_name: &str) -> Option<FwVersion>`. Regex (case-insensitive) `^.*?(\d+)_(\d+)_(\d+)(?:(?:_z8_|_z40_|_hub_)(\d+))?\.img$`.
  - `pub fn device_version(firmware: &str) -> Option<FwVersion>`. Trailing `(\d+)_(\d+)_(\d+)$`.
  - `pub fn name_matches(file_name: &str, firmware: &str) -> bool`. Algorithm:
    1. Normalize both: lowercase; map `-`, ` ` and `.` to `_`; strip `.img`.
    2. The prefix tokens are the firmware's `_` tokens minus the trailing three numeric tokens, minus the token `ascent`.
    3. True iff that token run appears contiguously in the file's tokens **and** the next file token is all digits.
  - `pub struct Firmware { pub path: PathBuf, pub bytes: Vec<u8>, pub md5_hex: String, pub version: Option<FwVersion> }`
  - `pub enum Warning { Downgrade { from: FwVersion, to: FwVersion }, NameMismatch { expected: String }, UnknownVersion }`
  - `pub enum PreflightError { NotFlashable(String), PathTooLong, NotImg, Unreadable(std::io::Error), Empty }`
  - `pub fn preflight(info: &DeviceInfo, path: &Path) -> Result<(Firmware, Vec<Warning>), PreflightError>`. Reads the whole file and computes MD5 (`md-5`).
- [ ] **Step 1: Write failing tests:**
  - `parses_file_versions`: `"Ascent_Lite_Plus_1_3_0.img"` → `1.3.0`; `"x_16_4_4_z40_2.img"` → `16.4.4.2`; `"notes.txt"` → None.
  - `parses_device_version`: `"Ascent_Lite_Plus_1_2_3"` → `1.2.3`.
  - `name_match_rules`:
    - `("Ascent_Lite_Plus_1_3_0.img", "Ascent_Lite_Plus_1_2_3")` → true
    - `("ascent-lite-plus 1.3.0.img", "Ascent_Lite_Plus_1_2_3")` → true
    - `("Ascent_Lite_Plus_1_3_0.img", "Ascent_Lite_1_2_3")` → **false**
    - `("Ascent_VRX_1_3_0.img", "Ascent_Lite_Plus_1_2_3")` → false
    
    Placeholder strings: after the Task 5 checkpoint, replace them with the real `firmwareInfo` and add one test using the user's real `.img` filename.
  - `preflight_rejects` (Review Focus 4): the file doesn't exist → `Unreadable`; a 0-byte `.img` → `Empty`; a `.bin` → `NotImg`; a 201-char path → `PathTooLong`; device `ascent_vrx` → `NotFlashable`. None of these touch a device: `preflight` takes no `Connector`.
  - `preflight_warns_downgrade`: device `1_2_3`, file `1_1_0` → `[Downgrade{from 1.2.3, to 1.1.0}]`.
  - `preflight_md5`: a file containing `b"abc"` → `md5_hex == "900150983cd24fb0d6963f7d28e17f72"`.
- [ ] **Step 2:** Run `cargo test -p ascent-proto --test firmware`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same test. Expected: all passed.
- [ ] **Step 5: Commit (ask first):** `feat(proto): firmware pre-flight checks`

### Task 7: Upgrade state machine

**Files:**
- Create: `crates/ascent-proto/src/upgrade.rs`, `crates/ascent-proto/tests/upgrade.rs`
- Modify: `crates/ascent-proto/src/discovery.rs` (add `reconnect`)

**Interfaces:**
- Consumes: `Session`, `Connector`, `PortInfo`, `Firmware`, `file_info`, `reboot_mode`, `status_message`
- Produces:
  - `pub fn reconnect(conn: &dyn Connector, like: &PortInfo, delay: Duration, timeout: Duration, retry_every: Duration, timing: AckTiming) -> Result<(PortInfo, Session, DeviceInfo), UpgradeError>`
    1. Sleep `delay`.
    2. Loop: `list()`, then pick a port with the same vid/pid (and the same serial when both are `Some`).
    3. Open it, then `find_device` until it succeeds or `timeout`.
  - `pub struct UpgradeOptions { pub timing: AckTiming, pub reopen_delay: Duration, pub reconnect_timeout: Duration, pub reconnect_retry: Duration, pub status_poll: Duration, pub max_status_polls: u32 }`. `impl Default` uses the Global Constraints values.
  - `#[derive(Clone)] pub struct CancelToken(Arc<AtomicBool>)` with `new()`, `cancel()`, `is_cancelled()`
  - `pub enum Phase { Rebooting, Reconnecting, EnteringUpgrade, StartingTransfer, Sending, Finishing, Writing, Restarting, Verifying }`
  - `pub enum Progress { Phase(Phase), Sent { bytes: u64, total: u64 }, Writing { percent: u8 }, CancelLocked }`. `CancelLocked` is emitted right after SENDFILE_END is sent.
  - `pub struct UpgradeOutcome { pub port: PortInfo, pub info: DeviceInfo }` (device state after the final reconnect)
  - `pub enum UpgradeError { Session(SessionError), Device { code: i32, message: &'static str }, TransferRejected(String), Cancelled { recovered: bool }, Reconnect, StatusPollLimit, Failed { cause: Box<UpgradeError>, recovered: bool } }`, with `pub fn recovery_hint(&self) -> Option<&'static str>`. When `recovered == false`, it returns: `"Power-cycle the VTX (unplug USB and battery). If it doesn't return to normal, recover it with the Caddx Windows tool."`
  - `pub fn run_upgrade(conn: &dyn Connector, port: &PortInfo, fw: &Firmware, opts: &UpgradeOptions, cancel: &CancelToken, on: &mut dyn FnMut(Progress)) -> Result<UpgradeOutcome, UpgradeError>`
- [ ] **Step 1: Write failing tests** (SimConnector; options scaled down: timing 20/100 ms, reopen 10 ms, reconnect timeout 500 ms, poll 5 ms):
  - `happy_path_sequence`: a 10 000-byte firmware, sim `receive_max_size = 4096`.
    - The sim log command order is `60, 3("clean"), 60, 114, 115, 116×3, 117, 118…, 60`.
    - `received_file == fw.bytes`.
    - The 115 payload's `filePath` is `/tmp/pc/<basename>` and its md5 field equals `fw.md5_hex`.
    - `Progress` includes `CancelLocked` after the last `Sent`.
  - `port_moves_after_reboot` (Review Focus 2): `reboot_moves_to = Some("/dev/cu.usbmodem1201")` → Ok, and `outcome.port.path` is the new path.
  - `device_error_status`: `status_script = [{10,2},{0,-5}]` → `Err(Failed{cause: Device{code:-5,..}, recovered: true})`, and the log includes a REBOOT whose payload starts `b"normal"`.
  - `cancel_before_end_recovers`: cancel inside the `on` callback at the first `Sent` → `Err(Cancelled{recovered:true})`. 117 is never sent; REBOOT "normal" is sent.
  - `cancel_after_end_ignored`: cancel when `CancelLocked` is seen → Ok.
  - `unplug_mid_transfer` (Review Focus 3): `unplug_after_data_chunks = Some(1)` (the device vanishes from `list` and link I/O errors) → `Err(Failed{recovered:false,..})`, with `recovery_hint().is_some()`, returning within ≤ 2 s.
  - `chunk_size_clamped` (Review Focus 5): `receive_max_size = 0` → a single 116 for a 10 000-byte file (1 MiB cap); `receive_max_size = 50_000_000` → 116 chunks ≤ 1 048 576.
  - `transfer_rejected`: the sim returns 117 `detail "BAD"` → `Err(Failed{cause: TransferRejected("BAD"),..})`.
- [ ] **Step 2:** Run `cargo test -p ascent-proto --test upgrade`. Expected: FAIL.
- [ ] **Step 3:** Implement the sequence from the spec ("Upgrade sequence" steps 1–10):
  - The chunk size comes from the **second** FIND_DEVICE.
  - Status ≥ 0 continues; percent ≥ 100 ends polling.
  - Any error or cancel after step 2 triggers recovery: `send_no_ack(Reboot, reboot_mode("normal"))`, then `reconnect`. `recovered` = whether that succeeded.
  - Check the cancel token before each command until 117 is sent.
- [ ] **Step 4:** Run the same test. Expected: 8 passed. Then run `cargo test --workspace`. Expected: all pass.
- [ ] **Step 5: Commit (ask first):** `feat(proto): upgrade state machine with recovery`

### Task 8: CLI `flash` (Milestone 2)

**Files:**
- Modify: `crates/ascent-cli/src/main.rs`

**Interfaces:**
- Consumes: `find_devices`, `preflight`, `run_upgrade`, `UpgradeOptions::default()`, `CancelToken`, `Warning`, `UpgradeError::recovery_hint`

- [ ] **Step 1:** Add `ascent-flash flash <FILE.img> [--port PATH] [--yes]`.
  1. Find exactly one flashable device. With zero or several, print the candidates and exit 2.
  2. Run `preflight`.
  3. Print the device and file versions.
  4. For each `Warning`, ask `y/N` (skipped with `--yes`).
  5. Ask a final confirmation: "Keep USB connected and the VTX powered. Flash now? [y/N]".
  6. Run with a progress line (`indicatif` is optional; plain `\r` lines are fine).
- [ ] **Step 2:** Make Ctrl-C call `CancelToken::cancel()` (`ctrlc` crate). After `CancelLocked`, print "Device is writing firmware — do not unplug" and ignore further Ctrl-C.
- [ ] **Step 3:** On error, print the error and `recovery_hint()`; exit 1. On success, print "Done — now on <version from outcome.info.firmware>".
- [ ] **Step 4:** Run `cargo run -p ascent-cli -- --simulate flash /tmp/Ascent_Lite_Plus_9_9_9.img --yes` (create a 20 KB dummy file first). Expected: phases print, ending with "Done". Repeat with Ctrl-C mid-send. Expected: a "Cancelled" message, exit 1.
- [ ] **Step 5: HARDWARE CHECKPOINT (user, Windows recovery tool at hand):**
  - (a) Run `--debug flash <real.img>` and press Ctrl-C during "Sending". Pass: the VTX comes back on its old firmware (`info` shows the same version). This verifies the "normal" reboot recovery.
  - (b) Run `--debug flash <real.img>` to completion. Pass: `info` shows the new version.
  - Record the outcomes and any surprises (timings, ack seq behaviour, units of `receiveMaxSize`) in REVERSE_ENGINEERING §8. Don't start Task 9 until (b) passes.
- [ ] **Step 6: Commit (ask first):** `feat(cli): flash command`

### Task 9: Tauri backend (commands, device watcher, progress events)

**Files:**
- Create: `app/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,src/main.rs,src/state.rs}`, `app/src-tauri/capabilities/default.json`
- Modify: root `Cargo.toml` (include `app/src-tauri`)

**Interfaces:**
- Consumes: `SerialConnector`, `SimConnector`, `find_devices`, `preflight`, `run_upgrade`, `Progress`, `Phase`, `Warning`, `UpgradeError`
- Produces (Tauri commands, all `serde` JSON, camelCase):
  - `get_device() -> Option<DeviceView>`, where `DeviceView { port, name, firmware, hardware, serial, tempC, flashable, otherCount }`
  - `inspect_firmware(path: String) -> Result<FirmwareView, String>`, where `FirmwareView { fileName, version: Option<String>, warnings: Vec<WarningView{kind:"downgrade"|"nameMismatch"|"unknownVersion", text}> }`
  - `start_flash(path: String) -> Result<(), String>`. Returns immediately; the work runs on a thread.
  - `cancel_flash()`
  - Events:
    - `"device-changed"` → `Option<DeviceView>`
    - `"flash-progress"` → `{ phase, text, percent: Option<f32>, cancelLocked: bool }`
    - `"flash-done"` → `{ ok: bool, message, hint: Option<String> }`

- [ ] **Step 1:** Install the CLI: `cargo install tauri-cli --version "^2" --locked`. Expected: `cargo tauri --version` prints 2.x.
- [ ] **Step 2:** Create the crate. Settings:
  - Product name "Ascent Flasher (unofficial)", identifier `io.github.ascentflasher`.
  - `frontendDist: "../ui"`, `withGlobalTauri: true`.
  - Plugin `tauri-plugin-dialog`, with the capability granting `dialog:default`.
  - One 520×640 window.
  - Env `ASCENT_SIM=1` selects `SimConnector`.
  - Logging is set up the same way as the CLI: a per-run file in `~/Library/Logs/AscentFlasher/`, with trace-level hex when env `ASCENT_DEBUG=1`. Put the logging setup in one shared fn, `ascent_proto::logging::init(debug: bool) -> tracing_appender::non_blocking::WorkerGuard`, created in Task 5 and reused here.
- [ ] **Step 3:** Device watcher thread:
  - Every 1 s, call `Connector::list()`.
  - When the candidate set changes (and no flash is running), run `find_devices` and emit `device-changed`.
  - Keep the latest confirmed `FoundDevice` in `state.rs`.
- [ ] **Step 4:** Flash thread:
  - Run `preflight` again, then `run_upgrade`.
  - Map each `Progress` to `flash-progress` text from the spec: "Rebooting into upgrade mode…", "Sending firmware… N%", "Device is writing firmware… N%", and so on.
  - Pause the watcher while flashing. Emit `flash-done`.
- [ ] **Step 5:** Run `ASCENT_SIM=1 cargo tauri dev` from `app/src-tauri` (blank UI for now). Expected: it builds and the window opens. The terminal shows the watcher emitting `device-changed` with the sim Lite+.
- [ ] **Step 6: Commit (ask first):** `feat(app): tauri backend`

### Task 10: UI — layout A (Milestone 3)

**Files:**
- Create: `app/ui/{index.html,style.css,main.js}`

**Interfaces:**
- Consumes: the Task 9 commands/events via `window.__TAURI__.core.invoke`, `window.__TAURI__.event.listen`, `window.__TAURI__.dialog.{open,ask}`, and `getCurrentWebview().onDragDropEvent`.

- [ ] **Step 1:** Build the single-column layout matching the chosen mockup.
  - **Device card:** name, green/grey status dot, port, FW, HW, SN, °C. Empty state: "Plug in your Ascent device". If not flashable: "This device can't be flashed by this app".
  - **Drop zone:** click → `dialog.open({filters:[{name:"Firmware", extensions:["img"]}]})`; drag-drop → the first path. Show the file name and "→ V1.3.0".
  - **Flash firmware button:** enabled only when the device is flashable and a file is chosen.
  - **Progress bar + step text.**
  - **Error panel:** message + hint.
  - Light/dark via `prefers-color-scheme`.
- [ ] **Step 2:** Confirm flow on Flash:
  1. For each warning → `dialog.ask(text, {kind:"warning"})`. Cancelling stops.
  2. Final `ask("Keep USB connected and the VTX powered. Flash now?")`.
  3. `start_flash`.
  
  While flashing, the button becomes **Cancel** (`cancel_flash`). On `cancelLocked`, disable it with the text "Device is writing firmware — do not unplug". Also disable the drop zone while flashing.
- [ ] **Step 3:** Run `ASCENT_SIM=1 cargo tauri dev`. Check by hand:
  - The sim device card appears.
  - Choosing a dummy `Ascent_Lite_Plus_9_9_9.img` shows V9.9.9.
  - Flash runs to "Done".
  - Cancel mid-send shows the cancelled message.
  - Choosing `Ascent_VRX_1_0_0.img` triggers the name-mismatch warning.
- [ ] **Step 4: HARDWARE CHECKPOINT (user):** run `cargo tauri dev` with the Lite+. Pass: the card shows real info, and one full flash through the GUI succeeds. Then build with `cargo tauri build`. Expected: an `.app` in `target/release/bundle/macos/` that runs locally (unsigned).
- [ ] **Step 5: Commit (ask first):** `feat(app): single-window flash UI`
