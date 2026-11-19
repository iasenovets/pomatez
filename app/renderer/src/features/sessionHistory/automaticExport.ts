import { Temporal } from "@js-temporal/polyfill";
import { makeExport } from "./export";
import { decode } from "./summary";

type Dependencies = {
  readHistory: () => Promise<{
    records: readonly unknown[];
    coverage: readonly unknown[];
  }>;
  write: (
    directory: string,
    filename: string,
    contents: string
  ) => Promise<"saved" | "unchanged">;
  getHash: (directory: string, date: string) => string | null;
  setHash: (directory: string, date: string, hash: string) => void;
};

const dayMs = 86_400_000;
const maxExportBytes = 32 * 1024 * 1024;

function indexHistory(
  records: readonly unknown[],
  coverage: readonly unknown[]
) {
  const bySession = new Map<string, { rows: unknown[]; id: string }>();
  const byDay = new Map<number, Set<string>>();
  const byCoverageId = new Map<string, unknown[]>();
  for (const record of records) {
    const event = decode(record);
    if (!event) continue;
    const row = record as {
      session_id: string;
      started_at: string;
    };
    const session = bySession.get(event.session) ?? {
      id: row.session_id,
      rows: [],
    };
    session.rows.push(record);
    bySession.set(event.session, session);

    const first = Math.floor(
      (event.kind === "start"
        ? Date.parse(row.started_at)
        : event.kind === "segment"
        ? event.start
        : event.end) / dayMs
    );
    // Segments ending at midnight contribute only to the previous day.
    const last =
      event.kind === "segment"
        ? Math.floor((event.end - 1) / dayMs)
        : first;
    if (last - first > 366) {
      throw new Error(
        "A history segment spans too many days for automatic export"
      );
    }
    for (let day = first; day <= last; day++) {
      const keys = byDay.get(day) ?? new Set<string>();
      keys.add(event.session);
      byDay.set(day, keys);
    }
  }
  for (const row of coverage) {
    if (!row || typeof row !== "object" || !("sessionId" in row))
      continue;
    const { sessionId } = row;
    if (typeof sessionId !== "string") continue;
    const entries = byCoverageId.get(sessionId) ?? [];
    entries.push(row);
    byCoverageId.set(sessionId, entries);
  }
  return { byDay, bySession, byCoverageId };
}

export function createAutomaticExporter(deps: Dependencies) {
  let active:
    | {
        directory: string;
        isCurrent: () => boolean;
        promise: Promise<void>;
      }
    | undefined;
  async function publish(directory: string, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    const history = await deps.readHistory();
    if (!isCurrent()) return;
    const { byDay, bySession, byCoverageId } = indexHistory(
      history.records,
      history.coverage
    );
    const encoder = new TextEncoder();
    const failures: string[] = [];
    for (const day of Array.from(byDay.keys()).sort((a, b) => a - b)) {
      if (!isCurrent()) return;
      const date = new Date(day * dayMs).toISOString().slice(0, 10);
      try {
        const sessions = Array.from(
          byDay.get(day)!,
          (key) => bySession.get(key)!
        );
        const ids = new Set(sessions.map((session) => session.id));
        const file = makeExport(
          sessions.flatMap((session) => session.rows),
          Array.from(ids).flatMap((id) => byCoverageId.get(id) ?? []),
          {
            date: Temporal.PlainDate.from(date),
            range: "day",
            zone: "UTC",
          }
        );
        if (!file.eventCount) continue;
        const bytes = encoder.encode(file.contents);
        if (bytes.length > maxExportBytes) {
          throw new Error("Snapshot exceeds 32 MiB");
        }
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes)
        );
        const hash = Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
        if (!isCurrent()) return;
        if (deps.getHash(directory, date) === hash) continue;
        await deps.write(
          directory,
          `pomatez-auto-${hash}.jsonl`,
          file.contents
        );
        deps.setHash(directory, date, hash);
      } catch (error) {
        failures.push(
          date +
            " — " +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
    if (failures.length) {
      const otherDays = failures.length - 1;
      throw new Error(
        failures[0] + (otherDays ? ` (+${otherDays} other days)` : "")
      );
    }
  }
  return async (directory: string, isCurrent = () => true) => {
    while (isCurrent() && active) {
      if (active.directory === directory && active.isCurrent()) {
        return active.promise;
      }
      // A stopped schedule can still have a native write in flight.
      // Let it settle without sharing its result with the replacement.
      await active.promise.catch(() => {});
    }
    if (!isCurrent()) return;
    const promise = publish(directory, isCurrent).finally(() => {
      active = undefined;
    });
    active = { directory, isCurrent, promise };
    return promise;
  };
}
