import { apiRequest } from "./client.js";

/**
 * Saved custom endpoints. A saved endpoint becomes a provider (`custom-<name>`)
 * in the Fallback Chain. Keys are sent TO the gateway and never come back: the
 * list only reports how many keys each endpoint has.
 */

export function listCustomEndpoints({ signal } = {}) {
  return apiRequest("/api/custom-endpoints", { signal });
}

export function createCustomEndpoint(input) {
  return apiRequest("/api/custom-endpoints", { method: "POST", body: input });
}

export function updateCustomEndpoint(id, input) {
  return apiRequest(`/api/custom-endpoints/${encodeURIComponent(id)}`, { method: "PUT", body: input });
}

export function deleteCustomEndpoint(id) {
  return apiRequest(`/api/custom-endpoints/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Tests a base URL + key and asks the provider which models it serves. Nothing
 * is saved. When `endpointId` is given the saved endpoint fills in whatever is
 * left out (its key included, which never reaches the browser).
 * Resolves to { ok, models: string[], count, truncated }.
 */
export function discoverCustomModels(input, { signal } = {}) {
  return apiRequest("/api/custom-endpoints/discover", { method: "POST", body: input, signal });
}

/** Commas, semicolons, spaces or new lines (any mix): what the model and key boxes accept. */
export function splitList(text) {
  return [...new Set(String(text ?? "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}
