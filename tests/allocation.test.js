'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  scorePair,
  findBestAssignment,
  buildAssignmentPlan,
  computeStateHash
} = require('../allocation')

// 旧的“逐个分配”贪心实现，仅用于对照验证新算法能拿到更高总分
function greedyAssign(members, seats) {
  const scored = []
  for (const m of members) {
    for (const s of seats) {
      scored.push({ memberId: m.id, seatId: s.id, score: scorePair(m, s) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const usedMembers = new Set()
  const usedSeats = new Set()
  const result = []
  for (const pair of scored) {
    if (usedMembers.has(pair.memberId) || usedSeats.has(pair.seatId)) continue
    result.push(pair)
    usedMembers.add(pair.memberId)
    usedSeats.add(pair.seatId)
  }
  return result
}

function totalOf(assignments) {
  return assignments.reduce((sum, a) => sum + a.score, 0)
}

test('旧贪心得不到最高总分时，新算法仍能选出整体最优方案', () => {
  // 贪心会先给 m1 拿 s1（11 分），导致 m2 只能坐 s2（-4 分），总分 7；
  // 最优方案是 m1 坐 s2（10 分）、m2 坐 s1（11 分），总分 21
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false },
    { id: 'm2', wantsWindow: false, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: true },
    { id: 's2', isWindow: true, isQuiet: false }
  ]

  const greedy = greedyAssign(members, seats)
  assert.equal(totalOf(greedy), 7)

  const best = findBestAssignment(members, seats)
  assert.equal(best.totalScore, 21)
  assert.deepEqual(
    best.assignments.map(a => `${a.memberId}->${a.seatId}`).sort(),
    ['m1->s2', 'm2->s1']
  )
  assert.deepEqual(best.unassigned, [])
})

test('相同输入重复计算结果必须一致（含总分相同的并列方案）', () => {
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false },
    { id: 'm2', wantsWindow: true, needsQuiet: false },
    { id: 'm3', wantsWindow: false, needsQuiet: false }
  ]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: false },
    { id: 's2', isWindow: true, isQuiet: false },
    { id: 's3', isWindow: false, isQuiet: false }
  ]

  const first = findBestAssignment(members, seats)
  const second = findBestAssignment(members, seats)
  assert.deepEqual(first, second)

  // 并列最优时按固定规则（成员 id 升序、座位 id 字典序最小）取舍
  assert.deepEqual(
    first.assignments.map(a => `${a.memberId}->${a.seatId}`),
    ['m1->s1', 'm2->s2', 'm3->s3']
  )
})

test('成员多于座位时允许部分成员未分配并明确列出', () => {
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false },
    { id: 'm2', wantsWindow: true, needsQuiet: false },
    { id: 'm3', wantsWindow: false, needsQuiet: true }
  ]
  const seats = [{ id: 's1', isWindow: true, isQuiet: false }]

  const best = findBestAssignment(members, seats)
  assert.equal(best.assignments.length, 1)
  assert.equal(best.unassigned.length, 2)
  // 唯一的靠窗座位应分给靠窗偏好者之一
  assert.equal(best.assignments[0].seatId, 's1')
})

test('座位不足时应比较成员取舍，而不是按 ID 顺序先排先坐', () => {
  // m1 无偏好坐 s1 只得 1 分，把 s1 让给有靠窗偏好的 m2 可得 10 分
  const members = [
    { id: 'm1', wantsWindow: false, needsQuiet: false },
    { id: 'm2', wantsWindow: true, needsQuiet: false }
  ]
  const seats = [{ id: 's1', isWindow: true, isQuiet: false }]

  const best = findBestAssignment(members, seats)
  assert.equal(best.totalScore, 10)
  assert.deepEqual(best.assignments, [{ memberId: 'm2', seatId: 's1', score: 10 }])
  assert.deepEqual(best.unassigned, ['m1'])
})

