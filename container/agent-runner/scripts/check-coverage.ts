/**
 * Global coverage gate for the agent-runner.
 *
 * `bun test --coverage` prints a table but, on its own, cannot fail a build on
 * a project-wide number: bunfig's `coverageThreshold` is applied PER FILE, so
 * any value above 0 fails immediately on the handful of files that are wholly
 * uncovered, and 0 gates nothing. CI was therefore running a coverage step
 * that could never fail.
 *
 * This reads the lcov report bun writes and enforces a project-wide ratchet,
 * mirroring the `thresholds` block in the host's vitest.config.ts.
 */
// Set just under the measured values (functions 82.0%, lines 82.9%) so this
// acts as a ratchet against regression rather than an aspirational target.
// Raise them when coverage genuinely improves.
const FLOORS = { functions: 80, lines: 82 };
const LCOV_PATH = new URL('../coverage/lcov.info', import.meta.url);

const report = await Bun.file(LCOV_PATH).text().catch(() => {
  throw new Error(`No lcov report at ${LCOV_PATH.pathname} — run \`bun test --coverage\` first.`);
});

const totals = { FNF: 0, FNH: 0, LF: 0, LH: 0 };
for (const line of report.split('\n')) {
  const [key, value] = line.split(':');
  if (key && key in totals) totals[key as keyof typeof totals] += Number(value) || 0;
}

if (totals.FNF === 0 || totals.LF === 0) {
  console.error('Coverage gate: lcov report contains no counted functions or lines — refusing to pass vacuously.');
  process.exit(1);
}

const actual = {
  functions: (totals.FNH / totals.FNF) * 100,
  lines: (totals.LH / totals.LF) * 100,
};

let failed = false;
for (const [metric, floor] of Object.entries(FLOORS) as Array<[keyof typeof FLOORS, number]>) {
  const value = actual[metric];
  const status = value >= floor ? 'ok  ' : 'FAIL';
  console.log(`${status} ${metric.padEnd(9)} ${value.toFixed(2)}% (floor ${floor}%)`);
  if (value < floor) failed = true;
}

if (failed) {
  console.error('\nAgent-runner coverage fell below the floor. Add tests, or lower the floor deliberately.');
  process.exit(1);
}
