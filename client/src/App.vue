<script setup>
import { ref, computed, onMounted } from 'vue'

const members = ref([])
const seats = ref([])
const assignments = ref([])
const loading = ref(false)
const toast = ref('')
let toastTimer = null

const preview = ref(null)
const previewExpired = ref(false)
const previewLoading = ref(false)
const confirmLoading = ref(false)
// 生成预览的请求序号：异步返回时校验是否仍是最新请求，
// 防止旧请求在新请求之后返回而覆盖状态
let previewReqSeq = 0

/**
 * 显示一条轻提示。默认情况下新提示会覆盖旧提示；当 sticky=true 时，
 * 该提示不会被后续非 sticky 提示覆盖，用于“方案已过期”这类需要持续可见的状态。
 * @param {string} msg 提示文本
 * @param {{sticky?: boolean, duration?: number}} [options]
 */
function showToast(msg, options = {}) {
  const { sticky = false, duration = 2500 } = options
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
  toast.value = { text: msg, sticky }
  if (!sticky) {
    toastTimer = setTimeout(() => {
      toast.value = ''
      toastTimer = null
    }, duration)
  }
}

/** 清除提示（仅在非 sticky 时允许被普通操作清掉） */
function clearToast() {
  if (toast.value && toast.value.sticky) return
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
  toast.value = ''
}

/** 强制清除任意提示（含 sticky），用于新预览生成成功后刷新提示状态 */
function forceClearToast() {
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
  toast.value = ''
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

/**
 * 生成分配预览：只请求服务端方案，不修改本地 JSON。
 * - 成功：展示新方案，清除旧的过期提示与过期标记，提示与当前方案一致
 * - 失败：继续保留旧方案及其过期状态，不覆盖、不清提示
 */
async function generatePreview() {
  const reqSeq = ++previewReqSeq
  previewLoading.value = true
  try {
    const res = await fetch('/api/assign/preview', { method: 'POST' })
    if (!res.ok) throw new Error('生成预览失败')
    const data = await res.json()
    // 若期间又发起了新的生成请求，则放弃本次结果，避免旧请求覆盖新状态
    if (reqSeq !== previewReqSeq) return
    preview.value = data
    previewExpired.value = false
    // 新预览已成功生成，清除“方案已过期”等旧提示（含 sticky）
    forceClearToast()
  } catch (e) {
    if (reqSeq !== previewReqSeq) return
    // 生成失败：保留旧方案与过期状态，仅当当前没有 sticky 提示时才提示失败
    if (!(toast.value && toast.value.sticky)) {
      showToast(e.message || '生成预览失败')
    }
  } finally {
    if (reqSeq === previewReqSeq) {
      previewLoading.value = false
    }
  }
}

/**
 * 取消预览：丢弃方案并恢复页面状态，不产生任何数据变化。
 */
function cancelPreview() {
  preview.value = null
  previewExpired.value = false
  forceClearToast()
}

/**
 * 确认保存预览：服务端校验 baseRevision，若状态已变化则返回 409。
 * 即使预览已被本地标记为过期，也允许用户再次点击确认，由服务端返回 409
 * 并展示“方案已过期，请重新生成”；旧方案继续保留，不写入任何数据。
 */
async function confirmPreview() {
  if (!preview.value) return
  confirmLoading.value = true
  try {
    const res = await fetch('/api/assign/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: preview.value.baseRevision })
    })
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}))
      // 保留旧方案，只标记为过期并持续提示；用户可重新生成或取消
      previewExpired.value = true
      showToast(data.message || '方案已过期，请重新生成', { sticky: true })
      return
    }
    if (!res.ok) throw new Error('保存失败')
    const saved = await res.json()
    assignments.value = saved.newAssignments
    preview.value = null
    previewExpired.value = false
    showToast('方案已保存')
  } catch (e) {
    showToast(e.message || '保存失败')
  } finally {
    confirmLoading.value = false
  }
}

/**
 * 任何会改动 assignments 的操作（锁定/解锁/清空）都会让旧预览失效。
 * 这里不删除预览，而是保留内容并标记为过期，同时用持续可见的提示说明，
 * 避免后续“锁定成功/解锁成功/已清空”提示把过期状态覆盖掉。
 */
function markPreviewExpired() {
  if (preview.value && !previewExpired.value) {
    previewExpired.value = true
    showToast('方案已过期，请重新生成', { sticky: true })
  }
}

