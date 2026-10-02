import { initialComments, initialSignoffs, initialSteps } from './seed';
import type { RemoteState } from './types';
import { deepClone } from './util';

const serverState: RemoteState = {
  revision: 4,
  locked: false,
  steps: deepClone(initialSteps),
  comments: deepClone(initialComments),
  signoffs: deepClone(initialSignoffs),
  paramVersions: Object.fromEntries(initialSteps.map((step) => [step.id, 1]))
};

let failureBudget = 0;

/** 安排接下来 N 次同步失败 */
export function setFailureBudget(count: number) {
  failureBudget = Math.max(0, count);
}

/** 供界面演示：另一台终端在远端修改了 S-03 / S-04 的双版保留字段 */
export function simulateRemoteEdits() {
  const s3 = serverState.steps.find((s) => s.id === 'S-03');
  const s4 = serverState.steps.find((s) => s.id === 'S-04');
  if (s3) {
    s3.loadRate = 71;
    s3.wind = 5.8;
    serverState.paramVersions['S-03'] += 1;
  }
  if (s4) {
    s4.clearance = 2.1;
    serverState.paramVersions['S-04'] += 1;
  }
  serverState.revision += 1;
}

function latency() {
  return new Promise((resolve) => setTimeout(resolve, 650 + Math.random() * 500));
}

export async function pullRemote(): Promise<RemoteState> {
  await latency();
  if (failureBudget > 0) {
    failureBudget -= 1;
    throw new Error('网络链路不稳定，远端拉取超时');
  }
  return deepClone(serverState);
}

export async function pushRemote(state: RemoteState): Promise<RemoteState> {
  await latency();
  if (failureBudget > 0) {
    failureBudget -= 1;
    throw new Error('网络链路不稳定，远端写入失败');
  }
  Object.assign(serverState, deepClone(state));
  serverState.revision += 1;
  return deepClone(serverState);
}
