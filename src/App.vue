<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore, formatFieldValue } from './store';
import { roles } from './seed';
import type { Blocker, LiftStep, RoleId } from './types';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');

/* ---------- 步骤参数草稿：保存时才抬升版本、使旧意见作废 ---------- */
const draft = reactive<Partial<LiftStep>>({});
watch(
  () => store.selectedStepId,
  () => Object.assign(draft, store.selectedStep),
  { immediate: true }
);

function saveDraft() {
  store.commitStep({
    loadRate: Number(draft.loadRate),
    clearance: Number(draft.clearance),
    wind: Number(draft.wind),
    radius: Number(draft.radius),
    boom: Number(draft.boom),
    status: draft.status as LiftStep['status'],
    note: draft.note
  });
  Object.assign(draft, store.selectedStep);
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

/* ---------- 同步与门禁 ---------- */
function syncNow() {
  void store.sync();
}

function triggerFailureOnce() {
  store.setFailBudget(store.failBudget + 1);
}

const blockerGroups = computed(() => {
  const meta: Record<Blocker['type'], string> = {
    merge: '未决合并冲突',
    rule: '规则校核冲突',
    openComment: '未关闭意见',
    staleComment: '过期意见',
    signoff: '会签签署'
  };
  return (Object.keys(meta) as Blocker['type'][])
    .map((type) => ({ type, title: meta[type], items: store.blockers.filter((b) => b.type === type) }))
    .filter((group) => group.items.length > 0);
});

function blockerTarget(blocker: Blocker) {
  if (blocker.type === 'signoff') {
    store.switchRole(blocker.role as RoleId);
    go('/review');
  } else {
    if (blocker.stepId) store.selectStep(blocker.stepId);
    go('/checks');
  }
}

/* ---------- 检查页分区 ---------- */
const checksTab = ref(store.unresolvedConflicts.length > 0 ? 'merge' : 'rule');
const roleList = Object.keys(roles) as RoleId[];

function roleStateColor(state: string) {
  return state === 'accepted' ? 'positive' : state === 'reserved' ? 'warning' : state === 'invalid' ? 'negative' : 'grey';
}
function roleStateLabel(state: string) {
  return { accepted: '已接受', reserved: '有保留', unsigned: '待确认', invalid: '签署已作废' }[state] ?? state;
}

const stepComments = computed(() => store.comments.filter((c) => c.stepId === store.selectedStepId));

/* ---------- 三维场景（拖动旋转） ---------- */
function initializeScene() {
  if (!canvasRef.value || !sceneContainer.value) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6e1');
  scene.fog = new THREE.Fog('#dce6e1', 34, 78);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.HemisphereLight('#eefaf5', '#273b34', 2.3));
  const sun = new THREE.DirectionalLight('#fff4d6', 3.2);
  sun.position.set(14, 28, 18);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 44),
    new THREE.MeshStandardMaterial({ color: '#b8c7bf', roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 30, '#80948a', '#a8b8b0');
  grid.position.y = 0.02;
  scene.add(grid);

  const steel = new THREE.MeshStandardMaterial({ color: '#ec7a3c', roughness: 0.48, metalness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#2d5c4f', roughness: 0.58, metalness: 0.42 });
  const truss = new THREE.Group();
  const chordGeometry = new THREE.BoxGeometry(18, 1.1, 1.1);
  for (const z of [-3.5, 3.5]) {
    for (const y of [4.2, 8.4]) {
      const chord = new THREE.Mesh(chordGeometry, steel);
      chord.position.set(0, y, z);
      truss.add(chord);
    }
  }
  for (let x = -8; x <= 8; x += 2) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.8, 0.34), steel);
    brace.position.set(x, 6.2, -3.5);
    brace.rotation.z = x % 4 === 0 ? 0.36 : -0.36;
    truss.add(brace);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 7), darkSteel);
    cross.position.set(x, 4.2, 0);
    truss.add(cross);
  }
  truss.position.set(0, 6.5, 2);
  scene.add(truss);

  const crane = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 5), darkSteel);
  base.position.y = 0.6;
  crane.add(base);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.7, 3), new THREE.MeshStandardMaterial({ color: '#d8a733' }));
  cabin.position.set(-1, 2.5, 0);
  crane.add(cabin);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 24, 1.2), darkSteel);
  mast.position.y = 12;
  crane.add(mast);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 36), steel);
  boom.position.set(-8.5, 20.5, 9.5);
  boom.rotation.set(-0.38, 0.7, 0.14);
  crane.add(boom);
  crane.position.set(-15, 0, -12);
  scene.add(crane);

  const obstacleMat = new THREE.MeshStandardMaterial({ color: '#d34c45', transparent: true, opacity: 0.38 });
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 4), obstacleMat);
  obstacle.position.set(10, 2.5, 8);
  scene.add(obstacle);
  scene.add(new THREE.BoxHelper(obstacle, '#a92d2a'));

  const updateCamera = () => {
    const radius = 48;
    camera.position.set(
      Math.sin(theta) * Math.sin(phi) * radius,
      Math.cos(phi) * radius + 12,
      Math.cos(theta) * Math.sin(phi) * radius
    );
    camera.lookAt(0, 7, 0);
  };

  const render = () => {
    frame = requestAnimationFrame(render);
    truss.position.y = 6.5 + Math.sin(Date.now() / 900) * 0.08;
    updateCamera();
    renderer?.render(scene, camera);
  };
  render();

  const resize = () => {
    if (!sceneContainer.value || !renderer) return;
    const { width, height } = sceneContainer.value.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneContainer.value);
  resize();

  canvasRef.value.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    canvasRef.value?.setPointerCapture(event.pointerId);
  };
  canvasRef.value.onpointermove = (event) => {
    if (!dragging) return;
    theta += (event.clientX - previousX) * 0.006;
    previousX = event.clientX;
  };
  canvasRef.value.onpointerup = () => {
    dragging = false;
  };
}

