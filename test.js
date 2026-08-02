const assert = require('assert')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const {
  scorePair,
  findOptimalAssignment,
  buildPreview,
  buildConfirmedAssignments,
  computeFingerprint
} = require('./assignment')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
  }
}

async function asyncTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
  }
}

/**
 * 复现旧版贪心算法，用于对比证明最优算法确实能拿到更高总分。
 * 旧逻辑：把所有成员-座位对按分数降序排列，依次占用未被使用的成员和座位。
 */
function greedyAssign(members, seats) {
  if (members.length === 0 || seats.length === 0) return []
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
    result.push({ memberId: pair.memberId, seatId: pair.seatId, score: pair.score })
    usedMembers.add(pair.memberId)
    usedSeats.add(pair.seatId)
  }
  return result
}

function totalScore(assignments) {
  return assignments.reduce((sum, a) => sum + a.score, 0)
}

// ========== 算法单元测试 ==========

console.log('\n[算法单元测试]')

test('旧贪心在构造场景下拿不到最高分，最优算法能拿到', () => {
  const members = [
    { id: 'm1', wantsWindow: false, needsQuiet: true },
    { id: 'm2', wantsWindow: true, needsQuiet: false },
    { id: 'm3', wantsWindow: true, needsQuiet: false }
  ]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: true },
    { id: 's2', isWindow: true, isQuiet: false },
    { id: 's3', isWindow: false, isQuiet: true }
  ]

  const greedyResult = greedyAssign(members, seats)
  const optimalResult = findOptimalAssignment(members, seats)

  const greedyTotal = totalScore(greedyResult)
  const optimalTotal = totalScore(optimalResult)

  assert.ok(
    optimalTotal > greedyTotal,
    `最优总分(${optimalTotal})应高于贪心总分(${greedyTotal})`
  )
  assert.strictEqual(optimalTotal, 31, `最优总分应为31，实际${optimalTotal}`)
  assert.strictEqual(greedyTotal, 17, `贪心总分应为17，实际${greedyTotal}`)
})

test('相同输入重复计算结果一致（确定性）', () => {
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false },
    { id: 'm2', wantsWindow: false, needsQuiet: true },
    { id: 'm3', wantsWindow: true, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: false },
    { id: 's2', isWindow: false, isQuiet: true },
    { id: 's3', isWindow: true, isQuiet: true }
  ]
  const r1 = findOptimalAssignment(members, seats)
  const r2 = findOptimalAssignment([...members].reverse(), [...seats].reverse())
  assert.strictEqual(
    JSON.stringify(r1),
    JSON.stringify(r2),
    '打乱输入顺序后结果仍应一致'
  )
})

test('成员多于座位时，部分成员未分配', () => {
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false },
    { id: 'm2', wantsWindow: false, needsQuiet: true },
    { id: 'm3', wantsWindow: true, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: true }
  ]
  const result = findOptimalAssignment(members, seats)
  assert.strictEqual(result.length, 1, '只能分配1人')
  const assignedIds = new Set(result.map(a => a.memberId))
  const preview = buildPreview(members, seats, [])
  assert.strictEqual(preview.unassignedMembers.length, 2, '应有2人未分配')
})

test('座位多于成员时，所有成员都分到座位且有空座', () => {
  const members = [
    { id: 'm1', wantsWindow: true, needsQuiet: false }
  ]
  const seats = [
    { id: 's1', isWindow: true, isQuiet: false },
    { id: 's2', isWindow: false, isQuiet: true },
    { id: 's3', isWindow: true, isQuiet: true }
  ]
  const result = findOptimalAssignment(members, seats)
  assert.strictEqual(result.length, 1, '1名成员应被分配')
  // s3 同时靠窗和安静，得分11，优于仅靠窗的s1（10分）
  assert.strictEqual(result[0].seatId, 's3', '应选最优座位s3')
})

