/** 键盘连击判定：样本下限纯函数测试。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newChatterSummary,
  recordKeydown,
  chatterVerdict,
  chatterRate,
  pressesPerKey,
  CHATTER_MIN_PRESSES,
  CHATTER_MIN_PRESSES_PER_KEY,
  type ChatterSummary,
} from './chatter.ts'

const CFG = { thresholdMs: 50 }

/** 按 (code, t) 序列驱动 recordKeydown。 */
function runKeys(seq: [string, number][]): ChatterSummary {
  return seq.reduce((s, [code, t]) => recordKeydown(s, code, t, false, CFG), newChatterSummary())
}

test('无按压 → idle', () => {
  assert.equal(chatterVerdict(newChatterSummary()), 'idle')
})

test('2 次按压含 1 次 22ms → insufficient，不再是 Fault detected', () => {
  // 修复前的 BUG：chatterRate = 1/2 = 50% > 2% → bad，敲两个键就被告知键盘坏了
  const s = runKeys([
    ['KeyA', 0],
    ['KeyA', 22],
  ])
  assert.equal(s.chatterCount, 1)
  assert.equal(chatterVerdict(s), 'insufficient')
})

test('总按压不足 25 → 即使 0 chatter 也是 insufficient（不谎报健康）', () => {
  const seq: [string, number][] = []
  for (let i = 0; i < 24; i++) seq.push(['KeyA', i * 500])
  const s = runKeys(seq)
  assert.equal(s.totalPresses, 24)
  assert.equal(s.chatterCount, 0)
  assert.equal(chatterVerdict(s), 'insufficient')
})

test('按压数够但没有哪个键被按够 5 次 → insufficient', () => {
  // 25 次按压分散到 25 个不同键：对每个键都只有 1 次样本，无从判断"重复触发"
  const seq: [string, number][] = []
  for (let i = 0; i < 25; i++) seq.push([`Key${i}`, i])
  const s = runKeys(seq)
  assert.equal(s.totalPresses, CHATTER_MIN_PRESSES)
  assert.equal(chatterVerdict(s), 'insufficient')
})

test('单键按够 5 次且 0 chatter → ok', () => {
  const seq: [string, number][] = []
  for (let i = 0; i < CHATTER_MIN_PRESSES_PER_KEY; i++) seq.push(['KeyA', i * 500])
  const s = runKeys(seq)
  // 总数仍不足 25，需补足：再敲别的键凑够总数
  for (let i = 0; i < 20; i++) seq.push([`Key${i}B`, 10000 + i * 500])
  const s2 = runKeys(seq)
  assert.ok(s2.totalPresses >= CHATTER_MIN_PRESSES)
  assert.equal(s2.chatterCount, 0)
  assert.equal(chatterVerdict(s2), 'ok')
  assert.equal(chatterVerdict(s), 'insufficient') // 只有 5 次时总数不够 → 仍不足
})

test('样本达标且 1 次 chatter（率 ≤ 2%）→ warn', () => {
  const seq: [string, number][] = []
  // KeyA 按 60 次，其中第 2 次间隔 20ms → 1/60 = 1.67% ≤ 2%
  seq.push(['KeyA', 0])
  seq.push(['KeyA', 20])
  for (let i = 2; i < 60; i++) seq.push(['KeyA', 20 + i * 500])
  const s = runKeys(seq)
  assert.equal(s.chatterCount, 1)
  assert.equal(chatterVerdict(s), 'warn')
})

test('样本达标且 chatter 率 > 2% → bad', () => {
  const seq: [string, number][] = []
  // KeyA 按 30 次，前 3 次两两间隔 20ms → 2 次 chatter / 30 = 6.7% > 2%
  seq.push(['KeyA', 0])
  seq.push(['KeyA', 20])
  seq.push(['KeyA', 40])
  for (let i = 3; i < 30; i++) seq.push(['KeyA', 40 + i * 500])
  const s = runKeys(seq)
  assert.equal(s.chatterCount, 2)
  assert.equal(chatterVerdict(s), 'bad')
})

test('pressesPerKey 按 code 聚合，与事件顺序无关', () => {
  const s = runKeys([
    ['KeyA', 0],
    ['KeyB', 10],
    ['KeyA', 20],
  ])
  const m = pressesPerKey(s)
  assert.equal(m.get('KeyA'), 2)
  assert.equal(m.get('KeyB'), 1)
})

test('长按自动重复（e.repeat）不计入样本', () => {
  let s = newChatterSummary()
  s = recordKeydown(s, 'KeyA', 0, false, CFG)
  s = recordKeydown(s, 'KeyA', 10, true, CFG) // 系统重复
  assert.equal(s.totalPresses, 1)
  assert.equal(s.chatterCount, 0)
})

test('chatterRate 分母口径与 /guides/how-we-test 一致：含每键首次按压', () => {
  // 与 clicks.ts 的 suspiciousRate 同口径（见那边测试里的说明）：每键首次按压
  // 留在分母里 → 比率偏小 → 更倾向于不判 bad。文档与实现必须一起改。
  const s = runKeys([
    ['KeyA', 0], // 首次：无 gap，不可能被标记
    ['KeyA', 20], // 20ms → chatter
    ['KeyA', 500],
  ])
  assert.equal(s.totalPresses, 3)
  assert.equal(s.chatterCount, 1)
  assert.equal(chatterRate(s), 1 / 3, '文档口径：1/3，不是 1/2')
  assert.ok(chatterRate(s) < 1 / 2, '保守方向')
})
