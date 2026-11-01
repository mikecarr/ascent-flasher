// Session log: timestamped lines (relative to page load) that the user can
// download and attach to a bug report. No DOM access at import time.

const MAX_LINES = 50_000;

const stamp = (ms) => `[${(Math.max(0, ms) / 1000).toFixed(3).padStart(9)}s]`;

export class SessionLog {
  constructor({ now = () => globalThis.performance.now() } = {}) {
    this.now = now;
    this.start = now();
    this.startedAt = new Date().toISOString();
    this.lines = [];
    this.dropped = 0;
    // Bound, so `sessionLog.line` can be passed around as a callback.
    this.line = this.line.bind(this);
  }

  line(msg) {
    if (this.lines.length >= MAX_LINES) {
      // Keep the start (what led up to it) and the most recent lines.
      this.lines.splice(1000, 1);
      this.dropped += 1;
    }
    this.lines.push(`${stamp(this.now() - this.start)} ${msg}`);
  }

  text() {
    const head = [`Ascent Flasher session log (page loaded ${this.startedAt})`];
    if (this.dropped) head.push(`(${this.dropped} lines dropped from the middle)`);
    return `${[...head, ...this.lines].join("\n")}\n`;
  }

  /** Save the log as a .txt file via a Blob URL. */
  download(filename, { doc = globalThis.document, urlApi = globalThis.URL } = {}) {
    const blob = new Blob([this.text()], { type: "text/plain" });
    const url = urlApi.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => urlApi.revokeObjectURL(url), 0);
  }
}