test('锁定成员和座位原样保留，只对剩余重新计算', () => {
  const members = [
    { id: 'm1', name: 'M1', team: 'A', wantsWindow: false, needsQuiet: true },
    { id: 'm2', name: 'M2', team: 'B', wantsWindow: true, needsQuiet: false },
    { id: 'm3', name: 'M3', team: 'C', wantsWindow: true, needsQuiet: false }
  ]
  const seats = [
    { id: 's1', area: 'A', isWindow: true, isQuiet: true },
    { id: 's2', area: 'A', isWindow: true, isQuiet: false },
    { id: 's3', area: 'B', isWindow: false, isQuiet: true }
  ]
  const assignments = [
    { memberId: 'm1', seatId: 's1', locked: true }
  ]
  const preview = buildPreview(members, seats, assignments)

  const lockedEntry = preview.assignments.find(a => a.memberId === 'm1')
  assert.ok(lockedEntry, '锁定成员应出现在结果中')
  assert.strictEqual(lockedEntry.seatId, 's1', '锁定座位应保持为s1')
  assert.strictEqual(lockedEntry.locked, true, '应标记为锁定')

  const freeAssigned = preview.assignments.filter(a => !a.locked)
  const usedSeats = new Set(freeAssigned.map(a => a.seatId))
  assert.ok(!usedSeats.has('s1'), '剩余分配不能占用锁定座位s1')
  assert.ok(!freeAssigned.some(a => a.memberId === 'm1'), '锁定成员不应再被分配')
})

test('空成员或空座位返回空数组', () => {
  assert.deepStrictEqual(findOptimalAssignment([], [{ id: 's1' }]), [])
  assert.deepStrictEqual(findOptimalAssignment([{ id: 'm1' }], []), [])
})

test('preview 返回结构化数据含得分与偏好满足情况', () => {
  const members = [
    { id: 'm1', name: '张三', team: 'A', wantsWindow: true, needsQuiet: true }
  ]
  const seats = [
    { id: 's1', area: 'A区', isWindow: true, isQuiet: true }
  ]
  const preview = buildPreview(members, seats, [])
  assert.strictEqual(preview.assignments.length, 1)
  const a = preview.assignments[0]
  assert.strictEqual(a.memberName, '张三')
  assert.strictEqual(a.seatId, 's1')
  assert.strictEqual(a.area, 'A区')
  assert.strictEqual(a.score, 20)
  assert.strictEqual(a.windowMet, true)
  assert.strictEqual(a.quietMet, true)
  assert.strictEqual(preview.totalScore, 20)
  assert.strictEqual(preview.unassignedMembers.length, 0)
  assert.ok(preview.fingerprint, '应返回指纹')
})

test('状态改变后指纹不同', () => {
  const members = [{ id: 'm1', wantsWindow: false, needsQuiet: false }]
  const seats = [{ id: 's1', area: 'A', isWindow: false, isQuiet: false }]
  const fp1 = computeFingerprint(members, seats, [])
  const fp2 = computeFingerprint(members, seats, [{ memberId: 'm1', seatId: 's1', locked: true }])
  assert.notStrictEqual(fp1, fp2, '锁定后指纹应变化')
})

// ========== HTTP 集成测试 ==========

const TEST_PORT = 3199
let serverProc = null
let tmpDataDir = null

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null })
          } catch (e) {
            resolve({ status: res.statusCode, body: data })
          }
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      httpRequest('GET', '/api/members')
        .then(() => resolve())
        .catch(() => {
          if (n <= 0) reject(new Error('server did not start'))
          else setTimeout(() => attempt(n - 1), 200)
        })
    }
    attempt(retries)
  })
}

async function startServer() {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-test-'))
  fs.writeFileSync(path.join(tmpDataDir, 'members.json'), JSON.stringify([
    { id: 'm1', name: '张三', team: 'A', wantsWindow: false, needsQuiet: true },
    { id: 'm2', name: '李四', team: 'B', wantsWindow: true, needsQuiet: false },
    { id: 'm3', name: '王五', team: 'C', wantsWindow: true, needsQuiet: false }
  ], null, 2))
  fs.writeFileSync(path.join(tmpDataDir, 'seats.json'), JSON.stringify([
    { id: 's1', area: 'A区', isWindow: true, isQuiet: true },
    { id: 's2', area: 'A区', isWindow: true, isQuiet: false },
    { id: 's3', area: 'B区', isWindow: false, isQuiet: true }
  ], null, 2))
  fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')

  serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(TEST_PORT), DATA_DIR: tmpDataDir },
    stdio: 'ignore'
  })
  await waitForServer()
}

