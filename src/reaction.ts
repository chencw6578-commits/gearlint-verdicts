/** 反应时间测试 + 基础瞄准训练核心逻辑（纯函数，P1-9 娱乐向引流）。 */

/* ------------------------------------------------------------------ */
/* 反应时间（红→绿的间隔）：等待随机延迟后变绿，测点击反应            */
/* ------------------------------------------------------------------ */

export type ReactionPhase = 'idle' | 'waiting' | 'armed' | 'hit' | 'early'

export interface ReactionState {
  phase: ReactionPhase
  /** 本轮进入 waiting 的时刻（定时器从此时起算延迟） */
  startedAt: number | null
  /** 变绿（armed）时刻——反应时间 = click - armedAt */
  armedAt: number | null
  lastMs: number | null
  /** 最近若干次成绩（用于中位数评级，最多保留 8 条） */
  recent: number[]
}

export function newReactionState(): ReactionState {
  return { phase: 'idle', startedAt: null, armedAt: null, lastMs: null, recent: [] }
}

/** 随机等待窗口（ms）：变绿时机不可预测，防止"预判"。 */
export const REACTION_DELAY_RANGE_MS: [number, number] = [1500, 4000]

/** 进入等待：点击 Start 后由调用方在随机延迟后调 arm()。 */
export function reactionStart(s: ReactionState, now: number): ReactionState {
  return { ...s, phase: 'waiting', startedAt: now, armedAt: null, lastMs: null }
}

/** 变绿（定时器触发）。非 waiting 态忽略（防重复定时器）。 */
export function reactionArm(s: ReactionState, now: number): ReactionState {
  return s.phase === 'waiting' ? { ...s, phase: 'armed', armedAt: now } : s
}

/** 点击：armed → hit 并记录反应时间；waiting → early（抢跑，需重开）；其余忽略。 */
export function reactionClick(s: ReactionState, now: number): ReactionState {
  if (s.phase === 'armed' && s.armedAt !== null) {
    const ms = Math.max(0, Math.round(now - s.armedAt))
    return { ...s, phase: 'hit', lastMs: ms, recent: [...s.recent, ms].slice(-8) }
  }
  if (s.phase === 'waiting') return { ...s, phase: 'early' }
  return s
}

/** 最近成绩中位数（ms）；无成绩为 null。 */
export function reactionMedian(s: ReactionState): number | null {
  if (s.recent.length === 0) return null
  const sorted = [...s.recent].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

export type ReactionGrade = 'elite' | 'fast' | 'average' | 'slow'

/** 分级基准（常见参考：电竞选手均值 ~150ms，普通玩家 200–300ms）。 */
export function reactionGrade(ms: number): ReactionGrade {
  if (ms < 200) return 'elite'
  if (ms < 260) return 'fast'
  if (ms < 350) return 'average'
  return 'slow'
}

/* ------------------------------------------------------------------ */
/* 基础瞄准训练：目标随机出现 → 点击命中；30 秒一轮                   */
/* ------------------------------------------------------------------ */

export type AimPhase = 'idle' | 'running' | 'done'

export interface AimState {
  phase: AimPhase
  hits: number
  misses: number
  streak: number // 当前连击（失误清零）
  bestStreak: number
  /** 命中累计耗时（ms）：平均命中时间 = sumHitMs / hits */
  sumHitMs: number
  startedAt: number | null
  endedAt: number | null
  /**
   * **当前目标出现的时刻**。命中耗时 = now - targetAt。
   *
   * 为什么需要单独一个字段：此前用 `now - startedAt`（整轮起点）累加，
   * 于是每命中一次就把"从开局到现在"的全部时间再加一遍 —— 命中越多数值越大，
   * 与瞄准水平完全无关。实测 8 次命中、每次约 1.2s 会显示 4754 ms。
   * 目标在开局出现一次，之后每次命中立刻换新位置，所以 targetAt =
   * 上一次命中时刻（开局时 = startedAt）。
   */
  targetAt: number | null
}

export const AIM_RUN_MS = 30000
/** 命中该数即提前结束（防神枪手干等 30s）。 */
export const AIM_MAX_HITS = 30

export function newAimState(): AimState {
  return {
    phase: 'idle',
    hits: 0,
    misses: 0,
    streak: 0,
    bestStreak: 0,
    sumHitMs: 0,
    startedAt: null,
    endedAt: null,
    targetAt: null,
  }
}

export function aimStart(now: number): AimState {
  return { ...newAimState(), phase: 'running', startedAt: now, targetAt: now }
}

/**
 * 命中：记录**本目标**的出现→命中耗时，连击+1，并把 targetAt 推进到此刻
 * （下一个目标从这里开始计时）；命中数达到上限自动收尾。
 *
 * 旧状态（无 targetAt，如从 localStorage 反序列化）回退到 startedAt，
 * 语义退化为旧行为但不会崩。
 */
export function aimHit(s: AimState, now: number): AimState {
  if (s.phase !== 'running' || s.startedAt === null) return s
  const elapsed = Math.max(0, now - (s.targetAt ?? s.startedAt))
  const next: AimState = {
    ...s,
    hits: s.hits + 1,
    streak: s.streak + 1,
    bestStreak: Math.max(s.bestStreak, s.streak + 1),
    sumHitMs: s.sumHitMs + elapsed,
    targetAt: now,
  }
  return next.hits >= AIM_MAX_HITS ? { ...next, phase: 'done', endedAt: now } : next
}

/** 失误：misses+1、连击清零；只在 running 态生效。 */
export function aimMiss(s: AimState): AimState {
  return s.phase === 'running' ? { ...s, misses: s.misses + 1, streak: 0 } : s
}

/** 定时器超时收尾。 */
export function aimEnd(s: AimState, now: number): AimState {
  return s.phase === 'running' ? { ...s, phase: 'done', endedAt: now } : s
}

/** 命中率：hits / (hits + misses)；无射击为 0。 */
export function aimAccuracy(s: AimState): number {
  const total = s.hits + s.misses
  return total === 0 ? 0 : s.hits / total
}

/**
 * 平均命中耗时（ms）= 目标出现 → 命中，再对所有命中取平均。
 *
 * 这是**每次**瞄准各自花的时间，与命中次数无关（命中多不会让数字变大）。
 * 无命中为 null。
 */
export function aimAvgHitMs(s: AimState): number | null {
  return s.hits === 0 ? null : Math.round(s.sumHitMs / s.hits)
}
