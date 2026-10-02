<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useLiftStore } from './store';

const store = useLiftStore();
const { pendingChanges, conflicts, confirmations, network, syncStatus, lastSyncAt, pendingCount } = storeToRefs(store);

const openConflicts = computed(() => conflicts.value.filter((item) => item.status === 'open'));
const resolvedConflicts = computed(() => conflicts.value.filter((item) => item.status === 'resolved'));
const pendingConfirmations = computed(() => confirmations.value.filter((item) => item.status === 'pending'));
const confirmedConfirmations = computed(() => confirmations.value.filter((item) => item.status === 'confirmed'));

function formatTime(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="content-panel full-panel">
    <div class="panel-heading">
      <div>
        <span class="panel-kicker">SYNC CENTER</span>
        <h2>离线改动同步与冲突合并</h2>
      </div>
      <div class="sync-actions">
        <q-btn
          :color="network === 'online' ? 'primary' : 'grey'"
          :icon="network === 'online' ? 'sync' : 'cloud_off'"
          :label="network === 'online' ? '立即同步' : '当前离线'"
          :loading="syncStatus === 'syncing'"
          :disable="network === 'offline'"
          no-caps
          @click="store.sync"
        />
        <q-btn outline no-caps icon="science" label="模拟服务端改动" @click="store.simulateServerChange" />
      </div>
    </div>

    <div class="sync-status-bar" :class="network">
      <q-icon :name="network === 'online' ? 'cloud_done' : 'cloud_off'" />
      <div>
        <strong>{{ network === 'online' ? '网络已连接' : '离线模式' }}</strong>
        <span>
          {{ network === 'online'
            ? `断网期间的改动将在联网后合并到服务端。${lastSyncAt ? '上次同步 ' + formatTime(lastSyncAt) : '尚未同步'}`
            : '可继续编辑草稿、补充意见和签署，改动保存在本机，联网后自动同步。' }}
        </span>
      </div>
      <q-space />
      <q-badge v-if="pendingCount > 0" color="warning" class="pending-badge">{{ pendingCount }} 项待同步</q-badge>
      <q-badge v-else-if="syncStatus === 'success'" color="positive">已同步</q-badge>
      <q-badge v-else-if="syncStatus === 'failed'" color="negative">同步失败，可重试</q-badge>
    </div>

    <div class="sync-sections">
      <section class="sync-section">
        <div class="section-head">
          <h3>待同步改动</h3>
          <q-badge color="warning">{{ pendingChanges.length }}</q-badge>
        </div>
        <div v-if="pendingChanges.length === 0" class="empty-state">没有待同步的本地改动。</div>
        <div v-for="change in pendingChanges" :key="change.id" class="sync-row">
          <div class="sync-row-main">
            <strong>{{ change.stepId }} · {{ change.label }}</strong>
            <span>{{ change.baseValue }}{{ change.unit }} → <em>{{ change.localValue }}{{ change.unit }}</em></span>
          </div>
          <q-badge v-if="change.status === 'failed'" color="negative">失败</q-badge>
          <q-badge v-else color="warning">待同步</q-badge>
        </div>
      </section>

      <section class="sync-section">
        <div class="section-head">
          <h3>合并冲突 <small>同一字段两边都改过</small></h3>
          <q-badge color="negative">{{ openConflicts.length }}</q-badge>
        </div>
        <div v-if="openConflicts.length === 0" class="empty-state">没有未决冲突。</div>
        <div v-for="conflict in openConflicts" :key="conflict.id" class="conflict-card">
          <div class="conflict-card-head">
            <strong>{{ conflict.stepId }} · {{ conflict.label }}</strong>
            <q-badge v-if="conflict.controlled" color="negative">受控参数 · 需安全监督确认</q-badge>
            <q-badge v-else color="warning">字段冲突</q-badge>
          </div>
          <div class="conflict-versions">
            <div class="version local">
              <span>本地版本</span>
              <strong>{{ conflict.localValue }}{{ conflict.unit }}</strong>
            </div>
            <div class="version server">
              <span>服务端版本</span>
              <strong>{{ conflict.serverValue }}{{ conflict.unit }}</strong>
            </div>
          </div>
          <div class="conflict-actions">
            <q-btn size="sm" outline no-caps label="采用本地" @click="store.resolveConflict(conflict.id, 'local')" />
            <q-btn size="sm" color="primary" no-caps label="采用服务端" @click="store.resolveConflict(conflict.id, 'server')" />
          </div>
        </div>
        <div v-for="conflict in resolvedConflicts" :key="conflict.id" class="conflict-card resolved">
          <div class="conflict-card-head">
            <strong>{{ conflict.stepId }} · {{ conflict.label }}</strong>
            <q-badge color="positive">已解决 · 采用{{ conflict.resolution === 'local' ? '本地' : '服务端' }}</q-badge>
          </div>
          <small>操作人：{{ conflict.resolvedBy }}</small>
        </div>
      </section>

      <section class="sync-section">
        <div class="section-head">
          <h3>受控参数两版确认 <small>荷载率 / 净空 / 风速</small></h3>
          <q-badge color="warning">{{ pendingConfirmations.length }}</q-badge>
        </div>
        <div v-if="pendingConfirmations.length === 0" class="empty-state">没有待确认的受控参数改动。</div>
        <div v-for="item in pendingConfirmations" :key="item.id" class="conflict-card">
          <div class="conflict-card-head">
            <strong>{{ item.stepId }} · {{ item.label }}</strong>
            <q-badge color="negative">需安全监督确认</q-badge>
          </div>
          <div class="conflict-versions">
            <div class="version server">
              <span>改动前</span>
              <strong>{{ item.oldValue }}{{ item.unit }}</strong>
            </div>
            <div class="version local">
              <span>离线改动</span>
              <strong>{{ item.newValue }}{{ item.unit }}</strong>
            </div>
          </div>
          <div class="conflict-actions">
            <q-btn size="sm" color="primary" no-caps icon="verified_user" label="安全监督确认并采用新版" @click="store.confirmControlled(item.id)" />
          </div>
        </div>
        <div v-for="item in confirmedConfirmations" :key="item.id" class="conflict-card resolved">
          <div class="conflict-card-head">
            <strong>{{ item.stepId }} · {{ item.label }}</strong>
            <q-badge color="positive">已确认</q-badge>
          </div>
          <small>{{ item.oldValue }}{{ item.unit }} → {{ item.newValue }}{{ item.unit }} · {{ item.confirmedBy }}</small>
        </div>
      </section>
    </div>
  </div>
</template>
