import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';
import {
  PLAN_ID,
  fieldMeta,
  initialComments,
  initialSignoffs,
  initialSteps,
  isPreservedField,
  paramFields,
  roles
} from './seed';
import { pullRemote, pushRemote, setFailureBudget as serverFailBudget, simulateRemoteEdits } from './mockServer';
import { deepClone } from './util';
import type {
  Blocker,
  Comment,
  LiftStep,
  MergeConflict,
  PendingOp,
  RemoteState,
  RoleId,
  Signoff,
  StepField,
  SyncSnapshot
} from './types';

const cacheKey = 'yy58-lift-plan-draft-v2';
const allFields = Object.keys(fieldMeta) as StepField[];

function nowLabel() {
  return new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function initialSnapshot(): SyncSnapshot {
  return {
    steps: deepClone(initialSteps),
    comments: deepClone(initialComments),
    signoffs: deepClone(initialSignoffs),
    paramVersions: Object.fromEntries(initialSteps.map((step) => [step.id, 1])),
    revision: 4,
    locked: false
  };
}

function loadPersisted() {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(cacheKey);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 2) return null;
    return data;
  } catch {
    return null;
  }
}

const persisted = loadPersisted();

export function formatFieldValue(field: StepField, value: string | number) {
  const meta = fieldMeta[field];
  return typeof value === 'number' ? `${value}${meta.unit}` : value;
}

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: (persisted?.steps as LiftStep[]) ?? deepClone(initialSteps),
    comments: (persisted?.comments as Comment[]) ?? deepClone(initialComments),
    signoffs: (persisted?.signoffs as Signoff[]) ?? deepClone(initialSignoffs),
    paramVersions: (persisted?.paramVersions as Record<string, number>) ??
      Object.fromEntries(initialSteps.map((step) => [step.id, 1])),
    selectedStepId: (persisted?.selectedStepId as string) ?? 'S-02',
    revision: (persisted?.revision as number) ?? 4,
    locked: (persisted?.locked as boolean) ?? false,
    viewBookmarks: (persisted?.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (persisted?.activeBookmark as string) ?? '主吊全景',
    online: (persisted?.online as boolean) ?? true,
    syncing: false,
    lockRequested: false,
    lastSyncAt: (persisted?.lastSyncAt as string | null) ?? null,
    lastSyncError: null as string | null,
    pending: (persisted?.pending as PendingOp[]) ?? [],
    conflicts: (persisted?.conflicts as MergeConflict[]) ?? [],
    base: (persisted?.base as SyncSnapshot) ?? initialSnapshot(),
    currentRole: (persisted?.currentRole as RoleId) ?? 'engineering',
    failBudget: 0
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    currentUser(state) {
      return roles[state.currentRole];
    },
    /** 规则引擎冲突（阈值校核） */
    ruleConflicts(state) {
      return state.steps.flatMap((step) => {
        const issues: string[] = [];
        if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
        if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
        if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
        if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
        return issues.map((message, index) => ({
          id: `${step.id}-${index}`,
          stepId: step.id,
          title: step.title,
          message,
          severity: step.status === 'blocked' ? 'high' : 'medium'
        }));
      });
    },
    openComments(state): Comment[] {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    staleComments(state): Comment[] {
      return state.comments.filter((comment) => comment.paramVersion !== (state.paramVersions[comment.stepId] ?? 1));
    },
    unresolvedConflicts(state): MergeConflict[] {
      return state.conflicts.filter(
        (item) => item.resolvedWith === null || (item.requiresSafety && !item.safetyConfirmed)
      );
    },
    /** 发布门禁：按具体项列出所有阻断原因 */
    blockers(state): Blocker[] {
      if (state.locked) return [];
      const list: Blocker[] = [];
      for (const conflict of state.conflicts) {
        const step = state.steps.find((item) => item.id === conflict.stepId);
        const where = `${conflict.stepId} · ${step?.title ?? ''}`;
        if (conflict.resolvedWith === null) {
          list.push({ key: `merge-${conflict.id}`, type: 'merge', stepId: conflict.stepId, detail: `${where}：${conflict.label}存在本地/远端两版，尚未选择版本` });
        } else if (conflict.requiresSafety && !conflict.safetyConfirmed) {
          list.push({ key: `merge-${conflict.id}`, type: 'merge', stepId: conflict.stepId, detail: `${where}：${conflict.label}两版待安全监督确认` });
        }
      }
      for (const item of this.ruleConflicts) {
        list.push({ key: `rule-${item.id}`, type: 'rule', stepId: item.stepId, detail: `${item.stepId} · ${item.title}：${item.message}` });
      }
      for (const comment of state.comments) {
        const stale = comment.paramVersion !== (state.paramVersions[comment.stepId] ?? 1);
        if (comment.status === 'open') {
          list.push({ key: `open-${comment.id}`, type: 'openComment', stepId: comment.stepId, detail: `未关闭会签意见：${comment.author}（${roles[comment.role].team}）对 ${comment.stepId} 的意见` });
        }
        if (stale) {
          list.push({ key: `stale-${comment.id}`, type: 'staleComment', stepId: comment.stepId, detail: `过期意见：${comment.author} 对 ${comment.stepId} 的意见基于旧版步骤参数，需重新确认` });
        }
      }
      for (const role of Object.keys(roles) as RoleId[]) {
        const meta = roles[role];
        const signoff = state.signoffs.find((item) => item.role === role);
        for (const stepId of meta.scopeSteps) {
          const current = state.paramVersions[stepId] ?? 1;
          if (!signoff) {
            list.push({ key: `sign-${role}-${stepId}`, type: 'signoff', role, stepId, detail: `${meta.name}（${meta.team}）尚未会签：${stepId}` });
          } else if (!signoff.accepted) {
            list.push({ key: `sign-${role}-${stepId}`, type: 'signoff', role, stepId, detail: `${meta.name}（${meta.team}）的会签为“有保留”：${stepId}` });
          } else if ((signoff.stepVersions[stepId] ?? 0) !== current) {
            list.push({ key: `sign-${role}-${stepId}`, type: 'signoff', role, stepId, detail: `${meta.name}（${meta.team}）对 ${stepId} 的签署已被参数改动作废，需重新签署` });
          }
        }
      }
      return list;
    },
    readiness(state): number {
      const validRoles = (Object.keys(roles) as RoleId[]).filter((role) => {
        const meta = roles[role];
        const signoff = state.signoffs.find((item) => item.role === role);
        return !!signoff && signoff.accepted && meta.scopeSteps.every((id) => signoff.stepVersions[id] === (state.paramVersions[id] ?? 1));
      }).length;
      const passed = state.steps.filter((step) => step.status === 'passed').length;
      const penalty = this.openComments.length * 5 + this.staleComments.length * 6 + this.unresolvedConflicts.length * 8;
      return Math.max(0, Math.min(100, Math.round((validRoles / 4) * 60 + (passed / state.steps.length) * 40 - penalty)));
    }
  },
  actions: {
    persist() {
      if (typeof localStorage === 'undefined') return;
      const { syncing, failBudget, ...rest } = this.$state;
      void syncing;
      void failBudget;
      localStorage.setItem(cacheKey, JSON.stringify({ version: 2, ...rest, savedAt: new Date().toISOString() }));
    },
    initNetwork() {
      window.addEventListener('online', () => {
        this.online = true;
        void this.sync();
      });
      window.addEventListener('offline', () => {
        this.online = false;
      });
    },
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    switchRole(role: RoleId) {
      this.currentRole = role;
      this.persist();
    },
    toggleOnline() {
      this.online = !this.online;
      this.lastSyncError = null;
      this.persist();
      if (this.online) void this.sync();
    },
    /** 合并同类未同步项：同一目标只保留一条 */
    enqueue(op: PendingOp) {
      const duplicate = this.pending.find((item) => {
        if (item.type === 'step' || item.type === 'sign') return item.type === op.type && item.target === op.target;
        return item.type === op.type && item.target === op.target;
      });
      if (duplicate) {
        duplicate.createdAt = op.createdAt;
        if (op.payload !== undefined) duplicate.payload = op.payload;
      } else {
        this.pending.push(op);
      }
    },
    /** 保存步骤修改；五个步骤参数任一变化都会抬升参数版本，使旧意见/旧签署作废 */
    commitStep(patch: Partial<LiftStep>) {
      if (this.locked) return;
      const step = this.steps.find((item) => item.id === this.selectedStepId);
      if (!step) return;
      const next = { ...step, ...patch };
      const paramChanged = paramFields.some((field) => patch[field as keyof LiftStep] !== undefined && step[field] !== next[field]);
      Object.assign(step, next);
      if (paramChanged) this.paramVersions[step.id] = (this.paramVersions[step.id] ?? 1) + 1;
      this.enqueue({
        id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'step',
        target: step.id,
        label: `步骤参数修改 · ${step.id} ${step.title}`,
        createdAt: nowLabel()
      });
      this.persist();
    },
    addComment(content: string) {
      if (this.locked || !content.trim()) return;
      const meta = roles[this.currentRole];
      const comment: Comment = {
        id: `C-${Date.now()}`,
        author: meta.name,
        role: this.currentRole,
        content: content.trim(),
        status: 'open',
        stepId: this.selectedStepId,
        paramVersion: this.paramVersions[this.selectedStepId] ?? 1
      };
      this.comments.unshift(comment);
      this.enqueue({
        id: `op-${Date.now()}-c`,
        type: 'commentAdd',
        target: comment.id,
        label: `新增会签意见 · ${comment.stepId}`,
        createdAt: nowLabel()
      });
      this.persist();
    },
    resolveComment(id: string) {
      if (this.locked) return;
      const item = this.comments.find((comment) => comment.id === id);
      if (!item || item.status === 'resolved') return;
      item.status = 'resolved';
      this.enqueue({
        id: `op-${Date.now()}-r`,
        type: 'commentResolve',
        target: id,
        label: `关闭意见 · ${id}`,
        createdAt: nowLabel()
      });
      this.persist();
    },
    /** 过期意见由原意见提出角色按当前参数版本重新确认 */
    reconfirmComment(id: string) {
      if (this.locked) return;
      const item = this.comments.find((comment) => comment.id === id);
      if (!item) return;
      if (item.role !== this.currentRole) return;
      item.paramVersion = this.paramVersions[item.stepId] ?? 1;
      item.reconfirmedBy = roles[this.currentRole].name;
      this.enqueue({
        id: `op-${Date.now()}-f`,
        type: 'commentReconfirm',
        target: id,
        label: `重新确认意见 · ${id}`,
        createdAt: nowLabel()
      });
      this.persist();
    },
    sign(accepted: boolean) {
      if (this.locked) return;
      const role = this.currentRole;
      const meta = roles[role];
      const stepVersions: Record<string, number> = {};
      for (const id of meta.scopeSteps) stepVersions[id] = this.paramVersions[id] ?? 1;
      const existing = this.signoffs.find((item) => item.role === role);
      if (existing) {
        existing.accepted = accepted;
        existing.signedAt = nowLabel();
        existing.stepVersions = stepVersions;
      } else {
        this.signoffs.push({ role, accepted, signedAt: nowLabel(), stepVersions });
      }
      this.enqueue({
        id: `op-${Date.now()}-s`,
        type: 'sign',
        target: role,
        label: `会签签署 · ${meta.name}（${accepted ? '接受' : '有保留'}）`,
        createdAt: nowLabel()
      });
      this.persist();
    },
    signoffState(role: RoleId): { state: 'accepted' | 'reserved' | 'unsigned' | 'invalid'; signedAt?: string } {
      const signoff = this.signoffs.find((item) => item.role === role);
      if (!signoff) return { state: 'unsigned' };
      const meta = roles[role];
      const stale = meta.scopeSteps.some((id) => (signoff.stepVersions[id] ?? 0) !== (this.paramVersions[id] ?? 1));
      if (stale) return { state: 'invalid', signedAt: signoff.signedAt };
      if (!signoff.accepted) return { state: 'reserved', signedAt: signoff.signedAt };
      return { state: 'accepted', signedAt: signoff.signedAt };
    },
    /** 为冲突选择保留版本；荷载率/净空/风速仍需安全监督额外确认 */
    resolveConflict(id: string, choice: 'local' | 'remote') {
      if (this.locked) return;
      const conflict = this.conflicts.find((item) => item.id === id);
      if (!conflict || conflict.resolvedWith !== null) return;
      conflict.resolvedWith = choice;
      const chosen = choice === 'local' ? conflict.localValue : conflict.remoteValue;
      const step = this.steps.find((item) => item.id === conflict.stepId);
      if (step) (step as Record<string, unknown>)[conflict.field] = chosen;
      if (!conflict.requiresSafety) conflict.safetyConfirmed = true;
      this.persist();
      this.autoSyncWhenSettled();
    },
    confirmConflictSafety(id: string) {
      if (this.locked) return;
      const conflict = this.conflicts.find((item) => item.id === id);
      if (!conflict || !conflict.requiresSafety || this.currentRole !== 'safety') return;
      conflict.safetyConfirmed = true;
      this.persist();
      this.autoSyncWhenSettled();
    },
    /** 所有冲突都完成仲裁（含安全确认）后自动推送一次 */
    autoSyncWhenSettled() {
      if (this.online && !this.syncing && this.unresolvedConflicts.length === 0) {
        globalThis.setTimeout(() => void this.sync(), 300);
      }
    },
    isStale(comment: Comment): boolean {
      return comment.paramVersion !== (this.paramVersions[comment.stepId] ?? 1);
    },
    /** 三向合并：基线 / 本地 / 远端；同字段两边都改 → 冲突 */
    async sync() {
      if (this.syncing) return;
      if (!this.online) {
        this.lastSyncError = '当前处于断网状态，改动已保存在本地，恢复网络后自动同步。';
        this.persist();
        return;
      }
      this.syncing = true;
      this.lastSyncError = null;
      try {
        const remote = await pullRemote();

        // 远端已锁定发布：以远端为准，本地进入只读
        if (remote.locked) {
          this.steps = remote.steps;
          this.comments = remote.comments;
          this.signoffs = remote.signoffs;
          this.paramVersions = remote.paramVersions;
          this.revision = remote.revision;
          this.locked = true;
          this.conflicts = [];
          this.pending = [];
          this.base = {
            steps: deepClone(remote.steps),
            comments: deepClone(remote.comments),
            signoffs: deepClone(remote.signoffs),
            paramVersions: deepClone(remote.paramVersions),
            revision: remote.revision,
            locked: true
          };
          this.lastSyncAt = nowLabel();
          this.syncing = false;
          this.persist();
          return;
        }

        const mergedSteps: LiftStep[] = deepClone(this.steps);
        const mergedVersions = { ...this.paramVersions };
        const nextBaseSteps: LiftStep[] = deepClone(this.base.steps);
        const nextBaseVersions = { ...this.base.paramVersions };
        const pushSteps: LiftStep[] = deepClone(this.steps);

        for (const localStep of mergedSteps) {
          const remoteStep = remote.steps.find((s) => s.id === localStep.id);
          const baseStep = this.base.steps.find((s) => s.id === localStep.id);
          if (!remoteStep || !baseStep) continue;
          const pushStep = pushSteps.find((s) => s.id === localStep.id)!;
          const nextBaseStep = nextBaseSteps.find((s) => s.id === localStep.id)!;

          for (const field of allFields) {
            const lv = localStep[field];
            const rv = remoteStep[field];
            const bv = baseStep[field];
            const existing = this.conflicts.find((c) => c.stepId === localStep.id && c.field === field);

            if (existing) {
              existing.localValue = lv as string | number;
              existing.remoteValue = rv as string | number;
              if (existing.resolvedWith !== null && (!existing.requiresSafety || existing.safetyConfirmed)) {
                // 已完成仲裁：以所选版本为准
                const chosen = existing.resolvedWith === 'local' ? lv : rv;
                localStep[field] = chosen as never;
                pushStep[field] = chosen as never;
                nextBaseStep[field] = chosen as never;
                continue;
              }
              if (lv === rv) {
                nextBaseStep[field] = rv as never;
                pushStep[field] = rv as never;
                continue; // 标记稍后移除（自然收敛）
              }
              if (rv === bv) {
                // 远端改动已撤回，本地版生效
                nextBaseStep[field] = lv as never;
                pushStep[field] = lv as never;
                continue;
              }
              // 冲突仍未解决：推送时保留远端值，本地继续留两版
              pushStep[field] = rv as never;
              nextBaseStep[field] = bv as never;
              continue;
            }

            const localChanged = lv !== bv;
            const remoteChanged = rv !== bv;
            if (localChanged && remoteChanged) {
              this.conflicts.push({
                id: `${localStep.id}:${field}`,
                stepId: localStep.id,
                field,
                label: fieldMeta[field].label,
                localValue: lv as string | number,
                remoteValue: rv as string | number,
                resolvedWith: null,
                requiresSafety: isPreservedField(field),
                safetyConfirmed: false,
                createdAt: nowLabel()
              });
              // 未仲裁字段不得覆盖远端
              pushStep[field] = rv as never;
              nextBaseStep[field] = bv as never;
            } else if (remoteChanged) {
              localStep[field] = rv as never;
              pushStep[field] = rv as never;
              nextBaseStep[field] = rv as never;
            } else {
              pushStep[field] = lv as never;
              nextBaseStep[field] = lv as never;
            }
          }

          const localVer = this.paramVersions[localStep.id] ?? 1;
          const remoteVer = remote.paramVersions[localStep.id] ?? 1;
          const baseVer = this.base.paramVersions[localStep.id] ?? 1;
          mergedVersions[localStep.id] = Math.max(localVer, remoteVer, baseVer);
          nextBaseVersions[localStep.id] = this.conflicts.some(
            (c) => c.stepId === localStep.id && (c.resolvedWith === null || (c.requiresSafety && !c.safetyConfirmed))
          )
            ? baseVer
            : mergedVersions[localStep.id];
          pushStep.status = localStep.status;
        }

        // 移除已收敛 / 已完成仲裁并推送的冲突
        this.conflicts = this.conflicts.filter((conflict) => {
          if (conflict.resolvedWith !== null && (!conflict.requiresSafety || conflict.safetyConfirmed)) return false;
          const localStep = mergedSteps.find((s) => s.id === conflict.stepId);
          const remoteStep = remote.steps.find((s) => s.id === conflict.stepId);
          const baseStep = this.base.steps.find((s) => s.id === conflict.stepId);
          if (!localStep || !remoteStep || !baseStep) return true;
          const lv = localStep[conflict.field];
          const rv = remoteStep[conflict.field];
          const bv = baseStep[conflict.field];
          if (lv === rv) return false;
          if (rv === bv) return false;
          // 刷新为合并后的两版
          conflict.localValue = lv as string | number;
          conflict.remoteValue = rv as string | number;
          return true;
        });

        // 意见合并：本地新增保留；同一意见两边状态都改以本地为准
        const mergedComments: Comment[] = [];
        const allCommentIds = new Set([...this.comments.map((c) => c.id), ...remote.comments.map((c) => c.id)]);
        for (const id of allCommentIds) {
          const localComment = this.comments.find((c) => c.id === id);
          const remoteComment = remote.comments.find((c) => c.id === id);
          if (localComment && remoteComment) {
            const baseComment = this.base.comments.find((c) => c.id === id);
            if (baseComment && localComment.status !== baseComment.status && remoteComment.status !== baseComment.status) {
              mergedComments.push(localComment);
            } else {
              // 字段级：取较新的状态与确认信息
              mergedComments.push({
                ...remoteComment,
                ...localComment,
                status: localComment.status !== baseComment?.status ? localComment.status : remoteComment.status,
                paramVersion: Math.max(localComment.paramVersion, remoteComment.paramVersion),
                reconfirmedBy: localComment.reconfirmedBy ?? remoteComment.reconfirmedBy
              });
            }
          } else {
            mergedComments.push(deepClone(localComment ?? remoteComment)!);
          }
        }

        // 会签合并：同角色取签署时间较新的一版
        const mergedSignoffs: Signoff[] = [];
        const allRoles = new Set([...this.signoffs.map((s) => s.role), ...remote.signoffs.map((s) => s.role)]);
        for (const role of allRoles) {
          const localSign = this.signoffs.find((s) => s.role === role)!;
          const remoteSign = remote.signoffs.find((s) => s.role === role);
          if (localSign && remoteSign) {
            mergedSignoffs.push(localSign.signedAt >= remoteSign.signedAt ? localSign : remoteSign);
          } else {
            mergedSignoffs.push(deepClone(localSign ?? remoteSign)!);
          }
        }

        const pushState: RemoteState = {
          revision: remote.revision,
          locked: this.locked,
          steps: pushSteps,
          comments: mergedComments,
          signoffs: mergedSignoffs,
          paramVersions: mergedVersions
        };
        const pushed = await pushRemote(pushState);

        // 推送成功：落地合并结果
        this.steps = mergedSteps;
        this.comments = mergedComments;
        this.signoffs = mergedSignoffs;
        this.paramVersions = mergedVersions;
        this.revision = pushed.revision;
        this.base = {
          steps: nextBaseSteps,
          comments: deepClone(mergedComments),
          signoffs: deepClone(mergedSignoffs),
          paramVersions: nextBaseVersions,
          revision: pushed.revision,
          locked: this.locked
        };
        // 仍有未决冲突的步骤修改保留为未完成项，其余队列清空
        this.pending = this.pending.filter(
          (op) => op.type === 'step' && this.conflicts.some((c) => c.stepId === op.target && c.resolvedWith === null)
        );
        this.lastSyncAt = nowLabel();
        this.persist();
        // 同步期间排队的锁定请求：合并完成后按最新门禁重新校验；仍有阻断项则取消排队
        if (this.lockRequested && !this.locked) {
          if (this.blockers.length === 0) this.lockPlan();
          else this.lockRequested = false;
        }
      } catch (error) {
        // 同步失败：本地改动、未决冲突与未完成项全部保留，允许重试，重开页面也不丢
        this.lastSyncError = error instanceof Error ? error.message : '同步失败，请稍后重试';
        this.persist();
      } finally {
        this.syncing = false;
      }
    },
    lockPlan() {
      if (this.locked) return;
      // 同步进行中：排队，同步结束后在 sync() 末尾重新校验门禁
      if (this.syncing) {
        this.lockRequested = true;
        return;
      }
      if (this.blockers.length > 0) return;
      this.locked = true;
      this.lockRequested = false;
      this.revision += 1;
      this.writeSnapshot();
      this.persist();
      void this.sync();
    },
    writeSnapshot() {
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: PLAN_ID },
        data: {
          liftPlan: {
            __typename: 'LiftPlan',
            id: PLAN_ID,
            name: '东塔转换桁架吊装',
            revision: this.revision,
            status: 'LOCKED',
            steps: this.steps.map((step) => ({
              __typename: 'LiftStep',
              id: step.id,
              name: step.title,
              loadRate: step.loadRate,
              clearance: step.clearance
            }))
          }
        }
      });
    },
    simulateRemote() {
      simulateRemoteEdits();
    },
    setFailBudget(count: number) {
      this.failBudget = count;
      serverFailBudget(count);
    },
    resetDemo() {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(cacheKey);
      window.location.reload();
    }
  }
});
