/** 键盘连击（chatter）检测核心逻辑（纯函数，PRD §5.2） */

export interface ChatterConfig {
  /** 两次 keydown 间隔低于该毫秒数视为 chatter，默认 50ms（可选 30/50/80） */
  thresholdMs: number
}

export const DEFAULT_CHATTER_THRESHOLD = 50

export interface KeyEventRecord {
  code: string
  t: number // performance.now()
  gap: number | null // 与上一次同键 keydown 的间隔；首次为 null
  chatter: boolean
}

export interface ChatterSummary {
  events: KeyEventRecord[]
  totalPresses: number
  chatterCount: number
  lastPressByCode: Map<string, number>
  /** 因超过 MAX_CHATTER_EVENTS 被丢弃的最旧事件数（0 = 全量在内存里）。 */
  droppedEvents: number
}

/**
 * 事件环形缓冲上限 —— 内存保护，非统计口径。
 * 与 clicks.ts 的 MAX_CLICK_EVENTS 取同值：保修举证要覆盖整轮按压，
 * 阈值太小会让 UI 上的"按压数"与"总按键数"对不上，且早期数据无法举证。
 */
export const MAX_CHATTER_EVENTS = 2000

export function newChatterSummary(): ChatterSummary {
  return { events: [], totalPresses: 0, chatterCount: 0, lastPressByCode: new Map(), droppedEvents: 0 }
}

/**
 * 处理一次 keydown，返回新的 summary（不可变更新，保证 React setState 能感知变化）。
 * @param isRepeat OS 长按自动重复（e.repeat）——不计入 chatter（PRD §5.2 判定）
 */
export function recordKeydown(s: ChatterSummary, code: string, now: number, isRepeat: boolean, cfg: ChatterConfig): ChatterSummary {
  if (isRepeat) return s // 系统长按重复不参与判定
  const last = s.lastPressByCode.get(code)
  const gap = last !== undefined ? now - last : null
  const chatter = gap !== null && gap < cfg.thresholdMs
  const appended = [...s.events, { code, t: now, gap, chatter }]
  // 环形截断：只丢最旧的记录，累计计数不衰减，并记录丢弃量供 UI 提示。
  const overflow = Math.max(0, appended.length - MAX_CHATTER_EVENTS)
  const events = overflow > 0 ? appended.slice(overflow) : appended
  return {
    events,
    totalPresses: s.totalPresses + 1,
    chatterCount: s.chatterCount + (chatter ? 1 : 0),
    lastPressByCode: new Map(s.lastPressByCode).set(code, now),
    droppedEvents: s.droppedEvents + overflow,
  }
}

export function chatterRate(s: ChatterSummary): number {
  return s.totalPresses === 0 ? 0 : s.chatterCount / s.totalPresses
}

/* ---------- 连击判定：样本下限优先于占比 ---------- */

/** 判定返回态。与 ResultCard.Verdict 成员一致，局部声明以保持 tools 层无组件依赖。 */
export type ChatterVerdict = 'idle' | 'insufficient' | 'ok' | 'warn' | 'bad'

/**
 * 下确定结论所需的最小按压总数（与 diagnosis.ts 的 25 同源）。
 *
 * 原因同 DOUBLE_CLICK_MIN_CLICKS：chatter 率的分母是总按压数，2 次按压里
 * 1 次 22ms 就是 50%，远超 2% 的 bad 线，会立刻判「故障」。
 */
export const CHATTER_MIN_PRESSES = 25

/**
 * 至少要有一个键被重复按压的次数。
 *
 * chatter 的本质是"**同一个键**在极短间隔内重复触发"。总按压数再大，
 * 若分散到不同键上（25 次按压敲了 25 个不同的键），对每个键都只有 1 次
 * 样本 —— 这时根本无从判断重复，判定必须停在 insufficient。
 * 页面文案 "tap each key five to ten times" 说的也是这个数。
 */
export const CHATTER_MIN_PRESSES_PER_KEY = 5

/**
 * chatter 占比超过该值 → bad；否则单发只算 warn。
 *
 * 2% 比鼠标的 5%（DOUBLE_CLICK_BAD_RATE）更严，是**有意的**，不是两边各自拍脑袋：
 * 人手没办法在 50ms 内主动重复按同一个键，所以每出现一次标记都是强证据，
 * 门槛可以压得很低；鼠标那侧 150ms 的间隔是快速点击的常态，单发标记是弱证据，
 * 门槛必须更宽，才不至于把快手用户判成硬件故障。
 *
 * 来源性质：**工程判断**，不是实测标定，也没有厂商规格背书。
 * /guides/how-we-test 的阈值表按"行业惯例 / 工程判断 / 样本量下限"三类标明出处。
 *
 * 分母口径同 clicks.ts 的 suspiciousRate：含每键首次按压（永远不可能被标记），
 * 比率因此偏小、方向保守。
 */
export const CHATTER_BAD_RATE = 0.02

/** 内存窗口内每键按压数。窗口被截断时计数偏小，只会让判定更保守（安全方向）。 */
export function pressesPerKey(s: ChatterSummary): Map<string, number> {
  const m = new Map<string, number>()
  for (const ev of s.events) m.set(ev.code, (m.get(ev.code) ?? 0) + 1)
  return m
}

/**
 * 连击判定五态（语义与 doubleClickVerdict 一致：insufficient 同时压住 ok 与 bad）。
 */
export function chatterVerdict(s: ChatterSummary): ChatterVerdict {
  if (s.totalPresses === 0) return 'idle'
  if (s.totalPresses < CHATTER_MIN_PRESSES) return 'insufficient'
  let maxPerKey = 0
  for (const n of pressesPerKey(s).values()) if (n > maxPerKey) maxPerKey = n
  if (maxPerKey < CHATTER_MIN_PRESSES_PER_KEY) return 'insufficient'
  if (s.chatterCount === 0) return 'ok'
  return chatterRate(s) > CHATTER_BAD_RATE ? 'bad' : 'warn'
}

/** 切换阈值：对已录按键全量重算 chatter 标记与计数（数据不清空，历史按键按新阈值重新判定）。
 * 与鼠标页 applyThreshold 行为对齐——用户调阈值多为排除假阳性，旧红旗必须跟着退。 */
export function applyChatterThreshold(s: ChatterSummary, thresholdMs: number): ChatterSummary {
  let chatterCount = 0
  const events = s.events.map((ev) => {
    const chatter = ev.gap !== null && ev.gap < thresholdMs
    if (chatter) chatterCount++
    return chatter === ev.chatter ? ev : { ...ev, chatter }
  })
  return { ...s, events, chatterCount }
}

/** 页面失焦时调用：清空 lastPress 基线，避免跨窗口时间差误报（PRD §5.2 边界）。 */
export function resetBaselines(s: ChatterSummary): void {
  s.lastPressByCode.clear()
}
