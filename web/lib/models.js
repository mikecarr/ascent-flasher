// Known Ascent models, localhost gate, and USB VID tables (port of discovery.rs).

export const MODELS = [
  { name: "ascent_lite", label: "Ascent Lite", filePrefix: "H_Sky", power: "usb", writingTimeoutMs: 300000, confirmed: false },
  { name: "ascent_lite_plus", label: "Ascent Lite+", filePrefix: "H_Sky", power: "usb", writingTimeoutMs: 300000, confirmed: false },
  { name: "ascent_vrx_pro", label: "Ascent VRX Pro", filePrefix: "VRX_Pro", power: "external", writingTimeoutMs: 600000, confirmed: false },
];

/** Model for a device name (case-insensitive), or null. */
export function modelFor(deviceName) {
  const n = String(deviceName).toLowerCase();
  return MODELS.find((m) => m.name === n) ?? null;
}

export function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** Unconfirmed models may only be flashed from a local page. */
export function canFlash(model, hostname) {
  return model.confirmed || isLocalHost(hostname);
}

// 0x1D6B..=0x1D7B and 0x1D80..=0x1D84 (nothing between 0x1D7C and 0x1D7F).
export const CANDIDATE_VIDS = [];
for (let v = 0x1D6B; v <= 0x1D7B; v++) CANDIDATE_VIDS.push(v);
for (let v = 0x1D80; v <= 0x1D84; v++) CANDIDATE_VIDS.push(v);

export function isCandidateVid(vid) {
  return (vid >= 0x1D6B && vid <= 0x1D7B) || (vid >= 0x1D80 && vid <= 0x1D84);
}

/** How long to wait after REBOOT before re-finding the device, by USB VID. */
export function reopenDelayMs(vid) {
  if (vid >= 0x1D6B && vid <= 0x1D74) return 8000;
  if (vid === 0x1D75) return 9500;
  if (vid === 0x1D76) return 11500;
  if (vid >= 0x1D77 && vid <= 0x1D79) return 12000;
  if (vid >= 0x1D7A && vid <= 0x1D7B) return 10000;
  if (vid === 0x1D80) return 8000;
  if (vid >= 0x1D81 && vid <= 0x1D84) return 9500;
  return 8000;
}
