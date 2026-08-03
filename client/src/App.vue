<script setup>
import { ref, computed, onMounted } from 'vue'

const members = ref([])
const seats = ref([])
const assignments = ref([])
const loading = ref(false)
const toast = ref('')
const preview = ref(null)
const previewExpired = ref(false)

function showToast(msg) {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 2500)
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

function markPreviewExpired() {
  if (preview.value) {
    previewExpired.value = true
  }
}

async function generatePreview() {
  loading.value = true
  try {
    const res = await fetch('/api/assign/preview', { method: 'POST' })
    preview.value = await res.json()
    previewExpired.value = false
  } finally {
    loading.value = false
  }
}

async function confirmPreview() {
  if (!preview.value) return
  if (previewExpired.value) {
    showToast('方案已过期，请重新生成')
    return
  }
  loading.value = true
  try {
    const res = await fetch('/api/assign/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fingerprint: preview.value.fingerprint,
        revision: preview.value.revision
      })
    })
    if (res.status === 409) {
      previewExpired.value = true
      const data = await res.json()
      showToast(data.error || '方案已过期，请重新生成')
      return
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || '保存失败，数据未发生变化')
      return
    }
    const data = await res.json()
    assignments.value = data.assignments
    preview.value = null
    previewExpired.value = false
    showToast('方案已保存！')
  } catch (e) {
    showToast('保存失败，数据未发生变化')
  } finally {
    loading.value = false
  }
}

function cancelPreview() {
  preview.value = null
  previewExpired.value = false
}

async function doClear() {
  loading.value = true
  try {
    const res = await fetch('/api/clear', { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || '清空失败，数据未发生变化')
      return
    }
    assignments.value = await res.json()
    markPreviewExpired()
    showToast('已清空所有分配')
  } catch (e) {
    showToast('清空失败，数据未发生变化')
  } finally {
    loading.value = false
  }
}

async function doLock(memberId, seatId) {
  try {
    const res = await fetch('/api/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, seatId })
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || '锁定失败，数据未发生变化')
      return
    }
    const updated = await res.json()
    // 只有服务端返回对应成员确实已锁定，才更新状态并提示成功
    const confirmed = updated.some(
      a => a.memberId === memberId && a.seatId === seatId && a.locked
    )
    if (!confirmed) {
      showToast('锁定失败，数据未发生变化')
      return
    }
    assignments.value = updated
    markPreviewExpired()
    showToast('已锁定座位')
  } catch (e) {
    showToast('锁定失败，数据未发生变化')
  }
}

async function doUnlock(memberId) {
  try {
    const res = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId })
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || '解锁失败，数据未发生变化')
      return
    }
    const updated = await res.json()
    const confirmed = updated.some(
      a => a.memberId === memberId && !a.locked
    )
    if (!confirmed) {
      showToast('解锁失败，数据未发生变化')
      return
    }
    assignments.value = updated
    markPreviewExpired()
    showToast('已解锁座位')
  } catch (e) {
    showToast('解锁失败，数据未发生变化')
  }
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

const displayAssignments = computed(() => {
  if (preview.value) return preview.value.assignments
  return assignments.value
})

const assignmentBySeat = computed(() => {
  const map = {}
  for (const a of displayAssignments.value) map[a.seatId] = a
  return map
})

