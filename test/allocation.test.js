const test = require('node:test')
const assert = require('node:assert')
const { scorePair, assignOptimal, computeSignature, buildPlan } = require('../lib/allocation')

/**
 * 复刻「旧的逐个分配」方式：把所有成员-座位对按得分降序，先到先得。
 * 仅用于测试对比，证明该方式无法保证最高总得分。
 * @param {Array<object>} members 成员
 * @param {Array<object>} seats 座位
 * @returns {number} 旧方式得到的总得分
 */
function greedyTotal(members, seats) {
  const scored = []
  for (const m of members) {
    for (const s of seats) {
      scored.push({ memberId: m.id, seatId: s.id, score: scorePair(m, s) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const usedM = new Set()
  const usedS = new Set()
  let total = 0
  for (const p of scored) {
    if (usedM.has(p.memberId) || usedS.has(p.seatId)) continue
    usedM.add(p.memberId)
    usedS.add(p.seatId)
    total += p.score
  }
  return total
}

/**
 * 计算一组分配的总得分。
 * @param {Array<{memberId: string, seatId: string}>} result 分配结果
 * @param {Array<object>} members 成员
 * @param {Array<object>} seats 座位
 * @returns {number} 总得分
 */
function totalOf(result, members, seats) {
  const mMap = new Map(members.map(m => [m.id, m]))
  const sMap = new Map(seats.map(s => [s.id, s]))
  return result.reduce((sum, a) => sum + scorePair(mMap.get(a.memberId), sMap.get(a.seatId)), 0)
}

test('最佳方案总分高于旧的逐个分配方式', () => {
  // m1(靠窗) 更看重能坐窗边即可，m2(安静) 只有安静座位才满意。
  // 逐个分配会先把 s1(窗+静) 给 m1，导致 m2 落到不安静的 s2；
  // 最佳方案应把 s1 留给 m2、s2 给 m1，总分更高。
  const members = [
    { id: 'm1', name: 'A', team: 'T', wantsWindow: true, needsQuiet: false },
    { id: 'm2', name: 'B', team: 'T', wantsWindow: false, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', area: 'A', isWindow: true, isQuiet: true },
    { id: 's2', area: 'A', isWindow: true, isQuiet: false }
  ]

  const optimal = assignOptimal(members, seats)
  const optimalTotal = totalOf(optimal, members, seats)
  const greedy = greedyTotal(members, seats)

  assert.strictEqual(greedy, 7, '旧方式在该例子只能得到 7 分')
  assert.strictEqual(optimalTotal, 21, '最佳方案应得到 21 分')
  assert.ok(optimalTotal > greedy, '最佳方案总分必须高于旧方式')

  const byMember = new Map(optimal.map(a => [a.memberId, a.seatId]))
  assert.strictEqual(byMember.get('m1'), 's2')
  assert.strictEqual(byMember.get('m2'), 's1')
})

test('重复生成预览结果一致（确定性）', () => {
  const members = [
    { id: 'm1', name: 'A', team: 'T', wantsWindow: true, needsQuiet: true },
    { id: 'm2', name: 'B', team: 'T', wantsWindow: true, needsQuiet: true },
    { id: 'm3', name: 'C', team: 'T', wantsWindow: false, needsQuiet: false }
  ]
  const seats = [
    { id: 's1', area: 'A', isWindow: true, isQuiet: true },
    { id: 's2', area: 'A', isWindow: true, isQuiet: true },
    { id: 's3', area: 'A', isWindow: false, isQuiet: false }
  ]
  const p1 = buildPlan(members, seats, [])
  const p2 = buildPlan(members, seats, [])
  assert.deepStrictEqual(p1.assignments, p2.assignments)
  assert.strictEqual(p1.totalScore, p2.totalScore)
  assert.strictEqual(p1.signature, p2.signature)
})

test('锁定的成员与座位原样保留，只重排其余', () => {
  const members = [
    { id: 'm1', name: 'A', team: 'T', wantsWindow: true, needsQuiet: false },
    { id: 'm2', name: 'B', team: 'T', wantsWindow: false, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', area: 'A', isWindow: true, isQuiet: true },
    { id: 's2', area: 'A', isWindow: true, isQuiet: false }
  ]
  // 把 m1 锁定在 s1（一个原本不是最优的组合），锁定项必须保持不变。
  const assignments = [{ memberId: 'm1', seatId: 's1', locked: true }]
  const plan = buildPlan(members, seats, assignments)

  const m1 = plan.assignments.find(a => a.memberId === 'm1')
  assert.deepStrictEqual(m1, { memberId: 'm1', seatId: 's1', locked: true })
  const m2 = plan.assignments.find(a => a.memberId === 'm2')
  assert.strictEqual(m2.seatId, 's2', 'm2 只能用剩下的空座 s2')
  assert.strictEqual(m2.locked, false)
})

test('成员多于座位：部分成员未分配并被明确列出', () => {
  const members = [
    { id: 'm1', name: 'A', team: 'T', wantsWindow: true, needsQuiet: false },
    { id: 'm2', name: 'B', team: 'T', wantsWindow: true, needsQuiet: false },
    { id: 'm3', name: 'C', team: 'T', wantsWindow: true, needsQuiet: false }
  ]
  const seats = [
    { id: 's1', area: 'A', isWindow: true, isQuiet: false },
    { id: 's2', area: 'A', isWindow: true, isQuiet: false }
  ]
  const plan = buildPlan(members, seats, [])
  assert.strictEqual(plan.assigned.length, 2)
  assert.strictEqual(plan.unassignedMembers.length, 1)
  assert.strictEqual(plan.emptySeats.length, 0)
})

test('座位多于成员：保留空座', () => {
  const members = [
    { id: 'm1', name: 'A', team: 'T', wantsWindow: true, needsQuiet: false }
  ]
  const seats = [
    { id: 's1', area: 'A', isWindow: true, isQuiet: false },
    { id: 's2', area: 'A', isWindow: false, isQuiet: false }
  ]
  const plan = buildPlan(members, seats, [])
  assert.strictEqual(plan.assigned.length, 1)
  assert.strictEqual(plan.unassignedMembers.length, 0)
  assert.strictEqual(plan.emptySeats.length, 1)
  assert.strictEqual(plan.assigned[0].seatId, 's1', '应选靠窗座位得分最高')
})

test('状态改变导致签名变化（过期判断的基础）', () => {
  const members = [{ id: 'm1', name: 'A', team: 'T', wantsWindow: true, needsQuiet: false }]
  const seats = [{ id: 's1', area: 'A', isWindow: true, isQuiet: false }]

  const sigBefore = computeSignature(members, seats, [])
  const sigAfterLock = computeSignature(members, seats, [{ memberId: 'm1', seatId: 's1', locked: true }])
  assert.notStrictEqual(sigBefore, sigAfterLock, '锁定后签名必须变化')
})
