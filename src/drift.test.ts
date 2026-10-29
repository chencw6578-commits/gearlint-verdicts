/** 摇杆漂移检测纯函数边界测试。
 * 运行：npm test（node --test，零依赖）。覆盖无法用真机验证的判定边界：
 * 漂移阈值/占比组合、方向判定、死区圆度扇区覆盖、画圈圈数累积与反向抵消、
 * 中心噪声忽略、行程/回中/圆度分级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DRIFT_THRESHOLD,
  emptyStats,
  accumulateSample,
  judgeDrift,
  extractSticks,
  emptyCircleAccum,
  accumulateCircle,
  circleShape,
  CIRCLE_SECTORS,
  emptyCircleRun,
  accumulateCircleRun,
  evaluateCircleRun,
  CIRCLE_MIN_REVS,
  DRIFT_MIN_SAMPLES,
  type CircleRun,
} from './drift.ts'

/* ------------------------------------------------------------------ */
/* 漂移判定（judgeDrift / accumulateSample）                            */
/* ------------------------------------------------------------------ */

test('judgeDrift：无采样 → idle', () => {
  assert.equal(judgeDrift(emptyStats(), DEFAULT_DRIFT_THRESHOLD), 'idle')
})

test('judgeDrift：全部采样在阈值内 → ok', () => {
  let s = emptyStats()
  for (let i = 0; i < 100; i++) s = accumulateSample(s, { x: 0.01, y: -0.01 }, DEFAULT_DRIFT_THRESHOLD)
  assert.equal(s.driftFrames, 0)
  assert.equal(s.peakMag, Math.hypot(0.01, 0.01)) // 峰值 < 阈值
  assert.equal(judgeDrift(s, DEFAULT_DRIFT_THRESHOLD), 'ok')
})

test('judgeDrift：峰值超阈值但占比 ≤15% → warn（偶发偏移不升级）', () => {
  let s = emptyStats()
  for (let i = 0; i < 99; i++) s = accumulateSample(s, { x: 0, y: 0 }, DEFAULT_DRIFT_THRESHOLD)
  s = accumulateSample(s, { x: 0.3, y: 0 }, DEFAULT_DRIFT_THRESHOLD) // 占比 1%
  assert.equal(s.driftFrames, 1)
  assert.equal(s.peakMag, 0.3)
  assert.equal(judgeDrift(s, DEFAULT_DRIFT_THRESHOLD), 'warn')
})

test('judgeDrift：峰值 >1.6×阈值 且占比 >15% → bad（持续偏移）', () => {
  // 样本量取 60（= DRIFT_MIN_SAMPLES，60Hz 下约 1 秒）："持续偏移"需要
  // 真实观测时长支撑。原为 10 帧（约 167ms），而 judgeDrift 现在对样本量不足的
  // 高比例判定压制为 warn —— 10 帧 100% 超阈只代表刚放上摇杆的头几帧。
  // 判定条件（峰值 >1.6×阈值 且 占比 >15% → bad）本身未变。
  let s = emptyStats()
  for (let i = 0; i < DRIFT_MIN_SAMPLES; i++) s = accumulateSample(s, { x: 0.3, y: 0 }, DEFAULT_DRIFT_THRESHOLD)
  assert.ok(s.driftFrames / s.samples > 0.15)
  assert.equal(judgeDrift(s, DEFAULT_DRIFT_THRESHOLD), 'bad')
})

test('judgeDrift：占比高但峰值 ≤1.6×阈值 → warn 而非 bad（幅度不够不误报）', () => {
  // 峰值 0.1 > 阈值 0.08 但 ≤ 0.128（1.6×），即使 100% 漂移也只 warn
  let s = emptyStats()
  for (let i = 0; i < DRIFT_MIN_SAMPLES; i++) s = accumulateSample(s, { x: 0.1, y: 0 }, DEFAULT_DRIFT_THRESHOLD)
  assert.equal(s.driftFrames, DRIFT_MIN_SAMPLES)
  assert.equal(judgeDrift(s, DEFAULT_DRIFT_THRESHOLD), 'warn')
})

