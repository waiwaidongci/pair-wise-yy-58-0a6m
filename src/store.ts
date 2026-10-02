import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';

export type StepStatus = 'pending' | 'passed' | 'blocked';
export type Comment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
  pending?: boolean;
};

export type FieldValue = string | number;

export type PendingChange = {
  id: string;
  stepId: string;
  field: string;
  label: string;
  unit: string;
  localValue: FieldValue;
  baseValue: FieldValue;
  changedAt: string;
  status: 'pending' | 'failed';
  error?: string;
};

export type SyncConflict = {
  id: string;
  stepId: string;
  field: string;
  label: string;
  unit: string;
  localValue: FieldValue;
  serverValue: FieldValue;
  baseValue: FieldValue;
  controlled: boolean;
  status: 'open' | 'resolved';
  resolution?: 'local' | 'server';
  resolvedValue?: FieldValue;
  resolvedBy?: string;
};

export type PendingConfirmation = {
  id: string;
  stepId: string;
  field: string;
  label: string;
  unit: string;
  oldValue: FieldValue;
  newValue: FieldValue;
  changedAt: string;
  status: 'pending' | 'confirmed';
  confirmedBy?: string;
};

export type SignoffState = 'accepted' | 'pending' | 'reserved';
export type Signoff = {
  id: string;
  name: string;
  team: string;
  scope: string;
  covers: string[];
  state: SignoffState;
  signedAt: string | null;
  signatures: Record<string, string>;
};

export type LiftStep = {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: StepStatus;
  note: string;
};

const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

