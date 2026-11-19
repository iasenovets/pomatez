import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { createAutomaticExporter } from "./automaticExport";
import { startAutomaticExport } from "./automaticSchedule";
import type { ExportInterval } from "./automaticSchedule";
import { Repository } from "./repository";
import {
  automaticExportAvailable,
  writeAutomaticExport,
} from "./saveExport";

const settingsKey = "pomatez.automatic-history-export";

type Settings = {
  directory: string | null;
  enabled: boolean;
  interval: ExportInterval;
};

function readSettings(): Settings {
  try {
    const value = JSON.parse(
      localStorage.getItem(settingsKey) ?? "null"
    );
    if (
      value &&
      (value.directory === null ||
        typeof value.directory === "string") &&
      typeof value.enabled === "boolean" &&
      (value.interval === 5 ||
        value.interval === 15 ||
        value.interval === 60)
    )
      return value;
  } catch {
    // Automatic export requires readable, explicitly enabled preferences.
  }
  return { directory: null, enabled: false, interval: 15 };
}

const hashes = new Map<string, string>();
const exportHistory = createAutomaticExporter({
  async readHistory() {
    const repository = await Repository.open(
      indexedDB,
      "pomatez-session-history"
    );
    try {
      return await repository.readHistory();
    } finally {
      repository.close();
    }
  },
  write: writeAutomaticExport,
  getHash: (directory, date) =>
    hashes.get(JSON.stringify([directory, date])) ?? null,
  setHash: (directory, date, hash) =>
    hashes.set(JSON.stringify([directory, date]), hash),
});

type ExportStatus = { message: string; error: boolean };
const idle: ExportStatus = { message: "", error: false };

const AutomaticExportContext = createContext({
  settings: readSettings(),
  status: idle,
  available: false,
  saveSettings: (_value: Settings) => {},
});

export function AutomaticExportProvider({
  children,
}: React.PropsWithChildren<{}>) {
  const [settings, setSettings] = useState(readSettings);
  const [status, setStatus] = useState(idle);
  const available = automaticExportAvailable();

  function saveSettings(value: Settings) {
    localStorage.setItem(settingsKey, JSON.stringify(value));
    setSettings(value);
  }

  useEffect(() => {
    setStatus(idle);
    const { directory, enabled, interval } = settings;
    if (!enabled || !directory || !available) return;
    return startAutomaticExport(
      interval,
      async (isCurrent) => {
        try {
          await exportHistory(directory, isCurrent);
          if (isCurrent())
            setStatus({
              message: "Automatic export check complete.",
              error: false,
            });
        } catch (error) {
          if (isCurrent()) {
            setStatus({
              message:
                "Automatic export failed. Check the folder and its permissions. " +
                String(error),
              error: true,
            });
          }
        }
      },
      (run, ms) => {
        const timer = window.setInterval(run, ms);
        return () => window.clearInterval(timer);
      }
    );
  }, [available, settings]);

  return (
    <AutomaticExportContext.Provider
      value={{ settings, status, available, saveSettings }}
    >
      {children}
    </AutomaticExportContext.Provider>
  );
}

export function useAutomaticExport() {
  return useContext(AutomaticExportContext);
}
