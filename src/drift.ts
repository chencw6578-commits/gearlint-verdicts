/** 摇杆漂移检测核心逻辑（纯函数，PRD §5.1） */

export interface StickSample {
  x: number
  y: number
}

export interface StickStats {
  peak: StickSample // 采样期内绝对值最大的瞬时偏差
  peakMag: number
  samples: number
  driftFrames: number // |v| > threshold 的采样帧数
  direction: string // e.g. "X+", "Y-", "none"
}

export const DEFAULT_DRIFT_THRESHOLD = 0.08

export function emptyStats(): StickStats {
  return { peak: { x: 0, y: 0 }, peakMag: 0, samples: 0, driftFrames: 0, direction: 'none' }
}

function magnitude(s: StickSample): number {
  return Math.hypot(s.x, s.y)
}

/** 累积一帧采样，返回更新后的统计。 */
export function accumulateSample(stats: StickStats, sample: StickSample, threshold: number): StickStats {
  const mag = magnitude(sample)
  const next: StickStats = {
    peak: mag > stats.peakMag ? { ...sample } : stats.peak,
    peakMag: Math.max(stats.peakMag, mag),
    samples: stats.samples + 1,
    driftFrames: stats.driftFrames + (mag > threshold ? 1 : 0),
    direction: stats.direction,
  }
  if (mag > threshold) {
    const ax = Math.abs(sample.x) >= Math.abs(sample.y) ? (sample.x > 0 ? 'X+' : 'X-') : sample.y > 0 ? 'Y+' : 'Y-'
    next.direction = ax
  }
  return next
}

export type DriftVerdict = 'idle' | 'insufficient' | 'ok' | 'warn' | 'bad'

/**
 * 出**任何确定结论**所需的最少采样帧数（含 ok / warn / bad）。
 *
 * 为什么需要：bad 判定里 ratio > 0.15 是**比例**，没有样本量兜底时，
 * 刚开始采样的一小段就能撞出极高的比例——rAF 前 4 帧只要 2 帧超阈
 * （50%）就判 bad，而 20 帧里同样 2 帧超阈（10%）只判 warn。用户手刚
 * 放上摇杆约 67ms 就会看到 "Fault detected"，与同页 FAQ 承诺的
 * "a single flag can be noise … a fault that reproduces on two
 * separate runs is hardware" 自相矛盾。
 *
 * 取 60：60Hz 下约 1 秒采样，足够代表"用户稳定握住摇杆"的状态。
 *
 * ⚠️ 旧名 DRIFT_MIN_SAMPLES_FOR_BAD 只挡 bad，样本不足时仍会输出
 * ok / warn —— 那是**同一种过度自信的另一半**：3 帧没超阈就宣布
 * "No fault detected"，和 3 帧超阈就宣布 "Fault detected" 一样没有证据。
 * 现在这个门槛统一压住全部三种确定结论，样本不足一律 insufficient。
 */
export const DRIFT_MIN_SAMPLES = 60

/**
 * 依据采样统计判定：
 * - 采样帧数不足 DRIFT_MIN_SAMPLES → insufficient（**不下任何结论**，含"无故障"）
 * - 漂移帧占比 > 15% 且峰值 > 1.6× 阈值 → bad（持续偏移）
 * - 峰值超阈值但未达 bad 条件 → warn（偶发偏移）
 */
export function judgeDrift(stats: StickStats, threshold: number): DriftVerdict {
  if (stats.samples === 0) return 'idle'
  if (stats.samples < DRIFT_MIN_SAMPLES) return 'insufficient'
  const ratio = stats.driftFrames / stats.samples
  if (stats.peakMag > threshold * 1.6 && ratio > 0.15) return 'bad'
  if (stats.peakMag > threshold) return 'warn'
  return 'ok'
}

export interface GamepadInfo {
  id: string
  axes: number[] // [lx, ly, rx, ry, ...]
}

/** 从 Gamepad API 快照中提取双摇杆数值。 */
export function extractSticks(pad: Gamepad): GamepadInfo {
  return { id: pad.id, axes: Array.from(pad.axes).slice(0, 4) }
}

/* ------------------------------------------------------------------ */
/* 死区圆度统计（漂移圆环可视化的数据源，PRD P0）                        */
/* ------------------------------------------------------------------ */

/** 方向扇区数：一圈 8 等分。sectors=1 表示固定方向拉扯，sectors=8 表示整圈游走。 */
export const CIRCLE_SECTORS = 8

export interface CircleAccum {
  count: number
  sumR: number // 距中心距离累加（求平均偏移）
  maxR: number // 距中心最大距离
  sectorMask: number // 8 位：被采样覆盖的方向扇区
}

export interface CircleShape {
  maxR: number
  meanR: number
  sectors: number // 1–8，实际覆盖的扇区数（0 表示无采样）
}

export function emptyCircleAccum(): CircleAccum {
  return { count: 0, sumR: 0, maxR: 0, sectorMask: 0 }
}

/** 采样点所在方向扇区（0–7）：atan2 角度映射到 8 等分。 */
function angleSector(sample: StickSample): number {
  const idx = Math.round(Math.atan2(sample.y, sample.x) / (Math.PI / (CIRCLE_SECTORS / 2))) % CIRCLE_SECTORS
  return idx < 0 ? idx + CIRCLE_SECTORS : idx
}

