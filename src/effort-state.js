import fs from "node:fs";
import path from "node:path";

/**
 * The gateway-wide model effort chosen in the Control Panel.
 *
 *   low      quick work: simple questions, small edits, easy bug fixes
 *   medium   balanced (the default): coding, multi-file changes, everyday debugging
 *   high     deep analysis: hard bugs, security audits, architecture, big repos
 *   xhigh    maximum effort ("Extra High / Max"): long agentic runs, multi-step problems
 *
 * One selection applies to every provider and model that reasons. The value is
 * persisted to `file` (when given) so it survives a restart; a missing or
 * unreadable file means the default. Persistence is best effort and never
 * blocks the switch itself.
 */
export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh"]);
export const DEFAULT_EFFORT = "medium";

export const EFFORT_INFO = Object.freeze([
  { id: "low", label: "Low", summary: "Fast work", description: "Simple questions, small code changes, easy bug fixes. Least time and reasoning tokens." },
  { id: "medium", label: "Medium", summary: "Balanced", description: "Writing code, multi-file changes, everyday debugging and planning. Balances speed and analysis." },
  { id: "high", label: "High", summary: "Deep analysis", description: "Hard bugs, security audits, architecture design, large repository analysis. Takes more time and tokens." },
  { id: "xhigh", label: "Extra High / Max", summary: "Maximum effort", description: "Long agentic coding, hard problems and many-step analysis, on models that support it. Time and token use rise noticeably." }
]);

export function normalizeEffortLevel(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (text === "xhigh" || text === "extrahigh" || text === "max" || text === "extrahighmax") return "xhigh";
  return EFFORT_LEVELS.includes(text) ? text : null;
}

export class EffortState {
  #effort = DEFAULT_EFFORT;
  #updatedAt = null;
  #file = null;

  constructor({ file = null } = {}) {
    this.#file = file ? path.resolve(file) : null;
    this.#load();
  }

  #load() {
    if (!this.#file) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`effort state: ignoring unreadable ${path.basename(this.#file)}`);
      return;
    }
    const level = normalizeEffortLevel(parsed?.effort);
    if (!level) return;
    this.#effort = level;
    const at = Date.parse(parsed.updatedAt);
    this.#updatedAt = Number.isFinite(at) ? at : null;
  }

  #save() {
    if (!this.#file) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        effort: this.#effort,
        updatedAt: this.#updatedAt ? new Date(this.#updatedAt).toISOString() : null
      }, null, 2));
      fs.renameSync(tmp, this.#file);
    } catch (error) {
      console.warn(`effort state: could not persist (${error?.code || error?.message})`);
    }
  }

  get effort() { return this.#effort; }

  /** Select a level. Returns the snapshot, or null when `value` is not a known level. */
  set(value, now = Date.now()) {
    const level = normalizeEffortLevel(value);
    if (!level) return null;
    this.#effort = level;
    this.#updatedAt = now;
    this.#save();
    return this.snapshot();
  }

  snapshot() {
    return {
      effort: this.#effort,
      default: DEFAULT_EFFORT,
      updatedAt: this.#updatedAt ? new Date(this.#updatedAt).toISOString() : null,
      levels: EFFORT_INFO
    };
  }
}
