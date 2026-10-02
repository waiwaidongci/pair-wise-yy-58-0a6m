import type { LiftStep, Comment, Signoff, PreservedField, RoleId, StepField } from './types';

export const PLAN_ID = 'LP-2026-0918';

export const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

export const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: 'safety', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02', paramVersion: 1 },
  { id: 'C-12', author: '刘明', role: 'equipment', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05', paramVersion: 1 },
  { id: 'C-13', author: '陈晓', role: 'general', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03', paramVersion: 1 }
];

export const roles: Record<RoleId, {
  name: string;
  team: string;
  scope: string;
  scopeSteps: string[];
  signoff: Signoff;
}> = {
  general: {
    name: '陈晓',
    team: '总包项目部',
    scope: '吊装工序与场地移交',
    scopeSteps: ['S-01', 'S-02', 'S-06'],
    signoff: { role: 'general', accepted: true, signedAt: '09-28 16:42', stepVersions: { 'S-01': 1, 'S-02': 1, 'S-06': 1 } }
  },
  equipment: {
    name: '刘明',
    team: '设备管理',
    scope: '吊车参数与支腿地基',
    scopeSteps: ['S-01', 'S-05'],
    signoff: { role: 'equipment', accepted: true, signedAt: '09-28 17:05', stepVersions: { 'S-01': 1, 'S-05': 1 } }
  },
  safety: {
    name: '周工',
    team: '安全监督',
    scope: '净空、风速与警戒区',
    scopeSteps: ['S-02', 'S-03', 'S-04', 'S-05'],
    signoff: { role: 'safety', accepted: false, signedAt: '09-29 08:12', stepVersions: { 'S-02': 1, 'S-03': 1, 'S-04': 1, 'S-05': 1 } }
  },
  engineering: {
    name: '赵磊',
    team: '方案工程',
    scope: '载荷计算与路径参数',
    scopeSteps: ['S-03', 'S-04', 'S-05', 'S-06'],
    signoff: { role: 'engineering', accepted: true, signedAt: '09-28 18:20', stepVersions: { 'S-03': 1, 'S-04': 1, 'S-05': 1, 'S-06': 1 } }
  }
};

export const initialSignoffs: Signoff[] = [
  { ...roles.general.signoff, stepVersions: { ...roles.general.signoff.stepVersions } },
  { ...roles.equipment.signoff, stepVersions: { ...roles.equipment.signoff.stepVersions } },
  { ...roles.safety.signoff, stepVersions: { ...roles.safety.signoff.stepVersions } },
  { ...roles.engineering.signoff, stepVersions: { ...roles.engineering.signoff.stepVersions } }
];

export const fieldMeta: Record<StepField, { label: string; unit: string }> = {
  loadRate: { label: '荷载率', unit: '%' },
  clearance: { label: '最小净空', unit: 'm' },
  wind: { label: '风速', unit: 'm/s' },
  radius: { label: '作业半径', unit: 'm' },
  boom: { label: '臂长', unit: 'm' },
  note: { label: '现场控制说明', unit: '' },
  status: { label: '步骤结论', unit: '' }
};

export const paramFields: StepField[] = ['loadRate', 'clearance', 'wind', 'radius', 'boom'];
export const preservedFields: PreservedField[] = ['loadRate', 'clearance', 'wind'];

export function isPreservedField(field: StepField): field is PreservedField {
  return (preservedFields as StepField[]).includes(field);
}
