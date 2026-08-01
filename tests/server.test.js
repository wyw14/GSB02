'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const app = require('../server')

const DATA_DIR = path.join(__dirname, '..', 'data')
const DATA_FILES = ['members.json', 'seats.json', 'assignments.json']

let server
let baseUrl
const backups = {}

function readData(file) {
  return fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')
}

function writeData(file, content) {
  fs.writeFileSync(path.join(DATA_DIR, file), content, 'utf-8')
}

async function api(pathname, options = {}) {
  const res = await fetch(baseUrl + pathname, { method: 'GET', ...options })
  return res
}

async function post(pathname, body) {
  const options = { method: 'POST' }
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' }
    options.body = JSON.stringify(body)
  }
  return api(pathname, options)
}

before(async () => {
  for (const file of DATA_FILES) backups[file] = readData(file)
  await new Promise(resolve => {
    server = app.listen(0, () => resolve())
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  for (const file of DATA_FILES) writeData(file, backups[file])
  await new Promise(resolve => server.close(resolve))
})

test('连续两次预览结果一致，且不修改 assignments.json', async () => {
  writeData('assignments.json', '[]')

  const beforeContent = readData('assignments.json')

  const res1 = await post('/api/assign/preview')
  assert.equal(res1.status, 200)
  const plan1 = await res1.json()

  const res2 = await post('/api/assign/preview')
  const plan2 = await res2.json()

  // 每次预览都会分配新的标识，方案内容必须一致
  assert.notEqual(plan1.previewId, plan2.previewId)
  const { previewId: _id1, ...content1 } = plan1
  const { previewId: _id2, ...content2 } = plan2
  assert.deepEqual(content1, content2)
  assert.equal(readData('assignments.json'), beforeContent)

  // 预览应包含得分、偏好满足情况与总得分，且 12 名成员全部分配
  assert.equal(plan1.assignments.length, 12)
  assert.equal(typeof plan1.totalScore, 'number')
  assert.deepEqual(plan1.unassigned, [])
  for (const item of plan1.assignments) {
    assert.equal(typeof item.score, 'number')
    assert.ok(item.windowMet === null || typeof item.windowMet === 'boolean')
    assert.ok(item.quietMet === null || typeof item.quietMet === 'boolean')
  }
})

test('确认后正确保存，写入结果与预览一致', async () => {
  writeData('assignments.json', '[]')

  const previewRes = await post('/api/assign/preview')
  const plan = await previewRes.json()
  assert.ok(plan.previewId)

  const confirmRes = await post('/api/assign/confirm', { previewId: plan.previewId })
  assert.equal(confirmRes.status, 200)
  const saved = await confirmRes.json()

  assert.deepEqual(saved, plan.assignments)
  assert.deepEqual(JSON.parse(readData('assignments.json')), plan.assignments)
})

test('没有预览时直接确认返回过期提示', async () => {
  writeData('assignments.json', '[]')
  // 先用清空接口确保不存在待确认的预览
  await post('/api/clear')

  const res = await post('/api/assign/confirm', { previewId: 'not-exist' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, '方案已过期，请重新生成')
})

test('预览后进行锁定操作，旧方案无法确认', async () => {
  // 先保存一份已分配结果，锁定操作才有对象可锁
  writeData(
    'assignments.json',
    JSON.stringify([{ memberId: 'm1', seatId: 's1', locked: false }], null, 2)
  )

  const previewRes = await post('/api/assign/preview')
  assert.equal(previewRes.status, 200)
  const plan = await previewRes.json()

  await post('/api/lock', { memberId: 'm1', seatId: 's1' })

  const confirmRes = await post('/api/assign/confirm', { previewId: plan.previewId })
  assert.equal(confirmRes.status, 409)
  const body = await confirmRes.json()
  assert.equal(body.error, '方案已过期，请重新生成')

  // 确认失败后不能偷偷按新状态保存：文件里只有锁定操作产生的那一条
  const current = JSON.parse(readData('assignments.json'))
  assert.equal(current.length, 1)
  assert.equal(current[0].locked, true)
})

test('预览后进行清空操作，旧方案无法确认', async () => {
  writeData('assignments.json', '[]')
  const previewRes = await post('/api/assign/preview')
  const plan = await previewRes.json()

  await post('/api/clear')

  const confirmRes = await post('/api/assign/confirm', { previewId: plan.previewId })
  assert.equal(confirmRes.status, 409)
  assert.equal(JSON.parse(readData('assignments.json')).length, 0)
})

test('预览后进行解锁操作，旧方案无法确认', async () => {
  // 先造一条锁定分配
  writeData(
    'assignments.json',
    JSON.stringify([{ memberId: 'm1', seatId: 's1', locked: true }], null, 2)
  )
  const previewRes = await post('/api/assign/preview')
  const plan = await previewRes.json()

  await post('/api/unlock', { memberId: 'm1' })

  const confirmRes = await post('/api/assign/confirm', { previewId: plan.previewId })
  assert.equal(confirmRes.status, 409)
})

test('锁定成员在预览中原样保留', async () => {
  writeData(
    'assignments.json',
    JSON.stringify([{ memberId: 'm1', seatId: 's3', locked: true }], null, 2)
  )

  const res = await post('/api/assign/preview')
  const plan = await res.json()

  const lockedEntry = plan.assignments.find(a => a.memberId === 'm1')
  assert.equal(lockedEntry.seatId, 's3')
  assert.equal(lockedEntry.locked, true)
  // 锁定座位不会被分给其他成员
  assert.equal(plan.assignments.filter(a => a.seatId === 's3').length, 1)
  assert.equal(plan.assignments.length, 12)
})

test('原有锁定、解锁、清空功能仍然可用', async () => {
  writeData(
    'assignments.json',
    JSON.stringify([{ memberId: 'm1', seatId: 's1', locked: false }], null, 2)
  )

  const lockRes = await post('/api/lock', { memberId: 'm1', seatId: 's1' })
  assert.equal(lockRes.status, 200)
  assert.equal((await lockRes.json())[0].locked, true)

  const unlockRes = await post('/api/unlock', { memberId: 'm1' })
  assert.equal(unlockRes.status, 200)
  assert.equal((await unlockRes.json())[0].locked, false)

  const clearRes = await post('/api/clear')
  assert.equal(clearRes.status, 200)
  assert.deepEqual(await clearRes.json(), [])
  assert.deepEqual(JSON.parse(readData('assignments.json')), [])
})

test('不同页面的预览互不影响：旧预览 409 且不能保存，新预览可正常确认', async () => {
  writeData(
    'assignments.json',
    JSON.stringify([{ memberId: 'm1', seatId: 's1', locked: false }], null, 2)
  )

  // 页面 A 生成预览
  const resA = await post('/api/assign/preview')
  const planA = await resA.json()

  // 状态变化：锁定 m1
  await post('/api/lock', { memberId: 'm1', seatId: 's1' })

  // 页面 B 在状态变化后生成新预览，两份预览标识必须不同
  const resB = await post('/api/assign/preview')
  const planB = await resB.json()
  assert.notEqual(planA.previewId, planB.previewId)

  // 页面 A 确认旧预览 → 409，且不能把任何方案写入文件
  const confirmA = await post('/api/assign/confirm', { previewId: planA.previewId })
  assert.equal(confirmA.status, 409)
  const fileAfterA = JSON.parse(readData('assignments.json'))
  assert.equal(fileAfterA.length, 1)
  assert.equal(fileAfterA[0].locked, true)

  // 页面 B 确认自己的预览 → 200，写入内容与 B 展示的方案一致
  const confirmB = await post('/api/assign/confirm', { previewId: planB.previewId })
  assert.equal(confirmB.status, 200)
  assert.deepEqual(await confirmB.json(), planB.assignments)
  assert.deepEqual(JSON.parse(readData('assignments.json')), planB.assignments)
})

test('保存失败时返回 500，所有 JSON 文件内容保持不变', async () => {
  writeData('assignments.json', '[]')
  const membersBefore = readData('members.json')
  const seatsBefore = readData('seats.json')

  const previewRes = await post('/api/assign/preview')
  const plan = await previewRes.json()

  // 用同名目录占用临时文件路径，强制 writeFileSync 失败以模拟保存失败
  const tmpPath = path.join(DATA_DIR, 'assignments.json.tmp')
  fs.mkdirSync(tmpPath)
  try {
    const confirmRes = await post('/api/assign/confirm', { previewId: plan.previewId })
    assert.equal(confirmRes.status, 500)
    const body = await confirmRes.json()
    assert.equal(body.error, '保存失败，请重试')
  } finally {
    fs.rmdirSync(tmpPath)
  }

  assert.equal(readData('assignments.json'), '[]')
  assert.equal(readData('members.json'), membersBefore)
  assert.equal(readData('seats.json'), seatsBefore)
  assert.ok(!fs.existsSync(tmpPath))
})
