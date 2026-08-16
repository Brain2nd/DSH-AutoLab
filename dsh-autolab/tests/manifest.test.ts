import { describe, expect, it } from 'vitest'

import {
  canonicalJson,
  hashResolvedManifest,
  parseResolvedManifest,
  type ResolvedManifest,
} from '../src/manifest.js'
import { sha256 } from '../src/integrity.js'

const hash = (digit: string): string => digit.repeat(64)
const gitSha = (digit: string): string => digit.repeat(40)

function route(role: string) {
  return {
    route_id: `route-${role}`,
    provider: 'provider-a',
    model: 'model-a',
    config: {},
  }
}

function commonRole(roleId: string, promptDigit: string) {
  return {
    role_id: roleId,
    model_route: route(roleId),
    fallback_routes: [],
    dsh_preset: 'workspace-write' as const,
    reasoning: { mode: 'high', config: {} },
    allowed_tools: ['read', 'exec'],
    prompt_sha256: hash(promptDigit),
  }
}

function charter(laneId: string, direction: string) {
  const content = {
    direction,
    inherited_notes: ['fact-1'],
    domain_payload: { lane: laneId, compare_after_reveal: true },
  }
  return {
    lane_id: laneId,
    charter_sha256: sha256(canonicalJson(content)),
    content,
  }
}

