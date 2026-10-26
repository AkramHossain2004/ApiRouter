import { apiRequest } from "./client.js";

export function getProviders({ signal } = {}) {
  return apiRequest("/api/providers", { signal });
}

/**
 * Switches a whole provider off or on for ALL routing (every model, every key,
 * both pools). Sends the provider id and a flag only. While it is off none of
 * its models is used or fallen back to; a request still waiting on it is
 * aborted by the gateway and falls back to the next model. Enabling it restores
 * the previous behaviour.
 */
export function setProviderDisabled(provider, disabled) {
  return apiRequest("/api/providers/switch", { method: "PUT", body: { provider, disabled } });
}

/**
 * Asks the provider itself which models it serves ("Fetch Models"), using the
 * first key configured on the gateway — the key never reaches the browser.
 * Resolves to { ok, models, count, truncated, current, modelsSource }.
 */
export function discoverProviderModels(provider, { signal } = {}) {
  return apiRequest("/api/providers/discover", { method: "POST", body: { provider }, signal });
}

/** Replaces the provider's model list (instead of its <PROVIDER>_MODELS env list). Applies at once. */
export function saveProviderModels(provider, models) {
  return apiRequest(`/api/providers/${encodeURIComponent(provider)}/models`, { method: "PUT", body: { models } });
}

/** Drops the saved list, so the provider goes back to its <PROVIDER>_MODELS env list. */
export function resetProviderModels(provider) {
  return apiRequest(`/api/providers/${encodeURIComponent(provider)}/models`, { method: "DELETE" });
}
