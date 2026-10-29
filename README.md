# gearlint-verdicts

Input-testing verdict engines for browsers — pure TypeScript, zero dependencies, tested with Node's built-in test runner.

This is the threshold and classification logic behind [GearLint](https://www.gearlint.com)'s hardware tests: how a stick's resting wobble becomes a drift verdict, what counts as key chatter, when double-clicking is a fault versus fast fingers.

## Install

```bash
npm install gearlint-verdicts
```

Ships as ESM with TypeScript declarations — no dependencies, works in Node, workers and any bundler.

## What's inside

| Module | What it decides |
|---|---|
| `drift` | Stick drift verdict from sampled positions: peak deviation, drift-frame ratio, direction, plus circle-calibration scoring (sector coverage, revolution count, roundness) |
| `chatter` | Key chatter detection: per-key press rates against baselines, verdict thresholds |
| `clicks` | Double-click fault detection: inter-click gaps per button, suspicious-rate verdict, CPS window |
| `deadzone` | Dead-zone probing: rest detection, movement direction, verdict per stick |
| `wheel` | Scroll wheel health: notch counting and pass/fail |
| `reaction` | Reaction-time and aim tracking: armed-delay semantics, median reaction, accuracy |

Example — the drift verdict:

```ts
import { emptyStats, accumulateSample, judgeDrift, DEFAULT_DRIFT_THRESHOLD } from 'gearlint-verdicts';

let stats = emptyStats();
for (const sample of samples) {          // { x, y } pairs sampled from Gamepad API
  stats = accumulateSample(stats, sample, DEFAULT_DRIFT_THRESHOLD);
}
const verdict = judgeDrift(stats, DEFAULT_DRIFT_THRESHOLD);
// 'ok' | 'warn' | 'bad' | 'insufficient' | 'idle'
```

The default drift threshold is **0.08** on the Gamepad API's ±1 axis scale — a resting stick under a healthy controller produces noise well below it, while a worn potentiometer or Hall-effect fault pushes past it in the drift direction. Every constant in the codebase (`CHATTER_BAD_RATE`, `DOUBLE_CLICK_BAD_RATE`, `WHEEL_OK_NOTCHES`, …) is exported and documented at its definition.

## Design rules

- **Pure functions only.** No DOM, no Gamepad API access, no timers — callers sample the hardware and feed numbers in. This is what makes the verdicts unit-testable and reusable in Node, workers or any UI framework.
- **Constants are exported, not magic.** Every threshold is a named export so you can read, test or tune exactly what the site uses.
- **Tested at the boundaries.** 58 tests cover threshold/occupancy combinations, direction edge cases, circle-sector coverage, reverse-rotation cancellation, center-noise immunity and timing semantics — the cases you can't verify on a real controller by hand.

## Development

```bash
npm install        # typescript for typechecking only
npm test           # node --test "src/**/*.test.ts" — zero test dependencies
npm run typecheck  # tsc --noEmit
```

Tests run on Node's built-in runner (`node --test`) with native TypeScript type stripping — no test framework, no transpiler.

## Notes

- Verdicts are heuristics for triage, not lab equipment. They're good at answering "is this peripheral faulty?" quickly; for certification-grade measurement you want hardware.
- The same logic runs live at [gearlint.com](https://www.gearlint.com) — nothing is uploaded, all tests run locally in your browser.

## License

[MIT](./LICENSE)
