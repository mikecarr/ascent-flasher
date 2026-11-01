import { test } from "node:test";
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { WebSerialConnector } from "../lib/webserial.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");

/**
 * Like Chrome's navigator.serial: it caches each port's SerialPort object only
 * weakly, so an object nobody else holds is collected and the next getPorts()
 * hands out a new one for the same physical port.
 */
class ForgetfulSerial {
  constructor() {
    this.plugged = new Set(); // physical port tokens
    this.cache = new Map(); // token -> WeakRef<SerialPort>
    this.created = 0;
  }
  plug(token) {
    this.plugged.add(token);
  }
  unplug(token) {
    this.plugged.delete(token);
    this.cache.delete(token);
  }
  async getPorts() {
    return [...this.plugged].map((token) => {
      let port = this.cache.get(token)?.deref();
      if (!port) {
        this.created++;
        port = { getInfo: () => ({ usbVendorId: 0x1d77, usbProductId: 0xa4a2 }) };
        this.cache.set(token, new WeakRef(port));
      }
      return port;
    });
  }
}

async function idsAfterCollection(connector) {
  const before = (await connector.list()).map((p) => p.id);
  await new Promise((r) => setTimeout(r, 0)); // let list()'s temporaries go
  gc();
  const after = (await connector.list()).map((p) => p.id);
  return { before, after };
}

test("a listed port keeps its id when the browser collects its port object", async () => {
  const serial = new ForgetfulSerial();
  serial.plug("usb-1");
  const connector = new WebSerialConnector(serial);
  const { before, after } = await idsAfterCollection(connector);
  assert.equal(before.length, 1);
  assert.deepEqual(after, before);
  assert.equal(serial.created, 1, "the same SerialPort object must be handed back");
});

test("a port that really leaves gets a new id when it returns", async () => {
  const serial = new ForgetfulSerial();
  serial.plug("usb-1");
  const connector = new WebSerialConnector(serial);
  const [first] = await connector.list();
  serial.unplug("usb-1");
  assert.deepEqual(await connector.list(), []);
  serial.plug("usb-1");
  const [second] = await connector.list();
  assert.notEqual(second.id, first.id);
});
