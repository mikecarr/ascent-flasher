// Request/ack session over a Link, with same-seq resend (port of session.rs).
import { CMD, encodeRequest, FrameReader, decodeDeviceInfo } from "./protocol.js";
import { LinkGoneError, isLinkError } from "./link.js";

const POLL_MS = 20;

const CMD_NAMES = {
  [CMD.REBOOT]: "Reboot",
  [CMD.FIND_DEVICE]: "FindDevice",
  [CMD.REMOTE_UPGRADE]: "RemoteUpgrade",
  [CMD.SENDFILE_START]: "SendFileStart",
  [CMD.SENDFILE_DATA]: "SendFileData",
  [CMD.SENDFILE_END]: "SendFileEnd",
  [CMD.UPGRADE_STATUS]: "UpgradeStatus",
};

export const cmdName = (cmd) => CMD_NAMES[cmd] ?? `Command(${cmd})`;

export class SessionTimeoutError extends Error {
  constructor(cmd) {
    super(`timed out waiting for reply to ${cmdName(cmd)}`);
    this.name = "SessionTimeoutError";
    this.cmd = cmd;
  }
}

export class PayloadError extends Error {
  constructor(message, options) {
    super(`bad payload: ${message}`, options);
    this.name = "PayloadError";
  }
}

/** Any link failure is an I/O error; unknown ones count as the link gone. */
function asLinkError(e) {
  return isLinkError(e) ? e : new LinkGoneError(String(e?.message ?? e), { cause: e });
}

export class Session {
  constructor(link, clock, { resendMs = 2000, giveUpMs = 8000, log = () => {} } = {}) {
    this.link = link;
    this.clock = clock;
    this.resendMs = resendMs;
    this.giveUpMs = giveUpMs;
    this.log = log;
    this.reader = new FrameReader((m) => log(`warn: ${m}`));
    this.seq = 1;
    /** Whether the device echoes the request seq: null until the first reply. */
    this.echoesSeq = null;
  }

  nextSeq() {
    const s = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    return s;
  }

  async send(cmd, payload, seq, retry) {
    try {
      await this.link.write(encodeRequest(cmd, payload, seq, retry));
    } catch (e) {
      throw asLinkError(e);
    }
  }

  /** Send without waiting for a reply (e.g. REBOOT). */
  async sendNoAck(cmd, payload) {
    await this.send(cmd, payload, this.nextSeq(), 0);
  }

  /**
   * Send a request and wait for the frame carrying the same command,
   * re-sending with the same seq (retry + 1) every `resendMs`.
   */
  async request(cmd, payload) {
    const seq = this.nextSeq();
    while (this.reader.next()); // discard frames buffered before this request
    let retry = 0;
    await this.send(cmd, payload, seq, retry);
    const start = this.clock.now();
    let lastSend = start;
    for (;;) {
      for (let f; (f = this.reader.next());) {
        if (f.header.command !== cmd) continue; // frame for another command
        if (this.echoesSeq === null) {
          this.echoesSeq = f.header.seq === seq;
          this.log(`learned device seq echo behaviour: echoes seq: ${this.echoesSeq}`);
        }
        if (this.echoesSeq && f.header.seq !== seq) continue; // stale reply
        return f;
      }
      const now = this.clock.now();
      const untilGiveUp = Math.max(0, this.giveUpMs - (now - start));
      if (untilGiveUp === 0) throw new SessionTimeoutError(cmd);
      let untilResend = Math.max(0, this.resendMs - (now - lastSend));
      if (untilResend === 0) {
        retry += 1;
        await this.send(cmd, payload, seq, retry);
        lastSend = this.clock.now();
        untilResend = this.resendMs;
      }
      const wait = Math.max(1, Math.min(POLL_MS, untilGiveUp, untilResend));
      let bytes;
      try {
        bytes = await this.link.read(wait);
      } catch (e) {
        throw asLinkError(e);
      }
      if (bytes) this.reader.push(bytes);
    }
  }

  /** FIND_DEVICE; the complete reply is logged. */
  async findDevice() {
    const f = await this.request(CMD.FIND_DEVICE, new Uint8Array(0));
    let info;
    try {
      info = decodeDeviceInfo(f.payload);
    } catch (e) {
      throw new PayloadError(e.message, { cause: e });
    }
    this.log(`FIND_DEVICE reply: ${JSON.stringify(info)}`);
    return info;
  }

  /** Close the link (best effort). */
  async close() {
    try {
      await this.link.close();
    } catch {
      // already gone
    }
  }
}