export function validManifest(): ResolvedManifest {
  const roles = [
    {
      ...commonRole('controller', 'a'),
      role_kind: 'controller' as const,
      max_goal_rounds: 64,
      prebound_session_id: 'session-controller',
    },
    {
      ...commonRole('ops', 'b'),
      role_kind: 'ops' as const,
      max_goal_rounds: 24,
      resource_domain: 'local',
    },
    {
      ...commonRole('lane-a-method', 'c'),
      role_kind: 'method' as const,
      max_goal_rounds: 64,
      lane_id: 'lane-a',
      worktree_path: '/tmp/autolab-worktrees/lane-a',
    },
    {
      ...commonRole('lane-a-coder', 'd'),
      role_kind: 'coder' as const,
      max_goal_rounds: 48,
      lane_id: 'lane-a',
      worktree_path: '/tmp/autolab-worktrees/lane-a',
    },
    {
      ...commonRole('lane-a-preflight', 'e'),
      role_kind: 'preflight_judge' as const,
      lane_id: 'lane-a',
    },
    {
      ...commonRole('lane-a-postflight', 'f'),
      role_kind: 'postflight_judge' as const,
      lane_id: 'lane-a',
    },
    {
      ...commonRole('lane-b-method', '3'),
      role_kind: 'method' as const,
      max_goal_rounds: 64,
      lane_id: 'lane-b',
      worktree_path: '/tmp/autolab-worktrees/lane-b',
    },
    {
      ...commonRole('lane-b-coder', '4'),
      role_kind: 'coder' as const,
      max_goal_rounds: 48,
      lane_id: 'lane-b',
      worktree_path: '/tmp/autolab-worktrees/lane-b',
    },
    {
      ...commonRole('lane-b-preflight', '5'),
      role_kind: 'preflight_judge' as const,
      lane_id: 'lane-b',
    },
    {
      ...commonRole('lane-b-postflight', '6'),
      role_kind: 'postflight_judge' as const,
      lane_id: 'lane-b',
    },
  ]

  return parseResolvedManifest({
    schema_version: 1,
    lab_id: 'lab-20260815-120000-89abcdef',
    source_revision: 1,
    campaign_contract_sha256: hash('9'),
    anchors: {
      dialogue_head_sha256: hash('a'),
      lab_spec_sha256: hash('b'),
      lab_yaml_sha256: hash('c'),
    },
    authority_paths: {
      lab_dir: '/tmp/autolab/labs/example',
      creation_log: '/tmp/autolab/labs/example/dialogue/creation.jsonl',
      lab_spec: '/tmp/autolab/labs/example/revisions/000001/LAB_SPEC.md',
      lab_yaml: '/tmp/autolab/labs/example/revisions/000001/lab.yaml',
      resolved_manifest: '/tmp/autolab/labs/example/revisions/000001/RESOLVED_MANIFEST.json',
      fact_set: '/tmp/autolab/labs/example/artifacts/facts.json',
      evidence_index: '/tmp/autolab/labs/example/artifacts/evidence.json',
      assignment_root: '/tmp/autolab/labs/example/assignments',
      worktree_root: '/tmp/autolab-worktrees',
    },
    versions: { autolab_plugin: '0.1.0', dsh: '0.1.0-rc.6' },
    repository: {
      path: '/tmp/repository',
      base_ref: 'refs/heads/main',
      base_sha: gitSha('a'),
    },
    research: {
      user_direction: 'Improve the requested mechanism.',
      comparison_axes: ['method', 'feature'],
      domain_payload: { custom_number: 17 },
    },
    contract: {
      immutable_rules: ['Keep the public interface unchanged.'],
      domain_payload: { mutation_scope: ['src/model.ts'] },
    },
    search: {
      search_mode: 'cohort',
      research_route_authority: 'user',
      lane_count: 2,
      coordinator_enabled: false,
      lane_charters: [
        charter('lane-a', 'direction-a'),
        charter('lane-b', 'direction-b'),
      ],
    },
    lanes: [
      {
        lane_id: 'lane-a',
        worktree_path: '/tmp/autolab-worktrees/lane-a',
        base_ref: 'refs/heads/main',
        base_sha: gitSha('a'),
        method_role_id: 'lane-a-method',
        coder_role_id: 'lane-a-coder',
        preflight_judge_role_id: 'lane-a-preflight',
        postflight_judge_role_id: 'lane-a-postflight',
      },
      {
        lane_id: 'lane-b',
        worktree_path: '/tmp/autolab-worktrees/lane-b',
        base_ref: 'refs/heads/main',
        base_sha: gitSha('a'),
        method_role_id: 'lane-b-method',
        coder_role_id: 'lane-b-coder',
        preflight_judge_role_id: 'lane-b-preflight',
        postflight_judge_role_id: 'lane-b-postflight',
      },
    ],
    roles,
    execution: {
      runner_adapter: { id: 'local-runner', version: '1', sha256: hash('d') },
      hosts: [{ host_id: 'local', runner_target: 'local' }],
      gpu_pool: [{ gpu_id: 'GPU-0', host_id: 'local' }],
      max_parallel_gpu_attempts: 1,
      run_root: '/tmp/autolab-runs',
      contract: {
        launch_owner: 'coder-session',
        domain_options: { argv: ['python', 'run.py'], resume: 'lab-defined' },
      },
    },
    evidence: {
      artifact_root: '/tmp/autolab/labs/example/artifacts',
      contract: {
        interpretation_owner: 'postflight-session',
        materials: ['raw-result', 'run-log'],
        domain_options: { comparison: 'lab-defined' },
      },
    },
    communication: {
      topology: 'lane_isolated',
      acl_revision: 1,
      controller_visibility: 'global',
      coordinator_visibility: 'disabled',
      role_permissions: roles.map(role => ({ role_id: role.role_id, send: true, receive: true })),
      text_method_coder_within_lane: 'allowed',
      text_pair_blocks: [
        { role_ids: ['lane-a-method', 'lane-b-method'], active_when: 'before_reveal' },
        { role_ids: ['lane-a-coder', 'lane-b-coder'], active_when: 'before_reveal' },
      ],
      reveal_policy: {
        initial_state: 'sealed',
        trigger: 'cohort_barrier',
        text_cross_lane_before_reveal: 'blocked',
        text_cross_lane_after_reveal: 'allowed',
      },
      api_recovery: 'event-driven terminal recovery',
      attempt_recovery: 'adopt proven process identity',
      stop_pause_policy: 'Controller owns Lab stop state',
    },
    provenance: {
      '/research/user_direction': 'user',
      '/repository/base_sha': 'discovered:/tmp/repository/.git/HEAD',
    },
  })
}

