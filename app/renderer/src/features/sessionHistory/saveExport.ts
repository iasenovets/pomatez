import { invoke } from "@tauri-apps/api/core";

export async function saveExport(filename: string, contents: string) {
  if (window.electron?.saveHistoryJsonl) {
    return window.electron.saveHistoryJsonl(filename, contents);
  }
  const path = await invoke<string>("save_history_jsonl", {
    filename,
    contents,
  });
  return { status: "saved" as const, path };
}

export function automaticExportAvailable() {
  return Boolean(
    (window.electron?.chooseHistoryExportDirectory &&
      window.electron?.writeAutomaticHistoryExport) ||
      window.__TAURI__
  );
}

export function chooseAutomaticExportDirectory() {
  if (window.electron?.chooseHistoryExportDirectory) {
    return window.electron.chooseHistoryExportDirectory();
  }
  return invoke<string | null>("choose_history_export_directory");
}

export function writeAutomaticExport(
  directory: string,
  filename: string,
  contents: string
) {
  if (window.electron?.writeAutomaticHistoryExport) {
    return window.electron.writeAutomaticHistoryExport(
      directory,
      filename,
      contents
    );
  }
  return invoke<"saved" | "unchanged">(
    "write_automatic_history_export",
    {
      directory,
      filename,
      contents,
    }
  );
}
