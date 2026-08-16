import { join, resolve } from 'node:path'

import { z } from 'zod'
import { parseDocument } from 'yaml'

import { sha256 } from './artifacts.js'
import {
  canonicalJson,
  parseResolvedManifest,
  type ResolvedManifest,
} from './manifest.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const id = z.string().min(1)
const absolutePath = z.string().min(1).refine(value => value.startsWith('/'), 'path must be absolute')
const strings = z.array(z.string().min(1))
const jsonObject = z.record(z.string(), z.json())
const maxGoalRounds = z.number().int().positive()

const component = z.object({
  id,
  version: id,
  sha256: z.string().regex(SHA256_PATTERN),
}).strict()

const route = z.object({
  route_id: id,
  provider: id,
  model: id,
  config: jsonObject,
}).strict()

const roleCommon = {
  role_id: id,
  model_route: route,
  fallback_routes: z.array(route),
  dsh_preset: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  reasoning: z.object({ mode: id, config: jsonObject }).strict(),
  allowed_tools: strings,
} as const

const draftRoleSchema = z.discriminatedUnion('role_kind', [
  z.object({
    ...roleCommon,
    role_kind: z.literal('controller'),
    max_goal_rounds: maxGoalRounds,
  }).strict(),
  z.object({
    ...roleCommon,
    role_kind: z.literal('method'),
    max_goal_rounds: maxGoalRounds,
    lane_id: id,
    prebound_session_id: id.optional(),
  }).strict(),
  z.object({
    ...roleCommon,
    role_kind: z.literal('coder'),
    max_goal_rounds: maxGoalRounds,
    lane_id: id,
    prebound_session_id: id.optional(),
  }).strict(),
  z.object({
    ...roleCommon,
    role_kind: z.literal('preflight_judge'),
    lane_id: id,
    prebound_session_id: id.optional(),
  }).strict(),
  z.object({
    ...roleCommon,
    role_kind: z.literal('postflight_judge'),
    lane_id: id,
    prebound_session_id: id.optional(),
  }).strict(),
  z.object({
    ...roleCommon,
    role_kind: z.literal('ops'),
    max_goal_rounds: maxGoalRounds,
    resource_domain: id,
    prebound_session_id: id.optional(),
  }).strict(),
  z.object({
    ...roleCommon,
    role_kind: z.literal('coordinator'),
    max_goal_rounds: maxGoalRounds,
    prebound_session_id: id.optional(),
  }).strict(),
])

const laneSchema = z.object({
  lane_id: id,
  worktree_path: absolutePath,
  base_ref: id,
  method_role_id: id,
  coder_role_id: id,
  preflight_judge_role_id: id,
  postflight_judge_role_id: id,
  charter: jsonObject,
}).strict()

const provenance = z.string().refine(value => (
  value === 'user'
  || value === 'proposed'
  || value === 'default'
  || value.startsWith('discovered:') && value.length > 'discovered:'.length
  || value.startsWith('inherited:') && value.length > 'inherited:'.length
), 'invalid provenance')

/**
 * Human/Controller-authored machine projection. Runtime identities and hashes are
 * deliberately absent; resolveDraftLabConfig injects only mechanically observed
 * values at commit time.
 */
export const draftLabConfigSchema = z.object({
  schema_version: z.literal(1),
  repository: z.object({ path: absolutePath, base_ref: id }).strict(),
  worktree_root: absolutePath,
  /** Science contracts are kept verbatim and are not interpreted by Runtime. */
  research: jsonObject,
  contract: jsonObject,
  search: z.object({
    search_mode: z.enum(['sequential', 'cohort']),
    /** Omitted keeps the final scientific route choice with the user. */
    research_route_authority: z.enum(['user', 'autolab']).optional(),
    coordinator_enabled: z.boolean(),
    lanes: z.array(laneSchema).min(1),
  }).strict(),
  roles: z.array(draftRoleSchema).min(1),
  execution: z.object({
    runner_adapter: component,
    hosts: z.array(z.object({ host_id: id, runner_target: id }).strict()).min(1),
    gpu_pool: z.array(z.object({ gpu_id: id, host_id: id }).strict()),
    max_parallel_gpu_attempts: z.number().int().nonnegative(),
    run_root: absolutePath.optional(),
    contract: jsonObject,
  }).strict(),
  evidence: z.object({
    artifact_root: absolutePath.optional(),
    contract: jsonObject,
  }).strict(),
  communication: z.object({
    topology: z.enum(['lane_isolated', 'coordinated']),
    acl_revision: z.number().int().nonnegative(),
    coordinator_visibility: z.enum(['disabled', 'runtime_only', 'revealed', 'global']),
    role_permissions: z.array(z.object({
      role_id: id,
      send: z.boolean(),
      receive: z.boolean(),
    }).strict()).min(1),
    text_method_coder_within_lane: z.enum(['allowed', 'blocked']),
    text_pair_blocks: z.array(z.object({
      role_ids: z.tuple([id, id]),
      active_when: z.enum(['before_reveal', 'after_reveal', 'always']),
    }).strict()),
    reveal_policy: z.object({
      initial_state: z.enum(['sealed', 'revealed']),
      trigger: z.enum(['manual', 'cohort_barrier', 'immediate']),
      text_cross_lane_before_reveal: z.enum(['blocked', 'allowed']),
      text_cross_lane_after_reveal: z.enum(['blocked', 'allowed']),
    }).strict(),
    api_recovery: id,
    attempt_recovery: id,
    stop_pause_policy: id,
  }).strict(),
  provenance: z.record(z.string().min(1), provenance),
}).strict()

