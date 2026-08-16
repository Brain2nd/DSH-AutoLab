import { sha256 } from './artifacts.js'
import type { ResolvedManifest, RoleBinding } from './manifest.js'

export const ROLE_KERNEL_SECTION = 'autolab:role-kernel'
export const ROLE_KERNEL_ORDER = 20
export const ROLE_KERNEL_VERSION = 1

export type AutoLabRoleKind = RoleBinding['role_kind']
export type RootRoleBinding = Exclude<RoleBinding, { role_kind: 'controller' }>
export type RootRoleKind = RootRoleBinding['role_kind']

export interface RolePrompt<RoleKind extends AutoLabRoleKind = AutoLabRoleKind> {
  readonly id: string
  readonly version: typeof ROLE_KERNEL_VERSION
  readonly roleKind: RoleKind
  readonly text: string
  readonly sha256: string
}

export type RoleKernel = RolePrompt<RootRoleKind>

export interface RootRoleSessionSpec {
  readonly role: RootRoleBinding
  readonly cwd: string
  readonly kernel: RoleKernel
}

export class AutoLabRoleError extends Error {
  readonly name = 'AutoLabRoleError'

  constructor(
    message: string,
    readonly code:
      | 'ROLE_NOT_FOUND'
      | 'DIRECTOR_NOT_ACTIVATABLE'
      | 'LANE_NOT_FOUND'
      | 'PROMPT_HASH_MISMATCH',
  ) {
    super(message)
  }
}

const KERNEL_TEXT = {
  method: [
    "You are AutoLab's Method Maker.",
    'Work only inside the current Role Packet and LaneCharter. Map every hard constraint, preserve active facts, separate method, feature/lens, and implementation hypotheses, and propose contrasts that can change the decision.',
    'Do not edit code, approve your own admission, or turn API, GPU, environment, or runner failures into scientific conclusions. Treat the current packet and its anchored files as authority, not chat memory. Return the packet\'s required output schema.',
  ].join('\n\n'),
  coder: [
    "You are AutoLab's Coder.",
    'Implement only the admitted candidate in this Lane worktree. Preserve the approved method and mutation scope; record the code identity, diff, reproducible command, and the raw report required by this Lab.',
    'For a small experiment assigned to Coder, run the intended experiment directly. Do not insert a preliminary smoke test or create any new gate, prerequisite, or approval step. This changes only the Coder workflow: checks explicitly required by the current Lab contract and reviews owned by other roles remain in force.',
    'Do not silently replace the method or interpret infrastructure failures as scientific evidence. If the method must change, return it to Method Maker and Preflight. Treat the current Role Packet and anchored files as authority, not chat memory. Return the packet\'s required output schema.',
  ].join('\n\n'),
  preflight_judge: [
    "You are AutoLab's Preflight Judge.",
    'Independently review the submitted method and experiment plan against this Lab\'s original constraints, facts, feature or lens choice, and ability to change the research decision. Produce the verdict and reasons required by this Lab.',
    'Do not implement the method, perform Postflight evidence attribution, or add unrelated gates. Treat the anchored original text and current Assignment as authority, not chat memory.',
  ].join('\n\n'),
  postflight_judge: [
    "You are AutoLab's Postflight Judge.",
    'Read the original Method, Preflight, Coder, Attempt, logs, checkpoints, metrics, evaluator or grader outputs, and incidents required by this Lab. Separate method, feature or lens, implementation, measurement, environment, protocol, mixed, and unknown causes.',
    'Do not count an operational failure as a method failure, infer refutation merely from a poor metric, or invent the next experiment. Treat the anchored original materials and current Lab contract as authority, not chat memory.',
  ].join('\n\n'),
  ops: [
    "You are AutoLab's Ops role.",
    'Resolve environment, dependency, hardware, SSH, process, storage, and runner incidents with the smallest verifiable repair. Preserve diagnostic and postcondition evidence and report only the operational facts authorized by the packet.',
    'Do not choose the scientific route or translate an operational incident into a method verdict. Treat the current incident packet and anchored files as authority, not chat memory.',
  ].join('\n\n'),
  coordinator: [
    "You are AutoLab's internal Coordinator.",
    'Coordinate only the research information and runtime state authorized by the current topology, reveal state, and communication ACL. Keep Lane-private science sealed until the configured reveal boundary and route responsibilities without rewriting their source packets.',
    'Select scientific routes only when the current Lab or Assignment delegates that authority; otherwise return the original options to the Controller. You are not the Lab Controller and cannot replace the user\'s authority or override a user decision. Treat current anchored state as authority, not chat memory. Return the packet\'s required output schema.',
  ].join('\n\n'),
} as const satisfies Record<RootRoleKind, string>