test('座位多于成员时全员分配且保留空座', () => {
  const members = [{ id: 'm1', wantsWindow: false, needsQuiet: true }]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: false },
    { id: 's2', isWindow: false, isQuiet: true },
    { id: 's3', isWindow: false, isQuiet: false }
  ]

  const best = findBestAssignment(members, seats)
  assert.equal(best.assignments.length, 1)
  assert.deepEqual(best.unassigned, [])
  assert.deepEqual(best.assignments[0], { memberId: 'm1', seatId: 's2', score: 10 })
})

test('没有可用座位时全部成员未分配', () => {
  const members = [{ id: 'm1', wantsWindow: true, needsQuiet: false }]
  const best = findBestAssignment(members, [])
  assert.deepEqual(best.assignments, [])
  assert.deepEqual(best.unassigned, ['m1'])
  assert.equal(best.totalScore, 0)
})

test('座位够坐时即使得分为负也必须入座', () => {
  // 唯一成员同时需要靠窗和安静，唯一座位两者都不满足，入座得 -10 分
  const members = [{ id: 'm1', wantsWindow: true, needsQuiet: true }]
  const seats = [{ id: 's1', isWindow: false, isQuiet: false }]

  const best = findBestAssignment(members, seats)
  assert.deepEqual(best.assignments, [{ memberId: 'm1', seatId: 's1', score: -10 }])
  assert.deepEqual(best.unassigned, [])
  assert.equal(best.totalScore, -10)
})

test('成员多于座位时即使最佳总分为负也要用尽全部座位', () => {
  // 两名成员都只想要靠窗，唯一座位不靠窗也不安静：必须有一人入座（-5 分）
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false },
    { id: 'm2', wantsWindow: true, needsQuiet: false }
  ]
  const seats = [{ id: 's1', isWindow: false, isQuiet: false }]

  const best = findBestAssignment(members, seats)
  assert.equal(best.assignments.length, 1)
  assert.equal(best.assignments[0].seatId, 's1')
  assert.equal(best.assignments[0].score, -5)
  assert.equal(best.totalScore, -5)
  assert.equal(best.unassigned.length, 1)
})

test('锁定的成员与座位原样保留，只对剩余资源重新计算', () => {
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false },
    { id: 'm2', wantsWindow: true, needsQuiet: false },
    { id: 'm3', wantsWindow: false, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', area: 'A区', isWindow: true, isQuiet: false },
    { id: 's2', area: 'A区', isWindow: true, isQuiet: false },
    { id: 's3', area: 'B区', isWindow: false, isQuiet: true }
  ]
  const current = [{ memberId: 'm1', seatId: 's1', locked: true }]

  const plan = buildAssignmentPlan(members, seats, current)

  const lockedEntry = plan.assignments.find(a => a.memberId === 'm1')
  assert.deepEqual(lockedEntry, {
    memberId: 'm1',
    seatId: 's1',
    locked: true,
    score: 10,
    windowMet: true,
    quietMet: null
  })

  // 锁定座位不能再分配给别人，m2 只能拿 s2，m3 拿 s3
  const m2 = plan.assignments.find(a => a.memberId === 'm2')
  const m3 = plan.assignments.find(a => a.memberId === 'm3')
  assert.equal(m2.seatId, 's2')
  assert.equal(m2.locked, false)
  assert.equal(m3.seatId, 's3')
  assert.equal(m3.quietMet, true)
  assert.equal(plan.totalScore, 10 + 10 + 10)
  assert.deepEqual(plan.unassigned, [])
})

test('状态指纹随锁定状态变化而变化', () => {
  const members = [{ id: 'm1', wantsWindow: true, needsQuiet: false }]
  const seats = [{ id: 's1', isWindow: true, isQuiet: false }]
  const before = computeStateHash(members, seats, [{ memberId: 'm1', seatId: 's1', locked: false }])
  const after = computeStateHash(members, seats, [{ memberId: 'm1', seatId: 's1', locked: true }])
  assert.notEqual(before, after)
})
