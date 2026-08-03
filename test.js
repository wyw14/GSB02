const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const {
  scorePair,
  computeBestAssignment,
  buildPreview
} = require('./assigner')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.stack || e.message}`)
  }
}

async function asyncTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.stack || e.message}`)
  }
}

/**
 * 复现旧的贪心分配：按单个配对分数从高到低排序，逐个占用座位。
 * @param {object[]} members
 * @param {object[]} seats
 * @returns {{memberId: string, seatId: string}[]}
 */
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
    result.push({ memberId: pair.memberId, seatId: pair.seatId })
    usedMembers.add(pair.memberId)
    usedSeats.add(pair.seatId)
  }
  return result
}

function sumScore(pairs, members, seats) {
  return pairs.reduce((sum, p) => {
    const m = members.find(x => x.id === p.memberId)
    const s = seats.find(x => x.id === p.seatId)
    return sum + scorePair(m, s)
  }, 0)
}

/** 枚举所有完美匹配的最大总分，用于验证 KM 结果的全局最优性 */
function enumerateMax(members, seats) {
  const n = members.length
  const used = new Array(seats.length).fill(false)
  let best = -Infinity
  function dfs(i, cur) {
    if (i === n) {
      if (cur > best) best = cur
      return
    }
    for (let j = 0; j < seats.length; j++) {
      if (used[j]) continue
      used[j] = true
      dfs(i + 1, cur + scorePair(members[i], seats[j]))
      used[j] = false
    }
  }
  dfs(0, 0)
  return best
}

console.log('\n=== 1. 计分规则 ===')

test('靠窗偏好命中加10，未命中减5', () => {
  const m = { wantsWindow: true, needsQuiet: false }
  assert.strictEqual(scorePair(m, { isWindow: true, isQuiet: false }), 10)
  assert.strictEqual(scorePair(m, { isWindow: false, isQuiet: false }), -5)
})

test('安静偏好命中加10，未命中减5', () => {
  const m = { wantsWindow: false, needsQuiet: true }
  assert.strictEqual(scorePair(m, { isWindow: false, isQuiet: true }), 10)
  assert.strictEqual(scorePair(m, { isWindow: false, isQuiet: false }), -5)
})

test('无偏好时属性命中加1', () => {
  const m = { wantsWindow: false, needsQuiet: false }
  assert.strictEqual(scorePair(m, { isWindow: true, isQuiet: false }), 1)
  assert.strictEqual(scorePair(m, { isWindow: false, isQuiet: true }), 1)
  assert.strictEqual(scorePair(m, { isWindow: true, isQuiet: true }), 2)
  assert.strictEqual(scorePair(m, { isWindow: false, isQuiet: false }), 0)
})

console.log('\n=== 2. 全局最优：旧贪心逐个分配失败的例子 ===')

