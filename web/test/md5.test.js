import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { md5Hex } from "../lib/md5.js";

const ascii = (s) => new TextEncoder().encode(s);

test("md5 known vectors", () => {
  assert.equal(md5Hex(ascii("")), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex(ascii("abc")), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5Hex(ascii("The quick brown fox jumps over the lazy dog")), "9e107d9d372bb6826bd81d3542a419d6");
});

test("md5 matches node:crypto on a large buffer and boundary lengths", () => {
  const big = new Uint8Array(1000001).fill(0x61);
  assert.equal(md5Hex(big), createHash("md5").update(big).digest("hex"));
  for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
    const b = new Uint8Array(n).map((_, i) => (i * 7 + 3) & 0xff);
    assert.equal(md5Hex(b), createHash("md5").update(b).digest("hex"), `len ${n}`);
  }
});
