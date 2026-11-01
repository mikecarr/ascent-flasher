// While a flash runs: warn before the tab is closed or reloaded, and keep the
// screen awake. Both are armed only for the flash and removed afterwards.
// `win`/`nav` are injected so this runs in Node tests.

export class FlashGuards {
  #win;
  #nav;
  #armed = false;
  #lock = null;
  #onBeforeUnload = (event) => {
    if (!this.#armed) return undefined;
    event.preventDefault();
    // Older browsers show the prompt only when returnValue is set.
    event.returnValue = "A firmware flash is running. Leaving now can leave the device unusable.";
    return event.returnValue;
  };
  #onVisibility = () => {
    // The browser drops a wake lock when the tab is hidden; take it back.
    if (this.#armed && !this.#lock && this.#win.document?.visibilityState === "visible") void this.#requestLock();
  };

  constructor(win = globalThis.window, nav = globalThis.navigator) {
    this.#win = win;
    this.#nav = nav;
  }

  get armed() {
    return this.#armed;
  }

  async arm() {
    if (this.#armed) return;
    this.#armed = true;
    this.#win?.addEventListener?.("beforeunload", this.#onBeforeUnload);
    this.#win?.document?.addEventListener?.("visibilitychange", this.#onVisibility);
    await this.#requestLock();
  }

  disarm() {
    this.#armed = false;
    this.#win?.removeEventListener?.("beforeunload", this.#onBeforeUnload);
    this.#win?.document?.removeEventListener?.("visibilitychange", this.#onVisibility);
    const lock = this.#lock;
    this.#lock = null;
    release(lock);
  }

  async #requestLock() {
    let lock;
    try {
      lock = await this.#nav?.wakeLock?.request("screen");
    } catch {
      return; // no permission, hidden tab, or unsupported: the flash goes on
    }
    if (!lock) return;
    if (!this.#armed || this.#lock) {
      release(lock); // disarmed (or already held) while the request was pending
      return;
    }
    this.#lock = lock;
    lock.addEventListener?.("release", () => {
      if (this.#lock === lock) this.#lock = null;
    });
  }
}

function release(lock) {
  try {
    Promise.resolve(lock?.release?.()).catch(() => {});
  } catch {
    // already released
  }
}