test('旧贪心逐个分配的总分严格低于全局最优', () => {
  // 反例（程序枚举验证）：
  // 成员 A（只靠窗 W）、B（只安静 Q）
  // 座位 s0(W)、s1(WQ 靠窗+安静)
  //
  // 分数矩阵：
  //        s0(W)  s1(WQ)
  //   A     10      11
  //   B     -4      11
  //
  // 旧贪心按单对分降序：A-s1(11) → B-s0(-4) = 7
  // 全局最优：A-s0(10) + B-s1(11) = 21
  // 贪心为了让 A 多拿 1 分，导致 B 损失 15 分，整体总分更低。
  const members = [
    { id: 'A', wantsWindow: true, needsQuiet: false },
    { id: 'B', wantsWindow: false, needsQuiet: true }
  ]
  const seats = [
    { id: 's0', isWindow: true, isQuiet: false },
    { id: 's1', isWindow: true, isQuiet: true }
  ]
  const best = computeBestAssignment(members, seats)
  const greedy = greedyAssign(members, seats)
  const greedyScore = sumScore(greedy, members, seats)
  const enumMax = enumerateMax(members, seats)

  assert.strictEqual(enumMax, 21, '枚举最优应为 21')
  assert.strictEqual(greedyScore, 7, '旧贪心只能得到 7')
  assert.strictEqual(best.totalScore, 21, '全局最优必须得到 21')
  assert.ok(best.totalScore > greedyScore,
    `全局最优 ${best.totalScore} 必须严格大于贪心 ${greedyScore}`)

  const aMap = Object.fromEntries(best.assignments.map(a => [a.memberId, a.seatId]))
  assert.strictEqual(aMap.A, 's0')
  assert.strictEqual(aMap.B, 's1')

  // 带锁定的场景：锁定项保持不变，剩余部分全局最优
  const lockedMembers = [
    { id: 'A', wantsWindow: true, needsQuiet: false },
    { id: 'B', wantsWindow: true, needsQuiet: true },
    { id: 'C', wantsWindow: false, needsQuiet: true }
  ]
  const lockedSeats = [
    { id: 's1', isWindow: true, isQuiet: false },
    { id: 's2', isWindow: false, isQuiet: true },
    { id: 's3', isWindow: true, isQuiet: true }
  ]
  const preview = buildPreview(lockedMembers, lockedSeats, [
    { memberId: 'A', seatId: 's3', locked: true }
  ])
  const aAssigned = preview.newAssignments.find(a => a.memberId === 'A')
  assert.strictEqual(aAssigned.seatId, 's3')
  assert.strictEqual(aAssigned.locked, true)
  const bAssigned = preview.newAssignments.find(a => a.memberId === 'B')
  const cAssigned = preview.newAssignments.find(a => a.memberId === 'C')
  assert.strictEqual(bAssigned.seatId, 's1')
  assert.strictEqual(cAssigned.seatId, 's2')

  // 完整数据：KM 不劣于贪心
  const allMembers = require('./data/members.json')
  const allSeats = require('./data/seats.json')
  const bestAll = computeBestAssignment(allMembers, allSeats)
  const greedyAll = greedyAssign(allMembers, allSeats)
  const greedyAllScore = sumScore(greedyAll, allMembers, allSeats)
  assert.ok(
    bestAll.totalScore >= greedyAllScore,
    `全局最优 ${bestAll.totalScore} 应 >= 贪心 ${greedyAllScore}`
  )
  console.log(`    完整数据：全局最优总分=${bestAll.totalScore}, 旧贪心总分=${greedyAllScore}`)
})

console.log('\n=== 3. 锁定座位保持不变 ===')

test('锁定的成员和座位原样保留，只重新分配剩余部分', () => {
  const members = [
    { id: 'm1', name: 'A', wantsWindow: true, needsQuiet: false },
    { id: 'm2', name: 'B', wantsWindow: true, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', area: 'A', isWindow: true, isQuiet: false },
    { id: 's2', area: 'A', isWindow: true, isQuiet: true }
  ]
  const assignments = [
    { memberId: 'm1', seatId: 's1', locked: true }
  ]
  const preview = buildPreview(members, seats, assignments)
  const locked = preview.newAssignments.filter(a => a.locked)
  assert.strictEqual(locked.length, 1)
  assert.strictEqual(locked[0].memberId, 'm1')
  assert.strictEqual(locked[0].seatId, 's1')
  const m2 = preview.newAssignments.find(a => a.memberId === 'm2')
  assert.ok(m2)
  assert.strictEqual(m2.seatId, 's2')
  assert.strictEqual(m2.locked, false)
})

console.log('\n=== 4. 成员多于/少于座位 ===')

test('成员多于座位时，部分成员未分配', () => {
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false },
    { id: 'm2', wantsWindow: false, needsQuiet: true },
    { id: 'm3', wantsWindow: true, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: false }
  ]
  const result = computeBestAssignment(members, seats)
  assert.strictEqual(result.assignments.length, 1)
  assert.strictEqual(result.unassignedMemberIds.length, 2)
})

