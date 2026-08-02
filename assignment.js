const crypto = require('crypto')

/**
 * 计算单个成员与座位的匹配得分。
 * 沿用项目既有规则：靠窗/安静偏好满足加分，不满足减分；无偏好时坐到特色座位有少量加分。
 * @param {Object} member 成员对象，需包含 wantsWindow、needsQuiet
 * @param {Object} seat 座位对象，需包含 isWindow、isQuiet
 * @returns {number}
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
 * 判断靠窗偏好是否满足。成员无此偏好时返回 null。
 * @param {Object} member
 * @param {Object} seat
 * @returns {boolean|null}
 */
function windowMet(member, seat) {
  if (!member.wantsWindow) return null
  return seat.isWindow
}

/**
 * 判断安静偏好是否满足。成员无此偏好时返回 null。
 * @param {Object} member
 * @param {Object} seat
 * @returns {boolean|null}
 */
function quietMet(member, seat) {
  if (!member.needsQuiet) return null
  return seat.isQuiet
}

/**
 * 匈牙利算法（O(n^3)）求解最小权完美匹配。
 * costMatrix 为方阵，返回 result[i] = 第 i 行匹配的列下标。
 * @param {number[][]} costMatrix
 * @returns {number[]}
 */
function hungarianMin(costMatrix) {
  const n = costMatrix.length
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
      let j1 = 0

      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = costMatrix[i0 - 1][j - 1] - u[i0] - v[j]
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
    } while (j0 !== 0)
  }

  const result = new Array(n)
  for (let j = 1; j <= n; j++) {
    result[p[j] - 1] = j - 1
  }
  return result
}

/**
 * 从所有可行分配中选择整体总得分最高的方案。
 * 使用匈牙利算法求解最大权匹配；通过固定排序与微小确定性平局权重，
 * 保证相同输入下结果一致，且总分相同时按"成员id升序优先获得id更小的座位"决出唯一方案。
 * @param {Object[]} members 待分配成员
 * @param {Object[]} seats 空闲座位
 * @returns {Array<{memberId:string,seatId:string,score:number}>}
 */
function findOptimalAssignment(members, seats) {
  if (members.length === 0 || seats.length === 0) return []

  // 固定排序，保证相同输入下矩阵构造顺序一致，从而结果可复现
  const ms = [...members].sort((a, b) => a.id.localeCompare(b.id))
  const ss = [...seats].sort((a, b) => a.id.localeCompare(b.id))
  const r = ms.length
  const c = ss.length
  const n = Math.max(r, c)

  // 主分放大系数，确保平局权重不会影响真实总分排序
  const BIG = 100000
  // 虚拟行列（代表未分配/空座）使用极低分，确保真实配对总是优先于未分配
  const DUMMY = -100000

  // 构造扩增方阵：augmented[i][j] = 主分*BIG + 平局权重
  // 平局权重使编号更小的成员优先拿到编号更小的座位，从而在总分相同时得到确定性唯一解
  const matrix = new Array(n)
  for (let i = 0; i < n; i++) {
    matrix[i] = new Array(n)
    for (let j = 0; j < n; j++) {
      if (i < r && j < c) {
        const base = scorePair(ms[i], ss[j])
        const tie = (n - i) * (n + 1) + (n - j)
        matrix[i][j] = base * BIG + tie
      } else {
        matrix[i][j] = DUMMY
      }
    }
  }

  // 最大权转最小权：用最大值减去每个元素
  let maxVal = -Infinity
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (matrix[i][j] > maxVal) maxVal = matrix[i][j]
    }
  }
  const cost = new Array(n)
  for (let i = 0; i < n; i++) {
    cost[i] = new Array(n)
    for (let j = 0; j < n; j++) {
      cost[i][j] = maxVal - matrix[i][j]
    }
  }

  const matching = hungarianMin(cost)

  const assignments = []
  for (let i = 0; i < r; i++) {
    const j = matching[i]
    // 跳过被分配到虚拟列（未分配）的成员
    if (j >= c) continue
    const member = ms[i]
    const seat = ss[j]
    assignments.push({
      memberId: member.id,
      seatId: seat.id,
      score: scorePair(member, seat)
    })
  }

  return assignments
}

/**
 * 计算当前状态指纹，用于判断预览是否过期。
 * 指纹覆盖成员属性、座位属性以及锁定分配；锁定/解锁/清空都会改变指纹。
 * @param {Object[]} members
 * @param {Object[]} seats
 * @param {Object[]} assignments 当前分配（含 locked 标记）
 * @returns {string} sha256 十六进制指纹
 */
