const test = require('node:test')
const assert = require('node:assert')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const ASSIGN_FILE = path.join(DATA_DIR, 'assignments.json')
const BASE = 'http://localhost:3000'

/**
 * 读取 assignments.json 原始文本，用于断言「文件是否被改动」。
 * @returns {string} 文件内容
 */
function readAssignRaw() {
  return fs.readFileSync(ASSIGN_FILE, 'utf-8')
}

/**
 * 轮询等待服务端就绪。
 * @returns {Promise<void>}
 */
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/members`)
      if (res.ok) return
    } catch {
      // 服务尚未启动，继续重试
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('服务端启动超时')
}

test('server preview/commit 集成测试', async (t) => {
  // 备份 assignments.json，测试结束后原样恢复，避免污染真实数据。
  const backup = readAssignRaw()
  fs.writeFileSync(ASSIGN_FILE, '[]', 'utf-8')

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: 'ignore'
  })

  t.after(() => {
    child.kill()
    fs.writeFileSync(ASSIGN_FILE, backup, 'utf-8')
  })

  await waitForServer()

  await t.test('连续预览不修改 JSON', async () => {
    const before = readAssignRaw()
    const r1 = await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })
    const p1 = await r1.json()
    const r2 = await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })
    const p2 = await r2.json()
    const after = readAssignRaw()

    assert.strictEqual(before, after, '预览不得写入 assignments.json')
    assert.ok(p1.assigned.length > 0, '预览应包含分配结果')
    assert.ok(typeof p1.totalScore === 'number')
    assert.deepStrictEqual(p1.assignments, p2.assignments, '重复预览结果一致')
    assert.strictEqual(p1.signature, p2.signature)
  })

  await t.test('正确签名可确认保存', async () => {
    const preview = await (await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })).json()
    const res = await fetch(`${BASE}/api/assign/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: preview.signature })
    })
    assert.strictEqual(res.status, 200)
    const saved = JSON.parse(readAssignRaw())
    assert.deepStrictEqual(saved, preview.assignments, '保存内容与预览方案一致')
  })

  await t.test('状态改变后旧预览无法确认（过期）', async () => {
    // 先清空、生成预览，拿到旧签名
    await fetch(`${BASE}/api/clear`, { method: 'POST' })
    const preview = await (await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })).json()

    // 确认保存一次，产生可锁定的分配
    await fetch(`${BASE}/api/assign/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: preview.signature })
    })

    // 再次生成预览，然后改变状态（锁定），旧预览应过期
    const stale = await (await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })).json()
    const first = stale.assigned[0]
    await fetch(`${BASE}/api/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: first.memberId, seatId: first.seatId })
    })

    const before = readAssignRaw()
    const res = await fetch(`${BASE}/api/assign/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: stale.signature })
    })
    const after = readAssignRaw()

    assert.strictEqual(res.status, 409, '过期方案应返回 409')
    const body = await res.json()
    assert.strictEqual(body.error, 'expired')
    assert.strictEqual(before, after, '过期确认不得修改 JSON')
  })

  await t.test('锁定项在下一次预览中保持不变', async () => {
    const locked = JSON.parse(readAssignRaw()).find(a => a.locked)
    assert.ok(locked, '应存在锁定项（来自上一个用例）')
    const preview = await (await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })).json()
    const same = preview.assignments.find(a => a.memberId === locked.memberId)
    assert.deepStrictEqual(same, { memberId: locked.memberId, seatId: locked.seatId, locked: true })
  })

  await t.test('确认后清空，旧预览不得把已清空的分配写回', async () => {
    // 复现问题1：确认一次得到全部未锁定的分配
    await fetch(`${BASE}/api/clear`, { method: 'POST' })
    const p1 = await (await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })).json()
    await fetch(`${BASE}/api/assign/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: p1.signature })
    })

    // 生成新预览（此时无锁定项），随后清空
    const stale = await (await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })).json()
    await fetch(`${BASE}/api/clear`, { method: 'POST' })

    const before = readAssignRaw()
    const res = await fetch(`${BASE}/api/assign/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: stale.signature })
    })
    const after = readAssignRaw()

    assert.strictEqual(res.status, 409, '清空后旧预览应过期')
    assert.strictEqual(before, after, '不得把已清空的分配重新写回')
    assert.deepStrictEqual(JSON.parse(after), [], 'assignments 应保持为空')
  })

  await t.test('先锁定再解锁（状态回到相同）后旧预览仍失效', async () => {
    // 复现问题2：先造出一份已保存的分配
    await fetch(`${BASE}/api/clear`, { method: 'POST' })
    const seed = await (await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })).json()
    await fetch(`${BASE}/api/assign/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: seed.signature })
    })

    // 生成预览，然后锁定再解锁：数据字节回到相同，但仍属于「预览后发生过改动」
    const stale = await (await fetch(`${BASE}/api/assign/preview`, { method: 'POST' })).json()
    const first = stale.assigned[0]
    await fetch(`${BASE}/api/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: first.memberId, seatId: first.seatId })
    })
    await fetch(`${BASE}/api/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: first.memberId })
    })

    const res = await fetch(`${BASE}/api/assign/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: stale.signature })
    })
    assert.strictEqual(res.status, 409, 'lock 后 unlock 也应使旧预览过期')
  })

  await t.test('原有清空功能仍可用', async () => {
    const res = await fetch(`${BASE}/api/clear`, { method: 'POST' })
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(JSON.parse(readAssignRaw()), [])
  })
})
