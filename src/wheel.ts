/** 滚轮测试（通用方案）：只做双向 notch 计数与"能用"判定，不做编码器诊断。 */

export interface WheelState {
  up: number
  down: number
  /** 最近一次方向：-1 上 / 1 下 / null 尚未滚动（驱动图上箭头与滚轮动画）。 */
  lastDir: -1 | 1 | null
  /** 事件序号（每次滚动 +1，用于重放 CSS 动画）。 */
  seq: number
}

/** 通用通过标准：上、下各 ≥3 格。 */
export const WHEEL_OK_NOTCHES = 3

export function newWheelState(): WheelState {
  return { up: 0, down: 0, lastDir: null, seq: 0 }
}

/**
 * 记录一次滚轮事件。
 *
 * deltaY === 0 时**原样返回、不计数**：横向手势滚动（deltaX≠0 / deltaY=0）、
 * 触控板 inertia 的首个事件、部分浏览器对 wheel 的补发，都会送来 deltaY=0。
 * 原实现把它们一律计入 down，测试者只想验证"下滚能不能用"却会看到
 * down 自己上涨，攒够 WHEEL_OK_NOTCHES 格就判 ok —— 等于没测就通过。
 * 横向滚动不是"向下滚"，不该推进方向计数。
 */
export function recordWheel(s: WheelState, deltaY: number): WheelState {
  if (deltaY === 0) return s
  if (deltaY < 0) return { up: s.up + 1, down: s.down, lastDir: -1, seq: s.seq + 1 }
  return { up: s.up, down: s.down + 1, lastDir: 1, seq: s.seq + 1 }
}

export type WheelVerdict = 'idle' | 'counting' | 'ok'

export function wheelCheck(w: WheelState): { verdict: WheelVerdict; up: number; down: number } {
  if (w.up + w.down === 0) return { verdict: 'idle', up: w.up, down: w.down }
  if (w.up >= WHEEL_OK_NOTCHES && w.down >= WHEEL_OK_NOTCHES) return { verdict: 'ok', up: w.up, down: w.down }
  return { verdict: 'counting', up: w.up, down: w.down }
}
