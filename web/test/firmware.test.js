import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FIRMWARE_BYTES, REMOTE_DIR, fileVersion, deviceVersion, compareVersions,
  formatVersion, nameMatches, warningText, PreflightError, preflight, restartMismatch,
} from "../lib/firmware.js";

const v = (major, minor, patch, extra = null) => ({ major, minor, patch, extra });
const FW = "Ascent_H_Sky_17_5_8";
const info = (deviceName, firmware) => ({
  receiveMaxSize: 4096, sdkVersion: "", deviceName, cpuTemp: 0, firmware,
  serialNumber: "", hardwareVersion: "", status: 0, detail: "",
});
const file = (name, content = "x") => {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
};
const H = "localhost";
const kind = (p) => p.then(() => assert.fail("resolved"), (e) => { assert.ok(e instanceof PreflightError); return e.kind; });

test("constants", () => {
  assert.equal(MAX_FIRMWARE_BYTES, 268435456);
  assert.equal(REMOTE_DIR, "/tmp/pc/");
});

test("parsesFileVersions", () => {
  assert.deepEqual(fileVersion("Ascent_Lite_Plus_1_3_0.img"), v(1, 3, 0));
  const e = fileVersion("x_16_4_4_z40_2.img");
  assert.deepEqual(e, v(16, 4, 4, 2));
  assert.equal(formatVersion(e), "V16.4.4.2");
  assert.equal(formatVersion(v(1, 3, 0)), "V1.3.0");
  assert.equal(fileVersion("notes.txt"), null);
  assert.deepEqual(fileVersion("Ascent_H_Sky_17_6_0.IMG"), v(17, 6, 0));
});

test("parsesDeviceVersion", () => {
  assert.deepEqual(deviceVersion("Ascent_H_Sky_17_5_8"), v(17, 5, 8));
  assert.deepEqual(deviceVersion("Ascent_Lite_Plus_1_2_3"), v(1, 2, 3));
  assert.equal(deviceVersion("garbage"), null);
});

test("compareVersions", () => {
  assert.equal(compareVersions(v(1, 2, 3), v(1, 2, 3)), 0);
  assert.equal(compareVersions(v(1, 2, 3), v(1, 2, 4)), -1);
  assert.equal(compareVersions(v(2, 0, 0), v(1, 9, 9)), 1);
  assert.equal(compareVersions(v(1, 2, 3), v(1, 2, 3, 0)), -1);
  assert.equal(compareVersions(v(1, 2, 3, 2), v(1, 2, 3, 1)), 1);
});

test("nameMatchRules", () => {
  assert.equal(nameMatches("Ascent_H_Sky_17_6_0.img", FW), true);
  assert.equal(nameMatches("ascent-h-sky 17.6.0.img", FW), true);
  assert.equal(nameMatches("Ascent_Lite_Plus_17_6_0.img", FW), false);
  assert.equal(nameMatches("Ascent_L_Sky_17_6_0.img", FW), false);
  assert.equal(nameMatches("Ascent_H_Sky_Pro_17_6_0.img", FW), false);
  assert.equal(nameMatches("Ascent_Lite_Plus_1_3_0.img", "Ascent_Lite_Plus_1_2_3"), true);
  assert.equal(nameMatches("ascent-lite-plus 1.3.0.img", "Ascent_Lite_Plus_1_2_3"), true);
  assert.equal(nameMatches("Ascent_Lite_Plus_1_3_0.img", "Ascent_Lite_1_2_3"), false);
  assert.equal(nameMatches("Ascent_VRX_1_3_0.img", "Ascent_Lite_Plus_1_2_3"), false);
  assert.equal(nameMatches("Anything_1_3_0.img", "Ascent_1_2_3"), true);
});

test("VRX Pro file matches VRX Pro firmware", () => {
  assert.equal(nameMatches("Ascent_VRX_Pro_18_21_10.img", "Ascent_VRX_Pro_18_21_10"), true);
});

test("warningText", () => {
  assert.equal(warningText({ kind: "downgrade", from: v(17, 5, 8), to: v(17, 4, 0) }),
    "The file (V17.4.0) is older than the device (V17.5.8). Downgrading usually fails.");
  assert.equal(warningText({ kind: "nameMismatch", expected: "H_Sky" }),
    "This file name doesn't look like firmware for this device (expected 'H_Sky' in the name).");
  assert.equal(warningText({ kind: "unknownVersion" }), "Couldn't read a version from the file name.");
});

test("preflightRejects", async () => {
  const dev = info("Ascent_lite", FW);
  const unreadable = { name: "Ascent_H_Sky_17_6_0.img", size: 10, arrayBuffer: async () => { throw new Error("gone"); } };
  assert.equal(await kind(preflight(dev, unreadable, H)), "unreadable");
  assert.equal(await kind(preflight(dev, file("Ascent_H_Sky_17_6_1.img", ""), H)), "empty");
  assert.equal(await kind(preflight(dev, file("fw.bin"), H)), "notImg");
  assert.equal(await kind(preflight(info("ascent_vrx", FW), file("Ascent_H_Sky_17_6_2.img"), H)), "notFlashable");
  const r = await preflight(dev, file("Ascent_H_Sky_17_6_3.IMG"), H);
  assert.ok(r.firmware);
});

test("preflightWarnsDowngrade", async () => {
  const { warnings } = await preflight(info("Ascent_lite", FW), file("Ascent_H_Sky_17_4_0.img", "data"), H);
  assert.deepEqual(warnings, [{ kind: "downgrade", from: v(17, 5, 8), to: v(17, 4, 0) }]);
});