// 真实已保存的分配，锁定/解锁操作始终基于此而非预览建议
const realAssignmentByMember = computed(() => {
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
  const source = displayAssignments.value
  const total = source.length
  let windowWanted = 0
  let windowMet = 0
  let quietWanted = 0
  let quietMet = 0
  let lockedCount = 0

  for (const a of source) {
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
      <p>智能满足靠窗与安静区偏好，全局最优分配预览后确认</p>
    </div>

    <div class="actions">
      <button
        v-if="!preview"
        class="btn btn-primary"
        :disabled="loading"
        @click="generatePreview"
      >
        🎯 生成分配预览
      </button>
      <template v-else>
        <button
          class="btn"
          :class="previewExpired ? 'btn-warning' : 'btn-success'"
          :disabled="loading"
          @click="confirmPreview"
        >
          {{ previewExpired ? '⚠️ 方案已过期' : '✅ 确认保存方案' }}
        </button>
        <button
          v-if="previewExpired"
          class="btn btn-primary"
          :disabled="loading"
          @click="generatePreview"
        >
          🔄 重新生成预览
        </button>
        <button
          class="btn btn-secondary"
          :disabled="loading"
          @click="cancelPreview"
        >
          ↩️ 取消预览
        </button>
      </template>
      <button
        class="btn btn-danger"
        :disabled="loading || (!preview && assignments.length === 0)"
        @click="doClear"
      >
        🗑️ 清空全部分配
      </button>
    </div>

    <div v-if="preview" class="preview-banner" :class="{ expired: previewExpired }">
      <span v-if="!previewExpired">📋 当前为预览状态，尚未保存。确认后才会写入数据，取消则恢复原状。</span>
      <span v-else>⚠️ 方案已过期（锁定/解锁/清空后状态已变化），请重新生成预览。</span>
    </div>

    <div class="legend" style="margin-bottom: 20px">
      <div class="legend-items">
        <div class="legend-item"><div class="legend-dot empty"></div> 空座</div>
        <div class="legend-item"><div class="legend-dot occupied"></div> 已分配</div>
        <div class="legend-item"><div class="legend-dot locked"></div> 已锁定</div>
        <div v-if="preview" class="legend-item"><div class="legend-dot preview-dot"></div> 预览中</div>
        <div class="legend-item"><span class="tag tag-window">窗</span> 靠窗</div>
        <div class="legend-item"><span class="tag tag-quiet">静</span> 安静区</div>
      </div>
    </div>

    <div class="main-grid">
      <div class="seat-map">
        <div class="section-title">
          📍 座位分布图
          <span v-if="preview" class="preview-tag">预览</span>
        </div>
        <div v-for="(areaSeats, areaName) in seatsByArea" :key="areaName" class="area-group">
          <div class="area-label">{{ areaName }}</div>
          <div class="seat-row">
            <div
              v-for="seat in areaSeats"
              :key="seat.id"
              :class="[
                'seat-card',
                assignmentBySeat[seat.id] ? 'occupied' : 'empty',
                assignmentBySeat[seat.id]?.locked ? 'locked' : '',
                preview && !assignmentBySeat[seat.id]?.locked && assignmentBySeat[seat.id] ? 'preview-seat' : ''
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
        <div v-if="preview" class="preview-panel">
          <div class="section-title">🧾 分配方案预览</div>
          <div class="total-score">
            <span class="total-score-label">方案总得分</span>
            <span class="total-score-value">{{ preview.totalScore }}</span>
          </div>

          <div class="preview-list">
            <div
              v-for="a in preview.assignments"
              :key="a.memberId"
              class="preview-item"
              :class="{ 'preview-locked': a.locked }"
            >
              <div class="preview-item-main">
                <div class="preview-item-name">
                  {{ a.memberName }}
                  <span v-if="a.locked" class="mini-lock">🔒</span>
                </div>
                <div class="preview-item-team">{{ a.team }}</div>
              </div>
              <div class="preview-item-seat">
                <div class="preview-seat-id">{{ a.seatId }}</div>
                <div class="preview-seat-area">{{ a.area }}</div>
              </div>
              <div class="preview-item-prefs">
                <span v-if="a.windowMet === true" class="pref-met">✅窗</span>
                <span v-else-if="a.windowMet === false" class="pref-unmet">❌窗</span>
                <span v-else class="pref-na">—窗</span>
                <span v-if="a.quietMet === true" class="pref-met">✅静</span>
                <span v-else-if="a.quietMet === false" class="pref-unmet">❌静</span>
                <span v-else class="pref-na">—静</span>
              </div>
              <div class="preview-item-score" :class="a.score >= 0 ? 'score-pos' : 'score-neg'">
                {{ a.score }}
              </div>
            </div>
          </div>

          <div v-if="preview.unassignedMembers.length > 0" class="unassigned-section">
            <div class="unassigned-title">未分配成员（{{ preview.unassignedMembers.length }}）</div>
            <div
              v-for="m in preview.unassignedMembers"
              :key="m.id"
              class="unassigned-item"
            >
              <span class="unassigned-name">{{ m.name }}</span>
              <span class="unassigned-team">{{ m.team }}</span>
              <span class="unassigned-prefs">
                <span v-if="m.wantsWindow" class="tag tag-window">靠窗</span>
                <span v-if="m.needsQuiet" class="tag tag-quiet">安静</span>
              </span>
            </div>
          </div>
        </div>

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
              <template v-if="realAssignmentByMember[m.id]">
                <div class="member-seat-label">{{ realAssignmentByMember[m.id].seatId }}</div>
                <div v-if="seatMap[realAssignmentByMember[m.id].seatId]">
                  <span style="font-size:10px; color:#888;">{{ seatMap[realAssignmentByMember[m.id].seatId].area }}</span>
                </div>
                <button
                  v-if="realAssignmentByMember[m.id].locked"
                  class="member-lock-btn unlock-btn"
                  @click="doUnlock(m.id)"
                >🔓 解锁</button>
                <button
                  v-else
                  class="member-lock-btn lock-btn"
                  @click="doLock(m.id, realAssignmentByMember[m.id].seatId)"
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

<style scoped>
.btn-success {
  background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
  color: #1a4d2e;
}

.btn-success:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(67, 233, 123, 0.4);
}

.btn-secondary {
  background: #6c757d;
  color: white;
}

.btn-secondary:hover:not(:disabled) {
  background: #5a6268;
}

.btn-warning {
  background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%);
  color: white;
}

.btn-warning:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(255, 152, 0, 0.4);
}