const resolutionSchema = z.object({
  lab_id: id,
  revision: z.number().int().positive(),
  controller_session_id: id,
  dialogue_head_sha256: z.string().regex(SHA256_PATTERN),
  lab_spec_sha256: z.string().regex(SHA256_PATTERN),
  lab_yaml_sha256: z.string().regex(SHA256_PATTERN),
  lab_directory: absolutePath,
  autolab_plugin_version: id,
  dsh_version: id,
  repository_base_sha: z.string().regex(GIT_SHA_PATTERN),
  lane_base_shas: z.record(z.string().min(1), z.string().regex(GIT_SHA_PATTERN)),
  role_prompt_sha256: z.record(z.string().min(1), z.string().regex(SHA256_PATTERN)),
}).strict()

export type DraftLabConfig = z.infer<typeof draftLabConfigSchema>
export type LabConfigResolution = z.infer<typeof resolutionSchema>

export class LabConfigError extends Error {
  readonly name = 'LabConfigError'
  readonly code = 'INVALID_LAB_CONFIG'

  constructor(message: string) {
    super(message)
  }
}

export function parseDraftLabConfig(value: unknown): DraftLabConfig {
  const parsed = draftLabConfigSchema.safeParse(value)
  if (!parsed.success) throw new LabConfigError(formatIssues(parsed.error.issues))
  return parsed.data
}

export function parseDraftLabYaml(text: string): DraftLabConfig {
  const document = parseDocument(text, {
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    prettyErrors: false,
  })
  if (document.errors.length > 0) {
    throw new LabConfigError(document.errors.map(error => error.message).join('; '))
  }
  return parseDraftLabConfig(document.toJS({ maxAliasCount: 100 }))
}

