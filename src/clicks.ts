/** 鼠标双击异常 + CPS 检测核心逻辑（纯函数，PRD §5.3） */

export const DOUBLE_CLICK_BUG_MS = 100 // 同键两次 mousedown 间隔低于该值 → 疑似弹片抖动（默认档）

/** 灵敏度三档：80 严格（零误报，保修举证）/ 100 标准 / 150 灵敏（抓早期磨损征兆）。 */
export const THRESHOLD_OPTIONS_MS = [80, 100, 150] as const

export interface ClickEventRecord {
  button: number
  t: number
  gap: number | null
  suspicious: boolean
}

export interface ClickSummary {
  events: ClickEventRecord[]
  totalClicks: number
  suspiciousCount: number
  lastByButton: Map<number, number>
  /** 因超过 MAX_CLICK_EVENTS 被丢弃的最旧事件数（0 = 全量在内存里）。 */
  droppedEvents: number
}

/**
 * 事件环形缓冲上限 —— 内存保护，非统计口径。
 *
 * 为什么需要：一次测试点几千次很常见（用户会认真点），无限累积会让
 * 每次 setClicks 都复制一个越来越大的数组，页面会肉眼可见地变卡。
 *
 * 为什么放大到 2000：保修举证场景的核心诉求是"证明第 N 次到第 M 次
 * 间隔异常"，截断阈值直接决定举证链条能覆盖多少次按压。400 太激进
 * —— 用户点 600 次就只能证明最近 400 次，前 200 次的数据 UI 上完全
 * 取不到，而 totalClicks 仍显示 600，两个数字对不上。
 * 2000 条事件对象约 200KB 量级，对内存完全无害，却能覆盖绝大多数
 * 整轮测试；真超了由 perButtonGaps 的 truncated 标记诚实告知用户
 * "统计窗口已截断"，而不是静默给一个偏小的数字。
 */
export const MAX_CLICK_EVENTS = 2000

export function newClickSummary(): ClickSummary {
  return { events: [], totalClicks: 0, suspiciousCount: 0, lastByButton: new Map(), droppedEvents: 0 }
}

/** 处理一次 mousedown，返回新的 summary（不可变更新，保证 React setState 能感知变化）。 */
export function recordMousedown(s: ClickSummary, button: number, now: number, thresholdMs: number = DOUBLE_CLICK_BUG_MS): ClickSummary {
  const last = s.lastByButton.get(button)
  const gap = last !== undefined ? now - last : null
  const suspicious = gap !== null && gap < thresholdMs
  const appended = [...s.events, { button, t: now, gap, suspicious }]
  // 环形截断：只丢最旧的记录，累计计数不衰减（totalClicks 永远是真值），
  // 并记录丢弃量供 UI 提示"统计窗口已截断"。
  const overflow = Math.max(0, appended.length - MAX_CLICK_EVENTS)
  const events = overflow > 0 ? appended.slice(overflow) : appended
  return {
    events,
    totalClicks: s.totalClicks + 1,
    suspiciousCount: s.suspiciousCount + (suspicious ? 1 : 0),
    lastByButton: new Map(s.lastByButton).set(button, now),
    droppedEvents: s.droppedEvents + overflow,
  }
}

/** 切换阈值：对已录事件全量重算 suspicious 标记与计数（数据不清空，历史点击按新阈值重新判定）。 */
export function applyThreshold(s: ClickSummary, thresholdMs: number): ClickSummary {
  let suspiciousCount = 0
  const events = s.events.map((ev) => {
    const suspicious = ev.gap !== null && ev.gap < thresholdMs
    if (suspicious) suspiciousCount++
    return suspicious === ev.suspicious ? ev : { ...ev, suspicious }
  })
  return { ...s, events, suspiciousCount }
}

