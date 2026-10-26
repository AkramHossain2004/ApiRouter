import { splitList } from "../api/customEndpoints.js";

/**
 * The Custom Endpoints form, as plain functions so they can be tested without a
 * DOM.
 */

/** Same ceiling the gateway enforces (MAX_MODELS_PER_ENDPOINT). */
export const MAX_MODELS = 100;

export const EMPTY_FORM = {
  name: "", baseUrl: "", protocol: "openai-chat", models: "", keys: "", replaceKeys: false
};

export function formFromEndpoint(endpoint) {
  if (!endpoint) return { ...EMPTY_FORM };
  return {
    ...EMPTY_FORM,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    protocol: endpoint.protocol,
    models: (endpoint.models ?? []).join("\n")
  };
}

/** The first thing wrong with the form, or null. `isNew` is true when adding, false when editing. */
export function formProblem(form, isNew) {
  const models = splitList(form.models);
  const keys = splitList(form.keys);
  if (!form.name.trim()) return "Enter a name.";
  if (!form.baseUrl.trim()) return "Enter a base URL.";
  if (models.length === 0) return "Add at least one model.";
  if (models.length > MAX_MODELS) return `At most ${MAX_MODELS} models per endpoint (${models.length} selected).`;
  if (isNew && models.length > 0 && keys.length === 0) return "Add at least one API key.";
  if (form.replaceKeys && keys.length === 0) return "Enter the new keys, or untick Replace.";
  return null;
}

export function createBody(form) {
  return {
    name: form.name,
    baseUrl: form.baseUrl,
    protocol: form.protocol,
    models: splitList(form.models),
    apiKeys: splitList(form.keys)
  };
}

export function updateBody(form) {
  const keys = splitList(form.keys);
  const patch = {
    name: form.name,
    baseUrl: form.baseUrl,
    protocol: form.protocol,
    models: splitList(form.models)
  };
  if (keys.length > 0) patch[form.replaceKeys ? "apiKeys" : "addApiKeys"] = keys;
  return patch;
}

/**
 * What the "Fetch Models" button sends. Only the FIRST key is used, and it is
 * optional: with no key nothing is sent for auth (providers that list models
 * openly). When editing, the saved key is used if none is typed (the gateway
 * holds it).
 */
export function discoverBody(form, editingId) {
  const key = splitList(form.keys)[0] ?? "";
  const body = { baseUrl: form.baseUrl.trim(), protocol: form.protocol };
  if (key) body.apiKey = key;
  if (editingId && editingId !== "new") body.endpointId = editingId;
  return body;
}

export function discoverProblem(form) {
  if (!form.baseUrl.trim()) return "Enter a base URL first.";
  return null;
}

// Ids that are plainly not chat/text models. Only a default for the picker's
// "hide" switch: nothing is ever removed from what the provider returned.
const NON_TEXT = /embed|whisper|tts|dall-?e|moderation|rerank|imagen|image|veo|sora|transcri|speech|audio|realtime|stable-diffusion|sdxl|flux|midjourney|vision-preview-ocr/i;

export function looksLikeTextModel(id) {
  return !NON_TEXT.test(String(id ?? ""));
}

/** Adds or removes one model id in the models text box, keeping one id per line. */
export function toggleModel(modelsText, id, on) {
  const list = splitList(modelsText);
  const has = list.includes(id);
  if (on && !has) list.push(id);
  if (!on && has) list.splice(list.indexOf(id), 1);
  return list.join("\n");
}

/** Adds (on) or removes (off) many ids at once; adding stops at `limit` models in total. */
export function setManyModels(modelsText, ids, on, limit = MAX_MODELS) {
  let list = splitList(modelsText);
  if (on) {
    for (const id of ids) {
      if (list.length >= limit) break;
      if (!list.includes(id)) list.push(id);
    }
  } else {
    const drop = new Set(ids);
    list = list.filter((id) => !drop.has(id));
  }
  return list.join("\n");
}

/** Case-insensitive filter of fetched ids, optionally hiding non-text models. */
export function filterModels(ids, { query = "", hideNonText = true } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  return ids.filter((id) => (!hideNonText || looksLikeTextModel(id)) && (!needle || id.toLowerCase().includes(needle)));
}