test('座位多于成员时，保留空座（每个成员都有座位）', () => {
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false }
  ]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: false },
    { id: 's2', isWindow: false, isQuiet: true }
  ]
  const result = computeBestAssignment(members, seats)
  assert.strictEqual(result.assignments.length, 1)
  assert.strictEqual(result.unassignedMemberIds.length, 0)
  assert.strictEqual(result.assignments[0].seatId, 's1')
})

console.log('\n=== 5. 确定性：同一份输入结果一致 ===')

test('重复调用 computeBestAssignment 结果完全一致', () => {
  const members = require('./data/members.json')
  const seats = require('./data/seats.json')
  const r1 = computeBestAssignment(members, seats)
  const r2 = computeBestAssignment(members, seats)
  assert.deepStrictEqual(r1, r2)
})

test('buildPreview 重复调用结果一致', () => {
  const members = require('./data/members.json')
  const seats = require('./data/seats.json')
  const p1 = buildPreview(members, seats, [])
  const p2 = buildPreview(members, seats, [])
  assert.deepStrictEqual(p1, p2)
})

console.log('\n=== 6. 集成测试：预览与确认接口 ===')

async function startTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-test-'))
  fs.copyFileSync(
    path.join(__dirname, 'data', 'members.json'),
    path.join(tmpDir, 'members.json')
  )
  fs.copyFileSync(
    path.join(__dirname, 'data', 'seats.json'),
    path.join(tmpDir, 'seats.json')
  )
  fs.writeFileSync(path.join(tmpDir, 'assignments.json'), '[]')

  process.env.DATA_DIR = tmpDir
  delete require.cache[require.resolve('./server')]
  const app = require('./server')
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: data
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}
        },
        res => {
          let chunks = ''
          res.on('data', c => { chunks += c })
          res.on('end', () => {
            let parsed = null
            try { parsed = JSON.parse(chunks) } catch (_) { parsed = chunks }
            resolve({ status: res.statusCode, body: parsed })
          })
        }
      )
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }

  return {
    port,
    request,
    tmpDir,
    close: () =>
      new Promise(resolve => {
        server.close(() => {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
          resolve()
        })
      })
  }
}

function readFile(srv, name) {
  return fs.readFileSync(path.join(srv.tmpDir, name), 'utf-8')
}