onMounted(() => {
  store.initNetwork();
  nextTick(initializeScene);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
});
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>东塔转换桁架 · 方案版本 V{{ store.revision }}</span>
        </div>
        <q-space />

        <!-- 同步中心 -->
        <q-btn flat no-caps class="sync-btn">
          <q-icon :name="store.online ? (store.syncing ? 'sync' : 'cloud_done') : 'cloud_off'" :color="store.online ? 'teal-3' : 'orange-3'" size="20px" />
          <span class="sync-btn-text">
            {{ store.syncing ? '同步中…' : store.online ? '在线' : '断网离线' }}
            <small v-if="store.pending.length">未同步 {{ store.pending.length }} 项</small>
          </span>
          <q-badge v-if="store.pending.length" floating color="orange">{{ store.pending.length }}</q-badge>
          <q-menu anchor="bottom right" self="top right" :auto-close="false" class="sync-menu">
            <div style="min-width: 330px; padding: 14px;">
              <div class="sync-menu-head">
                <strong>同步中心</strong>
                <q-toggle
                  :model-value="store.online"
                  checked-icon="cloud"
                  unchecked-icon="cloud_off"
                  @update:model-value="store.toggleOnline()"
                />
              </div>
              <div class="sync-status-row">
                <q-icon :name="store.online ? 'wifi' : 'wifi_off'" :color="store.online ? 'green' : 'orange'" size="18px" />
                <span>{{ store.online ? '网络已连接' : '网络已断开：班组可继续改草稿、补意见、签署' }}</span>
              </div>
              <div v-if="store.lastSyncAt" class="sync-meta">上次成功同步：{{ store.lastSyncAt }}</div>
              <q-banner v-if="store.lastSyncError" class="sync-error" dense rounded :style="{ marginTop: '8px' }">
                <template #avatar><q-icon name="error_outline" color="orange-9" /></template>
                {{ store.lastSyncError }}
              </q-banner>
              <div v-if="store.pending.length" class="pending-list">
                <div class="pending-title">待同步 / 未完成项（{{ store.pending.length }}）</div>
                <div v-for="op in store.pending" :key="op.id" class="pending-row">
                  <q-icon name="pending_actions" size="16px" />
                  <span>{{ op.label }}</span>
                  <small>{{ op.createdAt }}</small>
                </div>
              </div>
              <div class="sync-actions">
                <q-btn color="primary" no-caps icon="sync" :label="store.syncing ? '同步中' : '立即同步'" :loading="store.syncing" :disable="!store.online" @click="syncNow" />
              </div>
              <q-separator style="margin: 10px 0" />
              <div class="demo-title">演示注入</div>
              <div class="demo-actions">
                <q-btn dense no-caps outline icon="edit_note" label="模拟他端改参数" :disable="!store.online || store.syncing" @click="store.simulateRemote()" />
                <q-btn dense no-caps outline icon="sync_problem" label="安排一次失败" @click="triggerFailureOnce" />
                <q-btn dense no-caps outline icon="restart_alt" label="重置演示" @click="store.resetDemo" />
              </div>
              <div v-if="store.failBudget > 0" class="sync-meta">下 {{ store.failBudget }} 次同步将失败，用于验证失败保留与重试。</div>
            </div>
          </q-menu>
        </q-btn>

        <!-- 角色切换 -->
        <q-btn flat no-caps class="role-btn">
          <q-icon name="account_circle" size="20px" />
          <span class="sync-btn-text">
            {{ store.currentUser.name }}
            <small>{{ store.currentUser.team }}</small>
          </span>
          <q-menu anchor="bottom right" self="top right">
            <q-list dense>
              <q-item v-for="role in roleList" :key="role" clickable :active="role === store.currentRole" @click="store.switchRole(role)">
                <q-item-section>{{ roles[role].name }} · {{ roles[role].team }}</q-item-section>
                <q-item-section v-if="role === 'safety'" side><q-badge dense color="deep-orange">安全监督</q-badge></q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>

        <q-btn dense flat round icon="notifications" aria-label="通知" @click="go('/checks')">
          <q-badge v-if="store.openComments.length" floating color="red">{{ store.openComments.length }}</q-badge>
        </q-btn>
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
      </q-toolbar>
    </q-header>

    <q-drawer show-if-above side="left" :width="232" bordered class="left-nav">
      <div class="drawer-section-label">方案工作区</div>
      <q-list padding>
        <q-item
          v-for="item in nav"
          :key="item.path"
          clickable
          :active="route.path === item.path"
          active-class="nav-active"
          @click="go(item.path)"
        >
          <q-item-section avatar><q-icon :name="item.icon" /></q-item-section>
          <q-item-section>{{ item.label }}</q-item-section>
          <q-item-section v-if="item.path === '/checks'" side>
            <q-badge v-if="store.unresolvedConflicts.length" color="negative">{{ store.unresolvedConflicts.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon :name="store.online ? 'cloud_done' : 'cloud_off'" :color="store.online ? 'teal' : 'orange'" />
        <span>
          {{ store.locked ? '版本已锁定，数据只读' : store.online ? (store.pending.length ? `本地有 ${store.pending.length} 项待同步` : '草稿已同步') : '离线草稿已本地保存，重开不丢' }}
          <br v-if="store.lastSyncAt" /><small v-if="store.lastSyncAt">最近同步 {{ store.lastSyncAt }}</small>
        </span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <q-banner v-if="!store.locked && !store.online" class="offline-banner" dense rounded>
          <template #avatar><q-icon name="cloud_off" color="orange-9" /></template>
          当前处于断网状态：可继续修改步骤草稿、补充会签意见并完成签署，所有改动保存在本地，网络恢复后自动同步合并。
          <template #action>
            <q-btn no-caps unelevated color="orange-8" icon="wifi" label="恢复网络" @click="store.toggleOnline()" />
          </template>
        </q-banner>
        <q-banner v-if="store.lastSyncError && store.online && !store.syncing" class="sync-banner" dense rounded>
          <template #avatar><q-icon name="sync_problem" color="red-9" /></template>
          {{ store.lastSyncError }} 未完成项已保留。
          <template #action>
            <q-btn no-caps flat color="red-9" icon="replay" label="重试同步" @click="syncNow" />
          </template>
        </q-banner>
        <q-banner v-if="store.locked" class="locked-banner" dense rounded>
          <template #avatar><q-icon name="lock" color="white" /></template>
          方案 V{{ store.revision }} 已锁定发布，参数、意见与签署均为只读。
        </q-banner>

        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn v-if="store.blockers.length" color="primary" no-caps icon="lock" label="确认并锁定" disable>
              <q-tooltip content-style="max-width: 260px; white-space: normal;">
                门禁被 {{ store.blockers.length }} 个具体项阻止，请到「多角色会签」逐项处理。
              </q-tooltip>
            </q-btn>
            <q-btn v-else color="primary" no-caps icon="lock" :label="store.lockRequested ? '同步完成后锁定…' : (store.locked ? '版本已锁定' : '确认并锁定')" :loading="store.lockRequested && store.syncing" :disable="store.locked" @click="store.lockPlan" />
          </div>
        </header>

        <section v-if="route.path === '/' || route.path === '/models'" class="work-grid">
          <article class="scene-panel content-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">THREE.JS SCENE</span>
                <h2>吊装姿态与空间冲突</h2>
              </div>
              <div class="view-bookmarks">
                <button
                  v-for="bookmark in store.viewBookmarks"
                  :key="bookmark"
                  :class="{ active: store.activeBookmark === bookmark }"
                  @click="store.setBookmark(bookmark)"
                >
                  {{ bookmark }}
                </button>
              </div>
            </div>
            <div ref="sceneContainer" class="scene-container">
              <canvas ref="canvasRef" aria-label="吊装三维场景" />
              <div class="scene-legend">
                <span><i class="legend-dot crane" />主吊</span>
                <span><i class="legend-dot load" />构件</span>
                <span><i class="legend-dot risk" />障碍物</span>
              </div>
              <div class="scene-hint">拖动旋转视角 · 滚轮缩放由设备手势控制</div>
            </div>
            <div class="timeline">
              <button
                v-for="step in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id }]"
                @click="store.selectStep(step.id)"
              >
                <span>{{ step.time }}</span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空 · v{{ store.paramVersions[step.id] ?? 1 }}</small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
              <q-badge dense :color="store.staleComments.some((c) => c.stepId === store.selectedStep.id) ? 'orange' : 'grey'">
                参数 v{{ store.paramVersions[store.selectedStep.id] ?? 1 }}
              </q-badge>
            </div>
            <q-banner v-if="store.staleComments.some((c) => c.stepId === store.selectedStep.id)" class="stale-banner" dense rounded>
              <template #avatar><q-icon name="history_toggle_off" color="orange-9" /></template>
              该步骤参数已被改动，既有会签意见全部作废，需原提出人重新确认、各角色重新签署。
            </q-banner>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: store.selectedStep.loadRate > 90 }">{{ store.selectedStep.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: store.selectedStep.clearance < 1.5 }">{{ store.selectedStep.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ store.selectedStep.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ store.selectedStep.wind }}m/s</strong></div>
            </div>
            <label class="field-label">荷载率</label>
            <q-slider v-model.number="draft.loadRate" :min="0" :max="120" color="primary" :disable="store.locked" />
            <div class="form-row">
              <q-input v-model.number="draft.clearance" type="number" label="最小净空 / m" outlined dense :disable="store.locked" />
              <q-input v-model.number="draft.wind" type="number" label="风速 / m/s" outlined dense :disable="store.locked" />
            </div>
            <div class="form-row">
              <q-input v-model.number="draft.radius" type="number" label="作业半径 / m" outlined dense :disable="store.locked" />
              <q-input v-model.number="draft.boom" type="number" label="臂长 / m" outlined dense :disable="store.locked" />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              v-model="draft.status"
              spread
              no-caps
              toggle-color="primary"
              :disable="store.locked"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
            />
            <q-input v-model="draft.note" type="textarea" autogrow outlined label="现场控制说明" class="note-input" :disable="store.locked" />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="保存步骤修改（抬升参数版本）" :disable="store.locked" @click="saveDraft" />
            <p class="inspector-hint">保存后该步骤的已有会签意见与覆盖该步骤的签署立即作废；断网时改动先入本地待同步队列。</p>
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <div class="checks-tabs">
              <button :class="{ active: checksTab === 'merge' }" @click="checksTab = 'merge'">
                合并冲突<q-badge v-if="store.unresolvedConflicts.length" dense color="negative">{{ store.unresolvedConflicts.length }}</q-badge>
              </button>
              <button :class="{ active: checksTab === 'rule' }" @click="checksTab = 'rule'">
                规则校核<q-badge v-if="store.ruleConflicts.length" dense color="negative">{{ store.ruleConflicts.length }}</q-badge>
              </button>
              <button :class="{ active: checksTab === 'comments' }" @click="checksTab = 'comments'">
                会签意见<q-badge v-if="store.openComments.length || store.staleComments.length" dense color="orange">{{ store.openComments.length + store.staleComments.length }}</q-badge>
              </button>
            </div>
          </div>

          <!-- 合并冲突：保留两版，安全字段需安全监督确认 -->
          <div v-if="checksTab === 'merge'" class="merge-panel">
            <div v-if="!store.conflicts.length" class="empty-state">
              <q-icon name="check_circle" color="green" size="28px" />
              <p>当前没有同步合并冲突。断网两端同改同一字段后，同步时会在这里生成冲突项。</p>
            </div>
            <div v-for="conflict in store.conflicts" :key="conflict.id" class="merge-card">
              <div class="merge-card-head">
                <strong>{{ conflict.stepId }} · {{ store.steps.find((s) => s.id === conflict.stepId)?.title }}</strong>
                <q-badge v-if="conflict.requiresSafety" color="deep-orange" dense>荷载率/净空/风速 · 安全监督确认</q-badge>
                <q-badge v-else color="grey" dense>普通字段</q-badge>
              </div>
              <p class="merge-field">字段：{{ conflict.label }}</p>
              <div class="merge-versions">
                <button class="version" :class="{ chosen: conflict.resolvedWith === 'local' }" :disabled="conflict.resolvedWith !== null || store.locked" @click="store.resolveConflict(conflict.id, 'local')">
                  <small>本地（班组离线版）</small>
                  <strong>{{ formatFieldValue(conflict.field, conflict.localValue) }}</strong>
                </button>
                <q-icon name="compare_arrows" size="22px" />
                <button class="version remote" :class="{ chosen: conflict.resolvedWith === 'remote' }" :disabled="conflict.resolvedWith !== null || store.locked" @click="store.resolveConflict(conflict.id, 'remote')">
                  <small>远端（他端版）</small>
                  <strong>{{ formatFieldValue(conflict.field, conflict.remoteValue) }}</strong>
                </button>
              </div>
              <div class="merge-foot">
                <template v-if="conflict.resolvedWith === null">
                  <q-icon name="help_outline" size="17px" />
                  <span>请选择保留版本；选择后该字段方可参与锁定门禁。</span>
                </template>
                <template v-else-if="conflict.requiresSafety && !conflict.safetyConfirmed">
                  <q-icon name="verified_user" size="17px" color="orange" />
                  <span>已选择「{{ conflict.resolvedWith === 'local' ? '本地版' : '远端版' }}」，还差安全监督确认。</span>
                  <q-btn dense no-caps unelevated color="deep-orange" icon="verified" label="安全监督确认采用此版" :disable="store.currentRole !== 'safety' || store.locked" @click="store.confirmConflictSafety(conflict.id)" />
                  <small v-if="store.currentRole !== 'safety'" class="role-hint">当前身份不是安全监督，请切换至周工（安全监督）。</small>
                </template>
                <template v-else>
                  <q-icon name="check_circle" size="17px" color="green" />
                  <span class="resolved">已采用「{{ conflict.resolvedWith === 'local' ? '本地版' : '远端版' }}」并完成确认，将在下次同步推送。</span>
                </template>
              </div>
            </div>
          </div>

          <!-- 规则校核冲突 -->
          <div v-if="checksTab === 'rule'" class="check-layout">
            <div class="conflict-list">
              <button v-for="item in store.ruleConflicts" :key="item.id" class="conflict-item" @click="store.selectStep(item.stepId); checksTab = 'comments'">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div><strong>{{ item.stepId }} · {{ item.title }}</strong><small>{{ item.message }}</small></div>
                <q-icon name="arrow_forward" />
              </button>
              <div v-if="store.ruleConflicts.length === 0" class="empty-state">当前版本未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in stepComments" :key="comment.id" class="comment-row">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ roles[comment.role].team }}</small></strong>
                  <q-badge v-if="store.isStale(comment)" dense color="orange" class="stale-tag">过期·待重新确认</q-badge>
                  <p>{{ comment.content }}</p>
                  <div class="comment-actions">
                    <button v-if="comment.status === 'open' && !store.locked" @click="store.resolveComment(comment.id)">标记已解决</button>
                    <span v-else-if="comment.status === 'resolved'" class="resolved">已解决</span>
                    <button v-if="store.isStale(comment) && !store.locked" class="reconfirm" :disabled="comment.role !== store.currentRole" @click="store.reconfirmComment(comment.id)">按当前参数重新确认</button>
                    <small v-if="store.isStale(comment) && comment.role !== store.currentRole" class="role-hint">需 {{ roles[comment.role].name }} 重新确认</small>
                    <small v-if="comment.reconfirmedBy" class="resolved">已由 {{ comment.reconfirmedBy }} 重新确认</small>
                  </div>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow :label="`对 ${store.selectedStep.id} 提出条件或补充意见（以 ${store.currentUser.name} 身份）`" :disable="store.locked" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" :disable="store.locked" @click="submitComment" />
            </div>
          </div>

          <!-- 全部会签意见 -->
          <div v-if="checksTab === 'comments'" class="all-comments">
            <div v-for="comment in store.comments" :key="comment.id" class="comment-row all" @click="store.selectStep(comment.stepId)">
              <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
              <div>
                <strong>{{ comment.author }} <small>{{ roles[comment.role].team }} · {{ comment.stepId }}</small></strong>
                <q-badge v-if="store.isStale(comment)" dense color="orange" class="stale-tag">过期·待重新确认</q-badge>
                <q-badge v-else-if="comment.status === 'open'" dense color="red">未关闭</q-badge>
                <q-badge v-else dense color="green">已解决</q-badge>
                <p>{{ comment.content }}</p>
                <div class="comment-actions">
                  <button v-if="comment.status === 'open' && !store.locked" @click.stop="store.resolveComment(comment.id)">标记已解决</button>
                  <button v-if="store.isStale(comment) && !store.locked" class="reconfirm" :disabled="comment.role !== store.currentRole" @click.stop="store.reconfirmComment(comment.id)">按当前参数重新确认</button>
                  <small v-if="store.isStale(comment) && comment.role !== store.currentRole" class="role-hint">需 {{ roles[comment.role].name }} 重新确认</small>
                  <small v-if="comment.reconfirmedBy" class="resolved">已由 {{ comment.reconfirmedBy }} 重新确认</small>
                </div>
              </div>
            </div>
            <div v-if="!store.comments.length" class="empty-state">暂无会签意见。</div>
            <div class="all-comments-input">
              <q-input v-model="commentText" type="textarea" outlined autogrow :label="`对 ${store.selectedStep.id} 补充意见（以 ${store.currentUser.name} 身份）`" :disable="store.locked" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" :disable="store.locked" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
          </div>
          <div class="review-grid">
            <article v-for="role in roleList" :key="role" :class="['review-card', { mine: role === store.currentRole }]">
              <div class="review-head">
                <strong>{{ roles[role].name }} <small v-if="role === store.currentRole">（当前身份）</small></strong>
                <q-badge :color="roleStateColor(store.signoffState(role).state)">{{ roleStateLabel(store.signoffState(role).state) }}</q-badge>
              </div>
              <span>{{ roles[role].team }}</span>
              <p>{{ roles[role].scope }}</p>
              <small class="scope-steps">覆盖步骤：{{ roles[role].scopeSteps.join('、') }}</small>
              <small v-if="store.signoffState(role).signedAt" class="signed-at">签署时间：{{ store.signoffState(role).signedAt }}</small>
              <template v-if="role === store.currentRole && !store.locked">
                <q-btn no-caps unelevated color="positive" icon="check" label="接受方案并签署" @click="store.sign(true)" />
                <q-btn no-caps flat color="warning" icon="flag" label="签注有保留" @click="store.sign(false)" />
              </template>
              <q-btn v-else-if="store.locked" disable no-caps label="版本已锁定" />
              <p v-else class="role-hint">切换为该角色身份可执行签署</p>
            </article>
          </div>

          <div class="release-gate" :class="{ clear: !store.blockers.length }">
            <div class="gate-summary">
              <q-icon :name="store.blockers.length ? 'gpp_bad' : 'verified_user'" size="30px" />
              <div>
                <strong>{{ store.blockers.length ? `发布门禁被 ${store.blockers.length} 个具体项阻止` : '门禁检查通过，可以锁定发布' }}</strong>
                <span>未决合并冲突、规则冲突、未关闭/过期意见、作废或缺位的会签均逐项阻止发布。</span>
              </div>
            </div>
            <q-btn :color="store.blockers.length ? 'grey' : 'positive'" no-caps icon="lock" :label="store.lockRequested ? '同步完成后自动锁定…' : `锁定并发布 V${store.revision + 1}`" :loading="store.lockRequested && store.syncing" :disable="store.blockers.length > 0 || (store.lockRequested && store.syncing)" @click="store.lockPlan" />
          </div>

          <div v-if="store.blockers.length" class="blocker-panel">
            <div v-for="group in blockerGroups" :key="group.type" class="blocker-group">
              <h4>{{ group.title }} <q-badge dense color="negative">{{ group.items.length }}</q-badge></h4>
              <button v-for="blocker in group.items" :key="blocker.key" class="blocker-row" @click="blockerTarget(blocker)">
                <q-icon name="chevron_right" size="18px" />
                <span>{{ blocker.detail }}</span>
                <q-icon name="arrow_forward" size="16px" class="blocker-go" />
              </button>
            </div>
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
