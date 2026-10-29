/** 鼠标按键间隔统计（P1-8 perButtonGaps）纯函数边界测试。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newClickSummary,
  recordMousedown,
  perButtonGaps,
  doubleClickVerdict,
  suspiciousRate,
  DOUBLE_CLICK_MIN_CLICKS,
  cpsGrade,
  CPS_GRADES,
  type ClickSummary,
} from './clicks.ts'

/** 按 (button, t) 序列驱动 recordMousedown，默认 100ms 阈值。 */
function runClicks(seq: [number, number][]): ClickSummary {
  return seq.reduce((s, [b, t]) => recordMousedown(s, b, t, 100), newClickSummary())
}

test('无点击 → 空数组', () => {
  assert.deepEqual(perButtonGaps(newClickSummary()), [])
})

test('单键按压一次 → 无间隔（null），suspicious 0', () => {
  const s = runClicks([[0, 1000]])
  const stats = perButtonGaps(s)
  assert.equal(stats.length, 1)
  assert.equal(stats[0].button, 0)
  assert.equal(stats[0].presses, 1)
  assert.equal(stats[0].minGap, null)
  assert.equal(stats[0].avgGap, null)
  assert.equal(stats[0].maxGap, null)
  assert.equal(stats[0].lastGap, null)
  assert.equal(stats[0].suspicious, 0)
})

test('左键多击：min/avg/max/last 与按压数、suspicious 计数正确', () => {
  // 间隔 50, 300, 90 → min 50, avg (50+300+90)/3=146.7, max 300, last 90；50 与 90 < 100 → suspicious 2
  const s = runClicks([
    [0, 1000],
    [0, 1050],
    [0, 1350],
    [0, 1440],
  ])
  const [st] = perButtonGaps(s)
  assert.equal(st.presses, 4)
  assert.equal(st.minGap, 50)
  assert.equal(st.avgGap, 146.7)
  assert.equal(st.maxGap, 300)
  assert.equal(st.lastGap, 90)
  assert.equal(st.suspicious, 2)
})

test('多按键分开统计：不同键的间隔互不影响', () => {
  // 左键 (0)：单次按压 → 全 null；右键 (2)：两次按压间隔 200 → min=avg=max=200
  const s = runClicks([
    [0, 1000],
    [2, 1100],
    [2, 1300],
  ])
  const stats = perButtonGaps(s)
  assert.equal(stats.length, 2)
  assert.equal(stats[0].button, 0)
  assert.equal(stats[0].presses, 1)
  assert.equal(stats[0].minGap, null)
  assert.equal(stats[1].button, 2)
  assert.equal(stats[1].presses, 2)
  assert.equal(stats[1].minGap, 200)
  assert.equal(stats[1].avgGap, 200)
  assert.equal(stats[1].maxGap, 200)
  assert.equal(stats[1].lastGap, 200)
  assert.equal(stats[1].suspicious, 0)
})

test('按按键升序排列，且只统计有事件的按键', () => {
  const s = runClicks([
    [2, 1000],
    [0, 1000],
    [5, 1100],
    [5, 1120],
  ])
  const stats = perButtonGaps(s)
  assert.deepEqual(stats.map((x) => x.button), [0, 2, 5])
  assert.equal(stats[2].suspicious, 1) // 20ms 间隔 < 100
})

/* ------------------------------------------------------------------ */
/* 双击判定：样本下限（"小样本即判故障"回归防线）                      */
/* ------------------------------------------------------------------ */

/** 生成 n 次点击，其中第 2 次与第 1 次间隔 gapMs（其余间隔 500ms，不计可疑）。 */
function clicksWithOneFastGap(n: number, gapMs: number): ClickSummary {
  const seq: [number, number][] = []
  let t = 0
  for (let i = 0; i < n; i++) {
    seq.push([0, t])
    t += i === 0 ? gapMs : 500
  }
  return runClicks(seq)
}

test('无点击 → idle', () => {
  assert.equal(doubleClickVerdict(newClickSummary()), 'idle')
})

test('3 次点击含 1 次 40ms → insufficient，不再是 Fault detected', () => {
  // 这是修复前的实际 BUG：suspiciousRate = 1/3 = 33% > 5% → bad，
  // 用户点三下就被告知鼠标坏了
  const s = clicksWithOneFastGap(3, 40)
  assert.equal(s.suspiciousCount, 1)
  assert.equal(doubleClickVerdict(s), 'insufficient')
})

