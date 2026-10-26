/**
 * Helpers for the Providers page's model list editor, as plain functions so
 * they can be tested without a DOM.
 */

/** Same ceiling the gateway enforces (MAX_PROVIDER_MODELS). */
export const MAX_PROVIDER_MODELS = 300;

/** What saving `next` would change compared with the list in use now. */
export function diffModels(current, next) {
  const before = new Set(current ?? []);
  const after = new Set(next ?? []);
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id))
  };
}

/** The first thing wrong with the list about to be saved, or null. */
export function modelsProblem(next) {
  if (next.length === 0) return "Keep at least one model, or use Reset to go back to the environment list.";
  if (next.length > MAX_PROVIDER_MODELS) return `At most ${MAX_PROVIDER_MODELS} models per provider (${next.length} selected).`;
  return null;
}

/** "+2 added, −1 removed", or null when nothing changed. */
export function describeDiff({ added, removed }) {
  const parts = [];
  if (added.length > 0) parts.push(`+${added.length} added`);
  if (removed.length > 0) parts.push(`−${removed.length} removed`);
  return parts.length > 0 ? parts.join(", ") : null;
}
