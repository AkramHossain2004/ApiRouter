/**
 * Shared view model for the two target-shaped endpoints.
 *
 * `/api/models` and `/api/health` both return one row per routing *target* —
 * provider + model + key index. `/api/models` is the richer projection (it adds
 * per-target usage joined from the request log); `/api/health` is the health
 * projection.
 *
 * They are normalized by the same function on purpose. The Providers page once
 * regressed by reading a health rollup as if it were provider configuration;
 * the defence is that each payload is narrowed here, once, to the shape the
 * page actually renders — rather than each page reaching into a raw response.
 *
 * Everything below is defensive. A missing `summary`, a null `protocols`, or a
 * row that is not an object at all must narrow to a safe default rather than
 * become a property access on `undefined`.
 */

import { matchesSearch } from "./table.js";

export const HEALTH_STATUSES = Object.freeze(["healthy", "cooldown", "failed", "unknown"]);


const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Numbers that are genuinely absent become null, so the UI can render "n/a". */
const num = (value) => (Number.isFinite(value) ? value : null);

/** Counters that are genuinely absent become 0 — "none observed" is the truth. */
const count = (value) => (Number.isFinite(value) ? value : 0);

const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];

const pick = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * A target is routable when it is not cooling down.
 *
 * `cooldownUntil` is absolute and therefore authoritative: a row rendered from
 * a payload fetched a minute ago still evaluates correctly. `status` is the
 * fallback for a row carrying no timestamp — the backend derives
 * `status: "cooldown"` from exactly this comparison, so the two agree.
 */
export function isRoutable(target, now = Date.now()) {
  const until = Number(target?.cooldownUntil);
  if (Number.isFinite(until) && until > 0) return until <= now;
  return target?.status !== "cooldown";
}

/** Narrow one raw row to the shape both pages render. Never throws. */
export function normalizeTarget(row, index = 0) {
  const provider = typeof row?.provider === "string" ? row.provider : "";
  const model = typeof row?.model === "string" ? row.model : "";
  const keyIndex = Number.isFinite(row?.keyIndex) ? row.keyIndex : null;

  return {
    id: typeof row?.id === "string" && row.id
      ? row.id
      : `${provider}:${model}:key-${keyIndex ?? index}`,
    provider,
    model,
    keyIndex: keyIndex ?? index,
    protocols: strings(row?.protocols),
    status: HEALTH_STATUSES.includes(row?.status) ? row.status : "unknown",
    score: num(row?.score),
    latencyMs: num(row?.latencyMs),
    successes: count(row?.successes),
    failures: count(row?.failures),
    consecutiveFailures: count(row?.consecutiveFailures),
    lastStatus: num(row?.lastStatus),
    lastReason: typeof row?.lastReason === "string" && row.lastReason ? row.lastReason : null,
    // Whether the provider's model catalogue listed this target's model.
    // Tri-state on purpose: `true` listed, `false` absent from a catalogue read
    // to the end, `null` the catalogue could not be inspected. Only `false` is
    // evidence, and only `false` is ever rendered as a warning.
    //
    // `modelListed` is the LATEST observation; `modelListedConfirmed` is the
    // last definite one, kept separately so an indeterminate probe cannot leave
    // an older `false` on screen looking freshly confirmed.
    modelListed: typeof row?.modelListed === "boolean" ? row.modelListed : null,
    modelListedAt: typeof row?.modelListedAt === "string" ? row.modelListedAt : null,
    modelListedConfirmed: typeof row?.modelListedConfirmed === "boolean" ? row.modelListedConfirmed : null,
    modelListedConfirmedAt: typeof row?.modelListedConfirmedAt === "string" ? row.modelListedConfirmedAt : null,
    cooldownUntil: count(row?.cooldownUntil),
    // Switched off in the Control Panel: routing never uses it until switched on.
    disabled: row?.disabled === true,
    // The whole provider is switched off; its models' own switches cannot override it.
    providerDisabled: row?.providerDisabled === true,
    updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : null,
    // /api/models only. Null rather than 0 on the health projection, so the
    // panel says "not reported" instead of implying a measured zero.
    successRate: num(row?.successRate),
    requests: num(row?.requests),
    requestFailures: num(row?.requestFailures)
  };
}