/**
 * 可疑占比 = suspiciousCount / totalClicks。
 *
 * ⚠️ 分母口径：**全部按压数，含每个按键的第一次按压**。首次按压没有上一次
 * 可比（gap = null），因此永远不可能被标记为 suspicious，却仍留在分母里。
 * 结果是这个比率比"flags ÷ 可比较按压数"略小 —— **偏保守**，即更不容易判 bad。
 *
 * 这是有意保留的，不是漏改：把首次按压剔出分母会让比率变大、误报变多，
 * 而对一个"告诉用户硬件坏了"的工具来说，误报的代价（白跑保修、白换件）
 * 大于漏报。口径已在 /guides/how-we-test 明写，用户可自行复算。
 */
export function suspiciousRate(s: ClickSummary): number {
  return s.totalClicks === 0 ? 0 : s.suspiciousCount / s.totalClicks
}

/* ---------- 双击判定：样本下限优先于占比 ---------- */

/** 判定返回态。与 ResultCard.Verdict 成员一致，局部声明以保持 tools 层无组件依赖。 */
export type ClickVerdict = 'idle' | 'insufficient' | 'ok' | 'warn' | 'bad'

/**
 * 下确定结论所需的最小点击数。
 *
 * 为什么必须有：占比是比率，小样本下分母极小 —— 3 次点击里 1 次间隔 40ms
 * 就是 33%，一脚踩过 5% 的 bad 线直接判「故障」；而同样的 1 次异常放在
 * 20 次里是 5%，才勉强算得上"持续 pattern"的证据。
 *
 * 更早的写法让结果卡在 3 次点击时就显示 Fault detected，而同一页的
 * /guides/how-we-test 承诺"每个页面在给出判定前都要求最低数据量"——
 * 没有这个下限，结果卡当着用户的面违背自家承诺。
 *
 * 20 与 diagnosis.ts 的 "recommended 20+ clicks" 同源，两处必须一起改。
 */
export const DOUBLE_CLICK_MIN_CLICKS = 20

/**
 * suspicious 占比超过该值 → bad（持续 pattern = 微动磨损），否则单发只算 warn。
 *
 * 5% 比键盘的 2%（CHATTER_BAD_RATE）更宽，原因见 CHATTER_BAD_RATE 的注释：
 * 鼠标侧"间隔过短"在快速点击时本来就会自然出现，单发标记的证据强度低于键盘
 * chatter，门槛必须更宽，否则快手用户会被判成硬件故障。
 *
 * 来源性质：**工程判断**，非实测标定。/guides/how-we-test 已标明。
 */
export const DOUBLE_CLICK_BAD_RATE = 0.05

/**
 * 双击判定五态：
 * - idle         完全没有数据
 * - insufficient 有数据但不足 20 次，**不下任何确定结论**（含"无故障"）
 * - ok / warn / bad 样本达标后才给出
 *
 * 注意 insufficient 也压住了 ok：3 次点击没异常同样证明不了开关健康，
 * 显示 "No fault detected" 与显示 "Fault detected" 是同一种过度自信。
 */
export function doubleClickVerdict(s: ClickSummary): ClickVerdict {
  if (s.totalClicks === 0) return 'idle'
  if (s.totalClicks < DOUBLE_CLICK_MIN_CLICKS) return 'insufficient'
  if (s.suspiciousCount === 0) return 'ok'
  return suspiciousRate(s) > DOUBLE_CLICK_BAD_RATE ? 'bad' : 'warn'
}

/* ---------- 每按键间隔统计（P1-8：min/avg/max/last gap，保修举证更硬） ---------- */

