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

### Observed on real hardware (2026-10-31, user's **Ascent Lite VTX** (not the Lite+), macOS)

`ascent-flash info` output:

| Field | Value |
|---|---|
| port | `/dev/cu.usbmodemCX201` |
| VID:PID | **`1D76:0101`**. The original's table calls 0x1D76 "Ascent GT Pro", so **the VID does not reliably identify the product**. Always confirm with FIND_DEVICE. |
| USB serial | `CX20` |
| devicename | `Ascent_lite` (mixed case) |
| firmwareInfo | `Ascent_H_Sky_17_5_8`. Version 17.5.8; the name prefix for the filename check is `H_Sky`. |
| hardwareVersion | `FPV-Ascent-Sky-482-V1.3-1.0` (matches the "H SKY482" family) |
| sdkversion, serialNumber | empty |
| receiveMaxSize | `1048576`. This is **bytes** (1 MiB chunks), the same as the original's default. |
| cputemp | 48 |
| status / detail | 0 / `OK` |

- **Seq echo:** the device echoes the request seq in its ack (`echoes_seq = yes`).
- **Reopen delay:** the original would wait 11500 ms for this device, because it keys the delay on VID 0x1D76.

### Observed on real hardware (2026-11-01, user's **Ascent Lite+ VTX**, macOS)

`ascent-flash info` output, compared with the Lite:

| Field | Lite+ | Lite |
|---|---|---|
| port | `/dev/cu.usbmodemCX241` | `/dev/cu.usbmodemCX201` |
| VID:PID | `1D76:0101` | `1D76:0101` (same) |
| USB serial | `CX24` | `CX20` |
| devicename | `Ascent_lite_plus` | `Ascent_lite` |
| firmwareInfo | `Ascent_H_Sky_18_21_10` (already on 18.21.10) | `Ascent_H_Sky_17_5_8` at the time |
| hardwareVersion | `FPV-Ascent-Sky-472-V1.3-1.1` | `FPV-Ascent-Sky-482-V1.3-1.0` |
| serialNumber | `1_0106` | empty |
| sdkversion | empty | empty |
| receiveMaxSize | `1048576` | `1048576` |
| cputemp | 54 | 48 |
| status / detail | 0 / `OK` | 0 / `OK` |

- **Same firmware family:** both report `H_Sky`, so the single `Ascent_H_Sky_*.img` covers the Lite and the Lite+ (confirms the inference in §10).
- **Same USB ID**, so the same 11.5 s reopen delay applies. The port name depends on the USB serial, so it differs per unit; the tool finds the device by VID/PID.
- **Seq echo:** yes, as on the Lite.
- Not flashed yet (it was already on the latest firmware).

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

- §2–§3 came from static decompilation. The Ascent upgrade flow has since been **confirmed on real hardware**; see "Confirmed by a real flash" below.
- ~~Chunk size above 5 KB~~ **Resolved:** `receiveMaxSize` is in bytes (1048576), and 1 MiB chunks are accepted.
- Recovery after a cancel (REBOOT "normal" from clean/upgrade mode) has not been exercised on hardware yet.
## 9. macOS tool (Artosyn `CaddxPcTool.app` v1.1.6) compared with the Windows tool (Caddx v2.2.9)

How this was examined: Ghidra headless decompile of the arm64 slice, plus `nm` symbols (C++ class and method names are intact). Static analysis only. The tool was not run.

