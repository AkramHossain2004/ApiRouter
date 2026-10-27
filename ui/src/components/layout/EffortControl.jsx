import { useState } from "react";
import { useSystemStatus } from "../../context/SystemStatusContext.jsx";
import { setEffort } from "../../api/effort.js";

/**
 * Model effort selector. One choice applies to every provider and model that
 * reasons; models that do not declare `reasoning` never receive it. Medium is
 * the default.
 */
export function EffortControl() {
  const { system, reload } = useSystemStatus();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  // Unknown (older backend, or not loaded yet): render nothing rather than guess.
  const effort = system?.effort;
  if (!effort?.levels?.length) return null;

  const value = pending ?? effort.effort;
  const current = effort.levels.find((level) => level.id === value);

  const change = async (next) => {
    setError(null);
    setPending(next);
    try {
      await setEffort(next);
      await reload();
    } catch (e) {
      setError(e?.message || "Could not change effort");
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      {error ? <span className="gateway-error" role="alert">{error}</span> : null}
      <label className="effort-control" title={error ?? current?.description}>
        <span className="effort-control__label">Effort</span>
        <select
          className="select effort-control__select"
          aria-label="Model effort"
          value={value}
          disabled={pending !== null}
          onChange={(event) => change(event.target.value)}
        >
          {effort.levels.map((level) => (
            <option key={level.id} value={level.id}>{level.label} — {level.summary}</option>
          ))}
        </select>
      </label>
    </>
  );
}