export function resolveDraftLabConfig(
  configValue: unknown,
  resolutionValue: LabConfigResolution,
): ResolvedManifest {
  const config = parseDraftLabConfig(configValue)
  const resolution = resolutionSchema.parse(resolutionValue)
  const labDirectory = resolve(resolution.lab_directory)
  const revisionName = String(resolution.revision).padStart(6, '0')
  const revisionDirectory = join(labDirectory, 'revisions', revisionName)

  const lanes = config.search.lanes.map(lane => {
    const baseSha = resolution.lane_base_shas[lane.lane_id]
    if (baseSha === undefined) {
      throw new LabConfigError(`missing discovered base SHA for lane ${lane.lane_id}`)
    }
    return {
      lane_id: lane.lane_id,
      worktree_path: resolve(lane.worktree_path),
      base_ref: lane.base_ref,
      base_sha: baseSha,
      method_role_id: lane.method_role_id,
      coder_role_id: lane.coder_role_id,
      preflight_judge_role_id: lane.preflight_judge_role_id,
      postflight_judge_role_id: lane.postflight_judge_role_id,
    }
  })

  const laneCharters = config.search.lanes.map(lane => ({
    lane_id: lane.lane_id,
    charter_sha256: sha256(canonicalJson(lane.charter)),
    content: lane.charter,
  }))

  const roles = config.roles.map(role => {
    const promptHash = resolution.role_prompt_sha256[role.role_id]
    if (promptHash === undefined) {
      throw new LabConfigError(`missing built-in prompt hash for role ${role.role_id}`)
    }
    const common = {
      role_id: role.role_id,
      model_route: role.model_route,
      fallback_routes: role.fallback_routes,
      dsh_preset: role.dsh_preset,
      reasoning: role.reasoning,
      allowed_tools: roleAllowedTools(role.role_kind, role.allowed_tools),
      prompt_sha256: promptHash,
    }
    switch (role.role_kind) {
      case 'controller':
        return {
          ...common,
          role_kind: role.role_kind,
          max_goal_rounds: role.max_goal_rounds,
          prebound_session_id: resolution.controller_session_id,
        }
      case 'method':
      case 'coder': {
        const lane = lanes.find(candidate => candidate.lane_id === role.lane_id)
        if (lane === undefined) throw new LabConfigError(`role ${role.role_id} has unknown lane ${role.lane_id}`)
        return {
          ...common,
          role_kind: role.role_kind,
          max_goal_rounds: role.max_goal_rounds,
          lane_id: role.lane_id,
          worktree_path: lane.worktree_path,
          ...(role.prebound_session_id === undefined ? {} : { prebound_session_id: role.prebound_session_id }),
        }
      }
      case 'preflight_judge':
      case 'postflight_judge': {
        return {
          ...common,
          role_kind: role.role_kind,
          lane_id: role.lane_id,
          ...(role.prebound_session_id === undefined ? {} : { prebound_session_id: role.prebound_session_id }),
        }
      }
      case 'ops':
        return {
          ...common,
          role_kind: role.role_kind,
          max_goal_rounds: role.max_goal_rounds,
          resource_domain: role.resource_domain,
          ...(role.prebound_session_id === undefined ? {} : { prebound_session_id: role.prebound_session_id }),
        }
      case 'coordinator':
        return {
          ...common,
          role_kind: role.role_kind,
          max_goal_rounds: role.max_goal_rounds,
          ...(role.prebound_session_id === undefined ? {} : { prebound_session_id: role.prebound_session_id }),
        }
    }
  })

  const researchRouteAuthority = config.search.research_route_authority ?? 'user'
  const search = {
    search_mode: config.search.search_mode,
    research_route_authority: researchRouteAuthority,
    lane_count: lanes.length,
    coordinator_enabled: config.search.coordinator_enabled,
    lane_charters: laneCharters,
  }
  const campaignContract = {
    research: config.research,
    contract: config.contract,
    search,
    execution: config.execution.contract,
    evidence: config.evidence.contract,
  }
  const artifactRoot = resolve(config.evidence.artifact_root ?? join(labDirectory, 'artifacts'))
  const runRoot = resolve(config.execution.run_root ?? join(labDirectory, 'artifacts', 'runs'))

  return parseResolvedManifest({
    schema_version: 1,
    lab_id: resolution.lab_id,
    source_revision: resolution.revision,
    campaign_contract_sha256: sha256(canonicalJson(campaignContract)),
    anchors: {
      dialogue_head_sha256: resolution.dialogue_head_sha256,
      lab_spec_sha256: resolution.lab_spec_sha256,
      lab_yaml_sha256: resolution.lab_yaml_sha256,
    },
    authority_paths: {
      lab_dir: labDirectory,
      creation_log: join(labDirectory, 'dialogue', 'creation.jsonl'),
      lab_spec: join(revisionDirectory, 'LAB_SPEC.md'),
      lab_yaml: join(revisionDirectory, 'lab.yaml'),
      resolved_manifest: join(revisionDirectory, 'RESOLVED_MANIFEST.json'),
      fact_set: join(labDirectory, 'artifacts', 'facts.json'),
      evidence_index: join(labDirectory, 'artifacts', 'evidence.json'),
      assignment_root: join(labDirectory, 'assignments'),
      worktree_root: resolve(config.worktree_root),
    },
    versions: {
      autolab_plugin: resolution.autolab_plugin_version,
      dsh: resolution.dsh_version,
    },
    repository: {
      path: resolve(config.repository.path),
      base_ref: config.repository.base_ref,
      base_sha: resolution.repository_base_sha,
    },
    research: config.research,
    contract: config.contract,
    search,
    lanes,
    roles,
    execution: { ...config.execution, run_root: runRoot },
    evidence: { ...config.evidence, artifact_root: artifactRoot },
    communication: {
      ...config.communication,
      controller_visibility: 'global',
    },
    provenance: config.search.research_route_authority === undefined
      && config.provenance['/search/research_route_authority'] === undefined
      ? {
          ...config.provenance,
          '/search/research_route_authority': 'default',
        }
      : config.provenance,
  })
}

function roleAllowedTools(
  roleKind: z.infer<typeof draftRoleSchema>['role_kind'],
  configured: readonly string[],
): string[] {
  const required = roleKind === 'method'
    ? 'SubmitMethodForPreflightReview'
    : roleKind === 'preflight_judge'
      ? 'SubmitPreflightVerdict'
      : roleKind === 'postflight_judge'
        ? 'SubmitPostflightResult'
      : roleKind === 'coder'
        ? 'SubmitCoderImplementation'
        : roleKind === 'ops' || roleKind === 'coordinator'
          ? 'SubmitAutoLabRoleResult'
        : undefined
  return required === undefined || configured.includes(required)
    ? [...configured]
    : [...configured, required]
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
}
