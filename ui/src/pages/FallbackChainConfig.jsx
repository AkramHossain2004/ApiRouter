import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { OrderLatency } from "../components/domain/OrderLatency.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { useApi } from "../hooks/useApi.js";
import { useToast } from "../context/ToastContext.jsx";
import { getFallback, saveChain, resetFallback } from "../api/fallback.js";
import { getRoutingPreview } from "../api/router.js";
import { providerLabel, formatRelativeTime } from "../lib/format.js";
import {
  addEntry, chainSummary, entryId, entryState, filterCatalogue, indexCatalogue,
  keysLabel, latencyOf, moveEntry, phaseLabel, removeEntry, sameChain, setKeys, toggleEnabled
} from "../lib/fallbackChain.js";

/**
 * Fallback Chain configuration — the single place routing order is decided.
 *
 * One selection, in the operator's exact order. Every eligible key of a model
 * is tried before the next model; the last successful target leads the next
 * request. Nothing selected means the router uses the automatic health-based
 * order instead. Nothing on this page invents a route: the order shown is what
 * the gateway will walk.
 */
const PROTOCOLS = ["openai-chat", "anthropic", "openai-responses", "gemini"];

function ModelName({ entry }) {
  return (
    <span className="ms-name" title={entryId(entry)}>
      <span className="ms-provider">{providerLabel(entry.provider)}</span>
      <span className="ms-model">{entry.model}</span>
    </span>
  );
}

/** Key chips for one entry. An empty selection means every configured key. */
function KeyPicker({ entry, group, disabled, onChange }) {
  const available = group?.keyStates ?? [];
  if (available.length <= 1) return null;
  const chosen = Array.isArray(entry.keys) ? entry.keys : available.map((key) => key.keyIndex);
  return (
    <span className="fc-keys fcx-keys" role="group" aria-label={`Keys for ${entryId(entry)}`}>
      {available.map((key) => {
        const on = chosen.includes(key.keyIndex);
        return (
          <button
            key={key.keyIndex}
            type="button"
            className={`fc-key ${on ? "fc-key--on" : ""}`}
            disabled={disabled}
            aria-pressed={on}
            title={`Key ${key.keyIndex} — ${key.status}${key.available ? "" : " (cooling down)"}`}
            onClick={() => onChange(
              on ? chosen.filter((index) => index !== key.keyIndex) : [...chosen, key.keyIndex]
            )}
          >
            {key.keyIndex}
          </button>
        );
      })}
    </span>
  );
}

/** Provider-level "n/m added" progress for the catalogue headers. */
function addedCount(models, chosen) {
  return models.filter((group) => chosen.has(entryId(group))).length;
}

const TABS = [
  { id: "chain", label: "Chain" },
  { id: "add", label: "Add models" },
  { id: "route", label: "Route order" }
];

