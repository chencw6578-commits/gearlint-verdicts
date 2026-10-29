/**
 * gearlint-verdicts — static entry point.
 * Re-exports the input-testing verdict engines: stick drift, key chatter,
 * mouse double-click, dead zone, scroll wheel and reaction/aim timing.
 */

// Stick drift
export {
  DEFAULT_DRIFT_THRESHOLD,
  DRIFT_MIN_SAMPLES,
  emptyStats,
  accumulateSample,
  judgeDrift,
  extractSticks,
  CIRCLE_SECTORS,
  emptyCircleAccum,
  accumulateCircle,
  circleShape,
  CIRCLE_MIN_REVS,
  CIRCLE_ROT_ANGLE_EPS,
  emptyCircleRun,
  accumulateCircleRun,
  evaluateCircleRun,
} from './drift.js';
export type { StickSample, StickStats } from './drift.js';

// Key chatter
export {
  DEFAULT_CHATTER_THRESHOLD,
  MAX_CHATTER_EVENTS,
  newChatterSummary,
  recordKeydown,
  chatterRate,
  CHATTER_MIN_PRESSES,
  CHATTER_MIN_PRESSES_PER_KEY,
  CHATTER_BAD_RATE,
  pressesPerKey,
  chatterVerdict,
  applyChatterThreshold,
  resetBaselines,
} from './chatter.js';

// Mouse double-click / CPS
export {
  DOUBLE_CLICK_BUG_MS,
  THRESHOLD_OPTIONS_MS,
  MAX_CLICK_EVENTS,
  newClickSummary,
  recordMousedown,
  applyThreshold,
  suspiciousRate,
  DOUBLE_CLICK_MIN_CLICKS,
  DOUBLE_CLICK_BAD_RATE,
  doubleClickVerdict,
  perButtonGaps,
  perButtonGapsWithMeta,
  CPS_DURATION_MS,
} from './clicks.js';

// Dead zone
export {
  REST_MS,
  QUIET_EPS,
  MOVE_EPS,
  MOVE_FRAMES,
  REST_STABLE_EPS,
  newProbe,
  directionOf,
  tickProbe,
  judgeDeadzone,
  worstOf,
} from './deadzone.js';

// Scroll wheel
export {
  WHEEL_OK_NOTCHES,
  newWheelState,
  recordWheel,
  wheelCheck,
} from './wheel.js';

// Reaction time & aim
export {
  newReactionState,
  REACTION_DELAY_RANGE_MS,
  reactionStart,
  reactionArm,
  reactionClick,
  reactionMedian,
  reactionGrade,
  AIM_RUN_MS,
  AIM_MAX_HITS,
  newAimState,
  aimStart,
  aimHit,
  aimMiss,
  aimEnd,
  aimAccuracy,
  aimAvgHitMs,
} from './reaction.js';
