// Clocks: real time for the page, virtual time for tests (no real waiting).

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Virtual time: `sleep` advances the clock and resolves on the next microtask. */
export class VirtualClock {
  constructor(start = 0) {
    this.t = start;
  }

  now() {
    return this.t;
  }

  async sleep(ms) {
    this.t += Math.max(0, ms);
  }
}
