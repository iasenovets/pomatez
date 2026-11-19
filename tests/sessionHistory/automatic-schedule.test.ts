import assert from "node:assert/strict";
import test from "node:test";
import { startAutomaticExport } from "../../app/renderer/src/features/sessionHistory/automaticSchedule.ts";

test("starts immediately, skips overlapping runs, and stops scheduling after disposal", async () => {
  let tick = () => {};
  let cancelled = false;
  let complete!: () => void;
  const runs: Array<() => boolean> = [];
  const stop = startAutomaticExport(
    15,
    (isCurrent) => {
      runs.push(isCurrent);
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    (run, ms) => {
      assert.equal(ms, 900_000);
      tick = run;
      return () => {
        cancelled = true;
      };
    }
  );
  assert.equal(runs.length, 1);
  tick();
  assert.equal(runs.length, 1);
  complete();
  await Promise.resolve();
  tick();
  assert.equal(runs.length, 2);
  stop();
  assert.equal(cancelled, true);
  assert.equal(runs[1](), false);
  complete();
  await Promise.resolve();
  tick();
  assert.equal(runs.length, 2);
});

test("uses the configured 5, 15, and 60 minute intervals", () => {
  for (const minutes of [5, 15, 60] as const) {
    const cancel = startAutomaticExport(
      minutes,
      async () => {},
      (_run, delay) => {
        assert.equal(delay, minutes * 60_000);
        return () => {};
      }
    );
    cancel();
  }
});