async function doClear() {
  const wasPreview = !!preview.value
  markPreviewExpired()
  loading.value = true
  try {
    const res = await fetch('/api/clear', { method: 'POST' })
    assignments.value = await res.json()
    if (!wasPreview) showToast('已清空所有分配')
  } finally {
    loading.value = false
  }
}

async function doLock(memberId, seatId) {
  const wasPreview = !!preview.value
  markPreviewExpired()
  const res = await fetch('/api/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, seatId })
  })
  assignments.value = await res.json()
  if (!wasPreview) showToast('已锁定座位')
}

async function doUnlock(memberId) {
  const wasPreview = !!preview.value
  markPreviewExpired()
  const res = await fetch('/api/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId })
  })
  assignments.value = await res.json()
  if (!wasPreview) showToast('已解锁座位')
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
    <div v-if="toast" class="toast" :class="{ 'toast-sticky': toast.sticky }">{{ toast.text }}</div>

    <div class="header">
      <h1>🎲 座位盲盒分配器</h1>
      <p>全局最优匹配，先预览再确认，智能满足靠窗与安静区偏好</p>
    </div>

    <div class="actions">
      <button
        class="btn btn-primary"
        :disabled="loading || previewLoading || confirmLoading"
        @click="generatePreview"
      >
        {{ preview ? '🔄 重新生成预览' : '🎯 生成分配预览' }}
      </button>
      <button
        class="btn btn-danger"
        :disabled="loading || assignments.length === 0"
        @click="doClear"
      >
        🗑️ 清空全部分配
      </button>
    </div>

    <div v-if="preview" class="preview-panel" :class="{ 'preview-expired': previewExpired }">
      <div v-if="previewExpired" class="preview-expired-banner">
        ⚠️ 方案已过期，请重新生成（下方为旧方案，不会被保存）
      </div>
      <div class="preview-header">
        <div class="section-title" style="margin-bottom:0;">
          📋 分配预览（尚未保存）
          <span v-if="previewExpired" class="expired-tag">已过期</span>
        </div>
        <div class="preview-total">
          方案总得分：<span class="total-score">{{ preview.totalScore }}</span>
          <span class="lock-hint">🔒 锁定项已保留</span>
        </div>
      </div>

      <div class="preview-table-wrap">
        <table class="preview-table">
          <thead>
            <tr>
              <th>成员</th>
              <th>团队</th>
              <th>座位</th>
              <th>区域</th>
              <th>靠窗</th>
              <th>安静</th>
              <th>个人得分</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in preview.details" :key="d.memberId">
              <td class="cell-name">{{ d.memberName }}</td>
              <td>{{ d.team }}</td>
              <td class="cell-seat">{{ d.seatId }}</td>
              <td>{{ d.area }}</td>
              <td>
                <span v-if="d.windowMet === true" class="pref-met">✅ 满足</span>
                <span v-else-if="d.windowMet === false" class="pref-unmet">❌ 未满足</span>
                <span v-else class="pref-na">—</span>
              </td>
              <td>
                <span v-if="d.quietMet === true" class="pref-met">✅ 满足</span>
                <span v-else-if="d.quietMet === false" class="pref-unmet">❌ 未满足</span>
                <span v-else class="pref-na">—</span>
              </td>
              <td class="cell-score" :class="d.score >= 0 ? 'score-pos' : 'score-neg'">
                {{ d.score }}
              </td>
              <td>
                <span v-if="d.locked" class="tag tag-locked">🔒 已锁定</span>
                <span v-else class="tag tag-new">🆕 建议</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="preview.unassignedMembers && preview.unassignedMembers.length" class="unassigned">
        <div class="unassigned-title">⚠️ 未分配座位的成员（{{ preview.unassignedMembers.length }} 人）</div>
        <div class="unassigned-list">
          <span v-for="u in preview.unassignedMembers" :key="u.memberId" class="unassigned-chip">
            {{ u.memberName }}
            <span v-if="u.wantsWindow" class="tag tag-window">窗</span>
            <span v-if="u.needsQuiet" class="tag tag-quiet">静</span>
          </span>
        </div>
      </div>

      <div class="preview-actions">
        <button
          class="btn"
          :class="previewExpired ? 'btn-warning' : 'btn-primary'"
          :disabled="confirmLoading"
          @click="confirmPreview"
        >
          {{ previewExpired ? '⚠️ 确认已过期方案' : '✅ 确认保存方案' }}
        </button>
        <button
          class="btn btn-secondary"
          :disabled="confirmLoading"
          @click="cancelPreview"
        >
          ❌ 取消
        </button>
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
