import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Which upstream protocol a custom endpoint was found to answer, remembered
 * across restarts. Keys are hashed (provider + base URL + saved protocol) so the
 * file never holds a URL. Best effort: a read or write failure only means the
 * router has to learn the protocol again.
 */
export class ProtocolMemory {
  constructor({ file } = {}) {
    this.file = file || null;
    this.map = new Map();
    this.writing = Promise.resolve();
    this.load();
  }

  static hash(key) {
    return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 24);
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [key, protocol] of Object.entries(data ?? {})) {
        if (typeof protocol === "string") this.map.set(key, protocol);
      }
    } catch { /* first run or unreadable file: start empty */ }
  }

  get(key) { return this.map.get(ProtocolMemory.hash(key)) ?? null; }

  set(key, protocol) {
    const hashed = ProtocolMemory.hash(key);
    if (this.map.get(hashed) === protocol) return;
    this.map.set(hashed, protocol);
    this.persist();
  }

  delete(key) {
    if (this.map.delete(ProtocolMemory.hash(key))) this.persist();
  }

  persist() {
    if (!this.file) return;
    const snapshot = JSON.stringify(Object.fromEntries(this.map));
    this.writing = this.writing.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.promises.rename(tmp, this.file);
      } catch { /* best effort */ }
    });
  }
}
