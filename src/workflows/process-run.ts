import { sleep } from 'workflow';
import type { AccessScope } from '@/lib/store';
import {
  advanceApsRun,
  expireRunWorkflow,
  processStoredRun,
  type RunWorkflowPhase,
} from '@/lib/run-processing';

export interface ProcessRunWorkflowInput {
  scope: AccessScope;
  runId: string;
  lang: 'tr' | 'en';
  autoDetect: boolean;
}

async function processStoredRunStep(input: ProcessRunWorkflowInput): Promise<RunWorkflowPhase> {
  'use step';
  return processStoredRun(input);
}

async function advanceApsRunStep(input: ProcessRunWorkflowInput): Promise<RunWorkflowPhase> {
  'use step';
  return advanceApsRun(input.scope, input.runId, input.lang);
}

async function expireRunWorkflowStep(input: ProcessRunWorkflowInput): Promise<RunWorkflowPhase> {
  'use step';
  return expireRunWorkflow(input.scope, input.runId, input.lang);
}

/**
 * Durable end-to-end take-off. No browser heartbeat is required: every costly
 * operation is a persisted step and Autodesk waits suspend without consuming a
 * function. The explicit loop bound is the product timeout, not an SDK timeout.
 */
export async function processRunWorkflow(input: ProcessRunWorkflowInput): Promise<RunWorkflowPhase> {
  'use workflow';

  let state = await processStoredRunStep(input);
  if (state.terminal) return state;

  // Wall-clock expiry is enforced from persisted run timestamps inside every
  // tick (translation ≤1h, property preparation ≤3h — durable sleep is free).
  // This generous static bound is only a compiler/runtime safety net.
  for (let attempt = 0; attempt < 1300; attempt++) {
    await sleep(`${state.waitSeconds ?? 10}s`);
    state = await advanceApsRunStep(input);
    if (state.terminal) return state;
  }

  return expireRunWorkflowStep(input);
}
