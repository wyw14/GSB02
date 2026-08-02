const express = require('express')
const fs = require('fs')
const path = require('path')
const {
  buildPreview,
  buildConfirmedAssignments,
  computeFingerprint
} = require('./assignment')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const REVISION_FILE = path.join(DATA_DIR, '.revision')

// 服务端状态修订号：每次锁定/解锁/清空/确认成功后递增并持久化到磁盘。
// 仅靠内容指纹无法识别"锁定后又解锁恢复原样"或"空状态下再次清空"这类操作；
// 持久化保证服务重启后修订号不回退，重启前生成的旧预览仍永久失效。
let stateRevision = readRevision()

function readRevision() {
  try {
    const raw = fs.readFileSync(REVISION_FILE, 'utf-8')
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch (e) {
    return 0
  }
}

/**
 * 安全删除文件，文件不存在时忽略。
 * @param {string} file
 */
function safeUnlink(file) {
  try { fs.unlinkSync(file) } catch (e) {}
}

/**
 * 事务式提交分配变更：同时写入 assignments.json 与 .revision。
 * 先写两个临时文件，再依次原子重命名；若修订号重命名失败，回滚 assignments 到旧内容，
 * 保证任一步写入失败都不留下数据变化。
 * @param {Array} newAssignments 要写入的新分配数组
 */
function commitAssignmentChange(newAssignments) {
  const assignmentsPath = path.join(DATA_DIR, 'assignments.json')
  const revisionPath = REVISION_FILE
  const assignmentsTmp = `${assignmentsPath}.tmp`
  const revisionTmp = `${revisionPath}.tmp`
  const rollbackTmp = `${assignmentsPath}.rollback.tmp`

  // 读取旧内容用于回滚；文件不存在时视为空数组
  let oldAssignmentsContent
  try {
    oldAssignmentsContent = fs.readFileSync(assignmentsPath, 'utf-8')
  } catch (e) {
    oldAssignmentsContent = '[]'
  }

  const nextRevision = stateRevision + 1

  // 第一步：写两个临时文件，原文件尚未改动，失败可直接清理
  fs.writeFileSync(assignmentsTmp, JSON.stringify(newAssignments, null, 2), 'utf-8')
  try {
    fs.writeFileSync(revisionTmp, String(nextRevision), 'utf-8')
  } catch (e) {
    safeUnlink(assignmentsTmp)
    throw e
  }

  // 第二步：原子替换 assignments
  let assignmentsCommitted = false
  try {
    fs.renameSync(assignmentsTmp, assignmentsPath)
    assignmentsCommitted = true
  } catch (e) {
    safeUnlink(assignmentsTmp)
    safeUnlink(revisionTmp)
    throw e
  }

  // 第三步：原子替换 revision；失败则把 assignments 回滚到旧内容
  try {
    // 测试钩子：设置 FAIL_REVISION_WRITE=1 时模拟修订号写入失败，验证回滚
    if (process.env.FAIL_REVISION_WRITE === '1') {
      throw new Error('模拟修订号写入失败')
    }
    fs.renameSync(revisionTmp, revisionPath)
  } catch (e) {
    try {
      fs.writeFileSync(rollbackTmp, oldAssignmentsContent, 'utf-8')
      fs.renameSync(rollbackTmp, assignmentsPath)
    } catch (rollbackErr) {
      throw new Error(
        `提交失败且回滚失败: ${e.message}; 回滚错误: ${rollbackErr.message}`
      )
    }
    safeUnlink(revisionTmp)
    throw e
  }

  stateRevision = nextRevision
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'))
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
  try {
    commitAssignmentChange(req.body)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: '保存失败，数据未发生变化' })
  }
})

app.post('/api/assign/preview', (req, res) => {
  const members = readJson('members.json')
  const seats = readJson('seats.json')
  const assignments = readJson('assignments.json')
  const preview = buildPreview(members, seats, assignments)
  res.json({ ...preview, revision: stateRevision })
})

app.post('/api/assign/confirm', (req, res) => {
  const { fingerprint, revision } = req.body || {}
  const members = readJson('members.json')
  const seats = readJson('seats.json')
  const assignments = readJson('assignments.json')

  const currentFingerprint = computeFingerprint(members, seats, assignments)
  // 修订号与内容指纹任一不匹配即判定过期：
  // 修订号负责捕获"内容恢复原样但中间发生过写操作"的情况，
  // 指纹负责捕获外部直接改文件等内容变化。
  if (fingerprint !== currentFingerprint || revision !== stateRevision) {
    return res.status(409).json({ error: '方案已过期，请重新生成' })
  }

  const newAssignments = buildConfirmedAssignments(members, seats, assignments)
  try {
    commitAssignmentChange(newAssignments)
    res.json({ ok: true, assignments: newAssignments })
  } catch (e) {
    res.status(500).json({ error: '保存失败，数据未发生变化' })
  }
})

app.post('/api/lock', (req, res) => {
  const { memberId, seatId } = req.body
  const assignments = readJson('assignments.json')

  // 锁定必须作用于真实存在的成员-座位分配；预览建议的座位不能直接锁定。
  const target = assignments.find(
    a => a.memberId === memberId && a.seatId === seatId
  )
  if (!target) {
    return res.status(404).json({ error: '该座位分配不存在，无法锁定' })
  }

  const updated = assignments.map(a =>
    a.memberId === memberId && a.seatId === seatId
      ? { ...a, locked: true }
      : a
  )

  try {
    commitAssignmentChange(updated)
    res.json(updated)
  } catch (e) {
    res.status(500).json({ error: '锁定失败，数据未发生变化' })
  }
})

app.post('/api/unlock', (req, res) => {
  const { memberId } = req.body
  const assignments = readJson('assignments.json')

  const target = assignments.find(a => a.memberId === memberId)
  if (!target) {
    return res.status(404).json({ error: '该成员没有分配，无法解锁' })
  }

  const updated = assignments.map(a =>
    a.memberId === memberId ? { ...a, locked: false } : a
  )

  try {
    commitAssignmentChange(updated)
    res.json(updated)
  } catch (e) {
    res.status(500).json({ error: '解锁失败，数据未发生变化' })
  }
})

app.post('/api/clear', (req, res) => {
  try {
    commitAssignmentChange([])
    res.json([])
  } catch (e) {
    res.status(500).json({ error: '清空失败，数据未发生变化' })
  }
})

app.use(express.static(path.join(__dirname, 'client', 'dist')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`)
})
