export type RoleId = 'general' | 'equipment' | 'safety' | 'engineering';
export type StepStatus = 'pending' | 'passed' | 'blocked';

export type StepField = 'loadRate' | 'clearance' | 'wind' | 'radius' | 'boom' | 'note' | 'status';
/** 需要安全监督仲裁的双版保留字段 */
export type PreservedField = 'loadRate' | 'clearance' | 'wind';

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

export type Comment = {
  id: string;
  author: string;
  role: RoleId;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
  /** 意见针对的步骤参数版本，与当前版本不一致即为过期意见 */
  paramVersion: number;
  reconfirmedBy?: string;
};

export type Signoff = {
  role: RoleId;
  accepted: boolean; // false 表示有保留
  signedAt: string;
  /** 各步骤签署时的参数版本，当前版本超出即作废 */
  stepVersions: Record<string, number>;
};

export type PendingOpType = 'step' | 'commentAdd' | 'commentResolve' | 'commentReconfirm' | 'sign';

export type PendingOp = {
  id: string;
  type: PendingOpType;
  target: string; // 步骤 ID 或意见 ID 或角色 ID
  label: string;
  createdAt: string;
  payload?: unknown;
};

export type MergeConflict = {
  id: string; // `${stepId}:${field}`
  stepId: string;
  field: StepField;
  label: string;
  localValue: string | number;
  remoteValue: string | number;
  /** 已选版本：local / remote；未选择时为 null */
  resolvedWith: 'local' | 'remote' | null;
  /** 荷载率/净空/风速必须由安全监督确认 */
  requiresSafety: boolean;
  safetyConfirmed: boolean;
  createdAt: string;
};

/** 服务端权威状态（模拟） */
export type RemoteState = {
  revision: number;
  locked: boolean;
  steps: LiftStep[];
  comments: Comment[];
  signoffs: Signoff[];
  paramVersions: Record<string, number>;
};

/** 最近一次成功同步时的快照，用于三向合并 */
export type SyncSnapshot = {
  steps: LiftStep[];
  comments: Comment[];
  signoffs: Signoff[];
  paramVersions: Record<string, number>;
  revision: number;
  locked: boolean;
};

export type BlockerType = 'merge' | 'rule' | 'openComment' | 'staleComment' | 'signoff';

export type Blocker = {
  key: string;
  type: BlockerType;
  detail: string;
  stepId?: string;
  role?: RoleId;
};
