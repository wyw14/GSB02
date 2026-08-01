<script setup>
import { ref, computed, onMounted } from 'vue'

const members = ref([])
const seats = ref([])
const assignments = ref([])
const loading = ref(false)
const toast = ref('')
// 服务端返回的结构化预览方案（含每项得分与偏好满足情况），确认前不改动任何数据
const preview = ref(null)

function showToast(msg) {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 2000)
}

async function fetchData() {
  const [mRes, sRes, aRes] = await Promise.all([
    fetch('/api/members'),
    fetch('/api/seats'),
    fetch('/api/assignments')
  ])
  members.value = await mRes.json()
  seats.value = await sRes.json()
  assignments.value = await aRes.json()
}

async function doPreview() {
  loading.value = true
  try {
    const res = await fetch('/api/assign/preview', { method: 'POST' })
    preview.value = await res.json()
  } finally {
    loading.value = false
  }
}

async function doConfirm() {
  loading.value = true
  try {
    const res = await fetch('/api/assign/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewId: preview.value?.previewId })
    })
    if (res.status === 409) {
      preview.value = null
      showToast('方案已过期，请重新生成')
      return
    }
    if (!res.ok) {
      // 保存失败：保留当前预览与分配不变，仅提示失败
      const body = await res.json().catch(() => ({}))
      showToast(body.error || '保存失败，请重试')
      return
    }
    assignments.value = await res.json()
    preview.value = null
    showToast('分配方案已保存！')
  } catch (err) {
    showToast('保存失败，请重试')
  } finally {
    loading.value = false
  }
}

function doCancelPreview() {
  preview.value = null
}

async function doClear() {
  loading.value = true
  try {
    const res = await fetch('/api/clear', { method: 'POST' })
    assignments.value = await res.json()
    // 保留旧预览面板，确认时由服务端判定过期并提示
    showToast('已清空所有分配')
  } finally {
    loading.value = false
  }
}

async function doLock(memberId, seatId) {
  const res = await fetch('/api/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, seatId })
  })
  assignments.value = await res.json()
  showToast('已锁定座位')
}

async function doUnlock(memberId) {
  const res = await fetch('/api/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId })
  })
  assignments.value = await res.json()
  showToast('已解锁座位')
}

const memberMap = computed(() => {
  const map = {}
  for (const m of members.value) map[m.id] = m
  return map
})

const seatMap = computed(() => {
  const map = {}
  for (const s of seats.value) map[s.id] = s
  return map
})

const assignmentBySeat = computed(() => {
  const map = {}
  for (const a of assignments.value) map[a.seatId] = a
  return map
})

const assignmentByMember = computed(() => {
  const map = {}
  for (const a of assignments.value) map[a.memberId] = a
  return map
})

const seatsByArea = computed(() => {
  const groups = {}
  for (const s of seats.value) {
    if (!groups[s.area]) groups[s.area] = []
    groups[s.area].push(s)
  }
  return groups
})

function isWindowMet(member, seat) {
  if (!member.wantsWindow) return null
  return seat.isWindow
}

function isQuietMet(member, seat) {
  if (!member.needsQuiet) return null
  return seat.isQuiet
}

const stats = computed(() => {
  const total = assignments.value.length
  let windowWanted = 0
  let windowMet = 0
  let quietWanted = 0
  let quietMet = 0
  let lockedCount = 0

  for (const a of assignments.value) {
    const m = memberMap.value[a.memberId]
    const s = seatMap.value[a.seatId]
    if (!m || !s) continue
    if (a.locked) lockedCount++
    if (m.wantsWindow) {
      windowWanted++
      if (s.isWindow) windowMet++
    }
    if (m.needsQuiet) {
      quietWanted++
      if (s.isQuiet) quietMet++
    }
  }

  return { total, windowWanted, windowMet, quietWanted, quietMet, lockedCount }
})

onMounted(fetchData)
</script>

