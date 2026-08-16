import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import { canonicalJson, sha256 } from './integrity.js'

export { canonicalJson } from './integrity.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const idSchema = z.string().min(1)
const hashSchema = z.string().regex(SHA256_PATTERN)
const gitShaSchema = z.string().regex(GIT_SHA_PATTERN)
const absolutePathSchema = z.string().min(1).refine(isAbsolute, 'path must be absolute')
const stringListSchema = z.array(z.string().min(1))
const jsonObjectSchema = z.record(z.string(), z.json())
const maxGoalRoundsSchema = z.number().int().positive()

const componentRefSchema = z.object({
  id: idSchema,
  version: idSchema,
  sha256: hashSchema,
}).strict()

const modelRouteSchema = z.object({
  route_id: idSchema,
  provider: idSchema,
  model: idSchema,
  config: jsonObjectSchema,
}).strict()

const reasoningSchema = z.object({
  mode: idSchema,
  config: jsonObjectSchema,
}).strict()

const roleCommonShape = {
  role_id: idSchema,
  model_route: modelRouteSchema,
  fallback_routes: z.array(modelRouteSchema),
  dsh_preset: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  reasoning: reasoningSchema,
  allowed_tools: stringListSchema,
  prompt_sha256: hashSchema,
} as const

const controllerRoleSchema = z.object({
  ...roleCommonShape,
  role_kind: z.literal('controller'),
  max_goal_rounds: maxGoalRoundsSchema,
  prebound_session_id: idSchema,
}).strict()

const methodRoleSchema = z.object({
  ...roleCommonShape,
  role_kind: z.literal('method'),
  max_goal_rounds: maxGoalRoundsSchema,
  lane_id: idSchema,
  worktree_path: absolutePathSchema,
  prebound_session_id: idSchema.optional(),
}).strict()

const coderRoleSchema = z.object({
  ...roleCommonShape,
  role_kind: z.literal('coder'),
  max_goal_rounds: maxGoalRoundsSchema,
  lane_id: idSchema,
  worktree_path: absolutePathSchema,
  prebound_session_id: idSchema.optional(),
}).strict()

const preflightRoleSchema = z.object({
  ...roleCommonShape,
  role_kind: z.literal('preflight_judge'),
  lane_id: idSchema,
  prebound_session_id: idSchema.optional(),
}).strict()

const postflightRoleSchema = z.object({
  ...roleCommonShape,
  role_kind: z.literal('postflight_judge'),
  lane_id: idSchema,
  prebound_session_id: idSchema.optional(),
}).strict()

const opsRoleSchema = z.object({
  ...roleCommonShape,
  role_kind: z.literal('ops'),
  max_goal_rounds: maxGoalRoundsSchema,
  resource_domain: idSchema,
  prebound_session_id: idSchema.optional(),
}).strict()

const coordinatorRoleSchema = z.object({
  ...roleCommonShape,
  role_kind: z.literal('coordinator'),
  max_goal_rounds: maxGoalRoundsSchema,
  prebound_session_id: idSchema.optional(),
}).strict()

export const roleBindingSchema = z.discriminatedUnion('role_kind', [
  controllerRoleSchema,
  methodRoleSchema,
  coderRoleSchema,
  preflightRoleSchema,
  postflightRoleSchema,
  opsRoleSchema,
  coordinatorRoleSchema,
])

const laneCharterSchema = z.object({
  lane_id: idSchema,
  charter_sha256: hashSchema,
  content: jsonObjectSchema,
}).strict()

const laneBindingSchema = z.object({
  lane_id: idSchema,
  worktree_path: absolutePathSchema,
  base_ref: idSchema,
  base_sha: gitShaSchema,
  method_role_id: idSchema,
  coder_role_id: idSchema,
  preflight_judge_role_id: idSchema,
  postflight_judge_role_id: idSchema,
}).strict()

const hostSchema = z.object({
  host_id: idSchema,
  runner_target: idSchema,
}).strict()

const gpuSchema = z.object({
  gpu_id: idSchema,
  host_id: idSchema,
}).strict()

const roleCommunicationSchema = z.object({
  role_id: idSchema,
  send: z.boolean(),
  receive: z.boolean(),
}).strict()

