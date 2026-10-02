<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore } from './store';
import SyncCenter from './SyncCenter.vue';

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
  { path: '/review', label: '多角色会签', icon: 'fact_check' },
  { path: '/sync', label: '同步中心', icon: 'sync' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');
const isOffline = computed(() => store.network === 'offline');
const expiredSignoffIds = computed(() => new Set(store.expiredSignoffs.map((item) => item.id)));
const stepPendingChanges = computed(() => store.pendingChanges.filter((item) => item.stepId === store.selectedStepId));
const stepConfirmations = computed(() => store.confirmations.filter((item) => item.stepId === store.selectedStepId && item.status === 'pending'));

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function signoffStateOf(id: string) {
  return store.signoffs.find((item) => item.id === id)?.state ?? 'pending';
}

function isExpired(id: string) {
  return expiredSignoffIds.value.has(id);
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

function blockerIcon(type: string) {
  const map: Record<string, string> = {
    conflict: 'sync_problem',
    confirmation: 'verified_user',
    signoff: 'draw',
    expired: 'history_toggle_off',
    sync: 'cloud_sync',
    comment: 'forum'
  };
  return map[type] ?? 'warning';
}

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
  nextTick(initializeScene);
  const updateNetwork = () => store.setNetwork(navigator.onLine ? 'online' : 'offline');
  updateNetwork();
  window.addEventListener('online', () => {
    updateNetwork();
    store.sync();
  });
  window.addEventListener('offline', updateNetwork);
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
        <q-btn
          v-if="store.pendingCount > 0"
          dense
          flat
          no-caps
          icon="sync"
          :label="`${store.pendingCount} 项待同步`"
          class="sync-chip"
          @click="go('/sync')"
        >
          <q-badge floating color="warning">{{ store.pendingCount }}</q-badge>
        </q-btn>
        <q-badge :color="isOffline ? 'negative' : 'teal'" outline class="status-badge">
          {{ isOffline ? '离线编辑中' : store.syncStatus === 'syncing' ? '同步中…' : '在线' }}
        </q-badge>
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.openComments.length }}</q-badge>
        </q-btn>
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
            <q-badge color="negative">{{ store.conflicts.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon :name="isOffline ? 'cloud_off' : 'cloud_done'" :color="isOffline ? 'negative' : 'teal'" />
        <span>
          {{ isOffline ? '离线草稿保存在本机' : '草稿已自动保存' }}<br />
          <small>{{ store.pendingCount > 0 ? `${store.pendingCount} 项改动待同步` : new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small>
        </span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '版本已锁定' : '确认并锁定'"
              :disable="store.locked || !store.canRelease"
              @click="store.lockPlan"
            >
              <q-tooltip v-if="!store.locked && !store.canRelease" anchor="bottom right" self="top right">
                {{ store.releaseBlockers.length }} 项未消除，无法锁定发布
              </q-tooltip>
            </q-btn>
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
                v-for="(step, index) in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id }]"
                @click="store.selectStep(step.id)"
              >
                <span>{{ step.time }}</span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空</small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: store.selectedStep.loadRate > 90 }">{{ store.selectedStep.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: store.selectedStep.clearance < 1.5 }">{{ store.selectedStep.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ store.selectedStep.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ store.selectedStep.wind }}m/s</strong></div>
            </div>
            <div
              v-if="stepPendingChanges.length > 0 || stepConfirmations.length > 0"
              class="pending-hint"
            >
              <q-icon name="sync" color="warning" size="14px" />
              <span>
                <template v-if="stepPendingChanges.length > 0">{{ stepPendingChanges.map(c => c.label).join('、') }} 改动待同步；</template>
                <template v-if="stepConfirmations.length > 0">{{ stepConfirmations.map(c => c.label).join('、') }} 保留两版，待安全监督确认。</template>
              </span>
            </div>
            <label class="field-label">荷载率 <em class="controlled-tag">受控</em></label>
            <q-slider v-model="store.selectedStep.loadRate" :min="0" :max="120" color="primary" @change="store.updateStep({})" />
            <div class="form-row">
              <q-input v-model.number="store.selectedStep.clearance" type="number" label="最小净空 / m <受控>" outlined dense @change="store.updateStep({})" />
              <q-input v-model.number="store.selectedStep.wind" type="number" label="风速 / m/s <受控>" outlined dense @change="store.updateStep({})" />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              v-model="store.selectedStep.status"
              spread
              no-caps
              toggle-color="primary"
              @update:model-value="store.updateStep({})"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
            />
            <q-input v-model="store.selectedStep.note" type="textarea" autogrow outlined label="现场控制说明" class="note-input" @change="store.updateStep({})" />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="保存步骤修改" @click="store.updateStep({})" />
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <q-badge color="negative">{{ store.conflicts.length }} 项待处理</q-badge>
          </div>
          <div v-if="store.openSyncConflicts.length > 0" class="sync-alert" @click="go('/sync')">
            <q-icon name="sync_problem" color="negative" />
            <div>
              <strong>{{ store.openSyncConflicts.length }} 项同步冲突待合并</strong>
              <small>同一字段本地与服务端都有改动，需选择采用版本；受控参数由安全监督确认。</small>
            </div>
            <q-btn dense flat no-caps color="primary" label="前往合并" />
          </div>
          <div class="check-layout">
            <div class="conflict-list">
              <button v-for="item in store.conflicts" :key="item.id" class="conflict-item" @click="store.selectStep(item.stepId)">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div><strong>{{ item.stepId }} · {{ item.title }}</strong><small>{{ item.message }}</small></div>
                <q-icon name="arrow_forward" />
              </button>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前版本未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in store.comments.filter(c => c.stepId === store.selectedStepId)" :key="comment.id" class="comment-row">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small></strong>
                  <p>{{ comment.content }}</p>
                  <button v-if="comment.status === 'open'" @click="store.resolveComment(comment.id)">标记已解决</button>
                  <span v-else class="resolved">已解决</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" @click="submitComment" />
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
            <article v-for="person in store.signoffs" :key="person.id" class="review-card" :class="{ expired: isExpired(person.id) }">
              <div class="review-head">
                <strong>{{ person.name }}</strong>
                <q-badge v-if="isExpired(person.id)" color="negative">已过期</q-badge>
                <q-badge v-else-if="person.state === 'accepted'" color="positive">已接受</q-badge>
                <q-badge v-else-if="person.state === 'reserved'" color="warning">有保留</q-badge>
                <q-badge v-else color="grey">待确认</q-badge>
              </div>
              <span>{{ person.team }}</span>
              <p>{{ person.scope }}</p>
              <div v-if="isExpired(person.id)" class="expired-note">步骤参数已变更，原会签意见作废，需重新确认。</div>
              <div class="review-actions">
                <q-btn
                  v-if="person.state === 'accepted' && !isExpired(person.id)"
                  disable
                  no-caps
                  label="已签署"
                />
                <q-btn
                  v-else
                  color="primary"
                  no-caps
                  :label="isExpired(person.id) ? '重新签署' : '接受方案'"
                  @click="store.sign(person.id)"
                />
                <q-btn
                  v-if="person.state !== 'reserved'"
                  outline
                  no-caps
                  label="保留意见"
                  @click="store.reserve(person.id)"
                />
              </div>
              <small v-if="person.signedAt" class="signed-at">签署于 {{ person.signedAt }}</small>
            </article>
          </div>
          <div class="release-gate">
            <div class="gate-head">
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span>冲突、受控参数、会签、意见逐项通过后方可锁定发布。</span>
              </div>
            </div>
            <div v-if="store.releaseBlockers.length > 0" class="gate-blockers">
              <div v-for="(blocker, index) in store.releaseBlockers" :key="index" class="blocker-item" :class="blocker.type">
                <q-icon :name="blockerIcon(blocker.type)" size="14px" />
                <div>
                  <strong>{{ blocker.label }}</strong>
                  <small>{{ blocker.detail }}</small>
                </div>
              </div>
            </div>
            <div v-else class="gate-clear">
              <q-icon name="check_circle" color="positive" size="18px" />
              <span>所有发布条件已满足，可以锁定发布。</span>
            </div>
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '版本已锁定' : `锁定并发布 V${store.revision + 1}`"
              :disable="store.locked || !store.canRelease"
              @click="store.lockPlan"
            />
          </div>
        </section>

        <section v-if="route.path === '/sync'" class="content-panel full-panel">
          <SyncCenter />
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