export interface ButtonGapStats {
  button: number
  presses: number
  /** 同键相邻两次按压的最小间隔（ms）；不足 2 次按压为 null */
  minGap: number | null
  /** 同键相邻间隔平均值（ms）；间隔数 = 按压数 - 1 */
  avgGap: number | null
  maxGap: number | null
  lastGap: number | null
  suspicious: number
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/**
 * 按按键汇总间隔统计（min / avg / max / last）。
 * 间隔基于 recordMousedown 已记录的 gap；首次按压无 gap，不计入平均与极值。
 * 保修场景：maxGap 异常（按键"粘住"）与 minGap 过小（弹跳）都能单独举证。
 *
 * 口径说明：presses 统计的是**内存窗口内**的按压数（上限 MAX_CLICK_EVENTS）。
 * 一旦总点击数超过上限，presses 会小于 totalClicks —— 这时用 droppedEvents > 0
 * 判断并由 UI 明确提示"统计窗口已截断"，避免用户把窗口内数字误当成全量。
 */
export function perButtonGaps(s: ClickSummary): ButtonGapStats[] {
  const map = new Map<number, { sum: number; min: number; max: number; last: number | null; presses: number; suspicious: number }>()
  for (const ev of s.events) {
    let a = map.get(ev.button)
    if (!a) {
      a = { sum: 0, min: Number.POSITIVE_INFINITY, max: 0, last: null, presses: 0, suspicious: 0 }
      map.set(ev.button, a)
    }
    a.presses++
    if (ev.suspicious) a.suspicious++
    if (ev.gap !== null) {
      a.sum += ev.gap
      if (ev.gap < a.min) a.min = ev.gap
      if (ev.gap > a.max) a.max = ev.gap
      a.last = ev.gap
    }
  }
  return [...map.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([button, a]) => ({
      button,
      presses: a.presses,
      minGap: a.presses > 1 ? round1(a.min) : null,
      avgGap: a.presses > 1 ? round1(a.sum / (a.presses - 1)) : null,
      maxGap: a.presses > 1 ? round1(a.max) : null,
      lastGap: a.last !== null ? round1(a.last) : null,
      suspicious: a.suspicious,
    }))
}

/** 每按键统计 + 截断信息（供 UI 同屏展示，避免两个数字对不上时无处解释）。 */
export interface PerButtonGapsResult {
  stats: ButtonGapStats[]
  /** true = 总点击数已超过 MAX_CLICK_EVENTS，stats 里的 presses 只覆盖最近一段。 */
  truncated: boolean
  /** 被丢弃的最旧事件数；0 = 全量在内存里。 */
  dropped: number
  /** 内存窗口容量（MAX_CLICK_EVENTS）。 */
  windowSize: number
  /** 全量按压数（= s.totalClicks，永不衰减）。 */
  totalPresses: number
}

export function perButtonGapsWithMeta(s: ClickSummary): PerButtonGapsResult {
  return {
    stats: perButtonGaps(s),
    truncated: s.droppedEvents > 0,
    dropped: s.droppedEvents,
    windowSize: MAX_CLICK_EVENTS,
    totalPresses: s.totalClicks,
  }
}

/* ---------- CPS 计时器 ---------- */

export interface CpsState {
  running: boolean
  clicks: number
  startedAt: number | null
  durationMs: number
}

export const CPS_DURATION_MS = 5000

/** 支持的 CPS 测试时长（秒）。默认 1s——CPS 即每秒点击数，1 秒窗口结果最直观。 */
export const CPS_DURATION_OPTIONS_MS = [1000, 2000, 5000, 10000]

export function cpsStart(now: number, durationMs: number = CPS_DURATION_MS): CpsState {
  return { running: true, clicks: 0, startedAt: now, durationMs }
}

/* ---------- CPS 计时器（纯函数参考实现） ----------
 *
 * ⚠️ 当前状态：**未被页面引用**。MouseTest.tsx 的 CPS 区（onCpsPadDown +
 * setInterval）自己内联实现了同一套状态机，用 cpsPhase 这个 React state
 * 表示"窗口是否已关闭"，因此不受下面 cpsTick 的边界问题影响。
 *
 * 保留原因：cpsFromClicks / cpsGrade 被页面复用，本组是同一功能的完整
 * 参考实现；边界语义已按下方注释修正，未来若改为复用不会踩坑。
 */

/**
 * 计一次点击。
 *
 * 边界语义：**恰好落在窗口右端的那一次点击计入**。
 * 原实现先判 `now - startedAt >= durationMs` 再 return，会把恰好等于
 * durationMs 的那次点击既不计点也不计入总数。默认窗口正是 1 秒
 * （CPS_DURATION_OPTIONS_MS 首项，见上方注释），手速稍快时这会系统性
 * 少算约 1 次（≈10%），直接影响成绩公平性。
 *
 * 现在：窗口内（含右端点）→ clicks+1；窗口已过 → 关闭计时器，
 * 该次点击不计入（它确实发生在窗口之外）。
 */
export function cpsTick(s: CpsState, now: number): CpsState {
  if (!s.running) return s
  if (now - (s.startedAt ?? now) > s.durationMs) return { ...s, running: false }
  return { ...s, clicks: s.clicks + 1 }
}

/** 仅检查超时（供定时器驱动，不加点击数）。 */
export function cpsCheck(s: CpsState, now: number): CpsState {
  if (!s.running) return s
  if (now - (s.startedAt ?? now) >= s.durationMs) return { ...s, running: false }
  return s
}

export function cpsResult(s: CpsState): number {
  return cpsFromClicks(s.clicks, s.durationMs)
}

/** 由点击数与窗口时长计算每秒点击率（保留 1 位小数）。 */
export function cpsFromClicks(clicks: number, durationMs: number): number {
  return Math.round((clicks / (durationMs / 1000)) * 10) / 10
}

/**
 * CPS 评级分档 —— **判定与表格的单一真源**。
 *
 * 此前页面表格写 "4 – 6 = Normal / 7 – 9 = Fast"，而 cpsGrade 按 4.5 / 7 分界，
 * 于是同屏出现三种矛盾：5.0 CPS 在结果区是 Average、同页表格却是 Normal；
 * 4.0–4.4 表格说 Normal 而代码判 Slow；6.1–6.9 落在表格两行之间的空隙里。
 * 两套口径各自演进必然继续漂移，所以现在判定函数与表格行都由这张表驱动：
 * 区间连续、无缝隙、无重叠，改一处两边同时生效。
 */
export const CPS_GRADES = [
  {
    min: 10,
    grade: 'Elite',
    range: '10 or more',
    typical: 'Usually jitter-click technique rather than plain finger taps',
  },
  { min: 7, grade: 'Fast', range: '7 – 9.9', typical: 'Practiced gamers and rapid-fire situations' },
  { min: 4, grade: 'Normal', range: '4 – 6.9', typical: 'General use and most gaming' },
  { min: 0, grade: 'Slow', range: 'Under 4', typical: 'Everyday office clicking' },
] as const

/** 由 CPS 查评级名（t() 的 key）。分档来自 CPS_GRADES，不在函数里另写阈值。 */
export function cpsGrade(cps: number): string {
  const hit = CPS_GRADES.find((g) => cps >= g.min)
  return hit ? hit.grade : CPS_GRADES[CPS_GRADES.length - 1].grade
}

/* ---------- Polling rate ---------- */

export interface PollingWindow {
  count: number
  windowStart: number
}

export function newPollingWindow(now: number): PollingWindow {
  return { count: 0, windowStart: now }
}

/** 累积一次 pointermove；窗口满 1s 时返回 Hz 并自动重开窗口，未满返回 null。 */
export function pollTick(w: PollingWindow, now: number): { hz: number | null; next: PollingWindow } {
  const next = { count: w.count + 1, windowStart: w.windowStart }
  const elapsed = now - w.windowStart
  if (elapsed >= 1000) {
    const hz = Math.round((next.count / elapsed) * 1000)
    return { hz, next: { count: 0, windowStart: now } }
  }
  return { hz: null, next }
}

/* ---------- DPI 估算（P0 竞品对齐：已知物理距离 → 反推 DPI） ---------- */

/** 由水平方向累计像素移动量与已知物理距离（英寸）估算 DPI（counts per inch）。 */
export function estimateDpi(pixels: number, inches: number): number {
  if (pixels <= 0 || inches <= 0) return 0
  return Math.round(pixels / inches)
}

/* ---------- 拖拽测试（P0 竞品对齐：微动误报"拖动中途断/提前掉落"） ---------- */

/** 拖拽判定三态（与 ResultCard 的 Verdict 字面量兼容）。 */
export type DragVerdict = 'idle' | 'ok' | 'warn' | 'bad'

/** 位移达到该值（px）才算一次有意义的拖动；不足视为普通点击，不计数。 */
export const DRAG_MIN_TRAVEL = 30

/** 位移达标后松开，300ms 内再次按下 → 判定一次"中途掉落"（微动误报释放后立刻重按）。 */
export const DRAG_DROP_WINDOW_MS = 300

export interface DragStats {
  done: number // 完成次数（物体被拖到轨道终点）
  drops: number // 中途掉落次数（拖动中误释放 + 快速重按）
  totalTravel: number // 累计完成段拖动距离（px）
  maxTravel: number // 单次完成拖动最大距离（px）
  active: boolean // 当前是否按住拖动中
  traveled: number // 本次拖动已走距离（px）
  dropAt: number | null // 位移达标后的 up 时刻（落入 DRAG_DROP_WINDOW_MS → 记为掉落）
}

export function newDragStats(): DragStats {
  return { done: 0, drops: 0, totalTravel: 0, maxTravel: 0, active: false, traveled: 0, dropAt: null }
}

/** 按下（左键）：落在 drop 窗口内 → 掉落 +1 并续拖；否则全新拖动。 */
export function dragDown(s: DragStats, now: number): DragStats {
  const drop = s.dropAt !== null && now - s.dropAt < DRAG_DROP_WINDOW_MS
  return { ...s, drops: s.drops + (drop ? 1 : 0), dropAt: drop ? null : s.dropAt, active: true, traveled: 0 }
}

/** 移动：累计本次拖动距离（与上一采样点的直线距离）。 */
export function dragMove(s: DragStats, x: number, y: number, prevX: number, prevY: number): DragStats {
  if (!s.active) return s
  return { ...s, traveled: s.traveled + Math.hypot(x - prevX, y - prevY) }
}

/** 物体到达轨道终点（UI 判定 itemX ≥ 1 时调用）：完成一次拖动。 */
export function dragFinish(s: DragStats): DragStats {
  if (!s.active) return s
  return {
    ...s,
    done: s.done + 1,
    totalTravel: s.totalTravel + s.traveled,
    maxTravel: Math.max(s.maxTravel, s.traveled),
    active: false,
    traveled: 0,
    dropAt: null,
  }
}

/** 松开（未到终点）：位移达标 → 进入 drop 窗口（等待 300ms 内重按确认掉落）；否则视为放弃。 */
export function dragUp(s: DragStats, now: number): DragStats {
  if (!s.active) return s
  return { ...s, active: false, traveled: 0, dropAt: s.traveled >= DRAG_MIN_TRAVEL ? now : null }
}

/** 指针取消/移出：放弃本次拖动，不计数。 */
export function dragCancel(s: DragStats): DragStats {
  return s.active ? { ...s, active: false, traveled: 0, dropAt: null } : s
}

/** 中途掉落率：drops / (done + drops)。 */
export function dragDropRate(s: DragStats): number {
  const total = s.done + s.drops
  return total === 0 ? 0 : s.drops / total
}

/** 拖拽判定：idle 无数据 / ok 无掉落 / warn 1 次 / bad ≥2 次。 */
export function dragVerdict(s: DragStats): DragVerdict {
  if (s.done + s.drops === 0) return 'idle'
  if (s.drops === 0) return 'ok'
  return s.drops === 1 ? 'warn' : 'bad'
}
