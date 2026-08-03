/**
 * 座位分配核心逻辑（服务端唯一实现）。
 *
 * 该模块被 Express 服务端与测试共同复用，保证「预览」与「正式保存」
 * 使用完全相同的计分与最佳方案算法，避免用户看到的方案和最终写入的方案不一致。
 */

/**
 * 计算某个成员坐在某个座位上的得分，沿用项目原有的靠窗/安静计分规则。
 * @param {{wantsWindow: boolean, needsQuiet: boolean}} member 成员
 * @param {{isWindow: boolean, isQuiet: boolean}} seat 座位
 * @returns {number} 该成员-座位组合的得分
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
 * 匈牙利算法（Kuhn-Munkres）求方阵的最小费用完美匹配。
 * 说明：这里用最小费用求解，是把「最大总得分」取负后转化而来；
 * 该算法对固定输入是确定性的，因此天然满足「相同输入结果一致」的要求。
 * @param {number[][]} cost n×n 费用矩阵
 * @returns {number[]} rowToCol，rowToCol[i] 为第 i 行匹配到的列下标
 */
function minCostAssignment(cost) {
  const n = cost.length
  const INF = Infinity
  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0)
  const way = new Array(n + 1).fill(0)

  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(INF)
    const used = new Array(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = -1
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
          if (cur < minv[j]) {
            minv[j] = cur
            way[j] = j0
          }
          if (minv[j] < delta) {
            delta = minv[j]
            j1 = j
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }

  const rowToCol = new Array(n).fill(-1)
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) rowToCol[p[j] - 1] = j - 1
  }
  return rowToCol
}

/**
 * 从所有可行分配中选出整体总得分最高的方案（而非逐个成员贪心）。
 * @param {Array<{id: string, wantsWindow: boolean, needsQuiet: boolean}>} members 待分配成员
 * @param {Array<{id: string, isWindow: boolean, isQuiet: boolean}>} seats 空闲座位
 * @returns {Array<{memberId: string, seatId: string}>} 成员到座位的最佳匹配（数量为 min(成员数, 座位数)）
 */
function assignOptimal(members, seats) {
  if (members.length === 0 || seats.length === 0) return []

  const m = members.length
  const s = seats.length
  const n = Math.max(m, s)

  // BASE 远大于任一得分区间，先保证被分配的人数最大化（= min(成员数,座位数)），
  // 在此前提下再最大化总得分；padding 出来的虚拟行/列费用为 0，代表未分配或空座。
  const BASE = 1000
  const cost = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < s; j++) {
      cost[i][j] = -(BASE + scorePair(members[i], seats[j]))
    }
  }

  const rowToCol = minCostAssignment(cost)
  const result = []
  for (let i = 0; i < m; i++) {
    const j = rowToCol[i]
    if (j >= 0 && j < s) {
      result.push({ memberId: members[i].id, seatId: seats[j].id })
    }
  }
  return result
}

/**
 * 生成简短稳定的签名字符串，用于「预览是否过期」的判断。
 * 只要成员、座位或锁定状态发生变化，签名就会改变，从而使旧预览立即失效。
 * @param {Array<object>} members 成员列表
 * @param {Array<object>} seats 座位列表
 * @param {Array<object>} assignments 当前分配（含锁定状态）
 * @returns {string} 输入状态的确定性签名
 */
function computeSignature(members, seats, assignments) {
  const memberPart = members.map(m => `${m.id}:${m.wantsWindow ? 1 : 0}${m.needsQuiet ? 1 : 0}`)
  const seatPart = seats.map(s => `${s.id}:${s.isWindow ? 1 : 0}${s.isQuiet ? 1 : 0}`)
  // 仅锁定项会影响下一次分配的固定部分，因此过期判断以锁定项为准。
  const lockedPart = assignments
    .filter(a => a.locked)
    .map(a => `${a.memberId}>${a.seatId}`)
    .sort()
  const raw = JSON.stringify({ m: memberPart, s: seatPart, l: lockedPart })

  // djb2 哈希，输出短小且确定，避免把冗长 JSON 直接暴露给前端。
  let hash = 5381
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}

/**
 * 基于当前成员、座位与已锁定分配，构建完整的分配方案（预览与保存共用）。
 * @param {Array<object>} members 全部成员
 * @param {Array<object>} seats 全部座位
 * @param {Array<object>} assignments 当前分配（用于读取锁定项）
 * @returns {{
 *   signature: string,
 *   totalScore: number,
 *   assignments: Array<{memberId: string, seatId: string, locked: boolean}>,
 *   assigned: Array<object>,
 *   unassignedMembers: Array<object>,
 *   emptySeats: string[]
 * }} 结构化方案，供前端展示及后续手动调位使用
 */
function buildPlan(members, seats, assignments) {
  const memberMap = new Map(members.map(m => [m.id, m]))
  const seatMap = new Map(seats.map(s => [s.id, s]))

  // 已锁定的成员与座位原样保留，只对剩余成员和空闲座位重新计算。
  const locked = assignments.filter(a => a.locked && memberMap.has(a.memberId) && seatMap.has(a.seatId))
  const lockedMemberIds = new Set(locked.map(a => a.memberId))
  const lockedSeatIds = new Set(locked.map(a => a.seatId))

  const freeMembers = members.filter(m => !lockedMemberIds.has(m.id))
  const freeSeats = seats.filter(s => !lockedSeatIds.has(s.id))

  const optimal = assignOptimal(freeMembers, freeSeats)

  const finalAssignments = [
    ...locked.map(a => ({ memberId: a.memberId, seatId: a.seatId, locked: true })),
    ...optimal.map(a => ({ memberId: a.memberId, seatId: a.seatId, locked: false }))
  ]

  const assignedMemberIds = new Set(finalAssignments.map(a => a.memberId))
  const assignedSeatIds = new Set(finalAssignments.map(a => a.seatId))

  let totalScore = 0
  const assigned = finalAssignments.map(a => {
    const member = memberMap.get(a.memberId)
    const seat = seatMap.get(a.seatId)
    const score = scorePair(member, seat)
    totalScore += score
    return {
      memberId: member.id,
      memberName: member.name,
      team: member.team,
      seatId: seat.id,
      area: seat.area,
      wantsWindow: member.wantsWindow,
      needsQuiet: member.needsQuiet,
      isWindow: seat.isWindow,
      isQuiet: seat.isQuiet,
      windowMet: member.wantsWindow ? seat.isWindow : null,
      quietMet: member.needsQuiet ? seat.isQuiet : null,
      score,
      locked: a.locked
    }
  })

  const unassignedMembers = members
    .filter(m => !assignedMemberIds.has(m.id))
    .map(m => ({
      memberId: m.id,
      name: m.name,
      team: m.team,
      wantsWindow: m.wantsWindow,
      needsQuiet: m.needsQuiet
    }))

  const emptySeats = seats.filter(s => !assignedSeatIds.has(s.id)).map(s => s.id)

  return {
    signature: computeSignature(members, seats, assignments),
    totalScore,
    assignments: finalAssignments,
    assigned,
    unassignedMembers,
    emptySeats
  }
}

module.exports = {
  scorePair,
  assignOptimal,
  computeSignature,
  buildPlan
}