test('judgeDrift：采样帧数 < DRIFT_MIN_SAMPLES → insufficient（两个方向都不下结论）', () => {
  // 健康侧：59 帧全部在阈值内，也不能宣布"无漂移"—— 不到 1 秒的数据证明不了静止。
  let ok = emptyStats()
  for (let i = 0; i < DRIFT_MIN_SAMPLES - 1; i++) ok = accumulateSample(ok, { x: 0.01, y: 0 }, DEFAULT_DRIFT_THRESHOLD)
  assert.equal(ok.driftFrames, 0)
  assert.equal(judgeDrift(ok, DEFAULT_DRIFT_THRESHOLD), 'insufficient', '没看到异常 ≠ 健康')

  // 异常侧：59 帧里 30 帧超阈（50%）同样不足 —— 那只是刚放上摇杆的头几帧。
  let bad = emptyStats()
  for (let i = 0; i < DRIFT_MIN_SAMPLES - 1; i++)
    bad = accumulateSample(bad, { x: i < 30 ? 0.3 : 0, y: 0 }, DEFAULT_DRIFT_THRESHOLD)
  assert.ok(bad.driftFrames / bad.samples > 0.15)
  assert.equal(judgeDrift(bad, DEFAULT_DRIFT_THRESHOLD), 'insufficient', '高比例也必须被样本量压住')
})

test('accumulateSample：方向判定（X+ / Y-）、峰值保持最大幅值、阈值内不更新方向', () => {
  let s = emptyStats()
  s = accumulateSample(s, { x: 0.5, y: 0.2 }, DEFAULT_DRIFT_THRESHOLD) // |x|≥|y|, x>0 → X+
  assert.equal(s.direction, 'X+')
  assert.deepEqual(s.peak, { x: 0.5, y: 0.2 })

  s = accumulateSample(s, { x: -0.3, y: -0.5 }, DEFAULT_DRIFT_THRESHOLD) // |y|>|x|, y<0 → Y-，幅值更大 → 新峰值
  assert.equal(s.direction, 'Y-')
  assert.deepEqual(s.peak, { x: -0.3, y: -0.5 })

  s = accumulateSample(s, { x: 0.001, y: 0.001 }, DEFAULT_DRIFT_THRESHOLD) // 阈值内：方向与峰值均不变
  assert.equal(s.direction, 'Y-')
  assert.deepEqual(s.peak, { x: -0.3, y: -0.5 })
  assert.equal(s.driftFrames, 2)
})

test('extractSticks：只提取前 4 轴（双摇杆），忽略触发器/额外轴', () => {
  const pad = { id: 'Test Pad', axes: [0.1, -0.2, 0.3, 0.4, 0.9, 1] } as unknown as Gamepad
  const info = extractSticks(pad)
  assert.equal(info.id, 'Test Pad')
  assert.deepEqual(info.axes, [0.1, -0.2, 0.3, 0.4])
})

/* ------------------------------------------------------------------ */
/* 死区圆度统计（accumulateCircle / circleShape）                       */
/* ------------------------------------------------------------------ */

test('circleShape：固定方向拉扯 → 1 扇区', () => {
  let acc = emptyCircleAccum()
  for (let i = 0; i < 10; i++) acc = accumulateCircle(acc, { x: 1, y: 0 })
  const shape = circleShape(acc)
  assert.equal(shape.sectors, 1)
  assert.equal(shape.maxR, 1)
  assert.equal(shape.meanR, 1)
})

test('circleShape：整圈游走 → CIRCLE_SECTORS 全覆盖', () => {
  let acc = emptyCircleAccum()
  for (let i = 0; i < CIRCLE_SECTORS; i++) {
    const a = (2 * Math.PI * i) / CIRCLE_SECTORS
    acc = accumulateCircle(acc, { x: Math.cos(a), y: Math.sin(a) })
  }
  assert.equal(circleShape(acc).sectors, CIRCLE_SECTORS)
})

test('circleShape：空累加器 → sectors 0 / meanR 0 / maxR 0', () => {
  const shape = circleShape(emptyCircleAccum())
  assert.equal(shape.sectors, 0)
  assert.equal(shape.meanR, 0)
  assert.equal(shape.maxR, 0)
})

test('circleShape：meanR 为平均偏移（累加和/帧数）', () => {
  let acc = emptyCircleAccum()
  acc = accumulateCircle(acc, { x: 1, y: 0 })
  acc = accumulateCircle(acc, { x: 0.5, y: 0 })
  acc = accumulateCircle(acc, { x: 0, y: 0.5 })
  const shape = circleShape(acc)
  assert.ok(Math.abs(shape.meanR - (1 + 0.5 + 0.5) / 3) < 1e-9)
  assert.equal(shape.maxR, 1)
})

/* ------------------------------------------------------------------ */
/* 画圈校准（accumulateCircleRun / evaluateCircleRun）                  */
/* ------------------------------------------------------------------ */

