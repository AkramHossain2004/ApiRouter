import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { MetricSkeleton, TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { HealthDistribution, TimeSeriesChart } from "../components/charts/Charts.jsx";
import { RequestDrawer } from "../components/domain/RequestDrawer.jsx";
import { ProviderDrawer } from "../components/domain/ProviderDrawer.jsx";
import { useHealth } from "../context/HealthContext.jsx";
import { useConnection } from "../context/ConnectionContext.jsx";
import { useApi } from "../hooks/useApi.js";
import { getAnalytics } from "../api/analytics.js";
import { getRequests } from "../api/requests.js";
import { getProviders } from "../api/providers.js";
import { getGateway } from "../api/gateway.js";
import { getOneProvider } from "../api/oneProvider.js";
import { getFallback } from "../api/fallback.js";
import { Link } from "../router.jsx";
import {
  formatLatency, formatNumber, formatPercent, formatRelativeTime,
  providerLabel, EMPTY
} from "../lib/format.js";

/**
 * Dashboard.
 *
 * One screen for "is the gateway OK, where is traffic going, and what needs me".
 * It is laid out for a wide desktop and for a phone alike: a status strip
 * (gateway, routing mode, health), headline figures, the traffic chart, provider
 * health, where requests went, and a live activity feed. Panels stack in one
 * column on a phone and lists are tap-friendly rows rather than wide tables.
 *
 * Every figure comes from the gateway. Where a metric has no data source yet —
 * most obviously request counts on a freshly restarted process — the card reads
 * "n/a" rather than 0, because "no traffic recorded" and "all traffic failing"
 * must not look the same.
 *
 * Health comes from `useHealth`; everything else from local queries, so a health
 * tick re-renders only the panels that show health.
 */

const asList = (value) => (Array.isArray(value) ? value : []);

// On a desktop everything is on screen at once. On a phone the same panels are
// split over three tabs so each tab still fits one screen with no page scroll.
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "traffic", label: "Traffic" },
  { id: "activity", label: "Activity" }
];