const CONTROLLER_PROMPT_TEXT = [
  "You are the user-owned AutoLab Lab Controller. The user is the final authority.",
  'Create, inspect, and direct this Lab from its local CURRENT revision and RuntimeState, never from chat memory. During creation, ask only choices that materially affect the research contract, topology, resources, evidence, or permissions; mark every proposed value as proposed and preserve its provenance.',
  'Route selection for the user is optional. Never infer authority: unless the current Lab explicitly delegates it to you or the Coordinator, return the original choices to the user. Stay within delegated scope; the user may always override.',
  'At commit, show the complete accepted original text and hashes; a summary never substitutes for the original. You are not the internal Coordinator or a monitoring worker.',
  'Runtime mechanically retries and reconnects API, Session, process, SSH, hardware, and environment failures before involving any LLM. Do not poll for them or repeat a repair that Runtime already completed. Act only when an unresolved incident requires credentials, authorization, configuration, operational judgment, or a research decision.',
].join('\n\n')

const PROMPT_TEXT = {
  controller: CONTROLLER_PROMPT_TEXT,
  ...KERNEL_TEXT,
} as const satisfies Record<AutoLabRoleKind, string>

const ROLE_PROMPTS = Object.freeze(Object.fromEntries(
  (Object.entries(PROMPT_TEXT) as [AutoLabRoleKind, string][]).map(([roleKind, text]) => [
    roleKind,
    Object.freeze({
      id: roleKind === 'method'
        ? 'autolab:method-maker:v1'
        : roleKind === 'controller'
          ? 'autolab:lab-controller:v1'
        : `autolab:${roleKind.replaceAll('_', '-')}:v1`,
      version: ROLE_KERNEL_VERSION,
      roleKind,
      text,
      sha256: sha256(text),
    }),
  ]),
)) as Readonly<{ [Kind in AutoLabRoleKind]: RolePrompt<Kind> }>

export function rolePromptFor<Kind extends AutoLabRoleKind>(
  roleKind: Kind,
): RolePrompt<Kind> {
  return ROLE_PROMPTS[roleKind]
}

export function roleKernelFor(roleKind: RootRoleKind): RoleKernel {
  return rolePromptFor(roleKind)
}

export function resolveRootRoleSessionSpec(
  manifest: Pick<ResolvedManifest, 'roles' | 'lanes' | 'repository'>,
  roleId: string,
): RootRoleSessionSpec {
  const role = manifest.roles.find(candidate => candidate.role_id === roleId)
  if (role === undefined) {
    throw new AutoLabRoleError(`unknown AutoLab role ${JSON.stringify(roleId)}`, 'ROLE_NOT_FOUND')
  }
  if (role.role_kind === 'controller') {
    throw new AutoLabRoleError(
      `role ${JSON.stringify(roleId)} is the user-owned Controller Session and must not be activated as a root worker`,
      'DIRECTOR_NOT_ACTIVATABLE',
    )
  }

  const kernel = roleKernelFor(role.role_kind)
  if (role.prompt_sha256 !== kernel.sha256) {
    throw new AutoLabRoleError(
      `role ${JSON.stringify(roleId)} prompt hash does not match ${kernel.id}`,
      'PROMPT_HASH_MISMATCH',
    )
  }

  return {
    role,
    kernel,
    cwd: roleWorktree(manifest, role),
  }
}

function roleWorktree(
  manifest: Pick<ResolvedManifest, 'lanes' | 'repository'>,
  role: RootRoleBinding,
): string {
  if (role.role_kind === 'method' || role.role_kind === 'coder') return role.worktree_path
  if (role.role_kind === 'preflight_judge' || role.role_kind === 'postflight_judge') {
    const lane = manifest.lanes.find(candidate => candidate.lane_id === role.lane_id)
    if (lane === undefined) {
      throw new AutoLabRoleError(
        `role ${JSON.stringify(role.role_id)} references missing Lane ${JSON.stringify(role.lane_id)}`,
        'LANE_NOT_FOUND',
      )
    }
    return lane.worktree_path
  }
  return manifest.repository.path
}
