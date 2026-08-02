const express = require('express')
const fs = require('fs')
const path = require('path')
const { buildPreview } = require('./assigner')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'))
}

/**
 * 原子写入 JSON：先写临时文件，再 rename 覆盖目标文件，
 * 避免保存失败时留下只写入一部分的结果。
 * @param {string} file 文件名
 * @param {*} data 要写入的数据
 */
function writeJsonAtomic(file, data) {
  const target = path.join(DATA_DIR, file)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

/**
 * 读取 assignments 状态。
 *
 * assignments.json 保存一个对象 { revision, assignments }，把方案内容与
 * 修订号放在同一个文件里，因此任何写入都只需一次 rename，天然原子：
 * 要么两者一起更新成功，要么文件逐字节不变，不会出现“方案已写入但修订号
 * 没更新”或反过来的部分成功状态。
 *
 * 兼容旧格式：若文件直接是一个数组，视为 revision=0。
 * @returns {{revision: number, assignments: Array}}
 */
function readAssignmentsState() {
  const raw = readJson('assignments.json')
  if (Array.isArray(raw)) {
    return { revision: 0, assignments: raw }
  }
  return {
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    assignments: Array.isArray(raw.assignments) ? raw.assignments : []
  }
}

/**
 * 原子写入 assignments 状态（方案 + 修订号同文件）。
 * @param {number} revision 新版本号
 * @param {Array} assignments 分配列表
 */
function writeAssignmentsState(revision, assignments) {
  writeJsonAtomic('assignments.json', { revision, assignments })
}

app.get('/api/members', (req, res) => {
  res.json(readJson('members.json'))
})

app.get('/api/seats', (req, res) => {
  res.json(readJson('seats.json'))
})

app.get('/api/assignments', (req, res) => {
  const state = readAssignmentsState()
  res.json(state.assignments)
})

app.put('/api/assignments', (req, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  const state = readAssignmentsState()
  writeAssignmentsState(state.revision + 1, list)
  res.json({ ok: true })
})

/**
 * 生成分配预览：只计算并返回方案，不写入 assignments.json。
 * 返回当前数据的 revision 作为 baseRevision；确认时必须原样带回。
 */
app.post('/api/assign/preview', (req, res) => {
  const members = readJson('members.json')
  const seats = readJson('seats.json')
  const state = readAssignmentsState()

  const preview = buildPreview(members, seats, state.assignments)
  res.json({ ...preview, baseRevision: state.revision })
})

/**
 * 确认保存预览方案。
 * 服务端用单调递增的 revision 判断方案是否过期：只要在预览生成之后
 * 发生过任何变更（含锁定后又解锁、空分配后又清空等内容回到原样的情况），
 * revision 就会不同，此时返回 409，不写入任何文件。
 *
 * 保存时把新方案与新修订号写入同一个文件、一次 rename 原子完成，
 * 任一步失败都不会留下只写入一部分的结果。
 */
app.post('/api/assign/confirm', (req, res) => {
  const { baseRevision } = req.body || {}
  const members = readJson('members.json')
  const seats = readJson('seats.json')
  const state = readAssignmentsState()

  if (typeof baseRevision !== 'number' || baseRevision !== state.revision) {
    return res.status(409).json({
      error: 'PREVIEW_EXPIRED',
      message: '方案已过期，请重新生成'
    })
  }

  const preview = buildPreview(members, seats, state.assignments)

  // 方案与修订号在同一文件内一次原子写入：要么整体成功，要么文件不变。
  // 捕获写入异常（如磁盘只读），返回 500 且不改动任何数据。
  try {
    writeAssignmentsState(state.revision + 1, preview.newAssignments)
  } catch (e) {
    return res.status(500).json({
      error: 'SAVE_FAILED',
      message: '保存失败，请重试'
    })
  }

  res.json({ ...preview, baseRevision: state.revision + 1 })
})

app.post('/api/lock', (req, res) => {
  const { memberId, seatId } = req.body
  const state = readAssignmentsState()

  const assignments = state.assignments.map(a => {
    if (a.memberId === memberId && a.seatId === seatId) {
      return { ...a, locked: true }
    }
    return a
  })

  writeAssignmentsState(state.revision + 1, assignments)
  res.json(assignments)
})

app.post('/api/unlock', (req, res) => {
  const { memberId } = req.body
  const state = readAssignmentsState()

  const assignments = state.assignments.map(a => {
    if (a.memberId === memberId) {
      return { ...a, locked: false }
    }
    return a
  })

  writeAssignmentsState(state.revision + 1, assignments)
  res.json(assignments)
})

app.post('/api/clear', (req, res) => {
  const state = readAssignmentsState()
  writeAssignmentsState(state.revision + 1, [])
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