function stopServer() {
  if (serverProc) {
    serverProc.kill()
    serverProc = null
  }
}

function cleanupServer() {
  stopServer()
  if (tmpDataDir) {
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
    } catch (e) {}
    tmpDataDir = null
  }
}

/**
 * 重启服务进程但保留同一数据目录，用于验证修订号持久化。
 */
async function restartServer() {
  stopServer()
  // 等待端口释放
  await new Promise(r => setTimeout(r, 300))
  serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(TEST_PORT), DATA_DIR: tmpDataDir },
    stdio: 'ignore'
  })
  await waitForServer()
}

function readAssignments() {
  return JSON.parse(fs.readFileSync(path.join(tmpDataDir, 'assignments.json'), 'utf-8'))
}

async function runIntegrationTests() {
  console.log('\n[HTTP 集成测试]')

  await asyncTest('预览不修改 assignments.json', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const before = readAssignments()
    const res = await httpRequest('POST', '/api/assign/preview')
    assert.strictEqual(res.status, 200)
    assert.ok(res.body.fingerprint)
    assert.ok(typeof res.body.revision === 'number', '应返回修订号')
    assert.ok(res.body.assignments.length > 0)
    const after = readAssignments()
    assert.deepStrictEqual(after, before, '预览后文件内容不应变化')
    assert.deepStrictEqual(after, [], '文件应仍为空数组')
  })

  await asyncTest('连续两次预览结果一致', async () => {
    const r1 = await httpRequest('POST', '/api/assign/preview')
    const r2 = await httpRequest('POST', '/api/assign/preview')
    assert.strictEqual(
      JSON.stringify(r1.body.assignments),
      JSON.stringify(r2.body.assignments),
      '两次预览分配应一致'
    )
    assert.strictEqual(r1.body.fingerprint, r2.body.fingerprint)
    assert.strictEqual(r1.body.totalScore, r2.body.totalScore)
    assert.strictEqual(r1.body.revision, r2.body.revision, '修订号应一致')
  })

  await asyncTest('确认后正确保存 assignments.json', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const preview = await httpRequest('POST', '/api/assign/preview')
    const res = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision
    })
    assert.strictEqual(res.status, 200)
    assert.ok(res.body.ok)
    const saved = readAssignments()
    assert.strictEqual(saved.length, 3, '应保存3条分配')
    const expectedSeats = new Set(preview.body.assignments.map(a => a.seatId))
    const savedSeats = new Set(saved.map(a => a.seatId))
    assert.deepStrictEqual(savedSeats, expectedSeats, '保存的座位应与预览一致')
    assert.ok(saved.every(a => a.locked === false || a.locked === true), '应有locked字段')
    for (const a of saved) {
      assert.ok(!a.score, '写入文件不应包含预览专用字段score')
      assert.ok(a.memberId === undefined || typeof a.memberId === 'string')
    }
  })

  await asyncTest('预览后锁定导致旧方案无法确认（409过期）', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const preview = await httpRequest('POST', '/api/assign/preview')
    await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision
    })
    const assignments = readAssignments()
    const first = assignments[0]
    await httpRequest('POST', '/api/lock', {
      memberId: first.memberId,
      seatId: first.seatId
    })
    const res = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision
    })
    assert.strictEqual(res.status, 409, '状态改变后应返回409')
    assert.ok(res.body.error.includes('过期'), '应提示过期')
  })

  await asyncTest('锁定后再解锁使内容恢复原样，旧预览仍因修订号失效', async () => {
    // 先保存一个方案
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const preview0 = await httpRequest('POST', '/api/assign/preview')
    await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview0.body.fingerprint,
      revision: preview0.body.revision
    })
    const savedBefore = readAssignments()
    assert.ok(savedBefore.length > 0)

    // 基于当前已保存状态生成预览
    const preview = await httpRequest('POST', '/api/assign/preview')
    const first = savedBefore[0]

    // 锁定再解锁：JSON 内容恢复到与生成预览时完全相同
    await httpRequest('POST', '/api/lock', {
      memberId: first.memberId,
      seatId: first.seatId
    })
    await httpRequest('POST', '/api/unlock', { memberId: first.memberId })

    const savedAfter = readAssignments()
    assert.deepStrictEqual(
      savedAfter,
      savedBefore,
      '锁定后解锁应使JSON内容恢复原样'
    )

    // 旧预览内容指纹相同，但修订号已变，必须被拒绝
    const res = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision
    })
    assert.strictEqual(res.status, 409, '内容恢复原样但修订号已变，应返回409')
    assert.ok(res.body.error.includes('过期'))
    // JSON 不应发生变化
    assert.deepStrictEqual(readAssignments(), savedBefore, '确认失败后JSON不应变化')
  })

  await asyncTest('空分配状态下再次清空，旧预览仍因修订号失效', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const preview = await httpRequest('POST', '/api/assign/preview')
    // 空状态下清空，前后内容都是 []
    await httpRequest('POST', '/api/clear')
    const res = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision
    })
    assert.strictEqual(res.status, 409, '空状态清空后修订号已变，应返回409')
    assert.deepStrictEqual(readAssignments(), [], 'JSON应仍为空数组')
  })

  await asyncTest('缺少修订号或修订号错误时确认被拒绝', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const preview = await httpRequest('POST', '/api/assign/preview')

    const res1 = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint
    })
    assert.strictEqual(res1.status, 409, '缺少revision应被拒绝')

    const res2 = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision + 999
    })
    assert.strictEqual(res2.status, 409, '错误revision应被拒绝')
  })

  await asyncTest('过期后重新生成的新预览可正常确认保存', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const oldPreview = await httpRequest('POST', '/api/assign/preview')
    // 触发写操作使旧预览过期
    await httpRequest('POST', '/api/clear')
    const expiredRes = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: oldPreview.body.fingerprint,
      revision: oldPreview.body.revision
    })
    assert.strictEqual(expiredRes.status, 409, '旧预览应过期')

    // 重新生成预览，获取新修订号，确认应成功
    const newPreview = await httpRequest('POST', '/api/assign/preview')
    const okRes = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: newPreview.body.fingerprint,
      revision: newPreview.body.revision
    })
    assert.strictEqual(okRes.status, 200, '新预览应能确认成功')
    assert.ok(okRes.body.ok)
    assert.strictEqual(readAssignments().length, 3)
  })

  await asyncTest('清空后旧指纹也无法确认', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), JSON.stringify([
      { memberId: 'm1', seatId: 's1', locked: true }
    ]))
    const preview = await httpRequest('POST', '/api/assign/preview')
    await httpRequest('POST', '/api/clear')
    const res = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision
    })
    assert.strictEqual(res.status, 409)
  })

  await asyncTest('锁定功能正常工作', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), JSON.stringify([
      { memberId: 'm1', seatId: 's1', locked: false }
    ]))
    const res = await httpRequest('POST', '/api/lock', {
      memberId: 'm1',
      seatId: 's1'
    })
    assert.strictEqual(res.status, 200)
    const saved = readAssignments()
    assert.strictEqual(saved[0].locked, true)
  })

  await asyncTest('解锁功能正常工作', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), JSON.stringify([
      { memberId: 'm1', seatId: 's1', locked: true }
    ]))
    const res = await httpRequest('POST', '/api/unlock', { memberId: 'm1' })
    assert.strictEqual(res.status, 200)
    const saved = readAssignments()
    assert.strictEqual(saved[0].locked, false)
  })

  await asyncTest('清空功能正常工作', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), JSON.stringify([
      { memberId: 'm1', seatId: 's1', locked: false }
    ]))
    const res = await httpRequest('POST', '/api/clear')
    assert.strictEqual(res.status, 200)
    const saved = readAssignments()
    assert.deepStrictEqual(saved, [])
  })

  await asyncTest('确认后锁定的座位在下次预览中保持不变', async () => {
    // 先保存一个方案
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const preview1 = await httpRequest('POST', '/api/assign/preview')
    await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview1.body.fingerprint,
      revision: preview1.body.revision
    })
    // 锁定 m1 的座位
    const assignments = readAssignments()
    const m1Assignment = assignments.find(a => a.memberId === 'm1')
    await httpRequest('POST', '/api/lock', {
      memberId: 'm1',
      seatId: m1Assignment.seatId
    })
    // 再次预览，m1 应仍在锁定座位
    const preview2 = await httpRequest('POST', '/api/assign/preview')
    const m1Entry = preview2.body.assignments.find(a => a.memberId === 'm1')
    assert.strictEqual(m1Entry.seatId, m1Assignment.seatId, 'm1座位应保持锁定')
    assert.strictEqual(m1Entry.locked, true)
  })

  await asyncTest('锁定不存在的成员-座位分配返回404且不改JSON', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), JSON.stringify([
      { memberId: 'm1', seatId: 's1', locked: false }
    ]))
    const before = readAssignments()
    // 请求锁定 m1 在 s2（真实分配是 s1），应失败
    const res = await httpRequest('POST', '/api/lock', {
      memberId: 'm1',
      seatId: 's2'
    })
    assert.strictEqual(res.status, 404, '不存在的分配应返回404')
    assert.ok(res.body.error.includes('不存在'))
    assert.deepStrictEqual(readAssignments(), before, '失败时JSON不应变化')
  })

  await asyncTest('解锁不存在的成员返回404', async () => {
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const res = await httpRequest('POST', '/api/unlock', { memberId: 'm99' })
    assert.strictEqual(res.status, 404)
  })

  await asyncTest('锁定再解锁后重启服务，旧预览仍因持久化修订号失效', async () => {
    // 先保存一个方案
    fs.writeFileSync(path.join(tmpDataDir, 'assignments.json'), '[]')
    const preview0 = await httpRequest('POST', '/api/assign/preview')
    await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview0.body.fingerprint,
      revision: preview0.body.revision
    })

    // 生成预览 A
    const previewA = await httpRequest('POST', '/api/assign/preview')
    const assignments = readAssignments()
    const first = assignments[0]

    // 锁定再解锁，JSON 恢复原样
    await httpRequest('POST', '/api/lock', {
      memberId: first.memberId,
      seatId: first.seatId
    })
    await httpRequest('POST', '/api/unlock', { memberId: first.memberId })

    const beforeRestart = readAssignments()

    // 重启服务（修订号应从磁盘恢复，不回退到0）
    await restartServer()

    // 确认旧预览 A 应被拒绝
    const res = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: previewA.body.fingerprint,
      revision: previewA.body.revision
    })
    assert.strictEqual(res.status, 409, '重启后旧预览应仍失效')
    assert.ok(res.body.error.includes('过期'))
    // JSON 逐字节不变
    assert.deepStrictEqual(
      readAssignments(),
      beforeRestart,
      '确认失败后JSON不应变化'
    )
  })

  await asyncTest('重启后新生成的预览可正常确认', async () => {
    // 紧接上一个测试的重启状态，重新生成预览应能确认
    const preview = await httpRequest('POST', '/api/assign/preview')
    const res = await httpRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision
    })
    assert.strictEqual(res.status, 200, '新预览应能确认成功')
    assert.ok(res.body.ok)
  })
}