/** 累积一帧摇杆采样到圆度统计：距离取 |v|，方向按 atan2 落入 8 扇区。 */
export function accumulateCircle(acc: CircleAccum, sample: StickSample): CircleAccum {
  const r = magnitude(sample)
  return {
    count: acc.count + 1,
    sumR: acc.sumR + r,
    maxR: Math.max(acc.maxR, r),
    sectorMask: acc.sectorMask | (1 << angleSector(sample)),
  }
}

/** 由累加器导出可视化形状（纯函数，不暴露内部字段）。 */
export function circleShape(acc: CircleAccum): CircleShape {
  let sectors = 0
  let mask = acc.sectorMask
  while (mask) {
    mask &= mask - 1
    sectors++
  }
  return {
    maxR: acc.maxR,
    meanR: acc.count > 0 ? acc.sumR / acc.count : 0,
    sectors,
  }
}

/* ------------------------------------------------------------------ */
/* 画圈校准（circle calibration，P0 竞品对齐）：转动摇杆走满圈看轨迹      */
/* ------------------------------------------------------------------ */

/** 判定所需的完整圈数（转向累计弧度 / 2π；反向转动会抵消）。 */
export const CIRCLE_MIN_REVS = 2

/** 单帧转角 ≥ 该值（rad）才视为"正在转动"。
 * 松手回中是径向运动（角度基本不变），转角 ≈ 0，不参与 minR；
 * 慢速一圈 10s 时单帧转角 ≈ 0.0105 rad，仍在阈值内，正常转动不受影响。 */
export const CIRCLE_ROT_ANGLE_EPS = 0.012

export interface CircleRun {
  /** 累计转向（弧度 / 2π），带方向；|revolutions| >= 2 才出结论 */
  revolutions: number
  maxR: number // 转动过程中最大半径
  minR: number // 转动过程中最小半径（回中死区越小越好）
  samples: number
  sectorMask: number // 8 位：转动覆盖的方向扇区
  lastAngle: number | null // 上一帧角度（计算角度增量用）
}

export function emptyCircleRun(): CircleRun {
  return { revolutions: 0, maxR: 0, minR: Number.POSITIVE_INFINITY, samples: 0, sectorMask: 0, lastAngle: null }
}

/**
 * 累积一帧画圈采样。r < 0.05 视为中心噪声：不计转向、不更新角度基线，
 * 避免静止散布把圈数算满；仍参与 maxR（行程）与扇区覆盖。
 * minR 只吸收"正在转动"（转角 ≥ CIRCLE_ROT_ANGLE_EPS）的采样——
 * 松手回中/静止贴近中心是径向运动，角度不变，不会把圆度分母拉向 0，
 * 否则健康摇杆转完一圈松手即被误判为 "Irregular"（半径波动）。
 */
export function accumulateCircleRun(run: CircleRun, sample: StickSample): CircleRun {
  const r = magnitude(sample)
  const next: CircleRun = {
    ...run,
    maxR: Math.max(run.maxR, r),
    samples: run.samples + 1,
    sectorMask: run.sectorMask | (1 << angleSector(sample)),
  }
  if (r >= 0.05 && run.lastAngle !== null) {
    let d = Math.atan2(sample.y, sample.x) - run.lastAngle
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    if (Math.abs(d) >= CIRCLE_ROT_ANGLE_EPS) {
      next.revolutions = run.revolutions + d / (2 * Math.PI)
      next.minR = Math.min(run.minR, r)
    }
  }
  if (r >= 0.05) next.lastAngle = Math.atan2(sample.y, sample.x)
  return next
}

export type CircleRunStatus = 'idle' | 'ok' | 'warn' | 'bad'

export interface CircleRunResult {
  status: CircleRunStatus
  revolutions: number
  maxR: number
  minR: number
  roundness: number // maxR/minR，≈1 越圆
  sectors: number
}

/** 圈数不足 → idle（继续转）；否则按行程 / 圆度 / 覆盖扇区判定。
 * minR 只来自"转动中"采样（见 accumulateCircleRun），因此不会再被松手回中污染。 */
export function evaluateCircleRun(run: CircleRun): CircleRunResult {
  const sectors = circleShape({ count: run.samples, sumR: 0, maxR: run.maxR, sectorMask: run.sectorMask }).sectors
  const revs = Math.abs(run.revolutions)
  const minR = Number.isFinite(run.minR) ? run.minR : 0
  const roundness = minR > 0 ? run.maxR / minR : Number.POSITIVE_INFINITY
  if (revs < CIRCLE_MIN_REVS) {
    return { status: 'idle', revolutions: revs, maxR: run.maxR, minR, roundness, sectors }
  }
  let status: CircleRunStatus = 'ok'
  if (run.maxR < 0.7) status = 'warn' // 行程不足：转不到边缘，可能卡涩或行程磨损
  else if (roundness > 1.6) status = 'bad' // 转动中半径波动大 → 电位器磨损
  else if (roundness > 1.3 || sectors < 6) status = 'warn'
  return { status, revolutions: revs, maxR: run.maxR, minR, roundness, sectors }
}
