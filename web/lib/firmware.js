// Firmware pre-flight: pure checks on a file and DeviceInfo (port of firmware.rs).
import { modelFor, canFlash } from "./models.js";
import { md5Hex } from "./md5.js";

export const MAX_FIRMWARE_BYTES = 268435456;
export const REMOTE_DIR = "/tmp/pc/";
// The remote path goes into a 128-byte field that must keep a NUL.
const MAX_REMOTE_PATH_BYTES = 127;

const FILE_RE = /^.*?(\d+)_(\d+)_(\d+)(?:(?:_z8_|_z40_|_hub_)(\d+))?\.img$/i;
const DEVICE_RE = /(\d+)_(\d+)_(\d+)$/;

function versionFrom(m) {
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    extra: m[4] === undefined ? null : Number(m[4]),
  };
}

/** Version in a firmware file name, e.g. Ascent_Lite_Plus_1_3_0.img. */
export function fileVersion(name) {
  return versionFrom(FILE_RE.exec(name));
}

/** Version at the end of the device's firmwareInfo, e.g. Ascent_H_Sky_17_5_8. */
export function deviceVersion(firmware) {
  return versionFrom(DEVICE_RE.exec(firmware));
}

/** Ordering as in Rust's derived Ord: a missing `extra` sorts before any value. */
export function compareVersions(a, b) {
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (a.extra === b.extra) return 0;
  if (a.extra === null) return -1;
  if (b.extra === null) return 1;
  return a.extra < b.extra ? -1 : 1;
}

export function formatVersion(v) {
  return `V${v.major}.${v.minor}.${v.patch}${v.extra === null ? "" : `.${v.extra}`}`;
}

/**
 * After a flash (spec step 7, as the CLI): null when the restarted unit
 * reports the file's version (or the file's version is unknown), otherwise
 * the warning text.
 */
export function restartMismatch(deviceFirmware, fileVer) {
  if (!fileVer) return null;
  const dev = deviceVersion(deviceFirmware);
  if (dev && compareVersions(dev, fileVer) === 0) return null;
  const shown = dev ? formatVersion(dev) : deviceFirmware;
  return `The unit restarted but reports ${shown}; the file was ${formatVersion(fileVer)}.`;
}

const isDigits = (t) => /^[0-9]+$/.test(t);

// Original-case prefix tokens of the device firmware (up to three trailing
// numeric tokens, and "ascent", removed).
function prefixTokens(firmware) {
  const toks = firmware.split("_");
  for (let i = 0; i < 3; i++) {
    if (toks.length && isDigits(toks[toks.length - 1])) toks.pop();
  }
  return toks.filter((t) => t !== "" && t.toLowerCase() !== "ascent");
}

function normalize(s) {
  s = s.toLowerCase();
  if (s.endsWith(".img")) s = s.slice(0, -4);
  return s.replace(/[- .]/g, "_");
}

/** Does the file name carry the device's model prefix, followed by a number? */
export function nameMatches(fileName, firmware) {
  const prefix = prefixTokens(firmware).map(normalize);
  if (prefix.length === 0) return true;
  const ftoks = normalize(fileName).split("_");
  for (let i = 0; i < ftoks.length; i++) {
    const end = i + prefix.length;
    if (end < ftoks.length && prefix.every((p, j) => ftoks[i + j] === p) && isDigits(ftoks[end])) {
      return true;
    }
  }
  return false;
}

/** Plain-words text for a warning (no trailing question). */
export function warningText(w) {
  switch (w.kind) {
    case "downgrade":
      return `The file (${formatVersion(w.to)}) is older than the device (${formatVersion(w.from)}). Downgrading usually fails.`;
    case "nameMismatch":
      return `This file name doesn't look like firmware for this device (expected '${w.expected}' in the name).`;
    case "unknownVersion":
      return "Couldn't read a version from the file name.";
    default:
      return String(w.kind);
  }
}

export class PreflightError extends Error {
  /** @param {"notFlashable"|"notImg"|"badFileName"|"empty"|"tooLarge"|"unreadable"} kind */
  constructor(kind, message) {
    super(message);
    this.name = "PreflightError";
    this.kind = kind;
  }
}

const tooLarge = (size) => new PreflightError("tooLarge",
  `firmware file is too large (${Math.floor(size / 1_000_000)} MB) — Ascent images are at most about 180 MB; is this the right file?`);

// Printable ASCII, and /tmp/pc/<name> fits the 128-byte field with its NUL.
function remoteNameOk(name) {
  return name.length > 0 && /^[\x20-\x7e]+$/.test(name)
    && REMOTE_DIR.length + name.length <= MAX_REMOTE_PATH_BYTES;
}

/**
 * @param {object} info DeviceInfo
 * @param {{name: string, size: number, arrayBuffer: () => Promise<ArrayBuffer>}} file
 * @param {string} hostname page hostname (gates unconfirmed models)
 */
export async function preflight(info, file, hostname) {
  const model = modelFor(info.deviceName);
  if (!model || !canFlash(model, hostname)) {
    throw new PreflightError("notFlashable", `device ${JSON.stringify(info.deviceName)} is not a flashable Ascent model`);
  }
  if (!/\.img$/i.test(file.name)) {
    throw new PreflightError("notImg", "firmware file must have a .img extension");
  }
  if (!remoteNameOk(file.name)) {
    throw new PreflightError("badFileName", "rename the file to a shorter ASCII name, e.g. Ascent_H_Sky_18_21_10.img");
  }
  // Size check BEFORE reading, so a huge file is never loaded.
  if (file.size > MAX_FIRMWARE_BYTES) throw tooLarge(file.size);
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    throw new PreflightError("unreadable", `cannot read firmware file: ${e?.message ?? e}`);
  }
  if (buffer.byteLength === 0) throw new PreflightError("empty", "firmware file is empty");
  // The file may have changed since the size check.
  if (buffer.byteLength > MAX_FIRMWARE_BYTES) throw tooLarge(buffer.byteLength);
  const bytes = new Uint8Array(buffer);

  const version = fileVersion(file.name);
  const warnings = [];
  const from = deviceVersion(info.firmware);
  if (version === null) {
    warnings.push({ kind: "unknownVersion" });
  } else if (from && compareVersions(version, from) < 0) {
    warnings.push({ kind: "downgrade", from, to: version });
  }
  if (!nameMatches(file.name, info.firmware)) {
    warnings.push({ kind: "nameMismatch", expected: prefixTokens(info.firmware).join("_") });
  }
  return { firmware: { name: file.name, bytes, md5Hex: md5Hex(bytes), version }, warnings };
}