<template>
  <div>
    <div v-if="toast" class="toast">{{ toast }}</div>

    <div class="header">
      <h1>🎲 座位盲盒分配器</h1>
      <p>一键随机分配工位，智能满足靠窗与安静区偏好</p>
    </div>

    <div class="actions">
      <button class="btn btn-primary" :disabled="loading" @click="doPreview">
        🎯 生成分配预览
      </button>
      <button class="btn btn-danger" :disabled="loading || assignments.length === 0" @click="doClear">
        🗑️ 清空全部分配
      </button>
    </div>

    <div v-if="preview" class="preview-panel">
      <div class="section-title">🔍 分配预览（未保存）</div>
      <table class="preview-table">
        <thead>
          <tr>
            <th>成员</th>
            <th>座位</th>
            <th>区域</th>
            <th>靠窗偏好</th>
            <th>安静偏好</th>
            <th>得分</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in preview.assignments" :key="item.memberId">
            <td>
              {{ memberMap[item.memberId]?.name }}
              <span v-if="item.locked" class="tag tag-locked">🔒已锁定</span>
            </td>
            <td>{{ item.seatId }}</td>
            <td>{{ seatMap[item.seatId]?.area }}</td>
            <td>
              <span v-if="item.windowMet === true" class="pref-met">✅满足</span>
              <span v-else-if="item.windowMet === false" class="pref-unmet">❌未满足</span>
              <span v-else class="pref-na">无偏好</span>
            </td>
            <td>
              <span v-if="item.quietMet === true" class="pref-met">✅满足</span>
              <span v-else-if="item.quietMet === false" class="pref-unmet">❌未满足</span>
              <span v-else class="pref-na">无偏好</span>
            </td>
            <td>{{ item.score }}</td>
          </tr>
        </tbody>
      </table>
      <div class="preview-summary">
        <span>总得分：<b>{{ preview.totalScore }}</b></span>
        <span v-if="preview.unassigned.length > 0" class="preview-unassigned">
          未分配成员：{{ preview.unassigned.map(id => memberMap[id]?.name || id).join('、') }}
        </span>
      </div>
      <div class="preview-actions">
        <button class="btn btn-primary" :disabled="loading" @click="doConfirm">✅ 确认保存</button>
        <button class="btn btn-cancel" :disabled="loading" @click="doCancelPreview">❌ 取消</button>
      </div>
    </div>

    <div class="legend" style="margin-bottom: 20px">
      <div class="legend-items">
        <div class="legend-item"><div class="legend-dot empty"></div> 空座</div>
        <div class="legend-item"><div class="legend-dot occupied"></div> 已分配</div>
        <div class="legend-item"><div class="legend-dot locked"></div> 已锁定</div>
        <div class="legend-item"><span class="tag tag-window">窗</span> 靠窗</div>
        <div class="legend-item"><span class="tag tag-quiet">静</span> 安静区</div>
      </div>
    </div>

    <div class="main-grid">
      <div class="seat-map">
        <div class="section-title">📍 座位分布图</div>
        <div v-for="(areaSeats, areaName) in seatsByArea" :key="areaName" class="area-group">
          <div class="area-label">{{ areaName }}</div>
          <div class="seat-row">
            <div
              v-for="seat in areaSeats"
              :key="seat.id"
              :class="[
                'seat-card',
                assignmentBySeat[seat.id] ? 'occupied' : 'empty',
                assignmentBySeat[seat.id]?.locked ? 'locked' : ''
              ]"
            >
              <div class="seat-id">{{ seat.id }}</div>
              <div class="seat-tags">
                <span v-if="seat.isWindow" class="tag tag-window">窗</span>
                <span v-if="seat.isQuiet" class="tag tag-quiet">静</span>
              </div>

              <template v-if="assignmentBySeat[seat.id]">
                <div v-if="assignmentBySeat[seat.id].locked" class="lock-badge">🔒</div>
                <div class="seat-member">{{ memberMap[assignmentBySeat[seat.id].memberId]?.name }}</div>
                <div class="seat-member-team">{{ memberMap[assignmentBySeat[seat.id].memberId]?.team }}</div>
                <div class="pref-indicators">
                  <span
                    v-if="isWindowMet(memberMap[assignmentBySeat[seat.id].memberId], seat) === true"
                    class="pref-met"
                  >✅靠窗</span>
                  <span
                    v-if="isWindowMet(memberMap[assignmentBySeat[seat.id].memberId], seat) === false"
                    class="pref-unmet"
                  >❌靠窗</span>
                  <span
                    v-if="isQuietMet(memberMap[assignmentBySeat[seat.id].memberId], seat) === true"
                    class="pref-met"
                  >✅安静</span>
                  <span
                    v-if="isQuietMet(memberMap[assignmentBySeat[seat.id].memberId], seat) === false"
                    class="pref-unmet"
                  >❌安静</span>
                </div>
              </template>
              <template v-else>
                <div style="margin-top:8px; color:#ccc; font-size:12px;">空闲</div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div class="sidebar">
        <div class="stats-panel">
          <div class="section-title">📊 分配统计</div>
          <div class="stat-row">
            <span class="stat-label">已分配</span>
            <span class="stat-value">{{ stats.total }} / {{ members.length }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">靠窗偏好满足</span>
            <span :class="['stat-value', stats.windowWanted > 0 && stats.windowMet === stats.windowWanted ? 'good' : stats.windowWanted > 0 && stats.windowMet < stats.windowWanted ? 'bad' : '']">
              {{ stats.windowMet }} / {{ stats.windowWanted }}
            </span>
          </div>
          <div class="stat-row">
            <span class="stat-label">安静区偏好满足</span>
            <span :class="['stat-value', stats.quietWanted > 0 && stats.quietMet === stats.quietWanted ? 'good' : stats.quietWanted > 0 && stats.quietMet < stats.quietWanted ? 'bad' : '']">
              {{ stats.quietMet }} / {{ stats.quietWanted }}
            </span>
          </div>
          <div class="stat-row">
            <span class="stat-label">锁定座位</span>
            <span class="stat-value">{{ stats.lockedCount }}</span>
          </div>
        </div>

        <div class="member-panel">
          <div class="section-title">👥 成员列表</div>
          <div v-for="m in members" :key="m.id" class="member-item">
            <div class="member-info">
              <div class="member-name">{{ m.name }}</div>
              <div class="member-team">{{ m.team }}</div>
              <div class="member-prefs">
                <span v-if="m.wantsWindow" class="tag tag-window">靠窗</span>
                <span v-if="m.needsQuiet" class="tag tag-quiet">安静</span>
              </div>
            </div>
            <div class="member-seat-info">
              <template v-if="assignmentByMember[m.id]">
                <div class="member-seat-label">{{ assignmentByMember[m.id].seatId }}</div>
                <div v-if="seatMap[assignmentByMember[m.id].seatId]">
                  <span style="font-size:10px; color:#888;">{{ seatMap[assignmentByMember[m.id].seatId].area }}</span>
                </div>
                <button
                  v-if="assignmentByMember[m.id].locked"
                  class="member-lock-btn unlock-btn"
                  @click="doUnlock(m.id)"
                >🔓 解锁</button>
                <button
                  v-else
                  class="member-lock-btn lock-btn"
                  @click="doLock(m.id, assignmentByMember[m.id].seatId)"
                >🔒 锁定</button>
              </template>
              <template v-else>
                <div class="member-seat-none">未分配</div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
