/**
 * 摇杆死区探测核心逻辑（纯函数）。
 *
 * 测量对象是**有效死区**：从摇杆物理中位到「输出开始变化」为止的行程。
 * 浏览器拿不到电位计原始读数，只能读 OS 上报的轴值，所以这里的死区
 * 由两部分组成：
 *
 *   有效死区 ≈ 漂移偏置（静置时已偏离中位的幅值） + 物理静默行程
 *
 * 探测流程（状态机，tickProbe 每帧推进）：
 *   rest → 用户静置摇杆，采集中位数作为基线（静置幅值即漂移偏置）；
 *   push → 提示用户缓慢推向边缘；输出停留在基线 ±QUIET_EPS 内的帧
 *          记录最大绝对幅值 maxQuiet；一旦出现连续 MOVE_FRAMES 帧的
 *          持续偏移（超过 MOVE_EPS），判定输出已开始响应，冻结结果。
 *
 * 为什么用「持续 N 帧」而不是单帧越限：单帧噪声（手抖、采样毛刺）
 * 会让探测在推程一开始就误判"已响应"，死区被低估；连续帧要求把
 * 这种毛刺挡掉，与 drift.ts 的 DRIFT_MIN_SAMPLES 同一思路。
 */
import type { StickSample } from './drift'

/** 静置窗口：基线采样时长。1.5s 足够滤掉手放上去的初始抖动。 */
export const REST_MS = 1500
/** 输出与基线偏差 ≤ QUIET_EPS 视为「还没响应」。 */
export const QUIET_EPS = 0.01
/** 偏差超过 MOVE_EPS 才可能算作响应。 */
export const MOVE_EPS = 0.015
/** 连续 N 帧超 MOVE_EPS 才判定响应开始。 */
export const MOVE_FRAMES = 6
/** 静置窗口内最大波动：超过说明手没稳住，基线不可信，重新计时。 */
export const REST_STABLE_EPS = 0.025

export type ProbePhase = 'idle' | 'rest' | 'push' | 'done'

export interface ProbeResult {
  /** 探测的摇杆。 */
  stick: 'L' | 'R'
  /** 推移方向：以基线为原点的位移角，八向。 */
  direction: string
  /** 有效死区：静默期达到的最大绝对幅值（含漂移偏置）。 */
  deadzone: number
  /** 漂移偏置：基线幅值。 */
  driftOffset: number
  /** 物理静默行程：deadzone - driftOffset。 */
  travel: number
}

export interface ProbeState {
  phase: ProbePhase
  stick: 'L' | 'R'
  baseline: StickSample
  restStart: number
  maxQuiet: number
  moveFrames: number
  result: ProbeResult | null
}

export function newProbe(stick: 'L' | 'R', now: number): ProbeState {
  return { phase: 'rest', stick, baseline: { x: 0, y: 0 }, restStart: now, maxQuiet: 0, moveFrames: 0, result: null }
}

/** 位移向量 → 八向标签。屏幕坐标 y 向下为正，上推是 -y，所以 N 取 y<0。 */
export function directionOf(dx: number, dy: number): string {
  if (Math.hypot(dx, dy) < 1e-6) return '—'
  const deg = (Math.atan2(-dy, dx) * 180) / Math.PI // 数学角：x 正向为 0°，逆时针为正
  const oct = Math.round(((deg + 360) % 360) / 45) % 8
  return ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][oct]
}

/** 推进一帧探测。phase 变为 done 时 result 落定；其余帧返回更新后的状态。 */
export function tickProbe(s: ProbeState, v: StickSample, now: number): ProbeState {
  if (s.phase === 'idle' || s.phase === 'done') return s

  if (s.phase === 'rest') {
    const dx = v.x - s.baseline.x
    const dy = v.y - s.baseline.y
    if (Math.hypot(dx, dy) > REST_STABLE_EPS) {
      // 手没稳住：以当前帧为新基线重新计时，静置窗口从头来
      return { ...s, baseline: { ...v }, restStart: now, maxQuiet: 0, moveFrames: 0 }
    }
    if (now - s.restStart >= REST_MS) {
      return { ...s, phase: 'push', maxQuiet: Math.hypot(v.x, v.y), moveFrames: 0 }
    }
    return s
  }

  // push：静默帧记录最大幅值；持续偏移 → 响应开始，冻结
  const dev = Math.hypot(v.x - s.baseline.x, v.y - s.baseline.y)
  const mag = Math.hypot(v.x, v.y)
  if (dev <= QUIET_EPS) {
    return { ...s, maxQuiet: Math.max(s.maxQuiet, mag), moveFrames: 0 }
  }
  const moveFrames = dev > MOVE_EPS ? s.moveFrames + 1 : 0
  if (moveFrames >= MOVE_FRAMES) {
    const driftOffset = Math.hypot(s.baseline.x, s.baseline.y)
    return {
      ...s,
      phase: 'done',
      moveFrames,
      result: {
        stick: s.stick,
        direction: directionOf(v.x - s.baseline.x, v.y - s.baseline.y),
        deadzone: s.maxQuiet,
        driftOffset,
        travel: Math.max(0, s.maxQuiet - driftOffset),
      },
    }
  }
  return { ...s, moveFrames }
}

export type DeadzoneVerdict = 'ok' | 'warn' | 'bad'

/**
 * 有效死区判定（与首页漂移阈值同一口径）：
 * - ≤0.05 紧凑：低于所有常见游戏默认死区；
 * - ≤0.10 松旷：游戏默认死区（约 0.08）能盖住，但摇杆已偏离出厂状态；
 * - >0.10 明显：部分游戏能感到瞄准发飘，该修就修。
 * 物理行程（travel）单独看：travel 大而 driftOffset 小是中心区磨损；
 * 反之是漂移问题，去漂移页处理。
 */
export function judgeDeadzone(effective: number): DeadzoneVerdict {
  if (effective <= 0.05) return 'ok'
  if (effective <= 0.1) return 'warn'
  return 'bad'
}

/** 多次探测取信：同方向重复探测里取最大值（慢推收敛，快推低估）。 */
export function worstOf(results: ProbeResult[], stick: 'L' | 'R', direction: string): ProbeResult | undefined {
  const same = results.filter((r) => r.stick === stick && r.direction === direction)
  if (same.length === 0) return undefined
  return same.reduce((a, b) => (b.deadzone > a.deadzone ? b : a))
}
