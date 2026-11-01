import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODELS, modelFor, isLocalHost, canFlash, isCandidateVid, CANDIDATE_VIDS, reopenDelayMs,
} from "../lib/models.js";

test("model table", () => {
  assert.deepEqual(MODELS, [
    { name: "ascent_lite", label: "Ascent Lite", filePrefix: "H_Sky", power: "usb", writingTimeoutMs: 300000, confirmed: false },
    { name: "ascent_lite_plus", label: "Ascent Lite+", filePrefix: "H_Sky", power: "usb", writingTimeoutMs: 300000, confirmed: true },
    { name: "ascent_vrx_pro", label: "Ascent VRX Pro", filePrefix: "VRX_Pro", power: "external", writingTimeoutMs: 600000, confirmed: true },
  ]);
});

test("models", () => {
  assert.equal(modelFor("Ascent_VRX_pro").name, "ascent_vrx_pro");
  assert.equal(modelFor("Ascent"), null);
  assert.equal(modelFor("ASCENT_LITE").name, "ascent_lite");
  assert.equal(reopenDelayMs(0x1D76), 11500);
  assert.equal(reopenDelayMs(0x1D77), 12000);
});

test("reopen delay table and candidate VIDs", () => {
  assert.equal(reopenDelayMs(0x1D6B), 8000);
  assert.equal(reopenDelayMs(0x1D74), 8000);
  assert.equal(reopenDelayMs(0x1D75), 9500);
  assert.equal(reopenDelayMs(0x1D79), 12000);
  assert.equal(reopenDelayMs(0x1D7A), 10000);
  assert.equal(reopenDelayMs(0x1D7B), 10000);
  assert.equal(reopenDelayMs(0x1D80), 8000);
  assert.equal(reopenDelayMs(0x1D81), 9500);
  assert.equal(reopenDelayMs(0x1D84), 9500);
  assert.equal(reopenDelayMs(0x0001), 8000);
  assert.equal(isCandidateVid(0x1D6A), false);
  assert.equal(isCandidateVid(0x1D6B), true);
  assert.equal(isCandidateVid(0x1D7B), true);
  assert.equal(isCandidateVid(0x1D7C), false);
  assert.equal(isCandidateVid(0x1D7F), false);
  assert.equal(isCandidateVid(0x1D80), true);
  assert.equal(isCandidateVid(0x1D84), true);
  assert.equal(isCandidateVid(0x1D85), false);
  assert.ok(CANDIDATE_VIDS.includes(0x1D80) && !CANDIDATE_VIDS.includes(0x1D7C));
});

test("unconfirmed model can flash only on localhost", () => {
  const lite = modelFor("ascent_lite");
  assert.equal(canFlash(lite, "localhost"), true);
  assert.equal(canFlash(lite, "127.0.0.1"), true);
  assert.equal(canFlash(lite, "mikecarr.github.io"), false);
  assert.equal(canFlash({ ...lite, confirmed: true }, "mikecarr.github.io"), true);
  assert.equal(isLocalHost("[::1]"), true);
  assert.equal(isLocalHost("evil-localhost.com"), false);
});
