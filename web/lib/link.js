// Transport contract (mirrors crates/ascent-proto/src/link.rs).
//
// PortInfo  = {id: string, vid, pid, serial?: string}
// Connector = {list() -> Promise<PortInfo[]>, open(PortInfo) -> Promise<Link>}
// Link      = {write(bytes) -> Promise<void>,
//              read(timeoutMs) -> Promise<Uint8Array | null>  (null = timeout),
//              close() -> Promise<void>}

/** The device went away (unplugged or rebooting); the link is unusable. */
export class LinkGoneError extends Error {
  constructor(message = "device disconnected", options) {
    super(message, options);
    this.name = "LinkGoneError";
  }
}

/** The port is held by another app or tab. */
export class PortBusyError extends Error {
  constructor(message = "port is busy", options) {
    super(message, options);
    this.name = "PortBusyError";
  }
}

/** Whether `e` is a transport (I/O) error rather than a protocol one. */
export function isLinkError(e) {
  return e instanceof LinkGoneError || e instanceof PortBusyError;
}
