const KEY = /"narration"\s*:\s*"/;

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/",
};

/**
 * Incrementally pulls the value of the "narration" string out of a streaming JSON document.
 * Feed chunks with push(); each call returns the newly decoded narration text (possibly "").
 * Handles escapes (including \uXXXX) split across chunk boundaries.
 */
export class NarrationExtractor {
  private buf = "";
  private pos = -1; // index of the next unread char of the narration value, -1 until the key is found
  private finished = false;
  private text = "";

  get done(): boolean {
    return this.finished;
  }

  /** Everything decoded so far. */
  get narration(): string {
    return this.text;
  }

  push(chunk: string): string {
    if (this.finished) return "";
    this.buf += chunk;
    if (this.pos === -1) {
      const m = KEY.exec(this.buf);
      if (!m) return "";
      this.pos = m.index + m[0].length;
    }
    let out = "";
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as string;
      if (c === '"') {
        this.finished = true;
        this.pos++;
        break;
      }
      if (c !== "\\") {
        out += c;
        this.pos++;
        continue;
      }
      const n = this.buf[this.pos + 1];
      if (n === undefined) break; // escape split across chunks
      if (n === "u") {
        if (this.pos + 6 > this.buf.length) break;
        const hex = this.buf.slice(this.pos + 2, this.pos + 6);
        out += /^[0-9a-fA-F]{4}$/.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : "";
        this.pos += 6;
      } else {
        out += SIMPLE_ESCAPES[n] ?? n;
        this.pos += 2;
      }
    }
    this.text += out;
    if (this.finished) this.buf = "";
    return out;
  }
}