const FAIL_TEST_PORT = 3299
let failServerProc = null
let failDataDir = null

function startFailServer() {
  failDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-fail-'))
  fs.writeFileSync(path.join(failDataDir, 'members.json'), JSON.stringify([
    { id: 'm1', name: '张三', team: 'A', wantsWindow: false, needsQuiet: true }
  ], null, 2))
  fs.writeFileSync(path.join(failDataDir, 'seats.json'), JSON.stringify([
    { id: 's1', area: 'A区', isWindow: true, isQuiet: true }
  ], null, 2))
  fs.writeFileSync(
    path.join(failDataDir, 'assignments.json'),
    JSON.stringify([{ memberId: 'm1', seatId: 's1', locked: false }])
  )
  failServerProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(FAIL_TEST_PORT),
      DATA_DIR: failDataDir,
      FAIL_REVISION_WRITE: '1'
    },
    stdio: 'ignore'
  })
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const req = http.request(
        { hostname: '127.0.0.1', port: FAIL_TEST_PORT, path: '/api/members', method: 'GET' },
        res => { res.resume(); resolve() }
      )
      req.on('error', () => {
        if (n <= 0) reject(new Error('fail server did not start'))
        else setTimeout(() => attempt(n - 1), 200)
      })
      req.end()
    }
    attempt(30)
  })
}