const initialSignoffs: Signoff[] = [
  { id: 's1', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', covers: ['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06'], state: 'accepted', signedAt: '2026-09-18 09:12', signatures: {} },
  { id: 's2', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', covers: ['S-01', 'S-05'], state: 'pending', signedAt: null, signatures: {} },
  { id: 's3', name: '周工', team: '安全监督', scope: '净空、风速与警戒区', covers: ['S-02', 'S-04', 'S-05', 'S-06'], state: 'reserved', signedAt: null, signatures: {} },
  { id: 's4', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', covers: ['S-03', 'S-04', 'S-05'], state: 'pending', signedAt: null, signatures: {} }
];

// 受控参数：离线改动后保留两版，需安全监督确认才能用于发布门禁
const CONTROLLED_FIELDS = ['loadRate', 'clearance', 'wind'] as const;
const PARAM_FIELDS = ['loadRate', 'clearance', 'wind', 'radius', 'boom'] as const;
const TRACKED_FIELDS = ['loadRate', 'clearance', 'wind', 'radius', 'boom', 'status', 'note'] as const;

const FIELD_META: Record<string, { label: string; unit: string }> = {
  loadRate: { label: '荷载率', unit: '%' },
  clearance: { label: '净空', unit: 'm' },
  wind: { label: '风速', unit: 'm/s' },
  radius: { label: '作业半径', unit: 'm' },
  boom: { label: '臂长', unit: 'm' },
  status: { label: '步骤状态', unit: '' },
  note: { label: '步骤说明', unit: '' }
};

const draftKey = 'yy58-lift-plan-draft';
const serverKey = 'yy58-lift-plan-server';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function stepSignature(step: LiftStep): string {
  return PARAM_FIELDS.map((field) => `${field}:${step[field]}`).join('|');
}

function signaturesFor(steps: LiftStep[], covers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const step of steps) {
    if (covers.includes(step.id)) result[step.id] = stepSignature(step);
  }
  return result;
}

function loadServerSteps(): LiftStep[] {
  if (typeof localStorage === 'undefined') return clone(initialSteps);
  const raw = localStorage.getItem(serverKey);
  if (raw) return JSON.parse(raw) as LiftStep[];
  const copy = clone(initialSteps);
  localStorage.setItem(serverKey, JSON.stringify(copy));
  return copy;
}

function saveServerSteps(steps: LiftStep[]) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(serverKey, JSON.stringify(steps));
}

function getField(steps: LiftStep[], stepId: string, field: string): FieldValue {
  const step = steps.find((item) => item.id === stepId);
  return step ? (step as unknown as Record<string, FieldValue>)[field] : '';
}

function setField(steps: LiftStep[], stepId: string, field: string, value: FieldValue) {
  const step = steps.find((item) => item.id === stepId);
  if (step) (step as unknown as Record<string, FieldValue>)[field] = value;
}

function loadDraft() {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(draftKey);
  return raw ? JSON.parse(raw) : null;
}

const saved = loadDraft();

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: (saved?.steps as LiftStep[]) ?? clone(initialSteps),
    comments: (saved?.comments as Comment[]) ?? clone(initialComments),
    selectedStepId: (saved?.selectedStepId as string) ?? 'S-02',
    revision: (saved?.revision as number) ?? 4,
    locked: (saved?.locked as boolean) ?? false,
    viewBookmarks: (saved?.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (saved?.activeBookmark as string) ?? '主吊全景',
    pendingChanges: (saved?.pendingChanges as PendingChange[]) ?? [],
    conflicts: (saved?.conflicts as SyncConflict[]) ?? [],
    confirmations: (saved?.confirmations as PendingConfirmation[]) ?? [],
    signoffs: (saved?.signoffs as Signoff[]) ?? clone(initialSignoffs),
    baseSteps: (saved?.baseSteps as LiftStep[]) ?? clone(initialSteps),
    network: (typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline') as 'online' | 'offline',
    syncStatus: 'idle' as 'idle' | 'syncing' | 'success' | 'failed',
    lastSyncAt: (saved?.lastSyncAt as string) ?? null
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    fieldMeta: () => FIELD_META,
    isControlled: () => (field: string) => CONTROLLED_FIELDS.includes(field as (typeof CONTROLLED_FIELDS)[number]),
    conflicts(state) {
      return state.steps.flatMap((step) => {
        const issues: string[] = [];
        if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
        if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
        if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
        if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
        return issues.map((message, index) => ({ id: `${step.id}-${index}`, stepId: step.id, title: step.title, message, severity: step.status === 'blocked' ? 'high' : 'medium' }));
      });
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    openSyncConflicts(state): SyncConflict[] {
      return state.conflicts.filter((conflict) => conflict.status === 'open');
    },
    pendingConfirmations(state): PendingConfirmation[] {
      return state.confirmations.filter((item) => item.status === 'pending');
    },
    pendingCount(state): number {
      return state.pendingChanges.length + state.comments.filter((comment) => comment.pending).length;
    },
    expiredSignoffs(state): Signoff[] {
      return state.signoffs.filter((signoff) => {
        if (signoff.state === 'pending') return false;
        return signoff.covers.some((stepId) => {
          const step = state.steps.find((item) => item.id === stepId);
          if (!step) return false;
          const recorded = signoff.signatures[stepId];
          return recorded !== undefined && recorded !== stepSignature(step);
        });
      });
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      return Math.max(0, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty));
    },
    releaseBlockers(state): { type: string; label: string; detail: string; ref?: string }[] {
      const blockers: { type: string; label: string; detail: string; ref?: string }[] = [];
      for (const conflict of state.conflicts.filter((item) => item.status === 'open')) {
        blockers.push({
          type: 'conflict',
          label: `${conflict.stepId} ${conflict.label} 冲突未决`,
          detail: `本地 ${conflict.localValue}${conflict.unit} / 服务端 ${conflict.serverValue}${conflict.unit}`,
          ref: conflict.id
        });
      }
      for (const confirmation of state.confirmations.filter((item) => item.status === 'pending')) {
        blockers.push({
          type: 'confirmation',
          label: `${confirmation.stepId} ${confirmation.label} 待安全监督确认`,
          detail: `${confirmation.oldValue}${confirmation.unit} → ${confirmation.newValue}${confirmation.unit}`,
          ref: confirmation.id
        });
      }
      for (const signoff of state.signoffs) {
        const expired = signoff.covers.some((stepId) => {
          const step = state.steps.find((item) => item.id === stepId);
          if (!step) return false;
          const recorded = signoff.signatures[stepId];
          return recorded !== undefined && recorded !== stepSignature(step);
        });
        if (expired) {
          blockers.push({ type: 'expired', label: `${signoff.name} 会签已过期`, detail: '步骤参数变更，需重新确认', ref: signoff.id });
        } else if (signoff.state === 'pending') {
          blockers.push({ type: 'signoff', label: `${signoff.name} 尚未签署`, detail: signoff.scope, ref: signoff.id });
        } else if (signoff.state === 'reserved') {
          blockers.push({ type: 'signoff', label: `${signoff.name} 保留意见`, detail: signoff.scope, ref: signoff.id });
        }
      }
      const pendingChanges = state.pendingChanges.length;
      if (pendingChanges > 0) {
        blockers.push({ type: 'sync', label: `${pendingChanges} 项改动待同步`, detail: '联网后合并到服务端' });
      }
      const pendingComments = state.comments.filter((comment) => comment.pending).length;
      if (pendingComments > 0) {
        blockers.push({ type: 'sync', label: `${pendingComments} 条意见待同步`, detail: '联网后上传会签意见' });
      }
      for (const comment of state.comments.filter((item) => item.status === 'open')) {
        blockers.push({ type: 'comment', label: `${comment.stepId} 未关闭意见`, detail: comment.content, ref: comment.id });
      }
      return blockers;
    },
    canRelease(): boolean {
      return this.releaseBlockers.length === 0;
    }
  },
  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    updateStep(patch: Partial<LiftStep> = {}) {
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index < 0) return;
      const step = this.steps[index];
      Object.assign(step, patch);
      const base = this.baseSteps.find((item) => item.id === step.id);
      if (base) {
        for (const field of TRACKED_FIELDS) {
          const current = (step as unknown as Record<string, FieldValue>)[field];
          const baseValue = (base as unknown as Record<string, FieldValue>)[field];
          if (current !== baseValue) {
            this.upsertPendingChange(step.id, field, current, baseValue);
            if (CONTROLLED_FIELDS.includes(field as (typeof CONTROLLED_FIELDS)[number])) {
              this.upsertConfirmation(step.id, field, baseValue, current);
            }
          } else {
            this.removePendingChange(step.id, field);
            this.removeConfirmation(step.id, field);
          }
        }
      }
      this.persist();
    },
    upsertPendingChange(stepId: string, field: string, localValue: FieldValue, baseValue: FieldValue) {
      const meta = FIELD_META[field] ?? { label: field, unit: '' };
      const existing = this.pendingChanges.find((item) => item.stepId === stepId && item.field === field);
      if (existing) {
        existing.localValue = localValue;
        existing.baseValue = baseValue;
        existing.changedAt = new Date().toISOString();
        existing.status = 'pending';
        existing.error = undefined;
      } else {
        this.pendingChanges.push({
          id: `P-${stepId}-${field}-${Date.now()}`,
          stepId,
          field,
          label: meta.label,
          unit: meta.unit,
          localValue,
          baseValue,
          changedAt: new Date().toISOString(),
          status: 'pending'
        });
      }
    },
    removePendingChange(stepId: string, field: string) {
      this.pendingChanges = this.pendingChanges.filter((item) => !(item.stepId === stepId && item.field === field));
    },
    upsertConfirmation(stepId: string, field: string, oldValue: FieldValue, newValue: FieldValue) {
      const meta = FIELD_META[field] ?? { label: field, unit: '' };
      const existing = this.confirmations.find((item) => item.stepId === stepId && item.field === field);
      if (existing) {
        existing.oldValue = oldValue;
        existing.newValue = newValue;
        existing.changedAt = new Date().toISOString();
        if (existing.status === 'confirmed') {
          existing.status = 'pending';
          existing.confirmedBy = undefined;
        }
      } else {
        this.confirmations.push({
          id: `CF-${stepId}-${field}-${Date.now()}`,
          stepId,
          field,
          label: meta.label,
          unit: meta.unit,
          oldValue,
          newValue,
          changedAt: new Date().toISOString(),
          status: 'pending'
        });
      }
    },
    removeConfirmation(stepId: string, field: string) {
      this.confirmations = this.confirmations.filter((item) => !(item.stepId === stepId && item.field === field));
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    addComment(content: string, author = '王工', role = '方案') {
      if (!content.trim()) return;
      this.comments.unshift({
        id: `C-${Date.now()}`,
        author,
        role,
        content,
        status: 'open',
        stepId: this.selectedStepId,
        pending: this.network === 'offline'
      });
      this.persist();
    },
    resolveComment(id: string) {
      const item = this.comments.find((comment) => comment.id === id);
      if (item) item.status = 'resolved';
      this.persist();
    },
    setNetwork(status: 'online' | 'offline') {
      this.network = status;
      this.persist();
    },
    async sync() {
      if (this.network === 'offline') {
        this.syncStatus = 'failed';
        this.persist();
        return;
      }
      this.syncStatus = 'syncing';
      for (const change of this.pendingChanges) change.status = 'pending';
      this.persist();
      try {
        await new Promise((resolve) => setTimeout(resolve, 650));
        const serverSteps = loadServerSteps();
        const processed: string[] = [];
        for (const change of this.pendingChanges) {
          const serverValue = getField(serverSteps, change.stepId, change.field);
          if (serverValue !== change.baseValue) {
            const controlled = CONTROLLED_FIELDS.includes(change.field as (typeof CONTROLLED_FIELDS)[number]);
            this.conflicts.push({
              id: `X-${change.stepId}-${change.field}-${Date.now()}`,
              stepId: change.stepId,
              field: change.field,
              label: change.label,
              unit: change.unit,
              localValue: change.localValue,
              serverValue,
              baseValue: change.baseValue,
              controlled,
              status: 'open'
            });
            if (controlled) this.removeConfirmation(change.stepId, change.field);
          } else {
            setField(serverSteps, change.stepId, change.field, change.localValue);
          }
          processed.push(change.id);
        }
        this.pendingChanges = this.pendingChanges.filter((item) => !processed.includes(item.id));
        for (const comment of this.comments.filter((item) => item.pending)) {
          comment.pending = false;
        }
        for (const step of this.steps) {
          for (const field of TRACKED_FIELDS) {
            const conflictOpen = this.conflicts.some((item) => item.status === 'open' && item.stepId === step.id && item.field === field);
            if (!conflictOpen) {
              const serverValue = getField(serverSteps, step.id, field);
              (step as unknown as Record<string, FieldValue>)[field] = serverValue;
            }
          }
        }
        this.baseSteps = clone(serverSteps);
        saveServerSteps(serverSteps);
        this.syncStatus = 'success';
        this.lastSyncAt = new Date().toISOString();
        this.persist();
      } catch {
        this.syncStatus = 'failed';
        for (const change of this.pendingChanges) change.status = 'failed';
        this.persist();
      }
    },
    retrySync() {
      this.sync();
    },
    resolveConflict(id: string, resolution: 'local' | 'server', operator = '王工') {
      const conflict = this.conflicts.find((item) => item.id === id);
      if (!conflict || conflict.status === 'resolved') return;
      const resolvedValue = resolution === 'local' ? conflict.localValue : conflict.serverValue;
      conflict.resolution = resolution;
      conflict.resolvedValue = resolvedValue;
      conflict.resolvedBy = conflict.controlled ? '周工（安全监督）' : operator;
      conflict.status = 'resolved';
      const serverSteps = loadServerSteps();
      setField(serverSteps, conflict.stepId, conflict.field, resolvedValue);
      saveServerSteps(serverSteps);
      const step = this.steps.find((item) => item.id === conflict.stepId);
      if (step) (step as unknown as Record<string, FieldValue>)[conflict.field] = resolvedValue;
      this.baseSteps = clone(serverSteps);
      this.persist();
    },
    confirmControlled(id: string) {
      const confirmation = this.confirmations.find((item) => item.id === id);
      if (!confirmation || confirmation.status === 'confirmed') return;
      confirmation.status = 'confirmed';
      confirmation.confirmedBy = '周工（安全监督）';
      this.persist();
    },
    sign(id: string) {
      const signoff = this.signoffs.find((item) => item.id === id);
      if (!signoff) return;
      signoff.state = 'accepted';
      signoff.signedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      signoff.signatures = signaturesFor(this.steps, signoff.covers);
      this.persist();
    },
    reserve(id: string) {
      const signoff = this.signoffs.find((item) => item.id === id);
      if (!signoff) return;
      signoff.state = 'reserved';
      signoff.signedAt = null;
      signoff.signatures = signaturesFor(this.steps, signoff.covers);
      this.persist();
    },
    simulateServerChange() {
      const serverSteps = loadServerSteps();
      const step = serverSteps.find((item) => item.id === 'S-02');
      if (step) {
        step.clearance = Math.max(0.4, +(step.clearance - 0.2).toFixed(2));
        saveServerSteps(serverSteps);
      }
      this.persist();
    },
    lockPlan() {
      if (!this.canRelease) return;
      this.locked = true;
      this.revision += 1;
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: 'LP-2026-0918' },
        data: { liftPlan: { __typename: 'LiftPlan', id: 'LP-2026-0918', name: '东塔转换桁架吊装', revision: this.revision, status: 'LOCKED', steps: this.steps } }
      });
      this.persist();
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    persist() {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(
        draftKey,
        JSON.stringify({
          steps: this.steps,
          comments: this.comments,
          selectedStepId: this.selectedStepId,
          revision: this.revision,
          locked: this.locked,
          viewBookmarks: this.viewBookmarks,
          activeBookmark: this.activeBookmark,
          pendingChanges: this.pendingChanges,
          conflicts: this.conflicts,
          confirmations: this.confirmations,
          signoffs: this.signoffs,
          baseSteps: this.baseSteps,
          lastSyncAt: this.lastSyncAt,
          draftSavedAt: new Date().toISOString()
        })
      );
    }
  }
});
