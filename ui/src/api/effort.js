import { apiRequest, invalidateCache } from "./client.js";

/** Current model effort: { effort, default, levels: [{ id, label, summary, description }] }. */
export function getEffort({ signal } = {}) {
  return apiRequest("/api/effort", { signal });
}

/** Choose the effort ("low" | "medium" | "high" | "xhigh") used for every reasoning model. */
export async function setEffort(effort) {
  const result = await apiRequest("/api/effort", { method: "PUT", body: { effort }, retries: 0 });
  invalidateCache();
  return result;
}
