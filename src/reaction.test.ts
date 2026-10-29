/** 瞄准训练计时语义测试（修复前 avg hit 是"开局→现在"，与命中次数正相关）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newAimState, aimStart, aimHit, aimMiss, aimEnd, aimAvgHitMs, AIM_MAX_HITS } from './reaction.ts'

test('avg hit = 目标出现→命中，不是开局→现在', () => {
  // 每个目标都花 1200ms 命中。旧实现会算成 (1200 + 2400)/2 = 1800，
  // 因为第二次命中加的是"从开局到现在"的全部时间。
  let s = aimStart(0)
  s = aimHit(s, 1200)
  s = aimHit(s, 2400)
  assert.equal(s.hits, 2)
  assert.equal(aimAvgHitMs(s), 1200)
})

test('命中次数增加不会让平均耗时变大（旧实现的特征性 bug）', () => {
  // 修复前实测：8 次命中、每次约 1.2s → 显示 4754 ms
  let s = aimStart(0)
  for (let i = 1; i <= 8; i++) s = aimHit(s, i * 1200)
  assert.equal(s.hits, 8)
  assert.equal(aimAvgHitMs(s), 1200)
})

test('快慢混合取真实平均，与命中顺序无关', () => {
  let s = aimStart(0)
  s = aimHit(s, 500) // 500ms
  s = aimHit(s, 1500) // 1000ms
  s = aimHit(s, 3000) // 1500ms
  assert.equal(aimAvgHitMs(s), 1000)
})

test('无命中 → null（不显示 0 误导用户）', () => {
  const s = aimStart(0)
  assert.equal(aimAvgHitMs(s), null)
})

test('未开始 / 已结束时命中被忽略', () => {
  assert.equal(aimHit(newAimState(), 100).hits, 0)
  const done = aimEnd(aimStart(0), 5000)
  assert.equal(aimHit(done, 6000).hits, 0)
})

test('失误不清空已累计的命中耗时，只清连击', () => {
  let s = aimStart(0)
  s = aimHit(s, 1000)
  s = aimMiss(s)
  assert.equal(s.misses, 1)
  assert.equal(s.streak, 0)
  assert.equal(s.bestStreak, 1)
  s = aimHit(s, 2000) // 第二个目标从 1000 起算，花 1000ms
  assert.equal(aimAvgHitMs(s), 1000)
})

test('达到上限自动收尾，平均耗时仍正确', () => {
  let s = aimStart(0)
  for (let i = 1; i <= AIM_MAX_HITS; i++) s = aimHit(s, i * 800)
  assert.equal(s.phase, 'done')
  assert.equal(aimAvgHitMs(s), 800)
})

test('旧状态（无 targetAt）回退到 startedAt 而不是崩', () => {
  const legacy = { ...aimStart(0), targetAt: null }
  const s = aimHit(legacy, 900)
  assert.equal(s.hits, 1)
  assert.equal(aimAvgHitMs(s), 900)
})
