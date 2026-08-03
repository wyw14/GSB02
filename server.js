const express = require('express')
const fs = require('fs')
const path = require('path')
const { buildPlan, computeSignature } = require('./lib/allocation')

const app = express()
const PORT = 3000

app.use(express.json())

const DATA_DIR = path.join(__dirname, 'data')

// 操作版本号：每次改动分配（保存/锁定/解锁/清空/手动写入）都自增。
// 仅靠数据签名无法识别「lock 后再 unlock」这类回到相同状态、
// 或对空分配执行 clear 这类前后都无锁定项的改动；版本号让「预览之后发生过任何改动」
// 都能使旧预览过期。用启动时间戳做初值，避免服务重启后版本号与旧预览意外撞上。
let opVersion = Date.now()

function bumpVersion() {
  opVersion += 1
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'))
}

function writeJson(file, data) {
  // 先写临时文件再原子重命名，保证保存失败时不会留下只写入一部分的结果。
  const target = path.join(DATA_DIR, file)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

app.get('/api/members', (req, res) => {
  res.json(readJson('members.json'))
})

app.get('/api/seats', (req, res) => {
  res.json(readJson('seats.json'))
})

app.get('/api/assignments', (req, res) => {
  res.json(readJson('assignments.json'))
})

app.put('/api/assignments', (req, res) => {
  writeJson('assignments.json', req.body)
  bumpVersion()
  res.json({ ok: true })
})

app.post('/api/assign/preview', (req, res) => {
  const members = readJson('members.json')
  const seats = readJson('seats.json')
  const assignments = readJson('assignments.json')

  // 只计算并返回方案，不写入任何 JSON 文件。
  const plan = buildPlan(members, seats, assignments)
  // 预览签名 = 操作版本号 + 数据签名：版本号捕获「预览之后发生过任何改动」，
  // 数据签名额外兜底 members/seats 等被服务外部直接改动的情况。
  plan.signature = `${opVersion}:${plan.signature}`
  res.json(plan)
})

app.post('/api/assign/commit', (req, res) => {
  const { signature } = req.body || {}
  const members = readJson('members.json')
  const seats = readJson('seats.json')
  const assignments = readJson('assignments.json')

  // 过期判断：提交时重新组合当前版本号与数据签名，与预览时保存的签名比对；
  // 只要预览之后发生过任何改动（哪怕状态回到相同，如 lock 后 unlock），
  // 版本号就会不同即视为过期，拒绝保存而不偷偷按新状态覆盖。
  const currentSignature = `${opVersion}:${computeSignature(members, seats, assignments)}`
  if (!signature || signature !== currentSignature) {
    return res.status(409).json({ error: 'expired', message: '方案已过期，请重新生成' })
  }

  // 预览与保存复用同一套 buildPlan，保证写入的方案与用户确认的方案一致。
  const plan = buildPlan(members, seats, assignments)
  writeJson('assignments.json', plan.assignments)
  bumpVersion()
  plan.signature = `${opVersion}:${plan.signature}`
  res.json(plan)
})

app.post('/api/lock', (req, res) => {
  const { memberId, seatId } = req.body
  let assignments = readJson('assignments.json')

  assignments = assignments.map(a => {
    if (a.memberId === memberId && a.seatId === seatId) {
      return { ...a, locked: true }
    }
    return a
  })

  writeJson('assignments.json', assignments)
  bumpVersion()
  res.json(assignments)
})

app.post('/api/unlock', (req, res) => {
  const { memberId } = req.body
  let assignments = readJson('assignments.json')

  assignments = assignments.map(a => {
    if (a.memberId === memberId) {
      return { ...a, locked: false }
    }
    return a
  })

  writeJson('assignments.json', assignments)
  bumpVersion()
  res.json(assignments)
})

app.post('/api/clear', (req, res) => {
  writeJson('assignments.json', [])
  bumpVersion()
  res.json([])
})

app.use(express.static(path.join(__dirname, 'client', 'dist')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`)
})