async function runAsyncTests() {
  await asyncTest('连续预览不修改 JSON，且 baseRevision 相同', async () => {
    const srv = await startTestServer()
    try {
      const before = readFile(srv, 'assignments.json')
      const r1 = await srv.request('POST', '/api/assign/preview')
      const r2 = await srv.request('POST', '/api/assign/preview')
      const after = readFile(srv, 'assignments.json')
      assert.strictEqual(before, after)
      assert.strictEqual(r1.status, 200)
      assert.strictEqual(r2.status, 200)
      assert.strictEqual(typeof r1.body.baseRevision, 'number')
      assert.strictEqual(r1.body.baseRevision, r2.body.baseRevision)
      assert.ok(Array.isArray(r1.body.details))
      assert.ok(typeof r1.body.totalScore === 'number')
      // 预览不应写入 meta 版本号（preview 是只读操作）
      assert.strictEqual(r1.body.baseRevision, 0)
    } finally {
      await srv.close()
    }
  })

  await asyncTest('确认后正确保存，且与预览一致', async () => {
    const srv = await startTestServer()
    try {
      const preview = await srv.request('POST', '/api/assign/preview')
      assert.strictEqual(preview.status, 200)
      const confirm = await srv.request('POST', '/api/assign/confirm', {
        baseRevision: preview.body.baseRevision
      })
      assert.strictEqual(confirm.status, 200)
      const onDisk = JSON.parse(readFile(srv, 'assignments.json'))
      // 新格式：{ revision, assignments }
      assert.strictEqual(typeof onDisk.revision, 'number')
      assert.ok(Array.isArray(onDisk.assignments))
      assert.ok(onDisk.assignments.length > 0)
      assert.deepStrictEqual(onDisk.assignments, confirm.body.newAssignments)
      // GET 接口仍返回纯数组
      const getRes = await srv.request('GET', '/api/assignments')
      assert.deepStrictEqual(getRes.body, onDisk.assignments)
    } finally {
      await srv.close()
    }
  })

  await asyncTest('写入失败时所有JSON逐字节不变（原子性：方案与修订号同一成功边界）', async () => {
    const srv = await startTestServer()
    const file = path.join(srv.tmpDir, 'assignments.json')
    // 把临时文件路径创建为目录，使 writeFileSync(tmp) 必然抛 EISDIR，
    // 从而在 rename 之前就失败，保证原 assignments.json 逐字节不变。
    const tmpPath = `${file}.tmp`
    try {
      const preview = await srv.request('POST', '/api/assign/preview')
      assert.strictEqual(preview.status, 200)

      const files = ['assignments.json', 'members.json', 'seats.json']
      const before = {}
      for (const f of files) before[f] = fs.readFileSync(path.join(srv.tmpDir, f))

      fs.mkdirSync(tmpPath)

      const confirm = await srv.request('POST', '/api/assign/confirm', {
        baseRevision: preview.body.baseRevision
      })

      assert.strictEqual(confirm.status, 500, '写入失败应返回 500')
      assert.strictEqual(confirm.body.error, 'SAVE_FAILED')

      // 所有数据文件必须逐字节不变，没有部分写入
      for (const f of files) {
        const after = fs.readFileSync(path.join(srv.tmpDir, f))
        assert.ok(
          after.equals(before[f]),
          `写入失败后 ${f} 必须逐字节不变`
        )
      }
      const getRes = await srv.request('GET', '/api/assignments')
      assert.deepStrictEqual(getRes.body, [])
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      assert.strictEqual(Array.isArray(raw) ? 0 : raw.revision, 0)
    } finally {
      try { fs.rmSync(tmpPath, { recursive: true, force: true }) } catch (_) {}
      await srv.close()
    }
  })

  await asyncTest('过期预览确认入口可重复点击：每次都返回409且JSON不变', async () => {
    const srv = await startTestServer()
    try {
      // 先保存一份非空分配
      const p0 = await srv.request('POST', '/api/assign/preview')
      await srv.request('POST', '/api/assign/confirm', {
        baseRevision: p0.body.baseRevision
      })
      // 生成预览（此时 revision=1）
      const preview = await srv.request('POST', '/api/assign/preview')
      assert.strictEqual(preview.body.baseRevision, 1)
      // 清空，推进 revision 到 2
      await srv.request('POST', '/api/clear')
      const beforeJson = readFile(srv, 'assignments.json')

      // 用过期的 baseRevision 连续确认两次，每次都应 409 且文件不变
      for (let i = 0; i < 2; i++) {
        const confirm = await srv.request('POST', '/api/assign/confirm', {
          baseRevision: preview.body.baseRevision
        })
        assert.strictEqual(confirm.status, 409, `第 ${i + 1} 次确认应返回 409`)
        assert.strictEqual(confirm.body.error, 'PREVIEW_EXPIRED')
        assert.strictEqual(
          readFile(srv, 'assignments.json'),
          beforeJson,
          `第 ${i + 1} 次过期确认不得写入任何数据`
        )
      }
      // 确认清空结果仍在（空数组）
      const getRes = await srv.request('GET', '/api/assignments')
      assert.deepStrictEqual(getRes.body, [])
    } finally {
      await srv.close()
    }
  })

  await asyncTest('锁定后旧方案无法确认（返回409）', async () => {
    const srv = await startTestServer()
    try {
      const p0 = await srv.request('POST', '/api/assign/preview')
      await srv.request('POST', '/api/assign/confirm', {
        baseRevision: p0.body.baseRevision
      })
      const preview2 = await srv.request('POST', '/api/assign/preview')
      const detail = preview2.body.details.find(d => !d.locked)
      await srv.request('POST', '/api/lock', {
        memberId: detail.memberId,
        seatId: detail.seatId
      })
      const beforeJson = readFile(srv, 'assignments.json')
      const confirm = await srv.request('POST', '/api/assign/confirm', {
        baseRevision: preview2.body.baseRevision
      })
      assert.strictEqual(confirm.status, 409)
      assert.strictEqual(confirm.body.error, 'PREVIEW_EXPIRED')
      // JSON 逐字节不变
      assert.strictEqual(readFile(srv, 'assignments.json'), beforeJson)
    } finally {
      await srv.close()
    }
  })

  await asyncTest('【回归】锁定再解锁使数据恢复原样后，旧方案仍返回409且JSON不变', async () => {
    const srv = await startTestServer()
    try {
      // 先保存一份分配，使 assignments 非空，便于锁定某个成员
      const p0 = await srv.request('POST', '/api/assign/preview')
      await srv.request('POST', '/api/assign/confirm', {
        baseRevision: p0.body.baseRevision
      })
      // 记录当前分配数组内容（用于之后比较“恢复原样”）
      const originalListRes = await srv.request('GET', '/api/assignments')
      const originalList = originalListRes.body

      // 基于当前状态生成预览
      const preview = await srv.request('POST', '/api/assign/preview')
      assert.strictEqual(preview.status, 200)
      const baseRevision = preview.body.baseRevision

      // 锁定一个成员
      const target = preview.body.details.find(d => !d.locked)
      const lockRes = await srv.request('POST', '/api/lock', {
        memberId: target.memberId,
        seatId: target.seatId
      })
      assert.strictEqual(lockRes.status, 200)
      // 再解锁，使分配数组内容回到生成预览时的原样
      const unlockRes = await srv.request('POST', '/api/unlock', {
        memberId: target.memberId
      })
      assert.strictEqual(unlockRes.status, 200)
      const restoredListRes = await srv.request('GET', '/api/assignments')
      assert.deepStrictEqual(
        restoredListRes.body,
        originalList,
        '锁定再解锁后分配数组内容应恢复原样'
      )

      // 用旧 baseRevision 确认，必须返回 409，且整个文件逐字节不变
      const beforeConfirm = readFile(srv, 'assignments.json')
      const confirm = await srv.request('POST', '/api/assign/confirm', {
        baseRevision
      })
      assert.strictEqual(confirm.status, 409)
      assert.strictEqual(confirm.body.error, 'PREVIEW_EXPIRED')
      assert.strictEqual(
        readFile(srv, 'assignments.json'),
        beforeConfirm,
        '过期确认不得写入任何数据'
      )
    } finally {
      await srv.close()
    }
  })

  await asyncTest('【回归】空分配生成预览后再次清空，旧方案返回409且JSON不变', async () => {
    const srv = await startTestServer()
    try {
      // 初始分配数组为空
      const initialRes = await srv.request('GET', '/api/assignments')
      assert.deepStrictEqual(initialRes.body, [])

      // 基于空分配生成预览
      const preview = await srv.request('POST', '/api/assign/preview')
      assert.strictEqual(preview.status, 200)
      const baseRevision = preview.body.baseRevision

      // 再次清空（数组内容仍是 []，但属于一次变更操作，revision 前进）
      const clearRes = await srv.request('POST', '/api/clear')
      assert.strictEqual(clearRes.status, 200)
      const afterClear = await srv.request('GET', '/api/assignments')
      assert.deepStrictEqual(afterClear.body, [])

      // 用旧 baseRevision 确认，必须返回 409，且文件逐字节不变
      const beforeConfirm = readFile(srv, 'assignments.json')
      const confirm = await srv.request('POST', '/api/assign/confirm', {
        baseRevision
      })
      assert.strictEqual(confirm.status, 409)
      assert.strictEqual(confirm.body.error, 'PREVIEW_EXPIRED')
      assert.strictEqual(
        readFile(srv, 'assignments.json'),
        beforeConfirm,
        '过期确认不得写入任何数据'
      )
    } finally {
      await srv.close()
    }
  })

  await asyncTest('清空后旧方案无法确认（返回409）', async () => {
    const srv = await startTestServer()
    try {
      const p0 = await srv.request('POST', '/api/assign/preview')
      await srv.request('POST', '/api/assign/confirm', {
        baseRevision: p0.body.baseRevision
      })
      const preview = await srv.request('POST', '/api/assign/preview')
      await srv.request('POST', '/api/clear')
      const beforeJson = readFile(srv, 'assignments.json')
      const confirm = await srv.request('POST', '/api/assign/confirm', {
        baseRevision: preview.body.baseRevision
      })
      assert.strictEqual(confirm.status, 409)
      assert.strictEqual(readFile(srv, 'assignments.json'), beforeJson)
    } finally {
      await srv.close()
    }
  })

  await asyncTest('原有锁定、解锁、清空功能可用', async () => {
    const srv = await startTestServer()
    try {
      let preview = await srv.request('POST', '/api/assign/preview')
      await srv.request('POST', '/api/assign/confirm', {
        baseRevision: preview.body.baseRevision
      })
      const target = preview.body.details.find(d => !d.locked)
      const lockRes = await srv.request('POST', '/api/lock', {
        memberId: target.memberId,
        seatId: target.seatId
      })
      assert.strictEqual(lockRes.status, 200)
      const locked = lockRes.body.find(a => a.memberId === target.memberId)
      assert.strictEqual(locked.locked, true)

      const unlockRes = await srv.request('POST', '/api/unlock', {
        memberId: target.memberId
      })
      assert.strictEqual(unlockRes.status, 200)
      const unlocked = unlockRes.body.find(a => a.memberId === target.memberId)
      assert.strictEqual(unlocked.locked, false)

      const clearRes = await srv.request('POST', '/api/clear')
      assert.strictEqual(clearRes.status, 200)
      assert.deepStrictEqual(clearRes.body, [])
      const onDiskRes = await srv.request('GET', '/api/assignments')
      assert.deepStrictEqual(onDiskRes.body, [])
    } finally {
      await srv.close()
    }
  })

  await asyncTest('取消预览不产生数据变化（无任何写入请求）', async () => {
    const srv = await startTestServer()
    try {
      const before = readFile(srv, 'assignments.json')
      await srv.request('POST', '/api/assign/preview')
      const after = readFile(srv, 'assignments.json')
      assert.strictEqual(before, after)
    } finally {
      await srv.close()
    }
  })

  await asyncTest('预览包含每位成员的座位、区域、偏好满足、个人得分、总得分', async () => {
    const srv = await startTestServer()
    try {
      const res = await srv.request('POST', '/api/assign/preview')
      assert.strictEqual(res.status, 200)
      assert.ok(res.body.details.length > 0)
      for (const d of res.body.details) {
        assert.ok('seatId' in d)
        assert.ok('area' in d)
        assert.ok('windowMet' in d)
        assert.ok('quietMet' in d)
        assert.ok('score' in d)
        assert.ok('memberName' in d)
      }
      const sumOfScores = res.body.details.reduce((s, d) => s + d.score, 0)
      assert.strictEqual(res.body.totalScore, sumOfScores)
    } finally {
      await srv.close()
    }
  })
}

runAsyncTests().then(() => {
  console.log(`\n=== 结果 ===`)
  console.log(`通过: ${passed}, 失败: ${failed}`)
  if (failed > 0) process.exit(1)
}).catch(e => {
  console.error(e)
  process.exit(1)
})
