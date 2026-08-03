/**
 * 计算单个成员与单个座位的匹配得分。
 * 沿用项目既有计分规则：
 * - 偏好靠窗：命中 +10，未命中 -5
 * - 偏好安静：命中 +10，未命中 -5
 * - 无对应偏好时：命中该属性 +1（让属性不被浪费）
 * @param {object} member 成员
 * @param {object} seat 座位
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
 * 使用 Kuhn-Munkres 算法在方阵 cost 上求最小权匹配。
 * 输入必须为 n×n 方阵；返回长度为 n 的数组 matchCol，
 * matchCol[row] = col 表示第 row 行匹配第 col 列。
 *
 * 这里不直接处理矩形匹配：调用方负责补齐虚拟行/列。
 * 成员与座位均在外部按 id 排序，算法内部按固定下标顺序遍历，
 * 因此同一份输入的匹配结果是确定的，不会因刷新而变化。
 *
 * @param {number[][]} cost 方阵权值矩阵
 * @returns {number[]} 每行匹配的列下标
 */
function kuhmMunkresMin(cost) {
  const n = cost.length
  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0)
  const way = new Array(n + 1).fill(0)

  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(Infinity)
    const used = new Array(n + 1).fill(false)

    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity
      let j1 = -1

      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
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
    } while (j0 !== 0)
  }

  const matchCol = new Array(n).fill(-1)
  for (let j = 1; j <= n; j++) {
    if (p[j] !== 0) matchCol[p[j] - 1] = j - 1
  }
  return matchCol
}

/**
 * 对成员与座位做全局最优分配。
 *
 * 与旧的“按分数从高到低占一个算一个”不同，这里把问题视为
 * 二分图最大权匹配：同时考虑所有成员与所有空闲座位，选择
 * 总得分最高的一套方案，避免前排成员抢占资源导致后续成员
 * 偏好集体落空。
 *
 * 成员数与座位数不相等时，用虚拟行/列补齐为方阵：
 * - 座位更多：多出的座位保留为空
 * - 成员更多：多出的成员进入未分配列表
 * 虚拟边的权值设为 0，既不增加也不扣减真实总得分。
 *
 * @param {object[]} members 待分配成员数组
 * @param {object[]} seats 空闲座位数组
 * @returns {{ assignments: {memberId: string, seatId: string}[], unassignedMemberIds: string[], totalScore: number }}
 */
function computeBestAssignment(members, seats) {
  const sortedMembers = [...members].sort((a, b) => a.id.localeCompare(b.id))
  const sortedSeats = [...seats].sort((a, b) => a.id.localeCompare(b.id))

  const m = sortedMembers.length
  const n = sortedSeats.length

  if (m === 0 || n === 0) {
    return {
      assignments: [],
      unassignedMemberIds: sortedMembers.map(x => x.id),
      totalScore: 0
    }
  }

  const size = Math.max(m, n)
  const matrix = []
  for (let i = 0; i < size; i++) {
    const row = []
    for (let j = 0; j < size; j++) {
      if (i < m && j < n) {
        // 取负：KM 求最小权，等价于求原得分最大权
        row.push(-scorePair(sortedMembers[i], sortedSeats[j]))
      } else {
        row.push(0)
      }
    }
    matrix.push(row)
  }

  const matchCol = kuhmMunkresMin(matrix)

  const assignments = []
  const unassignedMemberIds = []
  let totalScore = 0

  for (let i = 0; i < m; i++) {
    const j = matchCol[i]
    if (j >= 0 && j < n) {
      const member = sortedMembers[i]
      const seat = sortedSeats[j]
      assignments.push({ memberId: member.id, seatId: seat.id })
      totalScore += scorePair(member, seat)
    } else {
      unassignedMemberIds.push(sortedMembers[i].id)
    }
  }

  assignments.sort((a, b) => a.memberId.localeCompare(b.memberId))
  unassignedMemberIds.sort((a, b) => a.localeCompare(b))

  return { assignments, unassignedMemberIds, totalScore }
}

/**
 * 根据完整输入生成分配预览方案，但不写入任何文件。
 * 已锁定的成员/座位原样保留，只对剩余成员与空闲座位做全局最优分配。
 *
 * 该函数保持纯净，只负责计算分配结果，不处理版本号/过期判断；
 * 版本号由服务端统一附加与校验，预览与保存复用同一套计算逻辑。
 *
 * @param {object[]} allMembers 全部成员
 * @param {object[]} allSeats 全部座位
 * @param {object[]} currentAssignments 当前已保存的分配
 * @returns {{
 *   newAssignments: {memberId: string, seatId: string, locked: boolean}[],
 *   details: Array,
 *   unassignedMembers: Array,
 *   totalScore: number
 * }}
 */
function buildPreview(allMembers, allSeats, currentAssignments) {
  const memberMap = new Map(allMembers.map(m => [m.id, m]))
  const seatMap = new Map(allSeats.map(s => [s.id, s]))

  const locked = currentAssignments.filter(a => a.locked)
  const lockedSeatIds = new Set(locked.map(a => a.seatId))
  const lockedMemberIds = new Set(locked.map(a => a.memberId))

  const freeMembers = allMembers.filter(m => !lockedMemberIds.has(m.id))
  const freeSeats = allSeats.filter(s => !lockedSeatIds.has(s.id))

  const result = computeBestAssignment(freeMembers, freeSeats)

  const newAssignments = [
    ...locked.map(a => ({ memberId: a.memberId, seatId: a.seatId, locked: true })),
    ...result.assignments.map(a => ({ memberId: a.memberId, seatId: a.seatId, locked: false }))
  ]

  const details = newAssignments.map(a => {
    const member = memberMap.get(a.memberId)
    const seat = seatMap.get(a.seatId)
    return {
      memberId: a.memberId,
      memberName: member ? member.name : '',
      team: member ? member.team : '',
      seatId: a.seatId,
      area: seat ? seat.area : '',
      isWindow: seat ? seat.isWindow : false,
      isQuiet: seat ? seat.isQuiet : false,
      windowMet: member && member.wantsWindow ? seat ? seat.isWindow : false : null,
      quietMet: member && member.needsQuiet ? seat ? seat.isQuiet : false : null,
      locked: a.locked,
      score: scorePair(member || {}, seat || {})
    }
  })

  details.sort((a, b) => {
    if (a.locked !== b.locked) return a.locked ? -1 : 1
    return a.memberId.localeCompare(b.memberId)
  })

  const unassignedMembers = result.unassignedMemberIds.map(id => {
    const member = memberMap.get(id)
    return member
      ? { memberId: id, memberName: member.name, team: member.team,
          wantsWindow: member.wantsWindow, needsQuiet: member.needsQuiet }
      : { memberId: id, memberName: '', team: '', wantsWindow: false, needsQuiet: false }
  })

  // 总得分包含锁定项，完整反映整套方案
  const totalScore = details.reduce((sum, d) => sum + d.score, 0)

  return { newAssignments, details, unassignedMembers, totalScore }
}

module.exports = {
  scorePair,
  computeBestAssignment,
  buildPreview
}