/** A labelled horizontal bar list (top providers / models). */
function BarList({ items, empty, limit = 5 }) {
  const list = asList(items).slice(0, limit);
  if (list.length === 0) return <span className="dim small">{empty}</span>;
  const top = Math.max(1, ...list.map((item) => item.count ?? 0));
  return (
    <ul className="dash-bars">
      {list.map((item) => (
        <li key={item.key} className="dash-bar">
          <div className="dash-bar__head">
            <span className="truncate dash-bar__label">{item.key}</span>
            <span className="mono tiny dim">{formatNumber(item.count)} · {formatPercent(item.share ?? 0, 0)}</span>
          </div>
          <div className="dash-bar__track" aria-hidden="true">
            <span className="dash-bar__fill" style={{ width: `${Math.max(3, ((item.count ?? 0) / top) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One tile of the status strip; the whole tile is a link to where it is managed. */
function StatusTile({ to, icon, label, value, detail, tone = "neutral" }) {
  return (
    <Link className={`dash-tile dash-tile--${tone}`} to={to}>
      <span className="dash-tile__icon"><Icon name={icon} size={18} /></span>
      <span className="dash-tile__body">
        <span className="dash-tile__label">{label}</span>
        <span className="dash-tile__value truncate">{value}</span>
        {detail ? <span className="dash-tile__detail truncate">{detail}</span> : null}
      </span>
      <Icon name="chevronRight" size={14} className="dash-tile__go" />
    </Link>
  );
}

export default function Dashboard() {
  const {
    health: healthData, summary, ranked, providers: healthProviders, error: healthError,
    loading: healthLoading, reload: reloadHealth, lastUpdatedAt, refreshing
  } = useHealth();
  const { generation } = useConnection();

  const providersApi = useApi(getProviders, { intervalMs: 10_000, deps: [generation] });
  const gateway = useApi(getGateway, { intervalMs: 10_000, deps: [generation] });
  const oneProvider = useApi(getOneProvider, { intervalMs: 10_000, deps: [generation] });
  const fallback = useApi(getFallback, { intervalMs: 15_000, deps: [generation] });

  const analytics = useApi(
    ({ signal }) => getAnalytics({ range: "24h" }, { signal }),
    { intervalMs: 15_000 }
  );

  const recent = useApi(
    ({ signal }) => getRequests({ limit: 8 }, { signal }),
    { intervalMs: 8_000 }
  );

  const [selectedRequest, setSelectedRequest] = useState(null);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [tab, setTab] = useState("overview");

  const traffic = analytics.data?.summary ?? null;
  const hasTraffic = (traffic?.total ?? 0) > 0;

  const providerSummary = providersApi.data?.summary ?? null;
  const providerRows = asList(providersApi.data?.providers);
  const healthRows = useMemo(
    () => [...asList(healthProviders)].sort((a, b) => (b.targets ?? 0) - (a.targets ?? 0)),
    [healthProviders]
  );

  const globalTargets = summary?.total ?? 0;
  const noTargets = !summary || summary.total === 0;
  const rankedList = asList(ranked);
  const paused = gateway.data?.paused === true;

  // --- Status strip ------------------------------------------------------
  const oneActive = oneProvider.data?.active === true;
  const chainLength = asList(fallback.data?.chain).length;
  const routing = oneActive
    ? {
      to: "/one-provider-fallback", value: "One Provider", tone: "info",
      detail: `${providerLabel(oneProvider.data.provider)} · ${asList(oneProvider.data.models).length} model${asList(oneProvider.data.models).length === 1 ? "" : "s"}`
    }
    : fallback.data?.mode === "manual"
      ? { to: "/fallback-chain", value: "Manual chain", tone: "info", detail: `${chainLength} model${chainLength === 1 ? "" : "s"} in your order` }
      : fallback.data
        ? { to: "/fallback-chain", value: "Automatic", tone: "neutral", detail: "Fastest healthy target first" }
        : { to: "/fallback-chain", value: null, tone: "neutral", detail: null };

  const healthPercent = summary?.healthPercent;
  const healthKnown = healthPercent !== null && healthPercent !== undefined;
  const healthTone = !healthKnown ? "neutral" : healthPercent >= 0.9 ? "ok" : healthPercent >= 0.5 ? "warn" : "danger";

  const fallbackRate = hasTraffic && Number.isFinite(traffic.requestsWithFallback)
    ? traffic.requestsWithFallback / traffic.total
    : null;

  const openProvider = (providerId) => {
    const record = providerRows.find((row) => row.id === providerId);
    if (record) setSelectedProvider(record);
  };

  if (healthLoading && !healthData) {
    return (
      <div className="page">
        <PageHeader title="Dashboard" description="Live gateway health, traffic and routing activity" />
        <MetricSkeleton count={6} />
      </div>
    );
  }

  const recentEntries = asList(recent.data?.entries);
  const failures = asList(analytics.data?.recentFailures);
  const fallbacks = asList(analytics.data?.recentFallbacks);
  const trafficLoading = analytics.loading && !analytics.data;

  return (
    <div className="page page--dashboard" data-tab={tab}>
      <PageHeader
        title="Dashboard"
        description="Live gateway health, traffic and routing activity"
        lastUpdatedAt={lastUpdatedAt}
        refreshing={refreshing}
        actions={
          <>
            <button type="button" className="btn" onClick={reloadHealth} disabled={refreshing} aria-label="Refresh health">
              <Icon name="refresh" size={14} /> <span className="btn__label">Refresh health</span>
            </button>
            <Link className="btn btn--primary" to="/playground">
              <Icon name="terminal" size={14} /> <span className="btn__label">Send a test request</span>
            </Link>
          </>
        }
      />

      {healthError ? <ErrorState error={healthError} onRetry={reloadHealth} compact /> : null}

      {paused ? (
        <div className="dash-alert dash-alert--danger" role="alert">
          <Icon name="stop" size={16} />
          <span><strong>The gateway is shut down.</strong> Every request is refused until you resume it.</span>
          <Link className="btn btn--sm" to="/system">System</Link>
        </div>
      ) : null}

      <div className="dash-tabs" role="tablist" aria-label="Dashboard sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`dash-tab-${item.id}`}
            aria-selected={tab === item.id}
            className={`dash-tabs__tab${tab === item.id ? " is-active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="dash-body">
        <div className="dash-top" data-pane="overview">
          <section aria-label="Status">
            <div className="dash-status">
              <StatusTile
                to="/system"
                icon="server"
                label="Gateway"
                tone={gateway.data ? (paused ? "danger" : "ok") : "neutral"}
                value={gateway.data ? (paused ? "Paused" : "Running") : "n/a"}
                detail={gateway.data ? (paused ? "Requests are refused" : "Accepting requests") : null}
              />
              <StatusTile
                to={routing.to}
                icon="route"
                label="Routing"
                tone={routing.tone}
                value={routing.value ?? "n/a"}
                detail={routing.detail}
              />
              <StatusTile
                to="/health-monitor"
                icon="activity"
                label="Health"
                tone={healthTone}
                value={healthKnown ? `${formatPercent(healthPercent)} healthy` : "n/a"}
                detail={summary ? `${formatNumber(summary.available ?? summary.total)} of ${formatNumber(summary.total)} targets routable` : null}
              />
            </div>
          </section>

          <section aria-label="Global statistics">
            <div className="metrics dash-kpis">
              <MetricCard
                label="Total Providers"
                value={formatNumber(providerSummary?.knownProviders ?? providerRows.length)}
                hint={[
                  Number.isFinite(providerSummary?.configuredProviders) ? `${providerSummary.configuredProviders} configured` : null,
                  providerSummary?.disabledProviders ? `${providerSummary.disabledProviders} switched off` : null
                ].filter(Boolean).join(" · ") || null}
                icon="server"
              />
              <MetricCard
                label="Total Targets"
                value={formatNumber(globalTargets)}
                icon="box"
                title="Each provider/model/key combination routes independently"
              />
              <MetricCard
                label="Total Requests"
                value={hasTraffic ? formatNumber(traffic.total) : null}
                hint={analytics.data ? "last 24h" : "loading"}
                icon="list"
                title="Requests recorded by this process. The log is in-memory and resets on restart."
              />
              <MetricCard
                label="Success Rate"
                value={hasTraffic ? formatPercent(traffic.successRate) : null}
                tone={hasTraffic ? (traffic.successRate >= 0.95 ? "ok" : traffic.successRate >= 0.8 ? "warn" : "danger") : null}
                hint={hasTraffic ? `${formatNumber(traffic.successful)} successful` : null}
                icon="check"
              />
              <MetricCard
                label="Failed Requests"
                value={hasTraffic ? formatNumber(traffic.failed) : null}
                tone={traffic?.failed > 0 ? "danger" : null}
                hint={hasTraffic ? formatPercent(traffic.failureRate) : null}
                icon="alert"
              />
              <MetricCard
                label="Average Latency"
                value={hasTraffic ? formatLatency(traffic.avgLatencyMs) : null}
                hint={hasTraffic && Number.isFinite(traffic.p95LatencyMs) ? `p95 ${formatLatency(traffic.p95LatencyMs)}` : null}
                icon="gauge"
              />
              <MetricCard
                label="Fallback Rate"
                value={fallbackRate === null ? null : formatPercent(fallbackRate)}
                hint={hasTraffic ? `${formatNumber(traffic.requestsWithFallback ?? 0)} request${traffic.requestsWithFallback === 1 ? "" : "s"} fell back` : null}
                tone={fallbackRate > 0.25 ? "warn" : null}
                icon="layers"
                title="Share of requests that needed more than their first-choice target"
              />
              <MetricCard
                label="Tokens (24h)"
                value={hasTraffic && (traffic.tokenReportingRequests ?? 0) > 0 ? formatNumber(traffic.tokens) : null}
                hint={hasTraffic && (traffic.tokenReportingRequests ?? 0) > 0 ? `${formatNumber(traffic.tokenReportingRequests)} reported usage` : null}
                icon="cpu"
                title="Only counts requests whose upstream reported token usage"
              />
            </div>
          </section>

          {noTargets ? (
            <div className="panel">
              <EmptyState title="No routing targets are configured" icon="server">
                The gateway is running, but no provider has an API key, model list and base URL
                configured together. Add one to <code>.env</code> and restart — see the
                {" "}<Link to="/configuration">Configuration</Link> page for exactly which variables are missing.
              </EmptyState>
            </div>
          ) : null}
        </div>

        <div className="dash-col dash-col--traffic" data-pane="traffic">
          <div className="panel dash-panel--grow">
            <div className="panel__header">
              <span className="panel__title">Requests (24h)</span>
              <div className="panel__actions">
                <Link className="btn btn--sm" to="/analytics">Analytics</Link>
              </div>
            </div>
            <div className="panel__body dash-chart">
              {trafficLoading ? (
                <TableSkeleton rows={3} label="Loading traffic" />
              ) : asList(analytics.data?.series).some((bucket) => bucket.total > 0) ? (
                <TimeSeriesChart series={analytics.data.series} height={190} title="Requests per interval" showLatency />
              ) : (
                <span className="dim small">No requests recorded in the last 24 hours.</span>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel__body dash-tops">
              <div>
                <div className="section__title">Top providers</div>
                <BarList items={analytics.data?.breakdowns?.provider} empty="No traffic yet." limit={4} />
              </div>
              <div>
                <div className="section__title">Top models</div>
                <BarList items={analytics.data?.breakdowns?.model} empty="No traffic yet." limit={4} />
              </div>
            </div>
          </div>
        </div>

        <div className="dash-col dash-col--health" data-pane="overview">
          <div className="panel dash-panel--grow">
            <div className="panel__header">
              <span className="panel__title">System Health</span>
              <div className="panel__actions">
                <Link className="btn btn--sm" to="/providers">Providers</Link>
              </div>
            </div>
            <div className="panel__body stack" style={{ gap: "var(--sp-3)" }}>
              <div>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--sp-2)" }}>
                  <span className="section__title">Targets</span>
                  <span className="tiny dim mono">
                    {summary?.healthPercent === null || summary?.healthPercent === undefined ? "n/a" : `${formatPercent(summary.healthPercent)} healthy`}
                  </span>
                </div>
                <HealthDistribution counts={summary ?? null} />
              </div>

              {healthRows.length > 0 ? (
                <ul className="dash-plist" aria-label="Provider health">
                  {healthRows.map((row) => (
                    <li key={row.provider}>
                      <button type="button" className="dash-plist__row" onClick={() => openProvider(row.provider)}>
                        <span className="dash-plist__main">
                          <span className="truncate dash-plist__name">{providerLabel(row.provider)}</span>
                          <span className="tiny dim">
                            {row.healthy}/{row.targets} healthy · {formatLatency(row.latencyMs)}
                          </span>
                        </span>
                        <HealthBadge status={row.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Next in line</span>
              <div className="panel__actions">
                <Link className="btn btn--sm" to="/fallback">Fallback chain</Link>
              </div>
            </div>
            <div className="panel__body">
              {rankedList.length === 0 ? (
                <span className="dim small">No routable target right now.</span>
              ) : (
                <ol className="dash-order">
                  {rankedList.slice(0, 4).map((target) => (
                    <li key={target.id ?? `${target.provider}/${target.model}/${target.keyIndex}`} className="dash-order__item">
                      <span className="dash-order__rank mono">{target.rank}</span>
                      <span className="truncate">
                        <span className="muted">{providerLabel(target.provider)}</span> / {target.model}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>

        <div className="dash-col dash-col--activity" data-pane="activity">
          <div className="panel dash-panel--grow">
            <div className="panel__header">
              <span className="panel__title">Recent requests</span>
              <div className="panel__actions">
                <Link className="btn btn--sm" to="/requests">Open log</Link>
              </div>
            </div>

            {recent.error ? (
              <div className="panel__body"><ErrorState error={recent.error} onRetry={recent.reload} compact /></div>
            ) : recent.loading && !recent.data ? (
              <div className="panel__body"><TableSkeleton rows={4} label="Loading recent requests" /></div>
            ) : recentEntries.length === 0 ? (
              <EmptyState title="No requests yet" icon="list">
                Traffic through the gateway will appear here as it happens.
              </EmptyState>
            ) : (
              <ul className="dash-feed" aria-label="Most recent requests through the gateway">
                {recentEntries.map((row) => (
                  <li key={row.seq}>
                    <button type="button" className="dash-feed__item" onClick={() => setSelectedRequest(row)}>
                      <span className={`dash-feed__dot dash-feed__dot--${row.outcome === "success" ? "ok" : "danger"}`} aria-hidden="true" />
                      <span className="dash-feed__main">
                        <span className="truncate dash-feed__title">
                          <span className="muted">{providerLabel(row.finalProvider)}</span> / {row.finalModel ?? EMPTY}
                        </span>
                        <span className="tiny dim">{formatRelativeTime(row.receivedAt)}</span>
                      </span>
                      <span className="dash-feed__side">
                        <StatusBadge tone={row.outcome === "success" ? "ok" : "danger"} dot={false}>
                          {row.httpStatus ?? EMPTY}
                        </StatusBadge>
                        <span className="mono tabular tiny">{formatLatency(row.latencyMs)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel dash-panel--grow">
            <div className="panel__header">
              <span className="panel__title">Recent failures</span>
              <div className="panel__actions">
                <Link className="btn btn--sm" to="/analytics">Analytics</Link>
              </div>
            </div>

            {trafficLoading ? (
              <div className="panel__body"><TableSkeleton rows={3} label="Loading failures" /></div>
            ) : failures.length === 0 ? (
              <EmptyState title="No failures recorded" icon="check">
                No request has failed in the last 24 hours.
              </EmptyState>
            ) : (
              <ul className="dash-feed" aria-label="Recent failed requests">
                {failures.slice(0, 5).map((failure) => (
                  <li key={failure.seq} className="dash-feed__item dash-feed__item--static">
                    <span className="dash-feed__dot dash-feed__dot--danger" aria-hidden="true" />
                    <span className="dash-feed__main">
                      <span className="truncate dash-feed__title">
                        <span className="muted">{providerLabel(failure.provider)}</span> / {failure.model ?? EMPTY}
                      </span>
                      <span className="tiny dim">{formatRelativeTime(failure.receivedAt)}</span>
                    </span>
                    <span className="dash-feed__side">
                      <StatusBadge tone="danger" dot={false}>{failure.category}</StatusBadge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel dash-panel--grow">
            <div className="panel__header">
              <span className="panel__title">Current fallback activity</span>
              <div className="panel__actions">
                <Link className="btn btn--sm" to="/fallback">Fallback chain</Link>
              </div>
            </div>

            {trafficLoading ? (
              <div className="panel__body"><TableSkeleton rows={3} label="Loading fallback activity" /></div>
            ) : fallbacks.length === 0 ? (
              <EmptyState title="No fallback activity" icon="layers">
                Every request in the last 24 hours was served by its first-choice target.
              </EmptyState>
            ) : (
              <ul className="dash-feed" aria-label="Requests that fell back to another eligible target">
                {fallbacks.slice(0, 5).map((item) => (
                  <li key={item.seq}>
                    <button type="button" className="dash-feed__item" onClick={() => setSelectedRequest(item)}>
                      <span className={`dash-feed__dot dash-feed__dot--${item.outcome === "success" ? "ok" : "danger"}`} aria-hidden="true" />
                      <span className="dash-feed__main">
                        <span className="truncate dash-feed__title">
                          <span className="muted">{providerLabel(item.finalProvider)}</span> / {item.finalModel ?? EMPTY}
                        </span>
                        <span className="tiny dim truncate">
                          {formatRelativeTime(item.receivedAt)} · {asList(item.attempts).map((attempt) => (attempt.ok ? "ok" : `×${attempt.status ?? "err"}`)).join(" → ")}
                        </span>
                      </span>
                      <span className="dash-feed__side">
                        <span className="mono tiny">{item.fallbackCount} hop{item.fallbackCount === 1 ? "" : "s"}</span>
                        <StatusBadge tone={item.outcome === "success" ? "ok" : "danger"} dot={false}>{item.outcome}</StatusBadge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <RequestDrawer
        entry={selectedRequest}
        open={Boolean(selectedRequest)}
        onClose={() => setSelectedRequest(null)}
      />

      <ProviderDrawer
        open={Boolean(selectedProvider)}
        onClose={() => setSelectedProvider(null)}
        id={selectedProvider?.id}
        record={selectedProvider ?? null}
      />
    </div>
  );
}