/** 生成绕圈采样：每圈 stepsPerRev 个等分点 + 收尾点，使累计转角恰为 revs 圈。 */
function circlePoints(radius: number, stepsPerRev = 16, revs = 2): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  for (let r = 0; r < revs; r++) {
    for (let i = 0; i < stepsPerRev; i++) {
      const a = (2 * Math.PI * i) / stepsPerRev
      pts.push({ x: radius * Math.cos(a), y: radius * Math.sin(a) })
    }
  }
  pts.push({ x: radius * Math.cos(2 * Math.PI * revs), y: radius * Math.sin(2 * Math.PI * revs) }) // 收尾回到起点
  return pts
}

test('画圈两整圈：revolutions ≈ 2、覆盖 8 扇区、正圆 → ok', () => {
  const run = circlePoints(1).reduce((r, p) => accumulateCircleRun(r, p), emptyCircleRun())
  assert.ok(Math.abs(run.revolutions - 2) < 1e-6, `revs=${run.revolutions}`)
  const res = evaluateCircleRun(run)
  assert.equal(res.status, 'ok')
  assert.equal(res.sectors, CIRCLE_SECTORS)
  assert.ok(Math.abs(res.roundness - 1) < 1e-9)
  assert.ok(Math.abs(res.maxR - 1) < 1e-9, `maxR=${res.maxR}`)
})

test('反向转动抵消圈数：顺半圈再逆半圈 → 累计 0，不达判定阈值', () => {
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i <= 8; i++) {
    const a = (Math.PI * i) / 8 // 0 → π
    pts.push({ x: Math.cos(a), y: Math.sin(a) })
  }
  for (let i = 8; i >= 0; i--) {
    const a = (Math.PI * i) / 8 // π → 0 原路返回
    pts.push({ x: Math.cos(a), y: Math.sin(a) })
  }
  const run = pts.reduce((r, p) => accumulateCircleRun(r, p), emptyCircleRun())
  assert.ok(Math.abs(run.revolutions) < 1e-6, `revs=${run.revolutions}`)
  assert.equal(evaluateCircleRun(run).status, 'idle')
})

test('中心噪声（r<0.05）不计转向、不更新角度基线、不参与 minR（径向静止不污染圆度）', () => {
  const r1 = accumulateCircleRun(emptyCircleRun(), { x: 1, y: 0 }) // 角度基线 0；非转动首帧，minR 保持 Infinity
  const r2 = accumulateCircleRun(r1, { x: 0.01, y: 0.01 }) // r≈0.014 < 0.05
  const r3 = accumulateCircleRun(r2, { x: 0, y: 1 }) // 角度 π/2，从基线 0 跳变 → 转动
  assert.equal(r2.revolutions, 0)
  assert.equal(r2.lastAngle, 0) // 中心噪声不更新基线
  assert.equal(r2.minR, Number.POSITIVE_INFINITY) // 中心噪声不再压低 minR
  assert.ok(Math.abs(r3.revolutions - 0.25) < 1e-6, `revs=${r3.revolutions}`) // (π/2)/(2π)
  assert.ok(Math.abs(r3.minR - 1) < 1e-9, `minR=${r3.minR}`) // 转动帧半径进入 minR
})

test('evaluateCircleRun：圈数不足（<CIRCLE_MIN_REVS）→ idle，继续引导转动', () => {
  const run = circlePoints(1, 16, 1).reduce((r, p) => accumulateCircleRun(r, p), emptyCircleRun())
  const res = evaluateCircleRun(run)
  assert.equal(res.status, 'idle')
  assert.ok(res.revolutions < CIRCLE_MIN_REVS)
})

test('evaluateCircleRun：行程不足（maxR < 0.7）→ warn，即使圈数够', () => {
  const run = circlePoints(0.5).reduce((r, p) => accumulateCircleRun(r, p), emptyCircleRun())
  const res = evaluateCircleRun(run)
  assert.equal(res.status, 'warn')
  assert.ok(Math.abs(res.maxR - 0.5) < 1e-9, `maxR=${res.maxR}`)
})

