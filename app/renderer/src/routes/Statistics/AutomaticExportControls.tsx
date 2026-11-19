import React, { useState } from "react";
import { useAutomaticExport } from "../../features/sessionHistory/AutomaticExportProvider";
import { chooseAutomaticExportDirectory } from "../../features/sessionHistory/saveExport";

export default function AutomaticExportControls() {
  const { available, settings, saveSettings, status } =
    useAutomaticExport();
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");

  if (!available) return null;

  const update = (value: typeof settings) => {
    setError("");
    try {
      saveSettings(value);
    } catch {
      setError("Automatic export preferences could not be saved.");
    }
  };

  const choose = async () => {
    setError("");
    setChoosing(true);
    try {
      const directory = await chooseAutomaticExportDirectory();
      if (directory) update({ ...settings, directory });
    } catch (failure) {
      setError(
        "Could not select the export folder. " + String(failure)
      );
    } finally {
      setChoosing(false);
    }
  };

  return (
    <section aria-label="Automatic JSONL export">
      <h2>Automatic JSONL export</h2>
      <p>Save UTC daily history snapshots while Pomatez is running.</p>
      <div className="history-controls">
        <button disabled={choosing} onClick={() => void choose()}>
          {choosing ? "Choosing…" : "Choose export folder"}
        </button>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={!settings.directory || choosing}
            onChange={(event) =>
              update({ ...settings, enabled: event.target.checked })
            }
          />
          Enable automatic export
        </label>
        <label>
          Interval
          <select
            value={settings.interval}
            disabled={choosing}
            onChange={(event) => {
              const interval = Number(event.target.value);
              if (
                interval === 5 ||
                interval === 15 ||
                interval === 60
              ) {
                update({ ...settings, interval });
              }
            }}
          >
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={60}>60 minutes</option>
          </select>
        </label>
      </div>
      {settings.directory && (
        <p className="history-export-message">{settings.directory}</p>
      )}
      {(error || status.message) && (
        <p
          className="history-export-message"
          role={error || status.error ? "alert" : "status"}
        >
          {error || status.message}
        </p>
      )}
    </section>
  );
}
