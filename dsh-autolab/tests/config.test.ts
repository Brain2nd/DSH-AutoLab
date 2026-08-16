import { describe, expect, it } from 'vitest'

import {
  parseDraftLabYaml,
  resolveDraftLabConfig,
  type DraftLabConfig,
} from '../src/config.js'

const hash = (digit: string): string => digit.repeat(64)
const gitSha = (digit: string): string => digit.repeat(40)

function component(name: string, digit: string) {
  return { id: name, version: '1', sha256: hash(digit) }
}

function commonRole(roleId: string) {
  return {
    role_id: roleId,
    model_route: { route_id: `${roleId}-route`, provider: 'p', model: 'm', config: {} },
    fallback_routes: [],
    dsh_preset: 'workspace-write' as const,
    reasoning: { mode: 'high', config: {} },
    allowed_tools: ['read'],
  }
}

function draft(laneCount = 2, gpuCount = 1, coordinatorEnabled = false): DraftLabConfig {
  const lanes: DraftLabConfig['search']['lanes'] = Array.from(
    { length: laneCount },
    (_, index) => {
      const suffix = String.fromCharCode(97 + index)
      const laneId = `lane-${suffix}`
      return {
        lane_id: laneId,
        worktree_path: `/tmp/worktrees/${laneId}`,
        base_ref: 'main',
        method_role_id: `${laneId}-method`,
        coder_role_id: `${laneId}-coder`,
        preflight_judge_role_id: `${laneId}-preflight`,
        postflight_judge_role_id: `${laneId}-postflight`,
        charter: {
          direction: `direction-${suffix}`,
          inherited_notes: ['fact-1'],
          domain_payload: { axis: index, enabled: true },
        },
      }
    },
  )
  const laneRoles: DraftLabConfig['roles'] = lanes.flatMap(lane => [
    {
      ...commonRole(lane.method_role_id),
      role_kind: 'method' as const,
      max_goal_rounds: 64,
      lane_id: lane.lane_id,
    },
    {
      ...commonRole(lane.coder_role_id),
      role_kind: 'coder' as const,
      max_goal_rounds: 48,
      lane_id: lane.lane_id,
    },
    {
      ...commonRole(lane.preflight_judge_role_id),
      role_kind: 'preflight_judge' as const,
      lane_id: lane.lane_id,
    },
    {
      ...commonRole(lane.postflight_judge_role_id),
      role_kind: 'postflight_judge' as const,
      lane_id: lane.lane_id,
    },
  ])
  const roles: DraftLabConfig['roles'] = [
    { ...commonRole('controller'), role_kind: 'controller', max_goal_rounds: 64 },
    {
      ...commonRole('ops'),
      role_kind: 'ops',
      max_goal_rounds: 24,
      resource_domain: 'local',
    },
    ...laneRoles,
  ]
  if (coordinatorEnabled) {
    roles.push({
      ...commonRole('coordinator'),
      role_kind: 'coordinator',
      max_goal_rounds: 32,
    })
  }

  return {
    schema_version: 1,
    repository: { path: '/tmp/repository', base_ref: 'main' },
    worktree_root: '/tmp/worktrees',
    research: {
      user_direction: 'Improve the requested mechanism.',
      comparison_axes: ['method', 'feature'],
      domain_payload: { may_be_nested: true, threshold: 0.25 },
    },
    contract: {
      immutable_rules: ['Keep the public interface unchanged.'],
      task_specific: { mutation_scope: ['src/model.ts'] },
    },
    search: {
      search_mode: 'cohort',
      research_route_authority: 'user',
      coordinator_enabled: coordinatorEnabled,
      lanes,
    },
    roles,
    execution: {
      runner_adapter: component('runner', '1'),
      hosts: [{ host_id: 'local', runner_target: 'local' }],
      gpu_pool: Array.from(
        { length: gpuCount },
        (_, index) => ({ gpu_id: `GPU-${index}`, host_id: 'local' }),
      ),
      max_parallel_gpu_attempts: gpuCount,
      contract: {
        launch_owner: 'coder-session',
        domain_options: { command: ['python', 'run.py'], resume: 'lab-defined' },
      },
    },
    evidence: {
      contract: {
        interpretation_owner: 'postflight-session',
        materials: ['raw-result', 'run-log'],
        domain_options: { comparison: 'lab-defined' },
      },
    },
    communication: {
      topology: 'lane_isolated',
      acl_revision: 1,
      coordinator_visibility: coordinatorEnabled ? 'runtime_only' : 'disabled',
      role_permissions: roles.map(role => ({ role_id: role.role_id, send: true, receive: true })),
      text_method_coder_within_lane: 'allowed',
      text_pair_blocks: lanes.length < 2
        ? []
        : [{
            role_ids: [lanes[0]!.method_role_id, lanes[1]!.method_role_id],
            active_when: 'before_reveal',
          }],
      reveal_policy: {
        initial_state: 'sealed',
        trigger: 'manual',
        text_cross_lane_before_reveal: 'blocked',
        text_cross_lane_after_reveal: 'allowed',
      },
      api_recovery: 'event-driven terminal recovery',
      attempt_recovery: 'adopt exact process identity',
      stop_pause_policy: 'Controller owns Lab stop state',
    },
    provenance: {
      '/research/user_direction': 'user',
      '/search/research_route_authority': 'user',
    },
  }
}