function stopFailServer() {
  if (failServerProc) {
    failServerProc.kill()
    failServerProc = null
  }
  if (failDataDir) {
    try { fs.rmSync(failDataDir, { recursive: true, force: true }) } catch (e) {}
    failDataDir = null
  }
}

function failRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: FAIL_TEST_PORT,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null })
          } catch (e) {
            resolve({ status: res.statusCode, body: data })
          }
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function readFailAssignments() {
  return JSON.parse(
    fs.readFileSync(path.join(failDataDir, 'assignments.json'), 'utf-8')
  )
}

async function runFailureRollbackTests() {
  console.log('\n[写入失败回滚测试]')

  await asyncTest('修订号写入失败时锁定返回500且 assignments 逐字节不变', async () => {
    const before = fs.readFileSync(path.join(failDataDir, 'assignments.json'), 'utf-8')
    const res = await failRequest('POST', '/api/lock', {
      memberId: 'm1',
      seatId: 's1'
    })
    assert.strictEqual(res.status, 500, '应返回500')
    assert.ok(res.body.error.includes('未发生变化'))
    const after = fs.readFileSync(path.join(failDataDir, 'assignments.json'), 'utf-8')
    assert.strictEqual(after, before, 'assignments.json 应逐字节不变')
    const saved = readFailAssignments()
    assert.strictEqual(saved[0].locked, false, '锁定不应生效')
    // 不应残留临时文件
    assert.ok(!fs.existsSync(path.join(failDataDir, 'assignments.json.tmp')))
    assert.ok(!fs.existsSync(path.join(failDataDir, 'assignments.json.rollback.tmp')))
  })

  await asyncTest('修订号写入失败时清空返回500且 assignments 不变', async () => {
    const before = readFailAssignments()
    const res = await failRequest('POST', '/api/clear')
    assert.strictEqual(res.status, 500)
    assert.deepStrictEqual(readFailAssignments(), before, '清空不应生效')
  })

  await asyncTest('修订号写入失败时确认返回500且 assignments 不变', async () => {
    const before = readFailAssignments()
    const preview = await failRequest('POST', '/api/assign/preview')
    const res = await failRequest('POST', '/api/assign/confirm', {
      fingerprint: preview.body.fingerprint,
      revision: preview.body.revision
    })
    assert.strictEqual(res.status, 500)
    assert.deepStrictEqual(readFailAssignments(), before, '确认不应改写数据')
  })

  await asyncTest('修订号写入失败时解锁返回500且 assignments 不变', async () => {
    // 先正常（失败模式下所有写都失败），直接验证解锁
    const before = readFailAssignments()
    const res = await failRequest('POST', '/api/unlock', { memberId: 'm1' })
    assert.strictEqual(res.status, 500)
    assert.deepStrictEqual(readFailAssignments(), before)
  })
}

;(async () => {
  try {
    await startServer()
    await runIntegrationTests()
  } catch (err) {
    console.error('测试运行失败:', err)
    failed++
  } finally {
    cleanupServer()
  }

  try {
    await startFailServer()
    await runFailureRollbackTests()
  } catch (err) {
    console.error('回滚测试运行失败:', err)
    failed++
  } finally {
    stopFailServer()
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
})()