const pairBlockSchema = z.object({
  role_ids: z.tuple([idSchema, idSchema]),
  active_when: z.enum(['before_reveal', 'after_reveal', 'always']),
}).strict()

const provenanceSchema = z.string().refine(value => (
  value === 'user'
  || value === 'proposed'
  || value === 'default'
  || value.startsWith('discovered:') && value.length > 'discovered:'.length
  || value.startsWith('inherited:') && value.length > 'inherited:'.length
), 'invalid provenance')

export const resolvedManifestSchema = z.object({
  schema_version: z.literal(1),
  lab_id: idSchema,
  source_revision: z.number().int().positive(),
  campaign_contract_sha256: hashSchema,
  anchors: z.object({
    dialogue_head_sha256: hashSchema,
    lab_spec_sha256: hashSchema,
    lab_yaml_sha256: hashSchema,
  }).strict(),
  authority_paths: z.object({
    lab_dir: absolutePathSchema,
    creation_log: absolutePathSchema,
    lab_spec: absolutePathSchema,
    lab_yaml: absolutePathSchema,
    resolved_manifest: absolutePathSchema,
    fact_set: absolutePathSchema,
    evidence_index: absolutePathSchema,
    assignment_root: absolutePathSchema,
    worktree_root: absolutePathSchema,
  }).strict(),
  versions: z.object({
    autolab_plugin: idSchema,
    dsh: idSchema,
  }).strict(),
  repository: z.object({
    path: absolutePathSchema,
    base_ref: idSchema,
    base_sha: gitShaSchema,
  }).strict(),
  /** Lab-authored science is opaque to Runtime; LAB_SPEC remains authoritative. */
  research: jsonObjectSchema,
  contract: jsonObjectSchema,
  search: z.object({
    search_mode: z.enum(['sequential', 'cohort']),
    /** Optional for v1 compatibility; absence has the same meaning as `user`. */
    research_route_authority: z.enum(['user', 'autolab']).optional(),
    lane_count: z.number().int().positive(),
    coordinator_enabled: z.boolean(),
    lane_charters: z.array(laneCharterSchema).min(1),
  }).strict(),
  lanes: z.array(laneBindingSchema).min(1),
  roles: z.array(roleBindingSchema).min(1),
  execution: z.object({
    runner_adapter: componentRefSchema,
    hosts: z.array(hostSchema).min(1),
    gpu_pool: z.array(gpuSchema),
    max_parallel_gpu_attempts: z.number().int().nonnegative(),
    run_root: absolutePathSchema,
    /** Domain-specific launch and resource details, interpreted by assigned Sessions/tools. */
    contract: jsonObjectSchema,
  }).strict(),
  evidence: z.object({
    artifact_root: absolutePathSchema,
    /** Evaluators, metrics, checks and evidence rules are Lab-local opaque data. */
    contract: jsonObjectSchema,
  }).strict(),
  communication: z.object({
    topology: z.enum(['lane_isolated', 'coordinated']),
    acl_revision: z.number().int().nonnegative(),
    controller_visibility: z.literal('global'),
    coordinator_visibility: z.enum(['disabled', 'runtime_only', 'revealed', 'global']),
    role_permissions: z.array(roleCommunicationSchema).min(1),
    text_method_coder_within_lane: z.enum(['allowed', 'blocked']),
    text_pair_blocks: z.array(pairBlockSchema),
    reveal_policy: z.object({
      initial_state: z.enum(['sealed', 'revealed']),
      trigger: z.enum(['manual', 'cohort_barrier', 'immediate']),
      text_cross_lane_before_reveal: z.enum(['blocked', 'allowed']),
      text_cross_lane_after_reveal: z.enum(['blocked', 'allowed']),
    }).strict(),
    api_recovery: idSchema,
    attempt_recovery: idSchema,
    stop_pause_policy: idSchema,
  }).strict(),
  provenance: z.record(z.string().min(1), provenanceSchema),
}).strict().superRefine((manifest, context) => {
  const charterIds = uniqueIndex(
    manifest.search.lane_charters,
    charter => charter.lane_id,
    context,
    ['search', 'lane_charters'],
    'lane charter',
  )
  const lanes = uniqueIndex(
    manifest.lanes,
    lane => lane.lane_id,
    context,
    ['lanes'],
    'lane',
  )
  if (manifest.search.lane_count !== manifest.lanes.length
    || manifest.search.lane_count !== manifest.search.lane_charters.length) {
    issue(context, ['search', 'lane_count'], 'lane_count must match lanes and lane_charters')
  }
  for (const laneId of charterIds.keys()) {
    if (!lanes.has(laneId)) issue(context, ['lanes'], `missing lane binding for ${laneId}`)
  }
  for (const laneId of lanes.keys()) {
    if (!charterIds.has(laneId)) {
      issue(context, ['search', 'lane_charters'], `missing lane charter for ${laneId}`)
    }
  }

  const worktrees = new Map<string, string>()
  for (const lane of manifest.lanes) {
    const normalized = resolve(lane.worktree_path)
    const owner = worktrees.get(normalized)
    if (owner !== undefined && owner !== lane.lane_id) {
      issue(context, ['lanes'], `lanes ${owner} and ${lane.lane_id} share worktree ${normalized}`)
    } else {
      worktrees.set(normalized, lane.lane_id)
    }
  }

  const roles = uniqueIndex(
    manifest.roles,
    role => role.role_id,
    context,
    ['roles'],
    'role',
  )
  const controllers = manifest.roles.filter(role => role.role_kind === 'controller')
  if (controllers.length !== 1) issue(context, ['roles'], 'exactly one Controller role is required')
  if (!manifest.roles.some(role => role.role_kind === 'ops')) {
    issue(context, ['roles'], 'at least one Ops role is required')
  }
  const coordinators = manifest.roles.filter(role => role.role_kind === 'coordinator')
  if (coordinators.length !== (manifest.search.coordinator_enabled ? 1 : 0)) {
    issue(
      context,
      ['roles'],
      manifest.search.coordinator_enabled
        ? 'coordinator_enabled requires exactly one Coordinator role'
        : 'Coordinator role requires coordinator_enabled',
    )
  }
  if ((manifest.communication.coordinator_visibility === 'disabled')
    !== !manifest.search.coordinator_enabled) {
    issue(context, ['communication', 'coordinator_visibility'], 'Coordinator visibility must match coordinator_enabled')
  }

  const sessionOwners = new Map<string, string>()
  for (const role of manifest.roles) {
    const sessionId = role.prebound_session_id
    if (sessionId === undefined) continue
    const owner = sessionOwners.get(sessionId)
    if (owner !== undefined) {
      issue(context, ['roles'], `roles ${owner} and ${role.role_id} reuse prebound SessionId ${sessionId}`)
    } else {
      sessionOwners.set(sessionId, role.role_id)
    }
  }

  const boundLaneRoles = new Set<string>()
  for (const [laneIndex, lane] of manifest.lanes.entries()) {
    const expected = [
      ['method_role_id', lane.method_role_id, 'method'],
      ['coder_role_id', lane.coder_role_id, 'coder'],
      ['preflight_judge_role_id', lane.preflight_judge_role_id, 'preflight_judge'],
      ['postflight_judge_role_id', lane.postflight_judge_role_id, 'postflight_judge'],
    ] as const
    if (new Set(expected.map(([, roleId]) => roleId)).size !== expected.length) {
      issue(context, ['lanes', laneIndex], `lane ${lane.lane_id} requires four independent roles`)
    }
    for (const [field, roleId, kind] of expected) {
      const role = roles.get(roleId)
      if (role === undefined) {
        issue(context, ['lanes', laneIndex, field], `unknown role ${roleId}`)
        continue
      }
      if (role.role_kind !== kind || !('lane_id' in role) || role.lane_id !== lane.lane_id) {
        issue(context, ['lanes', laneIndex, field], `${roleId} must be the ${kind} role for lane ${lane.lane_id}`)
      }
      boundLaneRoles.add(roleId)
      if ((kind === 'method' || kind === 'coder')
        && 'worktree_path' in role
        && resolve(role.worktree_path) !== resolve(lane.worktree_path)) {
        issue(context, ['roles'], `${roleId} must use its lane worktree ${lane.worktree_path}`)
      }
    }
  }
  for (const role of manifest.roles) {
    if ('lane_id' in role && !boundLaneRoles.has(role.role_id)) {
      issue(context, ['roles'], `lane role ${role.role_id} is not bound by its lane`)
    }
  }

  const permissions = uniqueIndex(
    manifest.communication.role_permissions,
    permission => permission.role_id,
    context,
    ['communication', 'role_permissions'],
    'role permission',
  )
  for (const roleId of roles.keys()) {
    if (!permissions.has(roleId)) {
      issue(context, ['communication', 'role_permissions'], `missing communication permission for ${roleId}`)
    }
  }
  for (const roleId of permissions.keys()) {
    if (!roles.has(roleId)) {
      issue(context, ['communication', 'role_permissions'], `communication permission references unknown role ${roleId}`)
    }
  }
  const controller = controllers[0]
  if (controller !== undefined) {
    const permission = permissions.get(controller.role_id)
    if (permission?.send !== true || permission.receive !== true) {
      issue(context, ['communication', 'role_permissions'], 'Controller send and receive must remain enabled')
    }
  }

  const blocks = new Set<string>()
  for (const [blockIndex, block] of manifest.communication.text_pair_blocks.entries()) {
    const [first, second] = block.role_ids
    if (first === second) {
      issue(context, ['communication', 'text_pair_blocks', blockIndex], 'text pair block cannot target one role twice')
    }
    if (!roles.has(first) || !roles.has(second)) {
      issue(context, ['communication', 'text_pair_blocks', blockIndex], 'text pair block references an unknown role')
    }
    if (controller !== undefined && (first === controller.role_id || second === controller.role_id)) {
      issue(context, ['communication', 'text_pair_blocks', blockIndex], 'Controller cannot be hidden by a text pair block')
    }
    const key = `${[first, second].sort().join('\0')}\0${block.active_when}`
    if (blocks.has(key)) {
      issue(context, ['communication', 'text_pair_blocks', blockIndex], 'duplicate text pair block')
    }
    blocks.add(key)
  }
  if ((manifest.communication.topology === 'lane_isolated'
      || manifest.search.search_mode === 'cohort')
    && manifest.communication.reveal_policy.text_cross_lane_before_reveal !== 'blocked') {
    issue(context, ['communication', 'reveal_policy', 'text_cross_lane_before_reveal'], 'isolated/cohort Lane text must be blocked before reveal')
  }

  const hosts = uniqueIndex(
    manifest.execution.hosts,
    host => host.host_id,
    context,
    ['execution', 'hosts'],
    'host',
  )
  const gpuIds = new Set<string>()
  for (const [gpuIndex, gpu] of manifest.execution.gpu_pool.entries()) {
    if (gpuIds.has(gpu.gpu_id)) issue(context, ['execution', 'gpu_pool', gpuIndex], `duplicate GPU ${gpu.gpu_id}`)
    gpuIds.add(gpu.gpu_id)
    if (!hosts.has(gpu.host_id)) issue(context, ['execution', 'gpu_pool', gpuIndex, 'host_id'], `unknown host ${gpu.host_id}`)
  }

})

export type RoleBinding = z.infer<typeof roleBindingSchema>
export type ResolvedManifest = z.infer<typeof resolvedManifestSchema>

export class ManifestValidationError extends Error {
  readonly name = 'ManifestValidationError'
  readonly code = 'INVALID_MANIFEST'

  constructor(message: string, readonly issues: readonly z.core.$ZodIssue[]) {
    super(message)
  }
}

export function parseResolvedManifest(value: unknown): ResolvedManifest {
  const parsed = resolvedManifestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ManifestValidationError(formatIssues(parsed.error.issues), parsed.error.issues)
  }
  return parsed.data
}

export function hashResolvedManifest(value: unknown): string {
  return sha256(canonicalJson(parseResolvedManifest(value)))
}

function uniqueIndex<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
): Map<string, T> {
  const index = new Map<string, T>()
  for (const [position, value] of values.entries()) {
    const key = keyOf(value)
    if (index.has(key)) issue(context, [...path, position], `duplicate ${label} ${key}`)
    else index.set(key, value)
  }
  return index
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message })
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
}
