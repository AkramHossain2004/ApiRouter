import { useState } from "react";
import { useToast } from "../../context/ToastContext.jsx";
import { splitList } from "../../api/customEndpoints.js";
import { discoverProviderModels, saveProviderModels, resetProviderModels } from "../../api/providers.js";
import { toggleModel, setManyModels, filterModels, looksLikeTextModel } from "../../lib/customEndpointForm.js";
import { MAX_PROVIDER_MODELS, diffModels, modelsProblem, describeDiff } from "../../lib/providerModels.js";
import { StatusBadge } from "../ui/StatusBadge.jsx";

/**
 * The model list of one built-in provider.
 *
 * "Fetch Models" asks the provider which models it serves (the gateway uses its
 * own key; nothing secret reaches this page). Tick the ones to keep, untick or
 * remove the ones to drop, and Save: the list replaces the provider's
 * <PROVIDER>_MODELS env list and takes effect at once. Reset goes back to the env list.
 */
export function ProviderModelsManager({ record, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [found, setFound] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [query, setQuery] = useState("");
  const [hideNonText, setHideNonText] = useState(true);
  const [saving, setSaving] = useState(false);

  const current = record.models ?? [];
  const fromPanel = record.modelsSource === "panel";
  const selected = splitList(text);
  const selectedSet = new Set(selected);
  const diff = diffModels(current, selected);
  const problem = modelsProblem(selected);
  const changeText = describeDiff(diff);

  const open = () => { setText(current.join("\n")); setFound(null); setFetchError(""); setQuery(""); setEditing(true); };
  const close = () => { setEditing(false); setFound(null); setFetchError(""); };

  const fetchModels = async () => {
    if (fetching) return;
    setFetching(true);
    setFetchError("");
    try {
      const result = await discoverProviderModels(record.id);
      setFound({ models: result.models ?? [], truncated: Boolean(result.truncated) });
      setQuery("");
    } catch (failure) {
      setFound(null);
      setFetchError(failure?.message || "Could not reach the provider");
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      await saveProviderModels(record.id, selected);
      toast.success("Model list saved", { detail: "It is live now — no restart needed." });
      close();
      onChanged?.();
    } catch (failure) {
      toast.error(failure?.message || "Could not save the model list");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await resetProviderModels(record.id);
      toast.success("Back to the environment list");
      close();
      onChanged?.();
    } catch (failure) {
      toast.error(failure?.message || "Could not reset the model list");
    } finally {
      setSaving(false);
    }
  };

  const shown = found ? filterModels(found.models, { query, hideNonText }) : [];
  const hiddenCount = found ? found.models.filter((id) => !looksLikeTextModel(id)).length : 0;
  const envModels = record.envModels ?? [];

  return (
    <section className="provider-models" aria-label={`Models of ${record.id}`} style={{ marginTop: "var(--sp-3)" }}>
      <div className="section__header">
        <span className="section__title" style={{ textTransform: "none" }}>Model list</span>
        <span className="section__actions">
          <StatusBadge tone="neutral" dot={false}>{fromPanel ? "chosen here" : "from .env"}</StatusBadge>
        </span>
      </div>

      {!editing ? (
        <div className="stack">
          <span className="tiny dim">
            {fromPanel
              ? `Using the list saved on this page (${current.length}). The environment list has ${envModels.length}.`
              : `Using ${record.envPrefix}_MODELS from the environment (${current.length}).`}
            {" "}Fetch the provider&apos;s own list to add or remove models without editing <code>.env</code>.
          </span>
          <div className="row" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={open}>Fetch &amp; edit models</button>
            {fromPanel ? (
              <button type="button" className="btn btn--ghost" onClick={reset} disabled={saving}>
                {saving ? "…" : "Reset to .env list"}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="stack">
          <div className="row" style={{ gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={fetchModels} disabled={fetching || saving}>
              {fetching ? "Fetching…" : found ? "Fetch again" : "Fetch Models"}
            </button>
            {found ? (
              <span className="tiny" role="status" style={{ color: "var(--ok, var(--text-dim))" }}>
                {found.models.length} model{found.models.length === 1 ? "" : "s"} found{found.truncated ? " (list cut short)" : ""}.
              </span>
            ) : null}
          </div>
          {fetchError ? <span className="tiny" role="alert" style={{ color: "var(--warn)" }}>{fetchError}</span> : null}
          {!found && !fetchError ? (
            <span className="field__hint">
              Asks the provider which models it serves, using the key already configured on the server. Nothing is saved until you press Save.
            </span>
          ) : null}

          {found ? (
            <div className="stack">
              <div className="row" style={{ gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="input" type="search" value={query} placeholder="Search models…" aria-label="Search models"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ maxWidth: 260 }}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button type="button" className="btn btn--sm" disabled={shown.length === 0}
                  onClick={() => setText(setManyModels(text, shown, true, MAX_PROVIDER_MODELS))}>
                  Select all shown
                </button>
                <button type="button" className="btn btn--sm btn--ghost" disabled={shown.length === 0}
                  onClick={() => setText(setManyModels(text, shown, false))}>
                  Unselect shown
                </button>
              </div>
              {hiddenCount > 0 ? (
                <label className="checkbox">
                  <input type="checkbox" checked={hideNonText} onChange={(event) => setHideNonText(event.target.checked)} />
                  Hide embedding, image and audio models ({hiddenCount})
                </label>
              ) : null}
              <div
                role="group" aria-label="Models from this provider"
                style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius, 6px)", padding: "var(--sp-2)" }}
              >
                {shown.length === 0 ? <span className="tiny dim">No models match.</span> : null}
                {shown.map((id) => (
                  <label key={id} className="checkbox mono tiny" style={{ display: "flex", overflowWrap: "anywhere" }}>
                    <input
                      type="checkbox" checked={selectedSet.has(id)}
                      disabled={!selectedSet.has(id) && selected.length >= MAX_PROVIDER_MODELS}
                      onChange={(event) => setText(toggleModel(text, id, event.target.checked))}
                    />
                    {id}
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <div className="field">
            <label className="field__label">Models to use ({selected.length})</label>
            <div
              role="list" aria-label="Selected models"
              style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1)", maxHeight: 160, overflowY: "auto" }}
            >
              {selected.length === 0 ? <span className="tiny dim">None selected.</span> : null}
              {selected.map((id) => (
                <span key={id} role="listitem" className="mono tiny" style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--border)", borderRadius: 999, padding: "1px 4px 1px 8px" }}>
                  {id}
                  <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove ${id}`} title="Remove"
                    style={{ padding: "0 6px", lineHeight: 1.2 }} onClick={() => setText(toggleModel(text, id, false))}>×</button>
                </span>
              ))}
            </div>
            <label className="field__label" htmlFor={`pm-${record.id}`} style={{ marginTop: "var(--sp-2)" }}>Add by hand</label>
            <textarea
              id={`pm-${record.id}`} className="textarea mono" rows={3} value={text}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
            <span className="field__hint">One model per line, or separated by commas (max {MAX_PROVIDER_MODELS}). Order is the order they are tried in.</span>
          </div>

          <div className="row" style={{ gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn--primary" onClick={save} disabled={Boolean(problem) || saving || !changeText}>
              {saving ? "Saving…" : "Save list"}
            </button>
            <button type="button" className="btn" onClick={close} disabled={saving}>Cancel</button>
            {fromPanel ? (
              <button type="button" className="btn btn--ghost" onClick={reset} disabled={saving}>Reset to .env list</button>
            ) : null}
            {problem ? <span className="tiny" style={{ color: "var(--warn)" }}>{problem}</span>
              : changeText ? <span className="tiny dim">{changeText}</span>
              : <span className="tiny dim">No changes yet.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