function resolution(config: DraftLabConfig) {
  return {
    lab_id: 'lab-20260815-120000-89abcdef',
    revision: 1,
    controller_session_id: 'controller-session',
    dialogue_head_sha256: hash('a'),
    lab_spec_sha256: hash('b'),
    lab_yaml_sha256: hash('c'),
    lab_directory: '/tmp/autolab/labs/example',
    autolab_plugin_version: '0.1.0',
    dsh_version: '0.1.0-rc.6',
    repository_base_sha: gitSha('d'),
    lane_base_shas: Object.fromEntries(
      config.search.lanes.map(lane => [lane.lane_id, gitSha('d')]),
    ),
    role_prompt_sha256: Object.fromEntries(
      config.roles.map((role, index) => [role.role_id, hash((index % 10).toString())]),
    ),
  }
}

describe('DraftLabConfig resolution', () => {
  it('preserves opaque contracts while deriving only Runtime identities and paths', () => {
    const config = draft()
    const manifest = resolveDraftLabConfig(config, resolution(config))

    expect(manifest.research).toEqual(config.research)
    expect(manifest.contract).toEqual(config.contract)
    expect(manifest.execution.contract).toEqual(config.execution.contract)
    expect(manifest.evidence.contract).toEqual(config.evidence.contract)
    expect(manifest.search.lane_charters.map(charter => charter.content))
      .toEqual(config.search.lanes.map(lane => lane.charter))
    expect(manifest).toMatchObject({
      lab_id: 'lab-20260815-120000-89abcdef',
      source_revision: 1,
      anchors: { dialogue_head_sha256: hash('a') },
      authority_paths: {
        creation_log: '/tmp/autolab/labs/example/dialogue/creation.jsonl',
        resolved_manifest: '/tmp/autolab/labs/example/revisions/000001/RESOLVED_MANIFEST.json',
      },
      search: { research_route_authority: 'user', lane_count: 2 },
      execution: { run_root: '/tmp/autolab/labs/example/artifacts/runs' },
      evidence: { artifact_root: '/tmp/autolab/labs/example/artifacts' },
    })
    expect(manifest.roles.find(role => role.role_kind === 'controller')).toMatchObject({
      prebound_session_id: 'controller-session',
    })
    expect(manifest.roles.find(role => role.role_kind === 'method')?.allowed_tools)
      .toContain('SubmitMethodForPreflightReview')
    expect(manifest.roles.find(role => role.role_kind === 'coder')?.allowed_tools)
      .toContain('SubmitCoderImplementation')
    expect(manifest.roles.find(role => role.role_kind === 'preflight_judge')?.allowed_tools)
      .toContain('SubmitPreflightVerdict')
    expect(manifest.roles.find(role => role.role_kind === 'postflight_judge')?.allowed_tools)
      .toContain('SubmitPostflightResult')
    expect(manifest.roles.find(role => role.role_kind === 'ops')?.allowed_tools)
      .toContain('SubmitAutoLabRoleResult')
  })

  it('keeps route choice with the user unless the Lab explicitly delegates it', () => {
    const omitted = draft()
    delete omitted.search.research_route_authority
    delete omitted.provenance['/search/research_route_authority']
    const defaulted = resolveDraftLabConfig(omitted, resolution(omitted))
    expect(defaulted.search.research_route_authority).toBe('user')
    expect(defaulted.provenance['/search/research_route_authority']).toBe('default')

    const delegated = draft()
    delegated.search.research_route_authority = 'autolab'
    const resolved = resolveDraftLabConfig(delegated, resolution(delegated))
    expect(resolved.search.research_route_authority).toBe('autolab')
    expect(resolved.provenance['/search/research_route_authority']).toBe('user')
  })

  it('accepts arbitrary JSON inside each Lab-owned contract without widening outer schema', () => {
    const config = draft()
    config.research = { custom_scalar: 7, custom_array: [null, true, { x: 'y' }] }
    config.contract = { custom_object: { any_domain_key: ['a', 'b'] } }
    config.execution.contract = { custom_launch_shape: { width: 17 } }
    config.evidence.contract = { custom_interpretation: { owner: 'named-session' } }

    const manifest = resolveDraftLabConfig(config, resolution(config))
    expect(manifest.research).toEqual(config.research)
    expect(manifest.contract).toEqual(config.contract)
    expect(manifest.execution.contract).toEqual(config.execution.contract)
    expect(manifest.evidence.contract).toEqual(config.evidence.contract)

    const widened = { ...config, unknown_runtime_field: true }
    expect(() => resolveDraftLabConfig(widened, resolution(config))).toThrow(/Unrecognized key/u)
  })

  it('allows more Method/Coder pairs than GPUs', () => {
    const config = draft(3, 1)
    const manifest = resolveDraftLabConfig(config, resolution(config))
    expect(manifest.search.lane_count).toBe(3)
    expect(manifest.execution.gpu_pool).toHaveLength(1)
    expect(manifest.roles.filter(role => role.role_kind === 'method')).toHaveLength(3)
  })

  it('enforces current role, Lane, Coordinator, and ACL identities', () => {
    const missingPermission = draft()
    missingPermission.communication.role_permissions.pop()
    expect(() => resolveDraftLabConfig(missingPermission, resolution(missingPermission)))
      .toThrow(/missing communication permission/u)

    const wrongLaneRole = draft()
    wrongLaneRole.search.lanes[0]!.coder_role_id = wrongLaneRole.search.lanes[0]!.method_role_id
    expect(() => resolveDraftLabConfig(wrongLaneRole, resolution(wrongLaneRole)))
      .toThrow(/four independent roles|must be the coder role/u)

    const coordinator = draft(2, 1, true)
    expect(resolveDraftLabConfig(coordinator, resolution(coordinator)).roles)
      .toContainEqual(expect.objectContaining({ role_kind: 'coordinator', max_goal_rounds: 32 }))
  })

  it('rejects missing mechanical discoveries and invalid Goal budgets', () => {
    const config = draft()
    const missing = resolution(config)
    delete missing.lane_base_shas['lane-b']
    expect(() => resolveDraftLabConfig(config, missing)).toThrow(/missing discovered base SHA/u)

    const invalid = draft()
    const method = invalid.roles.find(role => role.role_kind === 'method')!
    if (method.role_kind !== 'method') throw new Error('fixture role mismatch')
    method.max_goal_rounds = 0
    expect(() => resolveDraftLabConfig(invalid, resolution(invalid)))
      .toThrow(/max_goal_rounds/u)
  })

  it('is stable and parses ordinary YAML while rejecting duplicate keys', () => {
    const config = draft()
    expect(resolveDraftLabConfig(config, resolution(config)))
      .toEqual(resolveDraftLabConfig(structuredClone(config), resolution(config)))
    expect(parseDraftLabYaml(JSON.stringify(config))).toEqual(config)
    expect(() => parseDraftLabYaml('schema_version: 1\nschema_version: 1\n'))
      .toThrow(/Map keys must be unique/u)
  })
})
