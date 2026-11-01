import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAGIC, HEADER_LEN, MAX_FRAME_LEN, CMD, crc32, encodeRequest, encodeAck,
  decodeHeader, FrameReader, decodeDeviceInfo, encodeDeviceInfo, fileInfo,
  decodeFileDataInfo, encodeFileDataInfo, decodeUpgradeStatus,
  encodeUpgradeStatus, rebootPayload, statusMessage,
} from "../lib/protocol.js";

const enc = new TextEncoder();
const ascii = (s) => enc.encode(s);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const putStr = (b, off, s) => b.set(ascii(s), off);
const putI32 = (b, off, v) => new DataView(b.buffer).setInt32(off, v, true);
const u32le = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const dec = (b) => new TextDecoder().decode(b);

// ---- frame.rs ----

test("constants", () => {
  assert.equal(MAGIC, 0x4152544f);
  assert.equal(HEADER_LEN, 36);
  assert.equal(MAX_FRAME_LEN, 5120);
  assert.deepEqual(CMD, {
    REBOOT: 3, FIND_DEVICE: 60, REMOTE_UPGRADE: 114, SENDFILE_START: 115,
    SENDFILE_DATA: 116, SENDFILE_END: 117, UPGRADE_STATUS: 118,
  });
});

test("crcMatchesStandardVector", () => {
  assert.equal(crc32(ascii("123456789")), 0xcbf43926);
  assert.equal(crc32(ascii("1234"), ascii("56789")), 0xcbf43926);
});