test('松手回中不污染圆度：转满 2 圈后沿固定角度回落至中心 → 仍 ok（回归：修复松手误报 bad）', () => {
  // 两整圈正圆（半径 1）
  const pts = circlePoints(1)
  // 松手回中：角度保持 0 的径向回落（转角 ≈ 0 → 不算转动），半径从 0.6 递减到中心
  for (let i = 6; i >= 1; i--) pts.push({ x: i * 0.1, y: 0 })
  pts.push({ x: 0.01, y: 0.01 })
  const run = pts.reduce((r, p) => accumulateCircleRun(r, p), emptyCircleRun())
  const res = evaluateCircleRun(run)
  assert.ok(Math.abs(res.minR - 1) < 1e-9, `minR=${res.minR}，松手回中把圆度分母拉向 0`) // minR 保持边缘半径
  assert.equal(res.status, 'ok')
})

test('松手后再次转动：minR 仍只吸收转动帧，回中停顿不压低圆度', () => {
  // 半圈（0 → π）→ 回中停顿（多帧中心噪声）→ 再连续转 1.5 圈（π → 3π），全程 2 圈
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i <= 8; i++) {
    const a = (Math.PI * i) / 8 // 0 → π
    pts.push({ x: Math.cos(a), y: Math.sin(a) })
  }
  for (let i = 0; i < 30; i++) pts.push({ x: 0.01, y: 0 }) // 回中停顿约半秒
  for (let i = 0; i <= 25; i++) {
    const a = Math.PI + (Math.PI * i) / 8 // π → 3π + π/8（略超 1.5 圈），确保累计转角严格 > 2 圈，避免浮点 2−ε 边界
    pts.push({ x: Math.cos(a), y: Math.sin(a) })
  }
  const run = pts.reduce((r, p) => accumulateCircleRun(r, p), emptyCircleRun())
  const res = evaluateCircleRun(run)
  assert.ok(res.revolutions >= CIRCLE_MIN_REVS, `revs=${res.revolutions}`)
  assert.ok(Math.abs(res.minR - 1) < 1e-9, `minR=${res.minR}`) // 停顿不压低 minR
  assert.equal(res.status, 'ok')
})

/** 生成绕圈采样：radiusFn 决定每帧半径（用于构造圆度/回中异常）。 */
function circlePointsR(
  radiusFn: (i: number) => number,
  stepsPerRev = 16,
  revs = 2,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  let idx = 0
  for (let r = 0; r < revs; r++) {
    for (let i = 0; i < stepsPerRev; i++) {
      const a = (2 * Math.PI * i) / stepsPerRev
      const radius = radiusFn(idx++)
      pts.push({ x: radius * Math.cos(a), y: radius * Math.sin(a) })
    }
  }
  pts.push({ x: radiusFn(0) * Math.cos(2 * Math.PI * revs), y: radiusFn(0) * Math.sin(2 * Math.PI * revs) })
  return pts
}

test('evaluateCircleRun：半径波动大（roundness > 1.6）→ bad', () => {
  const pts = circlePointsR((i) => (i % 2 === 0 ? 1 : 0.5)) // 交替半径 → roundness 2
  const run = pts.reduce((r, p) => accumulateCircleRun(r, p), emptyCircleRun())
  const res = evaluateCircleRun(run)
  assert.ok(res.roundness > 1.6)
  assert.equal(res.status, 'bad')
})

test('evaluateCircleRun：圆度 1.3~1.6（0.9/0.6）→ warn', () => {
  const pts = circlePointsR((i) => (i % 2 === 0 ? 0.9 : 0.6))
  const run = pts.reduce((r, p) => accumulateCircleRun(r, p), emptyCircleRun())
  const res = evaluateCircleRun(run)
  assert.ok(res.roundness > 1.3 && res.roundness <= 1.6)
  assert.equal(res.status, 'warn')
})

test('evaluateCircleRun：扇区不足（<6）即使圆度正常 → warn（防御分支，直接构造状态）', () => {
  // 连续转动到 2 圈必然覆盖全部 8 扇区；<6 只可能来自异常轨迹/噪声，故用构造状态验证分支
  const run: CircleRun = {
    revolutions: 2.05, // 圈数达标
    maxR: 1,
    minR: 0.9, // 回中正常、圆度 ≈1.11 正常
    samples: 100,
    sectorMask: 0b00001111, // 仅 4 个扇区
    lastAngle: null,
  }
  const res = evaluateCircleRun(run)
  assert.equal(res.sectors, 4)
  assert.equal(res.status, 'warn')
})

test('evaluateCircleRun：minR 无限（无回中采样）→ 按 0 处理不崩溃', () => {
  const res = evaluateCircleRun(emptyCircleRun())
  assert.equal(res.minR, 0)
  assert.equal(res.roundness, Number.POSITIVE_INFINITY)
  assert.equal(res.status, 'idle')
})