test("preflightCleanUpgrade", async () => {
  const { firmware, warnings } = await preflight(info("Ascent_lite", FW), file("Ascent_H_Sky_17_6_0.img", "data"), H);
  assert.deepEqual(warnings, []);
  assert.deepEqual(firmware.version, v(17, 6, 0));
  assert.equal(firmware.name, "Ascent_H_Sky_17_6_0.img");
  assert.deepEqual(Array.from(firmware.bytes), Array.from(new TextEncoder().encode("data")));
  assert.ok(firmware.bytes instanceof Uint8Array);
});

test("preflightNameMismatchWarns", async () => {
  const { warnings } = await preflight(info("Ascent_lite", FW), file("Ascent_Lite_Plus_17_6_0.img", "data"), H);
  assert.deepEqual(warnings, [{ kind: "nameMismatch", expected: "H_Sky" }]);
});

test("preflight warns name mismatch for VRX Pro file on a Lite", async () => {
  const { warnings } = await preflight(info("Ascent_lite", "Ascent_H_Sky_18_21_10"), file("Ascent_VRX_Pro_18_21_10.img"), H);
  assert.ok(warnings.some((w) => w.kind === "nameMismatch" && w.expected === "H_Sky"));
});

test("preflightUnknownVersionWarns", async () => {
  const { firmware, warnings } = await preflight(info("Ascent_lite", FW), file("custom.img", "data"), H);
  assert.equal(firmware.version, null);
  assert.ok(warnings.some((w) => w.kind === "unknownVersion"));
});

test("md5 in preflight", async () => {
  const { firmware } = await preflight(info("Ascent_lite", FW), file("Ascent_H_Sky_17_6_0.img", "abc"), H);
  assert.equal(firmware.md5Hex, "900150983cd24fb0d6963f7d28e17f72");
});

test("preflightRejectsOversize", async () => {
  const big = { name: "Ascent_H_Sky_17_6_0.img", size: MAX_FIRMWARE_BYTES + 1, arrayBuffer: () => assert.fail("read") };
  const e = await preflight(info("Ascent_lite", FW), big, H).catch((x) => x);
  assert.equal(e.kind, "tooLarge");
  assert.equal(e.message, "firmware file is too large (268 MB) — Ascent images are at most about 180 MB; is this the right file?");
  // Exactly the cap is accepted (content is small; the size field is what is checked first).
  const atCap = { name: "Ascent_H_Sky_17_6_0.img", size: MAX_FIRMWARE_BYTES, arrayBuffer: async () => new Uint8Array(4).buffer };
  assert.ok((await preflight(info("Ascent_lite", FW), atCap, H)).firmware);
});

test("oversize is rejected before reading", async () => {
  const f = { name: "Ascent_H_Sky_18_21_10.img", size: 268435457, arrayBuffer: () => assert.fail("read") };
  assert.equal(await kind(preflight(info("Ascent_lite", FW), f, H)), "tooLarge");
});

test("oversize after reading is rejected", async () => {
  const f = { name: "Ascent_H_Sky_17_6_0.img", size: 4, arrayBuffer: async () => ({ byteLength: MAX_FIRMWARE_BYTES + 1 }) };
  assert.equal(await kind(preflight(info("Ascent_lite", FW), f, H)), "tooLarge");
});

test("preflightRejectsLongFileName", async () => {
  const dev = info("Ascent_lite", FW);
  const okName = `${"A".repeat(119 - 11)}_17_6_0.img`;
  assert.equal(okName.length, 119);
  assert.ok((await preflight(dev, file(okName), H)).firmware);
  const longName = `${"A".repeat(120 - 11)}_17_6_0.img`;
  const e = await preflight(dev, file(longName), H).catch((x) => x);
  assert.equal(e.kind, "badFileName");
  assert.equal(e.message, "rename the file to a shorter ASCII name, e.g. Ascent_H_Sky_18_21_10.img");
});

test("preflightRejectsNonAsciiFileName", async () => {
  const dev = info("Ascent_lite", FW);
  assert.equal(await kind(preflight(dev, file("Ascent_H_Sky_17_6_0_é.img"), H)), "badFileName");
  assert.equal(await kind(preflight(dev, file("Ascent\tH_Sky_17_6_0.img"), H)), "badFileName");
});

test("preflight follows canFlash: unknown models never, confirmed models anywhere", async () => {
  const f = file("Ascent_H_Sky_17_6_0.img");
  const other = info("Ascent_vrx", FW); // an Ascent unit that isn't in MODELS
  assert.equal(await kind(preflight(other, f, "mikecarr.github.io")), "notFlashable");
  assert.equal(await kind(preflight(other, f, "127.0.0.1")), "notFlashable");
  const lite = info("Ascent_lite", FW); // confirmed on hardware
  assert.ok((await preflight(lite, f, "mikecarr.github.io")).firmware);
});

// Final fix wave R9: spec step 7 / CLI main.rs version check after the restart.
test("restartMismatch compares the restarted unit's version with the file's", () => {
  // Same version: no warning.
  assert.equal(restartMismatch("Ascent_H_Sky_18_21_10", v(18, 21, 10)), null);
  // Unit came back on the old firmware.
  assert.equal(
    restartMismatch("Ascent_H_Sky_18_21_8", v(18, 21, 10)),
    "The unit restarted but reports V18.21.8; the file was V18.21.10.",
  );
  // Device version unparseable while the file's is known: warn with the raw string.
  assert.equal(
    restartMismatch("Ascent", v(18, 21, 10)),
    "The unit restarted but reports Ascent; the file was V18.21.10.",
  );
  // File version unknown: nothing to compare.
  assert.equal(restartMismatch("Ascent_H_Sky_18_21_8", null), null);
  assert.equal(restartMismatch("Ascent", null), null);
});
