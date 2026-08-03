'use strict'

const crypto = require('crypto')

/**
 * 计算单个成员与座位的匹配得分（沿用现有靠窗/安静计分规则）
 * @param {{wantsWindow: boolean, needsQuiet: boolean}} member 成员偏好
 * @param {{isWindow: boolean, isQuiet: boolean}} seat 座位属性
 * @returns {number} 匹配得分
 */
function scorePair(member, seat) {
  let score = 0
  if (member.wantsWindow && seat.isWindow) score += 10
  if (member.wantsWindow && !seat.isWindow) score -= 5
  if (member.needsQuiet && seat.isQuiet) score += 10
  if (member.needsQuiet && !seat.isQuiet) score -= 5
  if (!member.wantsWindow && seat.isWindow) score += 1
  if (!member.needsQuiet && seat.isQuiet) score += 1
  return score
}

/**
 * 判断成员的靠窗偏好是否被座位满足
 * @param {{wantsWindow: boolean}} member 成员
 * @param {{isWindow: boolean}} seat 座位
 * @returns {boolean|null} 无该偏好时返回 null
 */
function windowMet(member, seat) {
  if (!member.wantsWindow) return null
  return seat.isWindow
}

/**
 * 判断成员的安静偏好是否被座位满足
 * @param {{needsQuiet: boolean}} member 成员
 * @param {{isQuiet: boolean}} seat 座位
 * @returns {boolean|null} 无该偏好时返回 null
 */
function quietMet(member, seat) {
  if (!member.needsQuiet) return null
  return seat.isQuiet
}

/**
 * 计算当前成员、座位与分配（含锁定状态）的状态指纹，用于预览过期判断
 * @param {Array<object>} members 成员列表
 * @param {Array<object>} seats 座位列表
 * @param {Array<object>} assignments 当前分配列表
 * @returns {string} 状态指纹（同一份数据必然得到同一指纹）
 */
function computeStateHash(members, seats, assignments) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ members, seats, assignments }))
    .digest('hex')
}

