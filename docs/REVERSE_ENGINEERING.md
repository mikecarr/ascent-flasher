# Caddx PC Tool C v2.2.9 — Reverse-Engineering Notes

Goal: re-implement the device-flashing/config tool for macOS/Linux (Rust or Avalonia).
Source of truth: `Caddx_PC_Tool_V2.2.9_C_win_Setup.exe` (the `.zip` contains the identical file).

## 1. Packaging (how the files were extracted)

| Layer | What it is | How to open it |
|---|---|---|
| `…_win_Setup.exe` | Inno Setup **6.7.0** installer (innoextract 1.9 can't read it) | One LZMA2 chunk (`zlb\x1a` at file offset `0xD5E00`). Setup header at `0x7E51158`, LZMA1 in 4 KiB CRC'd blocks |
| Inno payload | One file: `{tmp}\VelopackSetup.exe`, run with `--silent --installto {localappdata}\Programs\Caddx_PC_Tool` | Inno's x86 CALL/JMP (E8/E9) filter, 64 KiB blocks, is applied to the **whole** file, including the appended zip. You have to undo it first |
| `VelopackSetup.exe` | Velopack bootstrapper with a `.nupkg` (zip) appended at offset `0x441400` | `7z x` |
| `lib/app/Caddx PC Tool.exe` | **.NET Framework 4.8 WinForms** app, x64, **not obfuscated** | `ilspycmd -p` (decompiles to 198 C# files) |

Third-party libraries: AntdUI (UI), WeifenLuo DockPanel, WebView2, PdfiumViewer (manuals), NLog, Newtonsoft/System.Text.Json, Velopack (updates from `github.com/CaddxFPV-Cust/Caddx-PC-Tool-C-Release`).
None of these are needed to talk to the device.

**Firmware is not bundled or downloaded.** The user picks a local file: `.img` for Ascent devices, `.bin` for gimbals.

## 2. Device discovery

- Every device shows up as a **USB CDC serial port**. Windows uses WMI (`Win32_PnPEntity`, regex `VID_xxxx&PID_xxxx`, `(COMn)`).
  - macOS/Linux replacement: `serialport::available_ports()` gives `UsbPortInfo{vid,pid}` (`/dev/cu.usbmodem*`, `/dev/ttyACM*`).
- The VID (not the PID) identifies the product family (`VIDConst.cs`). Supported range: `0x1A86 … 0x1D84`.

| VID (hex) | Dec | Name |
|---|---|---|
| 1A86 | 6790 | GM V2 gimbal (WCH CH34x/CH9102 bridge). **Baud 460800** |
| 1D6B–1D74 | 7531–7540 | Ascent L GND401 / L SKY402 / H SKY482 / L GND / GND/SKY EX1–3 |
| 1D75 | 7541 | Ascent VRX |
| 1D76 | 7542 | Ascent GT Pro |
| 1D77–1D7B | 7543–7547 | VRX Pro / VRX Max / VRX Cine / VRX EX / VRX EX2 |
| 1D80 | 7552 | Ascent JoyStick |
| 1D81–1D84 | 7553–7556 | OPV2 VTX / Z40 VTX / Z8 VTX / VRX |

- All other devices use **115200 8N1** (the baud rate likely doesn't matter for a real CDC-ACM device).
- After the port opens, the tool sends `FIND_DEVICE` (cmd 60). The device name in the reply (e.g. `ascent_vrx_max_wf`) maps to a display name (`AscentDeviceNameResolver.cs`).
  - The consumer "C" build only accepts `ascent_lite`, `ascent_lite_plus`, `ascent_vrx`, `ascent_vrx_pro`, `caddxsimgm`, `caddx_gm3`, `caddx_gm1`. This is UI gating, not something the protocol enforces.
- After a reboot, the tool waits a per-VID delay before reopening the port (`GD.cs`): 8000 ms by default, 9500–12000 ms for VRX/GT Pro, 6000 ms for the gimbal. The port name can change, so it re-finds the port by VID/PID.

## 3. Ascent ("AR"/Artosyn) serial protocol — the main one

Used by all Ascent goggles, VRX, VTX and the GM V2 gimbals.
Code: `UsbSerialportFSM.cs` (what the UI uses) and `ArTransportV2.cs` (a cleaner copy with the same wire format).

### Frame = 36-byte header + payload (all little-endian, packed)

| Off | Size | Field | Value |
|---|---|---|---|
| 0 | u32 | magic | `0x4152544F` (bytes `4F 54 52 41` = "OTRA", i.e. "ARTO" as a u32) |
| 4 | u16 | version | `0x0CDC` (3292) |
| 6 | u16 | type | 1 = request, 2 = ack |
| 8 | u16 | msgid | 0 |
| 10 | u16 | unused | `0xABCD` |
| 12 | u32 | command | see below |
| 16 | u16 | format | 2 (binary) |
| 18 | u16 | userid | 0 |
| 20 | u32 | length | payload bytes |
| 24 | u32 | seq | increments per new request; resends reuse it |
| 28 | u32 | retry | 0, then 1, 2, … on resend |
| 32 | u32 | crc32 | standard CRC-32 (poly `0xEDB88320`, init/xorout `0xFFFFFFFF`) over **header with crc=0** + payload |

- Receive side: scan for the magic (skip 1 byte on mismatch). Reject frames where `36 + length > 5120`.
- Matching: an ack has the same `command`. The app matches the pending request by command (and by seq in V2).
- Retry policy: resend every 2000 ms, give up after 8000–10000 ms total.

### Commands

| Cmd | Name | Request payload | Ack payload |
|---|---|---|---|
| 3 | REBOOT | 32-byte ASCII mode, NUL-padded: `"clean"` (enter upgrade/clean system) or `"normal"` | (sent without waiting for an ack; the port drops) |
| 60 | FIND_DEVICE | — | `ResDeviceInfo` (see below) |
| 114 | REMOTE_UPGRADE | — | — |
| 115 | SENDFILE_START | `ArFileInfo` (328 bytes) | — |
| 116 | SENDFILE_DATA | raw chunk (≤ `receiveMaxSize`) | `ResFileDataInfo` |
| 117 | SENDFILE_END | — | `ResFileDataInfo`; success = `status==0 && detail=="OK"` |
| 118 | UPGRADE_STATUS | — | `{i32 percent, i32 status, char detail[64]}` |
| 119 | SEND_TEXT (CLI) | 28 bytes: `"ASW\0", type, 0x14, …` | `{i32 status, char detail[64]}` |
| 120 | GET_BB_FREQ_CONFIG | — | ASCII text (device sends it back as cmd 116 data) |
| 121 | SET_BB_FREQ_CONFIG | — | `{i32 status, char detail[64]}` |
| 122 | FACTRESET_BB_FREQ | — | `{i32 status, char detail[64]}` |

```
ResDeviceInfo (ack 60):
  i32 receiveMaxSize; char sdkversion[32]; char devicename[64]; i32 cputemp;
  char firmwareInfo[64]; char serialNumber[32]; char hardwareVersion[32];
  i32 status; char detail[64]                                  // 300 bytes
ArFileInfo (req 115):
  char md5[64]   // lowercase hex MD5 string of the whole file, NUL-padded
  i32  length; i32 saveAsFile = 1
  char filePath[128]  // remote path, e.g. "/tmp/pc/<basename>"
  char fileDir[128]   // the *local* path with '/' separators, last 128 chars (informational)
ResFileDataInfo: i32 length; i32 cursize; i32 totalsize; i32 status; char detail[64]
```

### Firmware upgrade sequence (`UpgradeProcessFSM.cs`)

1. `FIND_DEVICE` → read `receiveMaxSize`. This becomes the chunk size; the default is 1 MiB, but frames over 5120 bytes are rejected on *receive* only.
2. `REBOOT "clean"` → close the port → wait the per-VID delay → reopen (timeout `ReOpenTimeout_Asce` = 200 s).
3. `FIND_DEVICE` (again, on the clean system).
4. `REMOTE_UPGRADE`.
5. `SENDFILE_START` with remote path `/tmp/pc/<basename of the chosen file>` (e.g. `/tmp/pc/foo_1_3_0.img`, extension kept).
6. Loop `SENDFILE_DATA` chunks, waiting for an ack after each one (stop-and-wait).
7. `SENDFILE_END`, then check for `"OK"`.
8. Poll `UPGRADE_STATUS` every 1 s (max 200 times) until `percent >= 100`.
   - A negative `status` is an error: −12 CHIPID, −11 FLASH_ERR, −10 MAX, −9 IMG_CRC, −8 IMG_TYPE, −7 UPGRADE_MODE, −6 APP_VERSION (too old), −5 BOARD_TYPE (wrong model), −4 BAD_FILE, −3 NO_FILE, −2 NO_PC, −1 NO_SD.
   - Non-negative values: 0 VERIFY_IMAGE, 1 START, 2 IN_PROGRESS, 3 DONE, 4/5 CLEAN_SYSTEM.
   - On failure, VRX and GT Pro devices get `REBOOT "normal"`.
9. The device reboots by itself → reopen → `FIND_DEVICE` to show the new version.

### Config file push (same file-transfer commands, no reboot first)

- `msp_rc_cfg.json` (RC mode slots) and `mipi_hub.json` (CamHub: Z8/MAX/Z40/HDMI, resolution, priority, flight controller) → `SENDFILE_START/DATA/END` to `/factory/<name>`. The whole file is sent as one chunk.
- BB frequency table (`fpv_bb_freq.bin`): send to `/factory/…` and then `SET_BB_FREQ_CONFIG`. Read it back with `GET_BB_FREQ_CONFIG`; the reply is text and gets saved to disk.

## 4. Legacy gimbal protocol (non-V2 GM gimbals; `Upg_Gimbal.cs`, `Serialport_Gimbal.cs`)

- Control command: `7E 16 <cmd> <roll i16 BE ×100> <pitch> <yaw> 5A A5`. Command values are in `GIM_CMD` (0 Start, 1 Stop, 2 CalibGyro, 3–10 gains/channels, 12–14 Push/Down/Write params, 21–37 mode settings).
- Telemetry: 118/121-byte frames starting `AB FF`, laid out per `ConstEnum.cs` (floats at offset 6, 16 channels at 54, sum+add checksums at 116/117).
- Firmware upgrade, where the **device pulls** the data:
  - Start: `EA 55 11 1E 41 00 <u32 len> <u32 crc32(fw)> 00 <crc16>`.
  - The device then asks for `{u32 offset @11, u8 size @15}`. The host replies `EA 55 <41 or shorter> 20 41 00 01 <data> <u32 offset> <u32 size> <crc16>`.
  - The upgrade aborts if the same offset repeats too many times.
- CRC16 = CRC-16/XMODEM (poly `0x1021`, init 0, as the code computes it; the byte order follows `BitConverter`, i.e. LE). CRC32 = standard.
- Some gimbal screens use **MAVLink** (a full generated `MAVLink.cs`, the Mission Planner flavour) through `MavSerialport.cs` at 115200.

## 5. MSP

`MSPHelper`/`MspFrameParser` implement standard **MSP v1** (`$M<`/`$M>`, size, cmd, XOR checksum). It's used for the Betaflight RC-mode screens. There are existing Rust crates for this, or it's a ~100-line implementation.

## 6. User interface (what to rebuild)

WinForms with the AntdUI controls. UI strings live in `resource/language/{en-US,zh-CN,ru-RU}.json` (272 flat dotted keys, which can be reused as a translation catalog).

**Shell**
- `SplashScreen` → user agreement → `MainFrm`.
- Left sidebar (`SidebarCtrl`): **Device** / **Settings** / **Help** (PDF manuals, FAQ) / **Product Series** / **Customer Service**. It also holds the Velopack "check for software update" button.

**Device flow**
1. `FindDeviceFrm` shows a card per detected COM port (`DeviceInfoCard`: "Discover devices", "Unsupported device", "Device occupied"). Each card shows name, HW/FW version and temperature from `FIND_DEVICE`.
2. Clicking a card opens a function picker (`FunctionSelectFrm`). If only one function is available, it goes straight to it.
3. Functions per device and user level (`MainFrm.GetAvailableFunctions`):
   - Default user / most devices: **Upgrade** only.
   - Ascent GT Pro Z8/Z40/Hub (level `op`): **Cam Hub**, **RC Mode**, **Upgrade**.
   - Level `customA`, Max/VRX: **Update channel** (BB freq), **Upgrade**.
   - Level `caddx`: all five.
   - Gimbals: **GM Set**.
   - Levels are unlocked by a hidden password dialog (`PasswordFrm`) that compares against hard-coded strings.

**Screens**

| Screen | Class | Contents |
|---|---|---|
| Ascent Upgrade | `AscentUpdataFrm`, `StartUpgAscentModalFrm` | Device HW/FW/temp. Drag-and-drop or pick a `*.img` file; the version is parsed from a filename like `x_y_z.img`, and the expected filename prefix is checked against the device. Warns on downgrade. "Tips" modal before starting. Progress bar + step text. Disconnect/Reconnect |
| Update channel | `updateChannel` | Table (ListView) of bands/frequencies, at most 12 entries, with validation (no duplicates, ascending, multiples). Load/save `bb_freq` file, read from device, write to device, factory reset |
| RC Mode | `RCModeCtrl`, `RangeSliderControl` | 4 "slots" mapping RC channel ranges to functions (zoom control/reset, camera change/reset). Range sliders. Uploads `msp_rc_cfg.json` (~20 s) |
| Cam Hub | `CamHubCtrl` | Per-input (Z8/MAX/Z40/HDMI) resolution, selected and priority settings, flight-controller type. Generate/read/upload `mipi_hub.json` |
| GM Set (gimbal) | `NewGimbalFrm` | Start/Stop, gyro and position calibration. Mode/sens/roll/pitch/yaw channel assignment, gains, sensitivity. Modes: FPV, Pitch-Stab, Horizon, Horizon-lookdown, FPV-lookdown. Angle protection. Live roll/pitch/yaw angles and temperature. Load/save/write param JSON. Firmware `*.bin` upgrade with progress |
| CLI | (in `CliSendProtocol` + UI) | Pick a COM port and a preset command (RF_Offset, VTX_MAC_Enable/Disable) → cmd 119. Can also launch **PuTTY** for a raw console |
| Settings | `SoftwareSettingFrm` | Language (EN/ZH/RU), software version, user agreement |

## 7. What a Mac/Linux re-implementation needs

1. Port enumeration filtered by VID (`serialport` crate).
2. The AR framing + CRC32 + ack/retry state machine (about 300 lines).
3. Upgrade flow, including **reconnect after reboot by VID/PID** (the device path changes).
4. Optional: config pushes, BB-freq, legacy gimbal, MSP, MAVLink.

**macOS/Linux gotchas:**
- Use `/dev/cu.*`, not `tty.*`, on macOS.
- On Linux the user must be in the `dialout`/`uucp` group (or add a udev rule for VIDs 1D6B–1D84 and 1A86).
- ModemManager may grab new ACM ports. Add a udev `ID_MM_DEVICE_IGNORE` rule.
- VID 0x1D6B is the Linux Foundation's ID (the Ascent devices run a Linux USB gadget), so a broad filter can also match non-Caddx Linux gadgets. Always confirm with `FIND_DEVICE`.

## 8. Unverified / open questions

- Everything above comes from static decompilation. **No traffic was captured from a real device.**
- Whether the device accepts data chunks larger than ~5 KB in practice: the PC caps *received* frames at 5120 bytes, but sends chunks of `receiveMaxSize` (units unclear; the UI labels it "kb").
- The exact format of `fpv_bb_freq.bin`, and whether 120 replies with cmd 120 or 116 (the code handles both).
- The firmware container format (`.img` for Ascent, `.bin` for gimbals). The device validates it (board type, version, CRC); the PC sends it as-is.
