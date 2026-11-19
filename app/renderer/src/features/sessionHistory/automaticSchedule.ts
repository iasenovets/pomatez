export type ExportInterval = 5 | 15 | 60;

export function startAutomaticExport(
  interval: ExportInterval,
  run: (isCurrent: () => boolean) => Promise<void>,
  schedule: (run: () => void, milliseconds: number) => () => void
) {
  let current = true;
  let running = false;
  const isCurrent = () => current;

  const tick = () => {
    if (!current || running) return;
    running = true;
    void run(isCurrent).finally(() => {
      running = false;
    });
  };
  const cancel = schedule(tick, interval * 60_000);
  tick();
  return () => {
    current = false;
    cancel();
  };
}