function compareById(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 从所有可行分配中搜索整体总得分最高的方案。
 * 成员按 id 升序逐个决策：可以尝试任一空闲座位；仅当剩余成员多于剩余座位时
 * 才可以保持未分配，因此分配人数恒等于成员数与座位数的较小值——
 * 成员不多于座位时全员入座，成员多于座位时全部座位用尽（即使总得分为负）。
 * 总分相同的多套方案保留按固定遍历顺序先找到的一套，同样的输入必然得到同样的结果。
 * @param {Array<object>} members 待分配成员（不含已锁定成员）
 * @param {Array<object>} seats 可用座位（不含已锁定座位）
 * @returns {{assignments: Array<{memberId: string, seatId: string, score: number}>, unassigned: string[], totalScore: number}}
 */
function findBestAssignment(members, seats) {
  const sortedMembers = [...members].sort(compareById)
  const sortedSeats = [...seats].sort(compareById)
  const memberCount = sortedMembers.length
  const seatCount = sortedSeats.length

  if (memberCount === 0) {
    return { assignments: [], unassigned: [], totalScore: 0 }
  }

  const scoreMatrix = sortedMembers.map(m => sortedSeats.map(s => scorePair(m, s)))

  const usedSeat = new Array(seatCount).fill(false)
  const currentSeatOf = new Array(memberCount).fill(-1)
  let best = null

  function dfs(memberIdx, currentTotal, seatsLeft) {
    if (memberIdx === memberCount || seatsLeft === 0) {
      if (best === null || currentTotal > best.total) {
        best = { total: currentTotal, seatOf: currentSeatOf.slice() }
      }
      return
    }
    // 上界剪枝：总分持平的方案按遍历顺序保留先找到的一套，上界不超过当前最优即可剪枝。
    // 剩余成员不超过剩余座位时全员必须入座，最高分允许为负；
    // 否则必然有 memberCount-memberIdx-seatsLeft 人保持未分配（贡献 0），故按 0 封底后取前 seatsLeft 个
    const remainingCount = memberCount - memberIdx
    const mustSitAll = remainingCount <= seatsLeft
    const bounds = []
    for (let i = memberIdx; i < memberCount; i++) {
      let max = mustSitAll ? -Infinity : 0
      for (let j = 0; j < seatCount; j++) {
        if (!usedSeat[j] && scoreMatrix[i][j] > max) max = scoreMatrix[i][j]
      }
      bounds.push(max)
    }
    bounds.sort((a, b) => b - a)
    let remaining = 0
    const take = Math.min(seatsLeft, bounds.length)
    for (let i = 0; i < take; i++) remaining += bounds[i]
    if (currentTotal + remaining <= (best ? best.total : -Infinity)) return

    for (let j = 0; j < seatCount; j++) {
      if (usedSeat[j]) continue
      usedSeat[j] = true
      currentSeatOf[memberIdx] = j
      dfs(memberIdx + 1, currentTotal + scoreMatrix[memberIdx][j], seatsLeft - 1)
      usedSeat[j] = false
      currentSeatOf[memberIdx] = -1
    }
    // 仅座位不足时才允许跳过当前成员，保证分配人数恒为成员数与座位数的较小值；
    // 跳过分支放在座位分支之后，同分时优先让 id 靠前的成员入座
    if (remainingCount > seatsLeft) {
      dfs(memberIdx + 1, currentTotal, seatsLeft)
    }
  }

  dfs(0, 0, Math.min(memberCount, seatCount))

  const assignments = []
  const unassigned = []
  for (let i = 0; i < memberCount; i++) {
    const seatIdx = best.seatOf[i]
    if (seatIdx === -1) {
      unassigned.push(sortedMembers[i].id)
    } else {
      assignments.push({
        memberId: sortedMembers[i].id,
        seatId: sortedSeats[seatIdx].id,
        score: scoreMatrix[i][seatIdx]
      })
    }
  }

  return { assignments, unassigned, totalScore: best.total }
}

/**
 * 基于当前完整数据生成整套分配方案：锁定项原样保留，
 * 仅对剩余成员与空闲座位重新计算总得分最高的分配。
 * @param {Array<object>} members 全部成员
 * @param {Array<object>} seats 全部座位
 * @param {Array<object>} currentAssignments 当前分配（含锁定标记）
 * @returns {{assignments: Array<{memberId: string, seatId: string, locked: boolean, score: number, windowMet: boolean|null, quietMet: boolean|null}>, unassigned: string[], totalScore: number}}
 */
function buildAssignmentPlan(members, seats, currentAssignments) {
  const memberMap = new Map(members.map(m => [m.id, m]))
  const seatMap = new Map(seats.map(s => [s.id, s]))

  const locked = currentAssignments.filter(
    a => a.locked && memberMap.has(a.memberId) && seatMap.has(a.seatId)
  )
  const lockedSeatIds = new Set(locked.map(a => a.seatId))
  const lockedMemberIds = new Set(locked.map(a => a.memberId))

  const freeMembers = members.filter(m => !lockedMemberIds.has(m.id))
  const freeSeats = seats.filter(s => !lockedSeatIds.has(s.id))

  const best = findBestAssignment(freeMembers, freeSeats)

  const lockedEntries = locked.map(a => {
    const member = memberMap.get(a.memberId)
    const seat = seatMap.get(a.seatId)
    return {
      memberId: a.memberId,
      seatId: a.seatId,
      locked: true,
      score: scorePair(member, seat),
      windowMet: windowMet(member, seat),
      quietMet: quietMet(member, seat)
    }
  })

  const newEntries = best.assignments.map(a => {
    const member = memberMap.get(a.memberId)
    const seat = seatMap.get(a.seatId)
    return {
      memberId: a.memberId,
      seatId: a.seatId,
      locked: false,
      score: a.score,
      windowMet: windowMet(member, seat),
      quietMet: quietMet(member, seat)
    }
  })

  const assignments = [...lockedEntries, ...newEntries]
  const totalScore = assignments.reduce((sum, a) => sum + a.score, 0)

  return { assignments, unassigned: best.unassigned, totalScore }
}

module.exports = {
  scorePair,
  windowMet,
  quietMet,
  computeStateHash,
  findBestAssignment,
  buildAssignmentPlan
}
