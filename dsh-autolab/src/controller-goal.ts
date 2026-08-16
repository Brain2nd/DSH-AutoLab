import { join } from 'node:path'

import type { FrozenRevision } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import { rolePromptFor } from './roles.js'
import type { RuntimeState } from './state.js'

export interface ControllerGoalIntent {
  readonly roleId: string
  readonly installId: string
  readonly assignmentId: string
  readonly packetHash: string
  readonly objective: string
  readonly objectiveHash: string
  readonly maxGoalRounds: number
}

/**
 * Compile one short native Goal from authoritative paths plus the small current
 * projection. Original Lab text stays in its revision and must be read there;
 * it is never summarized into another source of truth.
 */
export function compileControllerGoalIntent(
  state: RuntimeState,
  frozen: FrozenRevision,
): ControllerGoalIntent {
  const controller = frozen.manifest.roles.find(role => role.role_kind === 'controller')
  if (controller === undefined
    || controller.prebound_session_id !== state.controllerSessionId
    || controller.prompt_sha256 !== rolePromptFor('controller').sha256) {
    throw new Error(`AutoLab ${state.labId} Controller binding does not match CURRENT`)
  }
  const revision = frozen.ref.revision
  const assignmentId = `${state.labId}:controller:revision:${revision}`
  const installId = `${assignmentId}:goal`
  const progress = controllerProgress(state)
  const objective = [
    `AutoLab-Controller-Install-ID: ${JSON.stringify(installId)}`,
    `AutoLab-ID: ${JSON.stringify(state.labId)}`,
    `Controller-Session-ID: ${JSON.stringify(state.controllerSessionId)}`,
    `Controller-Assignment-ID: ${JSON.stringify(assignmentId)}`,
    '',
    'Authoritative Lab anchors (read the complete files; summaries and chat memory are not authority):',
    `- creation dialogue: ${frozen.manifest.authority_paths.creation_log}`,
    `- CURRENT: ${join(frozen.manifest.authority_paths.lab_dir, 'CURRENT')}`,
    `- LAB_SPEC.md: ${frozen.manifest.authority_paths.lab_spec} (sha256 ${frozen.ref.specHash})`,
    `- lab.yaml: ${frozen.manifest.authority_paths.lab_yaml} (sha256 ${frozen.ref.configHash})`,
    `- RESOLVED_MANIFEST.json: ${frozen.manifest.authority_paths.resolved_manifest} (sha256 ${frozen.ref.manifestHash})`,
    '',
    'Before making an explicitly delegated choice or dispatching work, read the complete relevant originals and call AutoLabStatus for the live projection. Coordinate Method, Coder, Preflight Judge, Postflight Judge, Ops, and optional Coordinator without taking over their independent judgments.',
    'Runtime handles deterministic API, Session, process, SSH, hardware, and environment recovery. Do not poll or invoke an LLM for a repair Runtime can complete. Act only on an unresolved incident or on research work that requires understanding or choice.',
    'When no authorized action or decision is ready, call AutoLabWait once; Runtime will resume this same Goal from the exact durable event.',
    '',
    `Progress at Goal compilation: ${canonicalJson(progress)}`,
  ].join('\n')
  return Object.freeze({
    roleId: controller.role_id,
    installId,
    assignmentId,
    packetHash: frozen.ref.manifestHash,
    objective,
    objectiveHash: sha256(objective),
    maxGoalRounds: controller.max_goal_rounds,
  })
}

function controllerProgress(state: RuntimeState): unknown {
  const roles = Object.fromEntries(Object.entries(state.roles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roleId, role]) => [roleId, {
      phase: role.phase,
      ...(role.goalInstall === undefined
        ? {}
        : { assignment_id: role.goalInstall.assignmentId }),
      ...(role.activationBlocker === undefined
        ? {}
        : { activation_blocker: role.activationBlocker.code }),
    }]))
  const reviews = Object.fromEntries(Object.entries(state.reviews)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reviewId, review]) => [reviewId, {
      stage: review.stage,
      phase: review.phase,
      worker_role_id: review.capability.workerRoleId,
      judge_role_id: review.capability.judgeRoleId,
      ...(review.verdict === undefined
        ? {}
        : { verdict: review.verdict.topLevelVerdict }),
      ...(review.result === undefined
        ? {}
        : { result_sha256: review.result.hash }),
    }]))
  const candidates = Object.fromEntries(Object.entries(state.candidates)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([laneId, candidate]) => [laneId, candidate.candidateId]))
  const trials = Object.fromEntries(Object.entries(state.trials)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([trialId, trial]) => [trialId, Object.fromEntries(Object.entries(trial.runSlots)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([runSlotId, slot]) => [runSlotId, slot.state.status]))]))
  return {
    runtime_revision: state.runtimeRevision,
    lifecycle: state.lifecycle,
    roles,
    reviews,
    candidates,
    trials,
    ...(state.blocker === undefined ? {} : { blocker: state.blocker }),
  }
}