.preview-banner {
  background: #e3f2fd;
  border: 1px solid #42a5f5;
  color: #1565c0;
  padding: 12px 20px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 14px;
  text-align: center;
  font-weight: 500;
}

.preview-banner.expired {
  background: #fff3e0;
  border-color: #ff9800;
  color: #e65100;
}

.preview-tag {
  display: inline-block;
  background: #42a5f5;
  color: white;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  margin-left: 8px;
  font-weight: 600;
}

.preview-dot {
  background: #e3f2fd;
  border: 2px dashed #42a5f5;
}

.preview-seat {
  border-style: dashed !important;
  border-color: #42a5f5 !important;
  box-shadow: 0 0 0 1px rgba(66, 165, 245, 0.3);
}

.preview-panel {
  background: white;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  border: 2px solid #42a5f5;
}

.total-score {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
}

.total-score-label {
  font-size: 14px;
  font-weight: 500;
}

.total-score-value {
  font-size: 24px;
  font-weight: 700;
}

.preview-list {
  max-height: 360px;
  overflow-y: auto;
}

.preview-item {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  margin-bottom: 4px;
  background: #f8f9fa;
  font-size: 12px;
}

.preview-item.preview-locked {
  background: #fff3e0;
}

.preview-item-name {
  font-weight: 600;
  color: #1a1a2e;
  font-size: 13px;
}

.mini-lock {
  font-size: 11px;
}

.preview-item-team {
  color: #888;
  font-size: 11px;
}

.preview-item-seat {
  text-align: center;
}

.preview-seat-id {
  font-weight: 700;
  color: #1565c0;
}

.preview-seat-area {
  font-size: 10px;
  color: #888;
}

.preview-item-prefs {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 10px;
}

.pref-na {
  color: #bbb;
}

.preview-item-score {
  font-weight: 700;
  font-size: 14px;
  min-width: 32px;
  text-align: right;
}

.score-pos {
  color: #4caf50;
}

.score-neg {
  color: #f44336;
}

.unassigned-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed #ddd;
}

.unassigned-title {
  font-size: 13px;
  font-weight: 600;
  color: #f44336;
  margin-bottom: 8px;
}

.unassigned-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: #ffebee;
  border-radius: 6px;
  margin-bottom: 4px;
  font-size: 12px;
}

.unassigned-name {
  font-weight: 600;
  color: #c62828;
}

.unassigned-team {
  color: #888;
  font-size: 11px;
  flex: 1;
}

.unassigned-prefs {
  display: flex;
  gap: 4px;
}
</style>