| Aspect | macOS (Artosyn, Qt 6, `com.artosyn.CaddxPcTool`, Developer ID-signed Sept 2025, Gatekeeper-rejected) | Windows (Caddx, .NET 4.8 WinForms) |
|---|---|---|
| Scope | Firmware upgrade, plus a Settings page (log viewer, language, "send text to device") | Upgrade, gimbal, RC mode, Cam Hub, BB-freq table, CLI, PDF manuals, Velopack self-update |
| Device detection | USB **manufacturer string "artosyn"** (case-insensitive) **or** VID `0x1D6B–0x1D77` | VID table `0x1D6B–0x1D84` plus `0x1A86` (gimbal); WMI-based |
| Device names | `setting.ini` → `[Devices Name]` keyed `0x<vid>` (the file isn't shipped, so this lookup is always empty) | Device-name/firmware-string resolver (§2) |
| Wire protocol | Same `OTRA` 36-byte header, CRC-32, commands 3/60/114–118 | Same |
| Ack matching | Tracks acks **by seq** (map of outstanding seqs; logs "ACK check failed for seq") | V1 by command; V2 by command + seq |
| Unsolicited frames | Accepts **cmd 0** frames with a `0xFFFFFFFF` marker as an upgrade-status notification | Not handled |
| PC → device ack | Has `sendAckResponse(seq)`: type-2 frame, **cmd 1000 (0x3E8)**, format 2. Present but no caller found | None |
| Upgrade flow | REBOOT "clean" → wait for reconnect → file info → 116 chunks of `segLength` (= FIND_DEVICE `receiveMaxSize`) → 117 → poll 118, with a "RESEND retry" path | Same |
| Version policy | **Refuses** a target lower than current (`VERSION_ERR`); equal is OK. Filename must match `^[A-Za-z0-9_]+(_\d+)+\.img$`, with a prefix/segment-count check against the device | Warns on downgrade and lets the user continue; name mismatch is a warning |
| Multi-part images | `divim_sky` flow for **`Ascent_R_Sky_`** packages, which split into sub-images by name (uboot/bootloader, env, uimage/kernel, factory, rootfs, usrdata) with `16M`/`32M` size tags, plus app/FPGA parts | Not present |
| Secrets / extra handshake | None found: no keys, no encryption, no vendor unlock | None |

**Conclusion:** the Caddx Windows tool is the Artosyn reference protocol with Caddx features added on top. Nothing Caddx-specific is needed to flash an Ascent VTX. Two things worth adopting:
- **Manufacturer-string detection:** a device whose USB manufacturer string is "artosyn" can be accepted even with an unlisted VID.
- **Optional strict downgrade refusal:** refuse a lower target version outright, as the Mac tool does.

Our tool doesn't support the `Ascent_R_Sky_` multi-part flow; it would need its own reverse-engineering pass.

### Confirmed by a real flash (2026-10-31, `Ascent_H_Sky_17_5_8.img` re-flashed to the same version)

| Step | Observed |
|---|---|
| FIND_DEVICE | reply in 50–125 ms |
| REBOOT "clean" | no ack; the device re-enumerated on the **same path and VID:PID**; FIND_DEVICE answered at the first try after the 11.5 s delay |
| REMOTE_UPGRADE (114) | ack in 1 ms (68-byte payload) |
| SENDFILE_START (115) | ack in 2 ms |
| SENDFILE_DATA (116) | 11 chunks: 10 × 1 MiB plus the remainder. Each acked in ~170 ms (~6 MB/s); no resends; `cursize` cumulative |
| SENDFILE_END (117) | reply in 350 ms: `{length 0, cursize 11509044, totalsize 11509044, status 0, "OK"}` |
| UPGRADE_STATUS (118) | polled at 1 s: 38 % → 79 % → 79 % → 100 %. Status 2 (IN_PROGRESS) while writing, 3 (DONE) at the end; detail empty |
| self-reboot | back after the 11.5 s wait; FIND_DEVICE reported `Ascent_H_Sky_17_5_8` |
| totals | about 30 s end to end; no CRC warnings; seq echoed on every reply |

### Deliberate cancel (2026-11-01, Ascent Lite, app, file `Ascent_H_Sky_18_21_10.img`, device on 17.5.8)

Cancel was pressed during "Reconnecting…", after REBOOT "clean".

| Step | Observed |
|---|---|
| clean-mode FIND_DEVICE | after the 11.5 s wait: `devicename "Ascent"` (not `Ascent_lite`), `cpu_temp 0`, firmware still `Ascent_H_Sky_17_5_8`, `hardware_version "FPV-Edu-Sky-V0.0-0.0"`, empty serial, `receiveMaxSize 1048576`, seq echoed |
| cancel | taken at the first check after the reconnect, before REMOTE_UPGRADE; nothing was sent to flash |
| REBOOT "normal" (recovery) | **ignored**: the device kept its USB link and kept answering in clean mode for the whole 11.5 s drop window. The tool reported "not recovered" as designed |
| way out | power-cycle (USB and battery); firmware unchanged |

So on the Lite, clean mode does not act on REBOOT "normal". That matches the Windows tool sending it only for VRX/GT Pro. On this device the recovery hint (power-cycle) is the real recovery path.

### Upgrade through the app (2026-11-01, Ascent Lite, 17.5.8 → 18.21.10)

After the cancel and a power cycle, the app flashed `Ascent_H_Sky_18_21_10.img` (15.6 MB, 15 chunks) in about 30 s: transfer 1.3 s, SENDFILE_END reply in 420 ms, UPGRADE_STATUS 38 → 59 → 79 → 79 → 100 %, back after the 11.5 s wait reporting `Ascent_lite` on `Ascent_H_Sky_18_21_10`. The protocol is unchanged in 18.21.10.

The cancel is only checked between steps, so it can take up to the 11.5 s reconnect wait to act. The app now keeps the button in a "Cancelling…" state until then (the first test needed two presses because the status line was redrawn back to "Reconnecting…").
- The exact format of `fpv_bb_freq.bin`, and whether 120 replies with cmd 120 or 116 (the code handles both).
- The firmware container format (`.img` for Ascent, `.bin` for gimbals). The device validates it (board type, version, CRC); the PC sends it as-is.

## 10. Firmware image format and newer releases

- **`.img` container:** it begins with the magic `ASW\0`, followed by a small partition/section table. Contents: a gzipped `u-boot.bin`, then a UBI root filesystem. From 18.x onward it also includes a kernel/device-tree (FIT) section. The PC sends the file unchanged; the device parses it.
- **Device OS:** Linux. Its U-Boot config is `console=ttyAMA0,115200`.
- **NAND layout:** A/B (dual-bank), with `fpvbsel` selecting the bank: `512K(boot),512K(env),1M(sel),4M(kernel0),4M(kernel1),6M(factory),16M(rootfs0),16M(rootfs1),32M(usrdata0),32M(usrdata1)`. **`factory` probably holds per-unit RF calibration. Never erase it.**
- **V18.21.10 (2026-08):** the package ships the same Windows installer (PC Tool 2.2.9, byte-identical to the one analyzed here), so the upgrade protocol is unchanged. Release notes: it adds Lite+ air-unit support, allows updates on USB power alone, and stops daemon logging to NAND (cited as a possible bricking cause). `Ascent_H_Sky_18_21_10.img` is 15.6 MB, MD5 `b78373e21b0131bd0c4864269ba1025b`, and has the same NAND layout as 17.5.8.
- **One air-unit image for both models:** V18.21.10 ships a single air-unit image (`Ascent_H_Sky_*`) and lists Lite+ support as new. The likely inference is that this one image covers both the Lite and the Lite+. **Confirmed 2026-11-01:** the Lite+ reports `Ascent_lite_plus` with firmware `Ascent_H_Sky_18_21_10` and the same VID:PID as the Lite (see §2). The flash and cancel results above come from the **Lite**; the Lite+ has only been read so far.
