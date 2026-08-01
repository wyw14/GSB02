const express = require('express')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { buildAssignmentPlan, computeStateHash } = require('./allocation')

const app = express()
const PORT = 3000

app.use(express.json())

const DATA_DIR = path.join(__dirname, 'data')

// 服务端按 previewId 持有各页面的待确认预览：{ stateHash, assignments }，
// 确认时同时校验标识与状态指纹，保证只保存发起确认的那个页面所展示的方案
const pendingPreviews = new Map()

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'))
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf-8')
}

// 先写临时文件再整体重命名，保证保存失败时不会留下只写入一部分的 assignments.json
function writeJsonAtomic(file, data) {
  const target = path.join(DATA_DIR, file)
  const tmp = target + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, target)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch (_) { /* 临时文件可能不存在，忽略 */ }
    throw err
  }
}

function readState() {
  return {
    members: readJson('members.json'),
    seats: readJson('seats.json'),
    assignments: readJson('assignments.json')
  }
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
  pendingPreviews.clear()
  res.json({ ok: true })
})

app.post('/api/assign/preview', (req, res) => {
  const { members, seats, assignments } = readState()
  const plan = buildAssignmentPlan(members, seats, assignments)
  const previewId = crypto.randomUUID()
  pendingPreviews.set(previewId, {
    stateHash: computeStateHash(members, seats, assignments),
    assignments: plan.assignments
  })
  res.json({ previewId, ...plan })
})

app.post('/api/assign/confirm', (req, res) => {
  const previewId = req.body && req.body.previewId
  const pending = pendingPreviews.get(previewId)
  const { members, seats, assignments } = readState()
  const stateHash = computeStateHash(members, seats, assignments)
  // 标识不存在或指纹不匹配都视为过期：页面展示的方案已不对应当前状态
  if (!pending || pending.stateHash !== stateHash) {
    pendingPreviews.delete(previewId)
    return res.status(409).json({ error: '方案已过期，请重新生成' })
  }
  try {
    writeJsonAtomic('assignments.json', pending.assignments)
  } catch (err) {
    return res.status(500).json({ error: '保存失败，请重试' })
  }
  const saved = pending.assignments
  pendingPreviews.delete(previewId)
  res.json(saved)
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
  pendingPreviews.clear()
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
  pendingPreviews.clear()
  res.json(assignments)
})

app.post('/api/clear', (req, res) => {
  writeJson('assignments.json', [])
  pendingPreviews.clear()
  res.json([])
})

app.use(express.static(path.join(__dirname, 'client', 'dist')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'))
})

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`)
  })
}

module.exports = app
