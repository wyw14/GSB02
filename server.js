const express = require('express')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = 3000

app.use(express.json())

const DATA_DIR = path.join(__dirname, 'data')

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'))
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf-8')
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
  res.json({ ok: true })
})

app.post('/api/assign', (req, res) => {
  const members = readJson('members.json')
  const seats = readJson('seats.json')
  let assignments = readJson('assignments.json')

  const locked = assignments.filter(a => a.locked)
  const lockedSeatIds = new Set(locked.map(a => a.seatId))
  const lockedMemberIds = new Set(locked.map(a => a.memberId))

  const freeSeats = seats.filter(s => !lockedSeatIds.has(s.id))
  const freeMembers = members.filter(m => !lockedMemberIds.has(m.id))

  const result = assignSeats(freeMembers, freeSeats)

  const newAssignments = [
    ...locked,
    ...result.map(a => ({ ...a, locked: false }))
  ]

  writeJson('assignments.json', newAssignments)
  res.json(newAssignments)
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
  res.json(assignments)
})

app.post('/api/clear', (req, res) => {
  writeJson('assignments.json', [])
  res.json([])
})

function assignSeats(members, seats) {
  if (members.length === 0 || seats.length === 0) return []

  const scored = []
  for (const m of members) {
    for (const s of seats) {
      let score = 0
      if (m.wantsWindow && s.isWindow) score += 10
      if (m.wantsWindow && !s.isWindow) score -= 5
      if (m.needsQuiet && s.isQuiet) score += 10
      if (m.needsQuiet && !s.isQuiet) score -= 5
      if (!m.wantsWindow && s.isWindow) score += 1
      if (!m.needsQuiet && s.isQuiet) score += 1
      scored.push({ memberId: m.id, seatId: s.id, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)

  const usedMembers = new Set()
  const usedSeats = new Set()
  const assignments = []

  for (const pair of scored) {
    if (usedMembers.has(pair.memberId) || usedSeats.has(pair.seatId)) continue
    assignments.push({ memberId: pair.memberId, seatId: pair.seatId })
    usedMembers.add(pair.memberId)
    usedSeats.add(pair.seatId)
    if (usedMembers.size === members.length) break
  }

  return assignments
}

app.use(express.static(path.join(__dirname, 'client', 'dist')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`)
})
