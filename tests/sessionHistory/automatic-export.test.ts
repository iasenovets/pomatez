import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildSync } from "esbuild";

const [{ text }] = buildSync({
  entryPoints: [
    "./app/renderer/src/features/sessionHistory/automaticExport.ts",
  ],
  bundle: true,
  format: "esm",
  write: false,
}).outputFiles;
const { createAutomaticExporter } = await import(
  "data:text/javascript;base64," + Buffer.from(text).toString("base64")
);

const startedAt = "2026-01-02T23:59:59.000Z";
const endedAt = "2026-01-03T00:00:01.000Z";
const common = {
  schema_version: 1,
  source: "pomatez",
  device_id: "device",
  session_id: "focus",
  phase: "focus",
  task_id: null,
  recorded_at: endedAt,
};
const start = {
  ...common,
  event_id: "start",
  sequence: 1,
  record_type: "session_started",
  started_at: startedAt,
  configured_duration_ms: 3000,
  round: 1,
};
const segment = {
  ...common,
  event_id: "segment",
  sequence: 2,
  record_type: "active_segment",
  started_at: startedAt,
  ended_at: endedAt,
  observed_ended_at: endedAt,
  duration_ms: 2000,
  end_reason: "observation_gap",
  quality_flags: ["coverage_gap"],
};
const end = {
  ...common,
  event_id: "end",
  sequence: 3,
  record_type: "session_ended",
  ended_at: endedAt,
  status: "interrupted",
  end_reason: "recovered",
  quality_flags: ["recovered", "coverage_gap"],
};
const coverage = [
  {
    sessionId: "focus",
    gaps: [
      {
        from: Date.parse(endedAt),
        to: Date.parse(endedAt) + 9000,
        reason: "observation_gap",
      },
    ],
  },
];

function fixture() {
  let records: unknown[] = [
    end,
    segment,
    start,
    segment,
    { schema_version: 2 },
  ];
  const cache = new Map<string, string>();
  const writes: {
    directory: string;
    filename: string;
    contents: string;
  }[] = [];
  const deps = {
    readHistory: async () => ({ records, coverage }),
    getHash: (directory: string, date: string) =>
      cache.get(JSON.stringify([directory, date])) ?? null,
    setHash: (directory: string, date: string, hash: string) =>
      cache.set(JSON.stringify([directory, date]), hash),
    write: async (
      directory: string,
      filename: string,
      contents: string
    ) => {
      writes.push({ directory, filename, contents });
      return "saved" as const;
    },
  };
  return {
    deps,
    writes,
    setRecords: (value: unknown[]) => {
      records = value;
    },
  };
}

test("publishes stable UTC snapshots around midnight and skips unchanged days after restart", async () => {
  const { deps, writes, setRecords } = fixture();
  await createAutomaticExporter(deps)("/one");
  assert.equal(writes.length, 2);
  for (const [index, { filename, contents }] of writes.entries()) {
    const [header, ...rows] = contents
      .trimEnd()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      header.first_date,
      index === 0 ? "2026-01-02" : "2026-01-03"
    );
    assert.equal(header.reporting_timezone, "UTC");
    assert.deepEqual(rows.slice(0, 3), [start, segment, end]);
    assert.equal(rows[3].reason, "observation_gap");
    assert.equal(
      filename,
      "pomatez-auto-" +
        createHash("sha256").update(contents).digest("hex") +
        ".jsonl"
    );
  }
  setRecords([start, end, segment]);
  await createAutomaticExporter(deps)("/one");
  assert.equal(writes.length, 2);
  await createAutomaticExporter(deps)("/two");
  assert.deepEqual(
    writes.slice(2).map((file) => file.filename),
    writes.slice(0, 2).map((file) => file.filename)
  );
});

test("retries failed days, accepts existing matching files and exports updated snapshots", async () => {
  const { deps, writes, setRecords } = fixture();
  setRecords([start, segment]);
  await createAutomaticExporter(deps)("/folder");
  setRecords([start, segment, end]);
  let attempt = 0;
  const run = createAutomaticExporter({
    ...deps,
    write: async (...args: Parameters<typeof deps.write>) => {
      if (++attempt === 2) throw new Error("Directory unavailable");
      await deps.write(...args);
      return "unchanged";
    },
  });
  await assert.rejects(run("/folder"), /directory unavailable/i);
  await run("/folder");
  assert.equal(attempt, 3);
  assert.equal(writes.length, 4);
  assert.notEqual(writes[0].filename, writes[2].filename);
  await run("/folder");
  assert.equal(attempt, 3);
});

test("coalesces concurrent work and checks cancellation before publishing", async () => {
  const { deps, writes } = fixture();
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let current = true;
  const run = createAutomaticExporter({
    ...deps,
    readHistory: async () => {
      reads++;
      await wait;
      return deps.readHistory();
    },
  });
  const first = run("/one", () => current);
  const second = run("/one", () => current);
  current = false;
  release();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(writes.length, 0);
});

test("runs a replacement schedule immediately after an old write settles", async () => {
  const { deps, writes } = fixture();
  let releaseWrite: () => void = () => {};
  let enteredWrite: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });
  let oldIsCurrent = true;
  const run = createAutomaticExporter({
    ...deps,
    write: async (
      directory: string,
      filename: string,
      contents: string
    ) => {
      if (directory === "/old") {
        enteredWrite();
        await wait;
      }
      return deps.write(directory, filename, contents);
    },
  });
  const original = run("/old", () => oldIsCurrent);
  await entered;
  oldIsCurrent = false;
  const replacement = run("/new");
  releaseWrite();
  await Promise.all([original, replacement]);
  assert.deepEqual(
    writes.map((file) => file.directory),
    ["/old", "/new", "/new"]
  );
});

test("a failed snapshot does not block later UTC days", async () => {
  const { deps, writes } = fixture();
  const run = createAutomaticExporter({
    ...deps,
    write: async (
      directory: string,
      filename: string,
      contents: string
    ) => {
      const header = JSON.parse(contents.split("\n", 1)[0]);
      if (header.first_date === "2026-01-02") {
        throw new Error("Existing destination differs");
      }
      return deps.write(directory, filename, contents);
    },
  });
  await assert.rejects(
    run("/folder"),
    /2026-01-02.*Existing destination differs/
  );
  assert.equal(writes.length, 1);
  assert.equal(
    JSON.parse(writes[0].contents.split("\n", 1)[0]).first_date,
    "2026-01-03"
  );
});