/** Recount from the rows themselves — the fallback when `summary` is absent. */
function deriveSummary(rows) {
  const summary = { total: rows.length, healthy: 0, cooldown: 0, failed: 0, unknown: 0, available: 0, averageLatencyMs: null };
  const latencies = [];

  for (const row of rows) {
    if (row.status === "healthy") summary.healthy += 1;
    else if (row.status === "cooldown") summary.cooldown += 1;
    else if (row.status === "failed") summary.failed += 1;
    else summary.unknown += 1;

    if (Number.isFinite(row.latencyMs)) latencies.push(row.latencyMs);
    if (isRoutable(row)) summary.available += 1;
  }

  if (latencies.length > 0) {
    summary.averageLatencyMs = Math.round(
      latencies.reduce((total, value) => total + value, 0) / latencies.length
    );
  }

  return summary;
}

/**
 * The card figures.
 *
 * The backend's own `summary` wins when present: it is computed over the same
 * rows in the same response, so it cannot disagree with the table, and it
 * counts `available` with the router's own predicate. The client-side recount
 * only covers a response that arrived without one.
 */
export function summarizeTargets(rows = [], payloadSummary = null, extra = {}) {
  const summary = isPlainObject(payloadSummary) ? payloadSummary : {};
  const derived = deriveSummary(rows);

  return {
    total: pick(summary.total, derived.total),
    healthy: pick(summary.healthy, derived.healthy),
    cooldown: pick(summary.cooldown, derived.cooldown),
    failed: pick(summary.failed, derived.failed),
    unknown: pick(summary.unknown, derived.unknown),
    available: pick(summary.available, derived.available),
    averageLatencyMs: pick(summary.averageLatencyMs, derived.averageLatencyMs),
    ...extra
  };
}

/** Only the fields an operator would think to type. Never the key value. */
const SEARCH_FIELDS = [
  (row) => row.model,
  (row) => row.provider,
  (row) => row.lastReason ?? ""
];

export function filterTargets(rows = [], { provider = null, protocol = null, status = null, search = "" } = {}) {
  return rows.filter((row) => {
    if (provider && row.provider !== provider) return false;
    if (protocol && !row.protocols.includes(protocol)) return false;
    if (status && row.status !== status) return false;
    return matchesSearch(row, search, SEARCH_FIELDS);
  });
}

/** Sorted, de-duplicated provider ids. Tolerates a non-array, or a null row. */
export const providerOptions = (rows = []) =>
  [...new Set((Array.isArray(rows) ? rows : []).map((row) => row?.provider).filter(Boolean))].sort();

/**
 * The row a drawer should render, or null when there is nothing to show.
 *
 * Returns null rather than throwing for an id that is not in `rows`, which is
 * the normal case rather than an error: a poll can land between opening a
 * drawer and closing it, and the target that was selected may no longer be in
 * the response. The drawer closes instead of rendering a half-populated panel.
 */
export function findTarget(rows = [], id) {
  if (!id) return null;
  return rows.find((row) => row.id === id) ?? null;
}

/**
 * Option lists for a page's filter controls.
 *
 * The endpoint advertises its own vocabulary, and that is preferred when
 * present. When the block is missing — an older gateway, or a truncated
 * response — the choices are recounted from the rows, so the controls keep
 * offering every value that is actually in the table instead of collapsing to
 * an empty select the operator cannot recover from.
 */
export function filterChoices({ filters = null, rows = [] } = {}) {
  // A default parameter only covers `undefined`, but a JSON payload can carry an
  // explicit `null` — which is precisely the value that would reach `.map`.
  const list = Array.isArray(rows) ? rows : [];
  const providers = strings(filters?.providers);
  const protocols = strings(filters?.protocols);
  const statuses = strings(filters?.statuses);

  return {
    providers: providers.length > 0 ? providers : providerOptions(list),
    protocols: protocols.length > 0
      ? protocols
      : [...new Set(list.flatMap((row) => (Array.isArray(row?.protocols) ? row.protocols : [])))].sort(),
    statuses: statuses.length > 0 ? statuses : [...HEALTH_STATUSES]
  };
}

/**
 * `GET /api/models` → rows + the filter vocabulary the endpoint advertises.
 *
 * `providers` is taken from the backend's own filter list when it sent one, and
 * recounted from the rows otherwise.
 */