export default function FallbackChainConfig() {
  const { data, error, loading, reload } = useApi((opts) => getFallback(opts));
  const toast = useToast();
  const [draft, setDraft] = useState(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [protocol, setProtocol] = useState("openai-chat");
  // Phones and small tablets show one section at a time; on desktop every
  // section is visible and this only drives the (hidden) tab bar.
  const [tab, setTab] = useState("chain");

  const saved = data?.chain ?? [];
  const chain = draft ?? saved;
  const dirty = draft !== null && !sameChain(chain, saved);
  const catalogue = data?.catalogue ?? [];
  const index = useMemo(() => indexCatalogue(catalogue), [catalogue]);
  const lastSeenAt = useMemo(() => {
    const stamps = catalogue.flatMap((group) => group.keyStates ?? [])
      .map((key) => key.updatedAt).filter(Boolean).sort();
    return stamps.at(-1) ?? null;
  }, [catalogue]);

  const chosen = useMemo(() => new Set(chain.map(entryId)), [chain]);
  const visible = useMemo(() => filterCatalogue(catalogue, query), [catalogue, query]);
  const groups = useMemo(() => {
    const byProvider = new Map();
    for (const group of visible) {
      if (!byProvider.has(group.provider)) byProvider.set(group.provider, []);
      byProvider.get(group.provider).push(group);
    }
    return [...byProvider.entries()];
  }, [visible]);
  const addable = visible.filter((group) => !chosen.has(entryId(group)));
  const enabledCount = chain.filter((entry) => entry.enabled !== false).length;

  const preview = useApi((opts) => getRoutingPreview({ protocol }, opts), { deps: [protocol, data] });
  const order = preview.data?.fallbackOrder ?? [];
  const summary = chainSummary(chain, catalogue);

  useEffect(() => { setQuery(""); setDraft(null); }, []);

  const run = async (action, success) => {
    setBusy(true);
    try {
      await action();
      setDraft(null);
      await reload();
      toast.success(success);
    } catch (failure) {
      toast.error(failure?.message || "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const tone = summary.failClosed ? "danger" : summary.source === "chain" ? "info" : "warn";

  return (
    <div className="page fcx">
      <PageHeader
        title="Manually Set Fallback"
        description="Pick the models and put them in the order the router should try them. Every eligible key of a model is tried before the next model."
        actions={data ? (
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy}
            title="Clears remembered model/key preferences only. Selection, providers, keys, health data and real cooldowns are kept."
            onClick={() => run(() => resetFallback(), "Remembered targets cleared")}>
            <Icon name="refresh" size={12} /> Reset remembered
          </button>
        ) : null}
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <p className="dim">Loading…</p> : null}

      {data ? (
        <>
          <div className={`fcx-status fcx-status--${tone}`} aria-label="Ordering in force">
            <div className="fcx-status__main">
              <span className={`badge badge--${tone}`}>
                {summary.failClosed ? "Fail closed" : summary.source === "chain" ? "Manual order" : "Automatic"}
              </span>
              <span className="fcx-status__text">{summary.label}</span>
            </div>
            {summary.failClosed ? (
              <p className="tiny fcx-status__hint">
                Every entry is disabled or names a model the router no longer has. Clear the selection to use the automatic order.
              </p>
            ) : null}
            <div className="fcx-stats">
              <span className="fcx-stat"><strong>{chain.length}</strong> in chain</span>
              <span className="fcx-stat"><strong>{enabledCount}</strong> enabled</span>
              <span className="fcx-stat"><strong>{catalogue.length}</strong> available</span>
            </div>
          </div>

          <div className="fcx-tabs" role="tablist" aria-label="Sections">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`fcx-tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls={`fcx-pane-${item.id}`}
                className={`fcx-tab ${tab === item.id ? "fcx-tab--on" : ""}`}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                {item.id === "chain" ? <span className="fcx-tab__count">{chain.length}</span> : null}
              </button>
            ))}
          </div>

          <div className="fcx-grid">
            {/* ---- Chain: the thing being built, so it is the primary column ---- */}
            <section className="panel fcx-pane" id="fcx-pane-chain" data-tab="chain" data-active={tab === "chain"}
              aria-label="Manually set fallback">
              <div className="panel__header">
                <span className="panel__title">Your chain</span>
                <span className="badge badge--neutral">{chain.length}</span>
                <div className="panel__actions">
                  <button type="button" className="btn btn--sm btn--ghost"
                    disabled={busy || (saved.length === 0 && chain.length === 0)}
                    onClick={() => run(() => saveChain([]), "Chain cleared")}>
                    <Icon name="trash" size={12} /> Clear
                  </button>
                </div>
              </div>
              <div className="panel__body">
                {chain.length === 0 ? (
                  <EmptyState title="Nothing selected" icon="list"
                    action={<button type="button" className="btn btn--primary fcx-empty-cta" onClick={() => setTab("add")}>
                      <Icon name="plus" size={13} /> Add models
                    </button>}>
                    Add models and they appear here in order. While nothing is selected the router uses the
                    automatic health-based order over every configured model.
                  </EmptyState>
                ) : (
                  <ol className="fcx-chain">
                    {chain.map((entry, i) => {
                      const group = index.get(entryId(entry));
                      const state = entryState(entry, group);
                      const latency = latencyOf(group);
                      const off = entry.enabled === false;
                      return (
                        <li key={entryId(entry)} draggable
                          className={`fcx-card ${dragOver === i && dragFrom !== i ? "fcx-card--over" : ""} ${dragFrom === i ? "fcx-card--dragging" : ""} ${off ? "fcx-card--off" : ""}`}
                          onDragStart={() => setDragFrom(i)}
                          onDragOver={(event) => { event.preventDefault(); setDragOver(i); }}
                          onDragLeave={() => setDragOver(null)}
                          onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
                          onDrop={() => { if (dragFrom !== null) setDraft(moveEntry(chain, dragFrom, i)); setDragFrom(null); setDragOver(null); }}>
                          <div className="fcx-card__top">
                            <span className="fcx-grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
                            <span className="fcx-rank">{i + 1}</span>
                            <ModelName entry={entry} />
                            <button type="button" role="switch" aria-checked={!off}
                              className={`fcx-switch ${off ? "" : "fcx-switch--on"}`}
                              aria-label={`${off ? "Enable" : "Disable"} ${entryId(entry)}`}
                              title={off ? "Enable this model" : "Disable this model (keeps its place)"}
                              onClick={() => setDraft(toggleEnabled(chain, i))}>
                              <span className="fcx-switch__knob" />
                            </button>
                          </div>
                          <div className="fcx-card__meta">
                            <HealthBadge status={group?.status ?? "unknown"} title={state.label} />
                            <LatencyBadge ms={latency.ms} />
                            <span className="tiny dim" title={latency.label}>{latency.label}</span>
                            <span className="tiny dim">· {keysLabel(entry, group)}</span>
                            {state.tone === "danger" || state.tone === "warn" ? (
                              <span className={`badge badge--${state.tone === "danger" ? "danger" : "warn"}`}>{state.label}</span>
                            ) : null}
                          </div>
                          <KeyPicker entry={entry} group={group} disabled={busy}
                            onChange={(keys) => setDraft(setKeys(chain, i, keys))} />
                          <div className="fcx-card__actions">
                            <button type="button" className="btn fcx-act" disabled={i === 0}
                              onClick={() => setDraft(moveEntry(chain, i, i - 1))} aria-label={`Move ${entryId(entry)} up`}>
                              <Icon name="arrowUp" size={14} /><span className="fcx-act__label">Up</span>
                            </button>
                            <button type="button" className="btn fcx-act" disabled={i === chain.length - 1}
                              onClick={() => setDraft(moveEntry(chain, i, i + 1))} aria-label={`Move ${entryId(entry)} down`}>
                              <Icon name="arrowDown" size={14} /><span className="fcx-act__label">Down</span>
                            </button>
                            <button type="button" className="btn fcx-act fcx-act--remove"
                              onClick={() => setDraft(removeEntry(chain, i))} aria-label={`Remove ${entryId(entry)}`}>
                              <Icon name="close" size={14} /><span className="fcx-act__label">Remove</span>
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </section>

            {/* ---- Catalogue ---- */}
            <section className="panel fcx-pane" id="fcx-pane-add" data-tab="add" data-active={tab === "add"}
              aria-label="Available models">
              <div className="panel__header">
                <span className="panel__title">Available models</span>
                <div className="panel__actions">
                  <button type="button" className="btn btn--sm" disabled={addable.length === 0}
                    onClick={() => setDraft(addable.reduce(addEntry, chain))}>
                    <Icon name="plus" size={12} /> Add all{query ? " shown" : ""}{addable.length ? ` (${addable.length})` : ""}
                  </button>
                </div>
              </div>
              <div className="panel__body">
                <div className="fcx-search">
                  <SearchInput value={query} onChange={setQuery} placeholder="Search provider or model…" label="Search models" />
                  {lastSeenAt ? <span className="tiny dim">health updated {formatRelativeTime(lastSeenAt)}</span> : null}
                </div>
                <div className="fcx-catalogue">
                  {groups.length === 0 ? (
                    <EmptyState title="No models">
                      {catalogue.length === 0 ? "No models are configured." : "Nothing matches this search."}
                    </EmptyState>
                  ) : groups.map(([provider, models]) => {
                    const pending = models.filter((group) => !chosen.has(entryId(group)));
                    return (
                      <details key={`${provider}-${query ? "q" : "a"}`} className="fcx-provider" open={Boolean(query) || groups.length <= 4}>
                        <summary className="fcx-provider__head">
                          <Icon name="chevronRight" size={13} className="fcx-provider__chev" />
                          <span className="fcx-provider__name">{providerLabel(provider)}</span>
                          <span className="tiny dim">{addedCount(models, chosen)}/{models.length} added</span>
                          {pending.length > 0 ? (
                            <button type="button" className="btn btn--sm btn--ghost fcx-provider__all"
                              aria-label={`Add all ${providerLabel(provider)} models`}
                              onClick={(event) => { event.preventDefault(); setDraft(pending.reduce(addEntry, chain)); }}>
                              + all
                            </button>
                          ) : null}
                        </summary>
                        <div className="fcx-provider__rows">
                          {models.map((group) => {
                            const added = chosen.has(entryId(group));
                            const latency = latencyOf(group);
                            return (
                              <div key={group.id} className={`fcx-row ${added ? "fcx-row--added" : ""}`}>
                                <span className="fcx-row__name">
                                  <span className="ms-model" title={group.id}>{group.model}</span>
                                  <span className="fcx-row__meta">
                                    <HealthBadge status={group.status} title={`${group.keyStates.length} key(s)`} />
                                    <LatencyBadge ms={latency.ms} />
                                    {group.keyStates.length > 1 ? <span className="tiny dim">{group.keyStates.length} keys</span> : null}
                                  </span>
                                </span>
                                <button type="button" className={`btn fcx-add ${added ? "btn--ghost" : ""}`} disabled={added}
                                  onClick={() => setDraft(addEntry(chain, group))} aria-label={`Add ${group.id}`}>
                                  <Icon name={added ? "check" : "plus"} size={13} />
                                  <span className="fcx-add__label">{added ? "Added" : "Add"}</span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* ---- Route order (kept last in the DOM: tests read from here to the end) ---- */}
            <section className="panel fcx-pane fcx-pane--route" id="fcx-pane-route" data-tab="route" data-active={tab === "route"}
              aria-label="Route order">
              <div className="panel__header">
                <span className="panel__title">
                  Route order <span className="dim tiny">({chain.length === 0 ? "automatic" : "saved chain"})</span>
                </span>
              </div>
              <div className="panel__body">
                <div className="fcx-seg" role="group" aria-label="Client protocol">
                  {PROTOCOLS.map((item) => (
                    <button key={item} type="button" aria-pressed={protocol === item}
                      className={`fcx-seg__btn ${protocol === item ? "fcx-seg__btn--on" : ""}`}
                      onClick={() => setProtocol(item)}>
                      {item}
                    </button>
                  ))}
                </div>
                {order.length === 0 ? (
                  <p className="dim tiny">{preview.error ? "Preview unavailable for this protocol." : "No eligible targets right now."}</p>
                ) : (
                  <ol className="fcx-order">
                    {order.map((item, i) => (
                      <li key={`${i}-${item.provider}-${item.model}-${item.keyIndex}`} className="fcx-order__item">
                        <span className="ms-num ms-num--sm">{i + 1}</span>
                        <span className="fcx-order__body">
                          <ModelName entry={item} />
                          <span className="fcx-order__meta">
                            <span className="tiny dim">key {item.keyIndex}</span>
                            <OrderLatency item={item} showUnmeasured />
                            {item.phase ? (
                              <span className={`badge ${item.phase === "sticky" ? "badge--info" : "badge--neutral"}`}>
                                {phaseLabel(item.phase) ?? item.phase}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="tiny dim fc-note">
                  This is the order the gateway will walk for a new request over {protocol}.
                </p>
              </div>
            </section>
          </div>

          {/* Sticky on every screen size: the save action is always reachable, never scrolled away. */}
          {dirty ? (
            <div className="fcx-savebar" role="status">
              <span className="fcx-savebar__text"><Icon name="alert" size={13} /> Unsaved changes</span>
              <button type="button" className="btn" disabled={busy} onClick={() => setDraft(null)}>
                <Icon name="undo" size={13} /> Discard
              </button>
              <button type="button" className="btn btn--primary" disabled={busy}
                onClick={() => run(() => saveChain(chain), "Chain saved")}>
                <Icon name="check" size={13} /> Save order
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