test("encodesFindDeviceHeader", () => {
  const f = encodeRequest(60, new Uint8Array(0), 7, 0);
  assert.equal(f.length, 36);
  const expect = Uint8Array.from([
    0x4f, 0x54, 0x52, 0x41, 0xdc, 0x0c, 0x01, 0x00, 0x00, 0x00, 0xcd, 0xab, 0x3c, 0x00, 0x00,
    0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);
  assert.deepEqual(f.slice(0, 32), expect);
  const h = concat(expect, new Uint8Array(4));
  assert.deepEqual(f.slice(32, 36), u32le(crc32(h)));
});

test("roundtripWithPayload", () => {
  const payload = Uint8Array.from({ length: 328 }, (_, i) => i & 0xff);
  const f = encodeRequest(115, payload, 3, 1);
  const hdr = f.slice(0, 36);
  const h = decodeHeader(hdr);
  assert.equal(h.command, 115);
  assert.equal(h.length, 328);
  assert.equal(h.seq, 3);
  assert.equal(h.retry, 1);
  assert.equal(h.type, 1);
  const z = hdr.slice();
  z.fill(0, 32, 36);
  assert.equal(crc32(z, f.slice(36)), h.crc32);
  assert.deepEqual(f.slice(36), payload);
});

test("rejectsBadMagic", () => {
  const hdr = encodeRequest(60, new Uint8Array(0), 0, 0).slice(0, 36);
  hdr[0] ^= 0xff;
  assert.equal(decodeHeader(hdr), null);
});

test("encodesAckType", () => {
  const f = encodeAck(60, Uint8Array.of(1, 2, 3), 9);
  const hdr = f.slice(0, 36);
  const h = decodeHeader(hdr);
  assert.equal(h.type, 2);
  assert.equal(h.command, 60);
  assert.equal(h.format, 2);
  assert.equal(h.length, 3);
  assert.equal(h.seq, 9);
  assert.equal(h.retry, 0);
  const zeroed = hdr.slice();
  zeroed.fill(0, 32, 36);
  assert.equal(h.crc32, crc32(zeroed, Uint8Array.of(1, 2, 3)));
  assert.deepEqual(f.slice(36), Uint8Array.of(1, 2, 3));
});

// ---- reader.rs ----

test("readsFrameSplitAcrossPushes", () => {
  const payload = Uint8Array.from({ length: 100 }, (_, i) => i);
  const bytes = encodeRequest(7, payload, 1, 0);
  const r = new FrameReader();
  r.push(bytes.subarray(0, 10));
  assert.equal(r.next(), null);
  r.push(bytes.subarray(10, 40));
  assert.equal(r.next(), null);
  r.push(bytes.subarray(40));
  const f = r.next();
  assert.deepEqual(f.payload, payload);
  assert.equal(f.header.command, 7);
  assert.equal(r.next(), null);
});

test("skipsLeadingGarbage", () => {
  const r = new FrameReader();
  r.push(concat(ascii("U-Boot 2020\r\n"), Uint8Array.of(0, 0xff)));
  r.push(encodeRequest(3, ascii("hello"), 2, 0));
  const f = r.next();
  assert.equal(dec(f.payload), "hello");
  assert.equal(f.header.seq, 2);
});

test("skipsOversizedLength", () => {
  const bad = encodeRequest(1, new Uint8Array(0), 1, 0);
  new DataView(bad.buffer).setUint32(20, 6000, true);
  assert.equal(bad.length, HEADER_LEN);
  const warnings = [];
  const r = new FrameReader((m) => warnings.push(m));
  r.push(bad);
  r.push(encodeRequest(9, ascii("ok"), 5, 0));
  const f = r.next();
  assert.equal(f.header.command, 9);
  assert.equal(dec(f.payload), "ok");
  assert.equal(warnings.length, 1);
});

test("twoFramesInOnePush", () => {
  const buf = concat(encodeRequest(1, ascii("aa"), 1, 0), encodeRequest(2, ascii("bbb"), 2, 0));
  const r = new FrameReader();
  r.push(buf);
  assert.equal(dec(r.next().payload), "aa");
  assert.equal(dec(r.next().payload), "bbb");
  assert.equal(r.next(), null);
});

test("crcMismatchDropsFrame", () => {
  const bad = encodeRequest(1, ascii("xx"), 1, 0);
  bad[HEADER_LEN] ^= 0xff;
  const warnings = [];
  const r = new FrameReader((m) => warnings.push(m));
  r.push(bad);
  r.push(encodeRequest(2, ascii("yy"), 2, 0));
  const f = r.next();
  assert.equal(f.header.command, 2);
  assert.equal(warnings.length, 1);
});

// ---- payload.rs ----

test("commandIds", () => {
  assert.equal(CMD.FIND_DEVICE, 60);
  assert.equal(CMD.UPGRADE_STATUS, 118);
});

test("deviceInfoDecodesOffsets", () => {
  const b = new Uint8Array(300);
  putI32(b, 0, 4096);
  putStr(b, 4, "1.0.0");
  putStr(b, 36, "ascent_lite_plus");
  putI32(b, 100, 42);
  putStr(b, 104, "Ascent_Lite_Plus_1_2_3");
  putStr(b, 168, "SN123");
  putStr(b, 200, "V1.0");
  putI32(b, 232, 0);
  putStr(b, 236, "OK");
  assert.deepEqual(decodeDeviceInfo(b), {
    receiveMaxSize: 4096,
    sdkVersion: "1.0.0",
    deviceName: "ascent_lite_plus",
    cpuTemp: 42,
    firmware: "Ascent_Lite_Plus_1_2_3",
    serialNumber: "SN123",
    hardwareVersion: "V1.0",
    status: 0,
    detail: "OK",
  });
});

test("deviceInfoTooShort", () => {
  assert.throws(() => decodeDeviceInfo(new Uint8Array(10)), /too short/);
});

test("fileInfoLayout", () => {
  const md5 = "d41d8cd98f00b204e9800998ecf8427e";
  const b = fileInfo(md5, 5, "/tmp/pc/a.img", "/Users/x/a.img");
  assert.equal(b.length, 328);
  assert.deepEqual(b.slice(0, 32), ascii(md5));
  assert.equal(b[32], 0);
  assert.deepEqual(b.slice(64, 68), u32le(5));
  assert.deepEqual(b.slice(68, 72), u32le(1));
  assert.deepEqual(b.slice(72, 72 + 13), ascii("/tmp/pc/a.img"));
  assert.equal(b[72 + 13], 0);
  assert.deepEqual(b.slice(200, 200 + 14), ascii("/Users/x/a.img"));
  assert.equal(b[200 + 14], 0);
});

test("fileInfoTruncatesLongLocalPath", () => {
  const local = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  const b = fileInfo("x", 1, "/tmp/pc/a.img", local);
  assert.deepEqual(b.slice(200, 328), ascii(local).slice(300 - 128));
});

test("fileInfoNormalisesBackslashes", () => {
  const b = fileInfo("x", 1, "/r", "C:\\dir\\a.img");
  assert.deepEqual(b.slice(200, 200 + 12), ascii("C:/dir/a.img"));
});

test("rebootModePads", () => {
  const m = rebootPayload("clean");
  assert.equal(m.length, 32);
  assert.deepEqual(m.slice(0, 5), ascii("clean"));
  assert.ok(m.slice(5).every((x) => x === 0));
});

test("statusMessagesCoverCodes", () => {
  for (let code = -12; code <= -1; code++) {
    const m = statusMessage(code);
    assert.notEqual(m, "Upgrade failed (unknown error)", `code ${code}`);
    assert.ok(m.length > 0);
  }
  assert.equal(statusMessage(-5), "Wrong model: this firmware is for a different device");
  assert.equal(statusMessage(-6), "Firmware version is too old for this device");
  assert.equal(statusMessage(-9), "Firmware image CRC error");
  assert.equal(statusMessage(-99), "Upgrade failed (unknown error)");
});

test("fileDataInfoDecodes", () => {
  const b = new Uint8Array(80);
  putI32(b, 0, 1);
  putI32(b, 4, 2);
  putI32(b, 8, 3);
  putI32(b, 12, 0);
  putStr(b, 16, "OK");
  const f = decodeFileDataInfo(b);
  assert.deepEqual(
    [f.length, f.cursize, f.totalsize, f.status, f.detail],
    [1, 2, 3, 0, "OK"],
  );
  assert.throws(() => decodeFileDataInfo(b.slice(0, 5)), /too short/);
});

test("upgradeStatusDecodes", () => {
  const b = new Uint8Array(72);
  putI32(b, 0, 50);
  putI32(b, 4, -9);
  putStr(b, 8, "bad");
  const u = decodeUpgradeStatus(b);
  assert.deepEqual([u.percent, u.status, u.detail], [50, -9, "bad"]);
  assert.throws(() => decodeUpgradeStatus(b.slice(0, 71)), /too short/);
});

test("deviceInfoRoundtrip", () => {
  const d = {
    receiveMaxSize: 1048576, sdkVersion: "2.0", deviceName: "ascent", cpuTemp: -3,
    firmware: "fw", serialNumber: "SN", hardwareVersion: "hw", status: 0, detail: "OK",
  };
  const b = encodeDeviceInfo(d);
  assert.equal(b.length, 300);
  assert.deepEqual(decodeDeviceInfo(b), d);
  const r = decodeDeviceInfo(encodeDeviceInfo({ ...d, sdkVersion: "x".repeat(50) }));
  assert.equal(r.sdkVersion.length, 32);
});

test("fileDataInfoRoundtrip", () => {
  const f = { length: 10, cursize: 20, totalsize: 30, status: -1, detail: "err" };
  const b = encodeFileDataInfo(f);
  assert.equal(b.length, 80);
  assert.deepEqual(decodeFileDataInfo(b), f);
});

test("upgradeStatusRoundtrip", () => {
  const u = { percent: 100, status: 3, detail: "DONE" };
  const b = encodeUpgradeStatus(u);
  assert.equal(b.length, 72);
  assert.deepEqual(decodeUpgradeStatus(b), u);
});
