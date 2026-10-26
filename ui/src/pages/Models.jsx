import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { FilterBar, FilterSelect } from "../components/ui/FilterBar.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { Drawer } from "../components/ui/Overlays.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { MetricSkeleton, TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { useApi } from "../hooks/useApi.js";
import { useDebouncedValue } from "../hooks/useDebounce.js";
import { getModels, setModelDisabled } from "../api/models.js";
import {
  filterChoices, filterModelGroups, findTarget, groupTargetsByModel, isRoutable,
  normalizeModelPayload, summarizeTargets
} from "../lib/targets.js";
import { sortRows } from "../lib/table.js";
import {
  formatDateTime, formatNumber, formatPercent,
  protocolLabel, providerLabel, EMPTY
} from "../lib/format.js";

/**
 * Model catalogue.
 *
 * Every row is one MODEL (provider + model). The gateway tracks, cools down and
 * ranks each key separately — a routing *target* is provider + model + key —
 * but a model with five keys is still one model, so its keys are folded into a
 * single row with an "N keys" tag. The per-key detail is not lost: a model whose
 * keys are not all in the same state says so in its Health cell, and the drawer
 * lists every key with its own health, latency and cooldown, so one exhausted
 * key beside healthy siblings stays visible.
 *
 * Text and vision are capabilities of a model, declared in the Model
 * Configurator — not separate routing pools — so there is one table here with
 * no pool filter, column or per-pool summary.
 *
 * All data comes from `GET /api/models`. The raw `/v1/models` discovery
 * endpoint is a client-facing contract and is deliberately not consumed here.
 */
export default function Models() {
  const models = useApi(getModels, { intervalMs: 15_000 });

  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState(null);
  const [protocol, setProtocol] = useState(null);
  const [status, setStatus] = useState(null);
  const [sort, setSort] = useState({ key: "provider", direction: "asc" });
  const [selectedId, setSelectedId] = useState(null);
  const [pendingKey, setPendingKey] = useState(null);
  const [switchError, setSwitchError] = useState(null);

  const debouncedSearch = useDebouncedValue(search, 220);

  // Narrowed once, so a partial or malformed response cannot reach the table.
  const view = useMemo(() => normalizeModelPayload(models.data), [models.data]);
  const { rows } = view;

  // The endpoint advertises its own filter vocabulary; the fallback recount
  // lives in the view model so both pages share one implementation.
  const choices = useMemo(() => filterChoices(view), [view]);

  // One row per provider + model; the keys of a model live inside its row.
  const groups = useMemo(() => groupTargetsByModel(rows), [rows]);

  const filtered = useMemo(
    () => sortRows(
      filterModelGroups(groups, { provider, protocol, status, search: debouncedSearch }),
      COLUMN_ACCESSORS,
      sort
    ),
    [groups, provider, protocol, status, debouncedSearch, sort]
  );

  const selected = useMemo(() => findTarget(groups, selectedId), [groups, selectedId]);

  const activeFilterCount = [provider, protocol, status, debouncedSearch].filter(Boolean).length;

  // One summary, recounted from all rows together.
  const summary = useMemo(() => summarizeTargets(rows), [rows]);

  // Applies at once on the gateway: new requests stop planning the model and a
  // request still waiting on it is aborted and falls back to the next one.
  const toggleModel = async (row) => {
    const key = `${row.provider}/${row.model}`;
    setPendingKey(key);
    setSwitchError(null);
    try {
      await setModelDisabled(row.provider, row.model, !row.disabled);
      models.reload();
    } catch (error) {
      setSwitchError(error);
    } finally {
      setPendingKey(null);
    }
  };
  const columns = useMemo(() => makeColumns({ onToggle: toggleModel, pendingKey }), [pendingKey, models.reload]);

  if (models.loading && !models.data) {
    return (
      <div className="page">
        <PageHeader title="Models" description="Model catalogue with health, protocol and usage" />
        <MetricSkeleton count={5} />
        <div className="panel"><div className="panel__body"><TableSkeleton rows={10} label="Loading models" /></div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Models"
        description="Model catalogue with health, protocol and usage"
        lastUpdatedAt={models.lastUpdatedAt}
        refreshing={models.refreshing}
        paused={models.paused}
        actions={
          <button type="button" className="btn" onClick={models.reload} disabled={models.refreshing}>
            Refresh
          </button>
        }
      />

      {models.error ? <ErrorState error={models.error} onRetry={models.reload} compact /> : null}
      {switchError ? <ErrorState error={switchError} compact /> : null}

      <section className="section">
        <div className="section__header">
          <h2 className="section__title">Targets</h2>
        </div>

        <div className="metrics">
          <MetricCard label="Models" value={formatNumber(groups.length)} icon="box" hint={`${formatNumber(summary.total)} keys across all models`} />
          <MetricCard label="Healthy" value={formatNumber(summary.healthy)} tone={summary.healthy > 0 ? "ok" : null} icon="check" />
          <MetricCard label="Failed" value={formatNumber(summary.failed)} tone={summary.failed > 0 ? "danger" : null} icon="alert" />
          <MetricCard label="Available" value={formatNumber(summary.available)} tone={summary.available === 0 ? "danger" : null} icon="route" hint="not cooling down" />
        </div>
      </section>

      <div className="panel section">
        <FilterBar
          actions={
            <span className="tiny dim nowrap">
              {filtered.length} of {groups.length} models
              {activeFilterCount > 0 ? ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}` : ""}
            </span>
          }
        >
          <div className="field filter-bar__search">
            <label className="field__label" htmlFor="model-search">Search</label>
            <SearchInput
              id="model-search"
              value={search}
              onChange={setSearch}
              label="Search models"
              placeholder="Model, provider or reason…"
            />
          </div>

          <FilterSelect label="Provider" value={provider} onChange={setProvider} options={choices.providers} />
          <FilterSelect
            label="Protocol"
            value={protocol}
            onChange={setProtocol}
            options={choices.protocols.map((value) => ({ value, label: protocolLabel(value) }))}
          />
          <FilterSelect label="Health" value={status} onChange={setStatus} options={choices.statuses} />
        </FilterBar>

        <DataTable
          columns={columns}
          rows={filtered}
          sort={sort}
          onSortChange={(next) => setSort(next)}
          rowKey={(row) => row.id}
          onRowClick={(row) => setSelectedId(row.id)}
          caption="Models with health and usage"
          emptyState={
            groups.length === 0 ? (
              <EmptyState title="No models configured" icon="box">
                Configure <code>PROVIDER_MODELS</code> for at least one provider to populate the catalogue.
              </EmptyState>
            ) : (
              <EmptyState title="No models match these filters" icon="filter">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => { setSearch(""); setProvider(null); setProtocol(null); setStatus(null); }}
                >
                  Clear filters
                </button>
              </EmptyState>
            )
          }
        />
      </div>

      <ModelDrawer model={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}

const COLUMN_ACCESSORS = {
  provider: (row) => row.provider,
  model: (row) => row.model,
  keys: (row) => row.keyCount,
  protocol: (row) => row.protocols[0] ?? "",
  status: (row) => row.status,
  latency: (row) => row.latencyMs,
  success: (row) => row.successRate,
  failures: (row) => row.failures,
  updated: (row) => row.updatedAt,
  switch: (row) => (row.disabled ? 1 : 0)
};

function makeColumns({ onToggle, pendingKey }) {
  return [
    {
      key: "provider",
      header: "Provider",
      sortable: true,
      get: (row) => row.provider,
      render: (row) => <span className="nowrap">{providerLabel(row.provider)}</span>
    },
    {
      key: "model",
      header: "Model",
      sortable: true,
      get: (row) => row.model,
      render: (row) => (
        <span className="mono truncate table__truncate" title={row.model}>{row.model}</span>
      )
    },
    {
      key: "protocol",
      header: "Protocol",
      sortable: true,
      get: (row) => row.protocols[0] ?? "",
      render: (row) => (
        <span className="tiny dim nowrap">
          {row.protocols.map(protocolLabel).join(", ") || EMPTY}
        </span>
      )
    },
    {
      key: "keys",
      header: "Keys",
      align: "right",
      sortable: true,
      get: (row) => row.keyCount,
      render: (row) => (
        <StatusBadge tone="neutral" dot={false} title={`${row.keyCount} API key${row.keyCount === 1 ? "" : "s"} serve this model`}>
          <span className="nowrap">{row.keyCount} {row.keyCount === 1 ? "key" : "keys"}</span>
        </StatusBadge>
      )
    },
    {
      key: "status",
      header: "Health",
      sortable: true,
      get: (row) => row.status,
      render: (row) => (
        <span className="row" style={{ gap: 6 }}>
          <HealthBadge status={row.status} title={row.lastReason ?? undefined} />
          {row.keyCount > 1 && row.statusCounts.healthy < row.keyCount ? (
            <span className="tiny dim nowrap" title="Keys of this model that are healthy">
              {row.statusCounts.healthy}/{row.keyCount} healthy
            </span>
          ) : null}
        </span>
      )
    },
    {
      key: "latency",
      header: "Latency",
      align: "right",
      sortable: true,
      get: (row) => row.latencyMs,
      render: (row) => <LatencyBadge ms={row.latencyMs} />
    },
    {
      key: "success",
      header: "Success rate",
      align: "right",
      sortable: true,
      get: (row) => row.successRate,
      render: (row) => row.successRate === null
        ? <span className="dim">—</span>
        : <span className="mono tabular">{formatPercent(row.successRate)}</span>
    },
    {
      key: "failures",
      header: "Failures",
      align: "right",
      sortable: true,
      get: (row) => row.failures,
      render: (row) => (
        <span className="mono" style={{ color: row.failures > 0 ? "var(--danger)" : undefined }}>
          {row.failures}
        </span>
      )
    },
    {
      key: "updated",
      header: "Last check",
      align: "right",
      sortable: true,
      get: (row) => row.updatedAt,
      render: (row) => <span className="dim tiny nowrap">{shortTime(row.updatedAt)}</span>
    },
    {
      key: "switch",
      header: "Switch",
      align: "right",
      sortable: true,
      get: (row) => (row.disabled ? 1 : 0),
      render: (row) => (
        <ModelSwitchButton row={row} busy={pendingKey === `${row.provider}/${row.model}`} onToggle={onToggle} />
      )
    }
  ];
}

/**
 * On/Off for one provider/model. It is per MODEL, not per key: every key of the
 * model changes together. The click must not open the row's drawer.
 */
function ModelSwitchButton({ row, busy, onToggle }) {
  const off = row.disabled === true;
  // The provider is off, so the model's own switch cannot bring it back: the
  // provider has to be enabled on the Providers page first.
  const providerOff = row.providerDisabled === true;
  return (
    <button
      type="button"
      className={`btn btn--sm ${off ? "" : "btn--ghost"}`}
      aria-pressed={!off}
      disabled={busy || providerOff}
      title={providerOff
        ? "The whole provider is switched off — enable it on the Providers page"
        : off ? "Switched off — click to enable this model" : "Click to disable this model (removes it from routing and fallback)"}
      onClick={(event) => { event.stopPropagation(); onToggle(row); }}
    >
      {busy ? "…" : off ? "Off" : "On"}
    </button>
  );
}

function shortTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? EMPTY : date.toLocaleTimeString();
}

function ModelDrawer({ model, onClose }) {
  return (
    <Drawer
      open={Boolean(model)}
      onClose={onClose}
      title={model?.model ?? ""}
      subtitle={model ? `${providerLabel(model.provider)} · ${model.keyCount} ${model.keyCount === 1 ? "key" : "keys"}` : null}
    >
      {model ? (
        <div className="stack" style={{ gap: "var(--sp-4)" }}>
          <div className="row row--wrap">
            <HealthBadge status={model.status} />
            <StatusBadge tone="neutral" dot={false}>
              {model.protocols.map(protocolLabel).join(", ") || "no protocol"}
            </StatusBadge>
            <StatusBadge tone="neutral" dot={false}>
              {model.keyCount} {model.keyCount === 1 ? "key" : "keys"}
            </StatusBadge>
          </div>

          <dl className="dl">
            <dt className="dl__term">Provider</dt>
            <dd className="dl__desc">{providerLabel(model.provider)}</dd>

            <dt className="dl__term">Model ID</dt>
            <dd className="dl__desc mono">{model.model}</dd>

            <dt className="dl__term">Protocols</dt>
            <dd className="dl__desc">{model.protocols.map(protocolLabel).join(", ") || EMPTY}</dd>

            <dt className="dl__term">Keys</dt>
            <dd className="dl__desc">
              {model.keyCount} total · {model.statusCounts.healthy} healthy
              {model.statusCounts.cooldown > 0 ? ` · ${model.statusCounts.cooldown} cooling down` : ""}
              {model.statusCounts.failed > 0 ? ` · ${model.statusCounts.failed} failed` : ""}
              {model.statusCounts.unknown > 0 ? ` · ${model.statusCounts.unknown} unknown` : ""}
            </dd>

            <dt className="dl__term">Requests seen</dt>
            <dd className="dl__desc mono">
              {formatNumber(model.requests)} ({formatNumber(model.requestFailures)} failed)
              <div className="tiny dim">Since this process started; the log is in-memory.</div>
            </dd>
          </dl>

          {model.keys.map((key) => (
            <KeyDetails key={key.id} target={key} />
          ))}
        </div>
      ) : null}
    </Drawer>
  );
}

/** One key of a model: its own health, latency and cooldown. */
function KeyDetails({ target }) {
  const routable = isRoutable(target);
  return (
    <section className="stack" style={{ gap: "var(--sp-2)" }} aria-label={`Key ${target.keyIndex}`}>
      <div className="row row--wrap">
        <strong className="mono">Key {target.keyIndex}</strong>
        <HealthBadge status={target.status} />
        {routable ? null : <StatusBadge tone="warn">cooling down</StatusBadge>}
      </div>

      <dl className="dl">
        <dt className="dl__term">Target ID</dt>
        <dd className="dl__desc mono tiny">{target.id}</dd>

        <dt className="dl__term">Score</dt>
        <dd className="dl__desc mono">
          {Number.isFinite(target.score) ? `${Math.round(target.score)} / 100` : EMPTY}
        </dd>

        <dt className="dl__term">Latency</dt>
        <dd className="dl__desc"><LatencyBadge ms={target.latencyMs} /></dd>

        <dt className="dl__term">Successes / failures</dt>
        <dd className="dl__desc mono">
          {formatNumber(target.successes)} / {formatNumber(target.failures)}
          {target.consecutiveFailures > 0 ? ` (${target.consecutiveFailures} in a row)` : ""}
        </dd>

        <dt className="dl__term">Last HTTP status</dt>
        <dd className="dl__desc mono">{target.lastStatus ?? EMPTY}</dd>

        <dt className="dl__term">Last reason</dt>
        <dd className="dl__desc">{target.lastReason || <span className="dim">none recorded</span>}</dd>

        <dt className="dl__term">Routing availability</dt>
        <dd className="dl__desc">
          {routable ? (
            <span className="row" style={{ gap: 6 }}>
              <StatusBadge tone="ok">routable</StatusBadge>
              <span className="tiny dim">the router may select this key</span>
            </span>
          ) : (
            <span className="tiny dim">excluded from routing until {formatDateTime(target.cooldownUntil)}</span>
          )}
        </dd>

        <dt className="dl__term">Updated</dt>
        <dd className="dl__desc">{formatDateTime(target.updatedAt)}</dd>
      </dl>
    </section>
  );
}