function computeFingerprint(members, seats, assignments) {
  const memberPart = [...members]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(m => `${m.id}:${m.wantsWindow ? 1 : 0}:${m.needsQuiet ? 1 : 0}`)
    .join('|')

  const seatPart = [...seats]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(s => `${s.id}:${s.area}:${s.isWindow ? 1 : 0}:${s.isQuiet ? 1 : 0}`)
    .join('|')

  // 包含全部分配（含未锁定），确保锁定、解锁、清空等任何变更都会使指纹变化
  const assignmentPart = [...assignments]
    .sort((a, b) => {
      const c = a.memberId.localeCompare(b.memberId)
      return c !== 0 ? c : a.seatId.localeCompare(b.seatId)
    })
    .map(a => `${a.memberId}->${a.seatId}:${a.locked ? 1 : 0}`)
    .join('|')

  const canonical = `M{${memberPart}}S{${seatPart}}A{${assignmentPart}}`
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

/**
 * 基于当前数据生成完整预览方案（不写文件）。
 * 锁定分配原样保留，仅对剩余成员与空闲座位做全局最优计算。
 * @param {Object[]} members
 * @param {Object[]} seats
 * @param {Object[]} assignments
 * @returns {{fingerprint:string,totalScore:number,assignments:Object[],unassignedMembers:Object[]}}
 */
function buildPreview(members, seats, assignments) {
  const memberMap = new Map(members.map(m => [m.id, m]))
  const seatMap = new Map(seats.map(s => [s.id, s]))

  const locked = assignments.filter(a => a.locked)
  const lockedSeatIds = new Set(locked.map(a => a.seatId))
  const lockedMemberIds = new Set(locked.map(a => a.memberId))

  const freeMembers = members.filter(m => !lockedMemberIds.has(m.id))
  const freeSeats = seats.filter(s => !lockedSeatIds.has(s.id))

  const optimal = findOptimalAssignment(freeMembers, freeSeats)
  const assignedMemberIds = new Set(optimal.map(a => a.memberId))

  const resultAssignments = []

  for (const a of locked) {
    const member = memberMap.get(a.memberId)
    const seat = seatMap.get(a.seatId)
    resultAssignments.push({
      memberId: a.memberId,
      memberName: member ? member.name : a.memberId,
      team: member ? member.team : '',
      seatId: a.seatId,
      area: seat ? seat.area : '',
      isWindow: seat ? seat.isWindow : false,
      isQuiet: seat ? seat.isQuiet : false,
      score: member && seat ? scorePair(member, seat) : 0,
      locked: true,
      windowMet: member && seat ? windowMet(member, seat) : null,
      quietMet: member && seat ? quietMet(member, seat) : null
    })
  }

  for (const a of optimal) {
    const member = memberMap.get(a.memberId)
    const seat = seatMap.get(a.seatId)
    resultAssignments.push({
      memberId: a.memberId,
      memberName: member ? member.name : a.memberId,
      team: member ? member.team : '',
      seatId: a.seatId,
      area: seat ? seat.area : '',
      isWindow: seat ? seat.isWindow : false,
      isQuiet: seat ? seat.isQuiet : false,
      score: a.score,
      locked: false,
      windowMet: member && seat ? windowMet(member, seat) : null,
      quietMet: member && seat ? quietMet(member, seat) : null
    })
  }

  const unassignedMembers = freeMembers
    .filter(m => !assignedMemberIds.has(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(m => ({
      id: m.id,
      name: m.name,
      team: m.team,
      wantsWindow: m.wantsWindow,
      needsQuiet: m.needsQuiet
    }))

  const totalScore = resultAssignments.reduce((sum, a) => sum + a.score, 0)
  const fingerprint = computeFingerprint(members, seats, assignments)

  return {
    fingerprint,
    totalScore,
    assignments: resultAssignments,
    unassignedMembers
  }
}

/**
 * 根据预览确认结果构造要写入 assignments.json 的数据。
 * 仅当指纹与当前状态一致时才应调用本函数。
 * @param {Object[]} members
 * @param {Object[]} seats
 * @param {Object[]} assignments
 * @returns {Object[]} 可直接写入的分配数组
 */
function buildConfirmedAssignments(members, seats, assignments) {
  const preview = buildPreview(members, seats, assignments)
  return preview.assignments.map(a => ({
    memberId: a.memberId,
    seatId: a.seatId,
    locked: a.locked
  }))
}

module.exports = {
  scorePair,
  windowMet,
  quietMet,
  findOptimalAssignment,
  computeFingerprint,
  buildPreview,
  buildConfirmedAssignments
}