test('19 次点击全部正常 → 仍是 insufficient（"没故障"同样需要样本）', () => {
  const s = clicksWithOneFastGap(19, 500)
  assert.equal(s.suspiciousCount, 0)
  assert.equal(doubleClickVerdict(s), 'insufficient')
})

test('刚好 20 次点击、0 可疑 → ok', () => {
  const s = clicksWithOneFastGap(DOUBLE_CLICK_MIN_CLICKS, 500)
  assert.equal(s.totalClicks, 20)
  assert.equal(doubleClickVerdict(s), 'ok')
})

test('20 次点击 1 次可疑（正好 5%，不超过 bad 线）→ warn', () => {
  const s = clicksWithOneFastGap(20, 40)
  assert.equal(s.suspiciousCount, 1)
  assert.equal(doubleClickVerdict(s), 'warn')
})

test('20 次点击 3 次可疑（15% > 5%）→ bad', () => {
  const seq: [number, number][] = []
  let t = 0
  for (let i = 0; i < 20; i++) {
    seq.push([0, t])
    // 前三次之后各造一次 40ms 间隔
    t += i === 0 || i === 5 || i === 10 ? 40 : 500
  }
  const s = runClicks(seq)
  assert.equal(s.suspiciousCount, 3)
  assert.equal(doubleClickVerdict(s), 'bad')
})

/* ------------------------------------------------------------------ */
/* CPS 评级：判定与表格必须是同一套口径                                */
/* ------------------------------------------------------------------ */

test('cpsGrade 与 CPS_GRADES 表格逐点一致（0–15 CPS 步进 0.1）', () => {
  for (let cps = 0; cps <= 15.0001; cps += 0.1) {
    const row = CPS_GRADES.find((g) => cps >= g.min)
    assert.ok(row, `cps=${cps.toFixed(1)} 必须落入某一档`)
    assert.equal(cpsGrade(cps), row.grade, `cps=${cps.toFixed(1)} 判定与表格不一致`)
  }
})

test('修复前的矛盾点：5.0 CPS 是 Normal，不再是 Average', () => {
  // 旧代码 >= 4.5 判 Average，而同页表格写 4–6 = Normal，同屏自相矛盾
  assert.equal(cpsGrade(5), 'Normal')
})

test('修复前的空档：6.1–6.9 有明确归属，不再掉出表格', () => {
  assert.equal(cpsGrade(6.1), 'Normal')
  assert.equal(cpsGrade(6.9), 'Normal')
  assert.equal(cpsGrade(7), 'Fast')
})

test('表格不存在 Average 这一档（评级名与表格行同源）', () => {
  // 提升成 string[] 再查：CPS_GRADES 是 as const，字面量联合里根本没有
  // 'Average'，编译器已经保证它写不回来；这里做运行时兜底，防止将来有人
  // 把 as const 去掉后又塞进一个表格里没有的评级名。
  const grades: string[] = CPS_GRADES.map((g) => g.grade)
  assert.ok(!grades.includes('Average'))
})

test('CPS_GRADES 区间连续无缝隙、按阈值降序', () => {
  for (let i = 1; i < CPS_GRADES.length; i++) {
    assert.ok(CPS_GRADES[i - 1].min > CPS_GRADES[i].min)
  }
  assert.equal(CPS_GRADES[CPS_GRADES.length - 1].min, 0) // 兜底档，负数也不会 undefined
})

test('suspiciousRate 分母口径与 /guides/how-we-test 一致：含每键首次按压', () => {
  // 文档明写："flagged events ÷ all presses"。每个键的第一次按压没有上一次
  // 可比（gap = null），永远不会被标记，但**留在分母里** → 比率偏小、方向保守。
  // 这条断言锁住的就是这个口径：将来谁"顺手修正"成 flags÷可比较按压数，
  // 这里会先红，提醒他同步改方法论页，而不是让文档和实现悄悄分叉。
  const s = runClicks([
    [0, 1000], // 首次按压：无 gap，不可能被标记
    [0, 1050], // 50ms → suspicious
    [0, 2000],
  ])
  assert.equal(s.totalClicks, 3)
  assert.equal(s.suspiciousCount, 1)
  assert.equal(suspiciousRate(s), 1 / 3, '文档口径：1/3，不是 1/2')
  assert.ok(suspiciousRate(s) < 1 / 2, '保守方向：分母含首次按压 → 比率更小、更不易判 bad')
})