export function normalizeModelPayload(payload) {
  const rows = (Array.isArray(payload?.models) ? payload.models : []).map(normalizeTarget);
  const filters = {
    providers: strings(payload?.filters?.providers),
    protocols: strings(payload?.filters?.protocols),
    statuses: strings(payload?.filters?.statuses)
  };

  const providers = filters.providers.length > 0
    ? filters.providers.length
    : providerOptions(rows).length;

  return {
    rows,
    filters,
    summary: summarizeTargets(rows, payload?.summary, { providers })
  };
}

/** `GET /api/health` → rows + summary + per-provider rollups + monitor state. */
export function normalizeHealthPayload(payload) {
  const rows = (Array.isArray(payload?.targets) ? payload.targets : []).map(normalizeTarget);

  return {
    rows,
    summary: summarizeTargets(rows, payload?.summary),
    providers: Array.isArray(payload?.providers) ? payload.providers.filter(isPlainObject) : [],
    monitor: isPlainObject(payload?.monitor) ? payload.monitor : null
  };
}

/** Most usable first: a model with one healthy key is a usable model. */
const STATUS_RANK = Object.freeze({ healthy: 0, unknown: 1, cooldown: 2, failed: 3 });

const sumOrNull = (values) => {
  const present = values.filter((value) => Number.isFinite(value));
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
};

/**
 * Collapse the per-key target rows into ONE row per provider + model.
 *
 * `/api/models` returns a row per key, which makes a model with five keys look
 * like five models. The operator thinks in models, so this folds the keys of a
 * model together and keeps them in `keys` for the detail drawer, where the
 * per-key failure mode (one key exhausted, its siblings fine) is still visible.
 *
 *   keyCount    how many keys serve this model — the "N keys" tag
 *   status      the BEST status among its keys (usable if any key is)
 *   statusCounts how the keys split, so a mixed model is never shown as plainly
 *               healthy without saying how many of its keys are not
 *   latencyMs   mean of the keys that have one
 *   successRate recomputed from summed requests, not an average of averages
 *   failures    summed
 */
export function groupTargetsByModel(rows = [], now = Date.now()) {
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = `${row.provider}:${row.model}`;
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(row);
  }

  return [...buckets].map(([id, members]) => {
    const keys = [...members].sort((a, b) => a.keyIndex - b.keyIndex);
    const first = keys[0];

    const statusCounts = { healthy: 0, cooldown: 0, failed: 0, unknown: 0 };
    for (const key of keys) statusCounts[key.status] += 1;

    const status = keys
      .map((key) => key.status)
      .reduce((best, next) => (STATUS_RANK[next] < STATUS_RANK[best] ? next : best));

    const latencies = keys.map((key) => key.latencyMs).filter((value) => Number.isFinite(value));
    const requests = sumOrNull(keys.map((key) => key.requests));
    const requestFailures = sumOrNull(keys.map((key) => key.requestFailures));
    const updated = keys
      .map((key) => key.updatedAt)
      .filter(Boolean)
      .sort((a, b) => Date.parse(b) - Date.parse(a));

    return {
      id,
      provider: first.provider,
      model: first.model,
      keys,
      keyCount: keys.length,
      protocols: [...new Set(keys.flatMap((key) => key.protocols))],
      status,
      statusCounts,
      routableKeys: keys.filter((key) => isRoutable(key, now)).length,
      latencyMs: latencies.length === 0
        ? null
        : Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length),
      successes: keys.reduce((total, key) => total + key.successes, 0),
      failures: keys.reduce((total, key) => total + key.failures, 0),
      requests,
      requestFailures,
      successRate: requests > 0 && requestFailures !== null
        ? (requests - requestFailures) / requests
        : null,
      lastReason: keys.find((key) => key.lastReason)?.lastReason ?? null,
      disabled: keys.some((key) => key.disabled),
      providerDisabled: keys.some((key) => key.providerDisabled),
      updatedAt: updated[0] ?? null
    };
  });
}

/**
 * Filter grouped model rows. Provider, protocol and search work on the model;
 * a health filter keeps a model when ANY of its keys has that status, so
 * filtering on "failed" still finds the model that has one bad key.
 */
export function filterModelGroups(groups = [], { provider = null, protocol = null, status = null, search = "" } = {}) {
  return filterTargets(groups, { provider, protocol, search }).filter(
    (group) => !status || group.keys.some((key) => key.status === status)
  );
}