describe('ResolvedManifest v1', () => {
  it('preserves opaque Lab contracts alongside stable Runtime identities', () => {
    const manifest = validManifest()
    expect(manifest.schema_version).toBe(1)
    expect(manifest.research).toEqual({
      user_direction: 'Improve the requested mechanism.',
      comparison_axes: ['method', 'feature'],
      domain_payload: { custom_number: 17 },
    })
    expect(manifest.contract).toEqual({
      immutable_rules: ['Keep the public interface unchanged.'],
      domain_payload: { mutation_scope: ['src/model.ts'] },
    })
    expect(manifest.execution.contract).toEqual({
      launch_owner: 'coder-session',
      domain_options: { argv: ['python', 'run.py'], resume: 'lab-defined' },
    })
    expect(manifest.evidence.contract).toEqual({
      interpretation_owner: 'postflight-session',
      materials: ['raw-result', 'run-log'],
      domain_options: { comparison: 'lab-defined' },
    })
    expect(manifest.search).toMatchObject({
      search_mode: 'cohort',
      research_route_authority: 'user',
      lane_count: 2,
    })
    expect(manifest.roles.find(role => role.role_kind === 'controller')).toMatchObject({
      prebound_session_id: 'session-controller',
    })
    expect(manifest.communication).toMatchObject({
      controller_visibility: 'global',
      topology: 'lane_isolated',
      reveal_policy: { text_cross_lane_before_reveal: 'blocked' },
    })
  })

  it('accepts a legacy v1 manifest with no route delegation and does not invent authority', () => {
    const legacy = structuredClone(validManifest())
    delete legacy.search.research_route_authority
    expect(parseResolvedManifest(legacy).search.research_route_authority).toBeUndefined()
  })

  it('allows arbitrary JSON within contracts while rejecting unknown Runtime fields', () => {
    const manifest = structuredClone(validManifest())
    manifest.research = { any_domain_shape: [null, true, 3, { nested: 'value' }] }
    manifest.contract = { custom_rules: { alpha: ['x', 'y'] } }
    manifest.execution.contract = { custom_launch: { dimensions: [1, 2, 3] } }
    manifest.evidence.contract = { custom_reading: { handled_by: 'named-session' } }
    const parsed = parseResolvedManifest(manifest)
    expect(parsed.research).toEqual(manifest.research)
    expect(parsed.contract).toEqual(manifest.contract)
    expect(parsed.execution.contract).toEqual(manifest.execution.contract)
    expect(parsed.evidence.contract).toEqual(manifest.evidence.contract)

    const widened = { ...manifest, confidence: 0.99 }
    expect(() => parseResolvedManifest(widened)).toThrowError(
      expect.objectContaining({ code: 'INVALID_MANIFEST' }),
    )
  })

  it('requires positive Goal budgets only on roles with durable Goals', () => {
    const missing = structuredClone(validManifest())
    const method = missing.roles.find(role => role.role_kind === 'method')!
    if (method.role_kind !== 'method') throw new Error('fixture role mismatch')
    delete (method as Partial<typeof method>).max_goal_rounds
    expect(() => parseResolvedManifest(missing)).toThrow(/max_goal_rounds/u)

    const controllerBudget = structuredClone(validManifest())
    const controller = controllerBudget.roles.find(role => role.role_kind === 'controller')!
    delete (controller as Partial<typeof controller>).max_goal_rounds
    expect(() => parseResolvedManifest(controllerBudget)).toThrow(/max_goal_rounds/u)

    const judgeBudget = structuredClone(validManifest())
    const judge = judgeBudget.roles.find(role => role.role_kind === 'postflight_judge')!
    Object.assign(judge, { max_goal_rounds: 8 })
    expect(() => parseResolvedManifest(judgeBudget)).toThrow(/max_goal_rounds/u)
  })

  it('requires one independent four-role set and one worktree per Lane', () => {
    const shared = structuredClone(validManifest())
    shared.lanes[1]!.worktree_path = shared.lanes[0]!.worktree_path
    expect(() => parseResolvedManifest(shared)).toThrow(/share worktree/u)

    const mismatched = structuredClone(validManifest())
    const coder = mismatched.roles.find(role => role.role_id === 'lane-a-coder')!
    if (coder.role_kind !== 'coder') throw new Error('fixture role mismatch')
    coder.worktree_path = '/tmp/autolab-worktrees/not-lane-a'
    expect(() => parseResolvedManifest(mismatched)).toThrow(/must use its lane worktree/u)

    const reused = structuredClone(validManifest())
    reused.lanes[0]!.postflight_judge_role_id = reused.lanes[0]!.preflight_judge_role_id
    expect(() => parseResolvedManifest(reused)).toThrow(/four independent roles/u)

    const wrongKind = structuredClone(validManifest())
    wrongKind.lanes[0]!.coder_role_id = 'lane-a-preflight'
    expect(() => parseResolvedManifest(wrongKind)).toThrow(/must be the coder role/u)
  })

  it('enforces complete ACL identity and keeps Controller globally reachable', () => {
    const missing = structuredClone(validManifest())
    missing.communication.role_permissions.pop()
    expect(() => parseResolvedManifest(missing)).toThrow(/missing communication permission/u)

    const disabledController = structuredClone(validManifest())
    const permission = disabledController.communication.role_permissions.find(
      value => value.role_id === 'controller',
    )!
    permission.send = false
    expect(() => parseResolvedManifest(disabledController)).toThrow(/Controller send and receive/u)

    const hiddenController = structuredClone(validManifest())
    hiddenController.communication.text_pair_blocks.push({
      role_ids: ['controller', 'lane-a-method'],
      active_when: 'always',
    })
    expect(() => parseResolvedManifest(hiddenController)).toThrow(/Controller cannot be hidden/u)

    const openBeforeReveal = structuredClone(validManifest())
    openBeforeReveal.communication.reveal_policy.text_cross_lane_before_reveal = 'allowed'
    expect(() => parseResolvedManifest(openBeforeReveal)).toThrow(/blocked before reveal/u)
  })

  it('keeps Session ownership unique and Coordinator identity explicit', () => {
    const sharedSession = structuredClone(validManifest())
    const method = sharedSession.roles.find(role => role.role_id === 'lane-a-method')!
    const coder = sharedSession.roles.find(role => role.role_id === 'lane-a-coder')!
    method.prebound_session_id = 'shared-session'
    coder.prebound_session_id = 'shared-session'
    expect(() => parseResolvedManifest(sharedSession)).toThrow(/reuse prebound SessionId/u)

    const missingCoordinator = structuredClone(validManifest())
    missingCoordinator.search.coordinator_enabled = true
    missingCoordinator.communication.coordinator_visibility = 'runtime_only'
    expect(() => parseResolvedManifest(missingCoordinator)).toThrow(/requires exactly one Coordinator/u)

    const coordinated = structuredClone(validManifest())
    const coordinator = {
      ...commonRole('coordinator', '7'),
      role_kind: 'coordinator' as const,
      max_goal_rounds: 32,
    }
    coordinated.search.coordinator_enabled = true
    coordinated.communication.coordinator_visibility = 'runtime_only'
    coordinated.roles.push(coordinator)
    coordinated.communication.role_permissions.push({
      role_id: coordinator.role_id,
      send: true,
      receive: true,
    })
    expect(parseResolvedManifest(coordinated).roles)
      .toContainEqual(expect.objectContaining({ role_kind: 'coordinator' }))
  })

  it('does not couple Lane width to GPU count and checks only GPU/host identity', () => {
    const noGpu = structuredClone(validManifest())
    noGpu.execution.gpu_pool = []
    noGpu.execution.max_parallel_gpu_attempts = 0
    noGpu.provenance = {}
    expect(parseResolvedManifest(noGpu).search.lane_count).toBe(2)

    const unknownHost = structuredClone(validManifest())
    unknownHost.execution.gpu_pool[0]!.host_id = 'missing-host'
    expect(() => parseResolvedManifest(unknownHost)).toThrow(/unknown host/u)
  })

  it('hashes canonical JSON independently of object insertion order', () => {
    expect(canonicalJson({ z: 1, a: { d: 4, b: 2 } })).toBe('{"a":{"b":2,"d":4},"z":1}')
    const manifest = validManifest()
    expect(hashResolvedManifest(manifest)).toMatch(/^[0-9a-f]{64}$/u)
    expect(hashResolvedManifest({ ...manifest })).toBe(hashResolvedManifest(manifest))
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/NaN/u)
  })
})
