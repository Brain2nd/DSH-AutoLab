import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import type { StoredRoleBinding } from '../src/binding.js'
import {
  compileCommunicationAcl,
  reconcileCommunicationAcl,
  type CommunicationAclMessaging,
  type CommunicationRoleSession,
} from '../src/communication.js'
import { resolveDraftLabConfig } from '../src/config.js'
import {
  hashResolvedManifest,
  type ResolvedManifest,
  type RoleBinding,
} from '../src/manifest.js'

const hash = (value: string): string => value.repeat(64).slice(0, 64)
const gitSha = (value: string): string => value.repeat(40).slice(0, 40)

describe('Manifest-driven communication ACL', () => {
  it('maps directions to exact root Sessions, keeps Controller global, and reconciles idempotently', async () => {
    const manifest = fixtureManifest()
    const roleSessions = fixtureRoleSessions(manifest)
    const messaging = new FakeMessaging(roleSessions)
    // This role crosses both phases: send tightens while receive widens.
    messaging.seedPermission('session-lane-a-coder', true, false)
    messaging.seedBlock('session-controller', 'session-lane-a-method')
    messaging.seedBlock('session-lane-a-method', 'session-ops')

    const result = await reconcileCommunicationAcl({
      manifest,
      revealState: 'sealed',
      roleSessions,
      messaging,
    })

    expect(messaging.permission('session-lane-a-coder')).toEqual({
      sendAllowed: false,
      receiveAllowed: true,
    })
    expect(messaging.permission('session-lane-b-postflight')).toEqual({
      sendAllowed: true,
      receiveAllowed: false,
    })
    expect(messaging.wasPermissionSetOn(exactAgent(roleSessions, 'lane-a-coder'))).toBe(true)

    expect(messaging.isBlocked('session-controller', 'session-lane-a-method')).toBe(false)
    expect(result.plan.textPairs
      .filter(pair => pair.firstRoleId === 'controller' || pair.secondRoleId === 'controller')
      .every(pair => !pair.blocked)).toBe(true)

    // Cross-Lane policy covers Judge roles as well as Method/Coder, preventing
    // an unrevealed result from being relayed through another Lane's Judge.
    expect(messaging.isBlocked('session-lane-a-method', 'session-lane-b-coder')).toBe(true)
    expect(messaging.isBlocked('session-lane-a-postflight', 'session-lane-b-preflight')).toBe(true)
    expect(messaging.isBlocked('session-lane-a-method', 'session-lane-a-coder')).toBe(true)
    expect(messaging.isBlocked('session-lane-a-method', 'session-ops')).toBe(false)
    expect(messaging.isBlocked('session-lane-b-coder', 'session-ops')).toBe(true)

    messaging.clearMutationCalls()
    await reconcileCommunicationAcl({ manifest, revealState: 'sealed', roleSessions, messaging })
    expect(messaging.mutationCalls).toEqual([])
  })

  it('switches before/after reveal text edges without touching the always block', async () => {
    const manifest = fixtureManifest()
    const roleSessions = fixtureRoleSessions(manifest)
    const messaging = new FakeMessaging(roleSessions)
    await reconcileCommunicationAcl({ manifest, revealState: 'sealed', roleSessions, messaging })

    messaging.clearMutationCalls()
    const revealed = await reconcileCommunicationAcl({
      manifest,
      revealState: 'revealed',
      roleSessions,
      messaging,
    })

    expect(findPair(revealed.plan, 'lane-a-method', 'lane-b-method')?.blocked).toBe(false)
    expect(findPair(revealed.plan, 'lane-a-method', 'lane-a-coder')?.blocked).toBe(false)
    expect(findPair(revealed.plan, 'lane-a-method', 'ops')?.blocked).toBe(true)
    expect(findPair(revealed.plan, 'lane-b-coder', 'ops')?.blocked).toBe(true)
    expect(messaging.isBlocked('session-lane-a-method', 'session-lane-b-method')).toBe(false)
    expect(messaging.isBlocked('session-lane-a-method', 'session-lane-a-coder')).toBe(false)
    expect(messaging.isBlocked('session-lane-a-method', 'session-ops')).toBe(true)
    expect(messaging.isBlocked('session-lane-b-coder', 'session-ops')).toBe(true)
  })

  it('reconciles symmetric Controller edges from workers during unattended recovery', async () => {
    const manifest = fixtureManifest()
    const roleSessions = fixtureRoleSessions(manifest)
    const messaging = new FakeMessaging(roleSessions)
    messaging.seedBlock('session-controller', 'session-lane-a-method')

    await reconcileCommunicationAcl({
      manifest,
      revealState: 'sealed',
      roleSessions,
      messaging,
      controllerOffline: true,
    })

    expect(messaging.isBlocked('session-controller', 'session-lane-a-method')).toBe(false)
    expect(messaging.allCalls.some(call => call.endsWith(':session-controller'))).toBe(false)
    expect(messaging.mutationCalls).toContain(
      'unblock:session-lane-a-method:session-controller',
    )
  })

  it('compiles the within-Lane Method/Coder switch directly from the committed Manifest', () => {
    const manifest = fixtureManifest()
    manifest.communication.text_method_coder_within_lane = 'blocked'
    // Recreate receipts because the committed Manifest hash is the authority.
    const roleSessions = fixtureRoleSessions(manifest)
    const plan = compileCommunicationAcl({ manifest, revealState: 'revealed', roleSessions })
    expect(findPair(plan, 'lane-a-method', 'lane-a-coder')?.blocked).toBe(true)
    expect(findPair(plan, 'lane-b-method', 'lane-b-coder')?.blocked).toBe(true)
  })

  it('rejects an inexact role-to-Session binding before reading or mutating ACL state', async () => {
    const manifest = fixtureManifest()
    const roleSessions = fixtureRoleSessions(manifest)
    const method = roleSessions.find(value => value.roleId === 'lane-a-method')!
    const wrong: CommunicationRoleSession = {
      ...method,
      agent: agent('session-wrong'),
    }
    const changed = roleSessions.map(value => value === method ? wrong : value)
    const messaging = new FakeMessaging(changed)

    await expect(reconcileCommunicationAcl({
      manifest,
      revealState: 'sealed',
      roleSessions: changed,
      messaging,
    })).rejects.toMatchObject({ code: 'ROLE_BINDING_MISMATCH' })
    expect(messaging.allCalls).toEqual([])
  })

  it('keeps the default complete-role contract strict', async () => {
    const manifest = fixtureManifest()
    const complete = fixtureRoleSessions(manifest)
    const partial = complete.filter(value => value.roleId !== 'lane-b-coder')
    const messaging = new FakeMessaging(complete)

    await expect(reconcileCommunicationAcl({
      manifest,
      revealState: 'sealed',
      roleSessions: partial,
      messaging,
    })).rejects.toMatchObject({ code: 'ROLE_BINDING_MISMATCH' })
    expect(messaging.allCalls).toEqual([])
  })

  it('quarantines a live unattached role before widening an exact partial ACL', async () => {
    const manifest = fixtureManifest()
    const complete = fixtureRoleSessions(manifest)
    const partial = complete.filter(value => (
      value.roleId === 'controller' || value.roleId === 'lane-a-method'
    ))
    const quarantined = exactAgent(complete, 'lane-a-coder')
    const messaging = new FakeMessaging(complete)
    messaging.seedPermission('session-lane-a-method', false, false)

    const result = await reconcileCommunicationAcl({
      manifest,
      revealState: 'sealed',
      roleSessions: partial,
      messaging,
      allowPartial: true,
      quarantineSessions: [{ roleId: 'lane-a-coder', agent: quarantined }],
    })

    expect(result.plan.roles.map(role => role.roleId)).toEqual([
      'controller',
      'lane-a-method',
    ])
    expect(messaging.permission('session-lane-a-coder')).toEqual({
      sendAllowed: false,
      receiveAllowed: false,
    })
    expect(messaging.permission('session-lane-a-method')).toEqual({
      sendAllowed: true,
      receiveAllowed: true,
    })
    expect(messaging.mutationCalls.indexOf('permission:session-lane-a-coder'))
      .toBeLessThan(messaging.mutationCalls.indexOf('permission:session-lane-a-method'))
  })

  it('does not widen a partial ACL when live-role quarantine fails', async () => {
    const manifest = fixtureManifest()
    const complete = fixtureRoleSessions(manifest)
    const partial = complete.filter(value => (
      value.roleId === 'controller' || value.roleId === 'lane-a-method'
    ))
    const messaging = new FakeMessaging(complete)
    messaging.seedPermission('session-lane-a-method', false, false)
    messaging.failPermissionFor = 'session-lane-a-coder'

    await expect(reconcileCommunicationAcl({
      manifest,
      revealState: 'sealed',
      roleSessions: partial,
      messaging,
      allowPartial: true,
      quarantineSessions: [{
        roleId: 'lane-a-coder',
        agent: exactAgent(complete, 'lane-a-coder'),
      }],
    })).rejects.toMatchObject({ code: 'ACL_APPLY_FAILED' })

    expect(messaging.permission('session-lane-a-method')).toEqual({
      sendAllowed: false,
      receiveAllowed: false,
    })
    expect(messaging.mutationCalls).not.toContain('permission:session-lane-a-method')
  })

  it('requires Controller identity even in explicit partial mode', () => {
    const manifest = fixtureManifest()
    const complete = fixtureRoleSessions(manifest)
    const workerOnly = complete.filter(value => value.roleId === 'lane-a-method')

    expect(() => compileCommunicationAcl({
      manifest,
      revealState: 'sealed',
      roleSessions: workerOnly,
      allowPartial: true,
    })).toThrow(expect.objectContaining({ code: 'ROLE_BINDING_MISMATCH' }))
  })

  it('never enters the widening phase when a restrictive mutation fails', async () => {
    const manifest = fixtureManifest()
    const roleSessions = fixtureRoleSessions(manifest)
    const messaging = new FakeMessaging(roleSessions)
    messaging.seedBlock('session-lane-a-method', 'session-lane-a-coder')
    messaging.failPermissionFor = 'session-lane-a-coder'

    await expect(reconcileCommunicationAcl({
      manifest,
      revealState: 'revealed',
      roleSessions,
      messaging,
    })).rejects.toMatchObject({ code: 'ACL_APPLY_FAILED' })

    expect(messaging.isBlocked('session-lane-a-method', 'session-lane-a-coder')).toBe(true)
    expect(messaging.mutationCalls.some(call => call
      === 'unblock:session-lane-a-method:session-lane-a-coder')).toBe(false)
  })
})

class FakeMessaging implements CommunicationAclMessaging {
  readonly allCalls: string[] = []
  readonly mutationCalls: string[] = []
  failPermissionFor?: string
  private readonly agents = new Map<string, Agent>()
  private readonly permissions = new Map<string, { sendAllowed: boolean; receiveAllowed: boolean }>()
  private readonly blocks = new Set<string>()

  constructor(roleSessions: readonly CommunicationRoleSession[]) {
    for (const role of roleSessions) {
      const id = String(role.agent.id)
      this.agents.set(id, role.agent)
      this.permissions.set(id, { sendAllowed: true, receiveAllowed: true })
    }
  }

  async getPermissions(caller: Agent) {
    const id = String(caller.id)
    this.allCalls.push(`get-permissions:${id}`)
    return { sessionId: SessionId(id), ...this.permission(id) }
  }

  async setPermissions(
    caller: Agent,
    patch: { readonly sendAllowed?: boolean; readonly receiveAllowed?: boolean },
  ) {
    const id = String(caller.id)
    this.allCalls.push(`set-permissions:${id}`)
    this.mutationCalls.push(`permission:${id}`)
    if (this.failPermissionFor === id) throw new Error('injected permission failure')
    const previous = this.permission(id)
    const next = {
      sendAllowed: patch.sendAllowed ?? previous.sendAllowed,
      receiveAllowed: patch.receiveAllowed ?? previous.receiveAllowed,
    }
    this.permissions.set(id, next)
    return { sessionId: SessionId(id), ...next }
  }

  async listBlockedPeers(caller: Agent) {
    const id = String(caller.id)
    this.allCalls.push(`list-blocked:${id}`)
    return [...this.agents.keys()]
      .filter(peer => peer !== id && this.isBlocked(id, peer))
      .map(peer => ({ sessionId: SessionId(peer) }))
  }

  async setPeerBlocked(caller: Agent, recipient: string, blocked: boolean) {
    const sender = String(caller.id)
    const verb = blocked ? 'block' : 'unblock'
    this.allCalls.push(`set-block:${sender}:${recipient}:${blocked}`)
    this.mutationCalls.push(`${verb}:${sender}:${recipient}`)
    const key = sessionPairKey(sender, recipient)
    if (blocked) this.blocks.add(key)
    else this.blocks.delete(key)
    return {}
  }

  permission(sessionId: string): { sendAllowed: boolean; receiveAllowed: boolean } {
    return this.permissions.get(sessionId) ?? { sendAllowed: true, receiveAllowed: true }
  }

  wasPermissionSetOn(expected: Agent): boolean {
    return this.mutationCalls.includes(`permission:${String(expected.id)}`)
      && this.agents.get(String(expected.id)) === expected
  }

  seedBlock(first: string, second: string): void {
    this.blocks.add(sessionPairKey(first, second))
  }

  seedPermission(sessionId: string, sendAllowed: boolean, receiveAllowed: boolean): void {
    this.permissions.set(sessionId, { sendAllowed, receiveAllowed })
  }

  isBlocked(first: string, second: string): boolean {
    return this.blocks.has(sessionPairKey(first, second))
  }

  clearMutationCalls(): void {
    this.mutationCalls.length = 0
  }
}

function fixtureManifest(): ResolvedManifest {
  const roles = [
    role('controller', 'controller'),
    role('lane-a-method', 'method', 'lane-a'),
    role('lane-a-coder', 'coder', 'lane-a'),
    role('lane-a-preflight', 'preflight_judge', 'lane-a'),
    role('lane-a-postflight', 'postflight_judge', 'lane-a'),
    role('lane-b-method', 'method', 'lane-b'),
    role('lane-b-coder', 'coder', 'lane-b'),
    role('lane-b-preflight', 'preflight_judge', 'lane-b'),
    role('lane-b-postflight', 'postflight_judge', 'lane-b'),
    role('ops', 'ops'),
  ]
  return resolveDraftLabConfig({
    schema_version: 1,
    repository: { path: '/tmp/autolab-repository', base_ref: 'main' },
    worktree_root: '/tmp/autolab-worktrees',
    research: {
      objective: 'Find the best valid mechanism.',
      primary_metric: 'score',
      metric_direction: 'maximize',
      formal_success_condition: 'Evaluator score exceeds the frozen baseline.',
      screening_vs_formal: 'Screening is not formal evidence.',
      stop_condition: 'Controller stops the Lab.',
    },
    contract: {
      hard_constraints: ['constraint'],
      allowed_mutation_scope: ['src/model.ts'],
      forbidden_changes: ['evaluator'],
      fixed_protocol: ['split-v1'],
      baseline_refs: ['baseline'],
      formal_evidence_requirements: ['evaluator receipt'],
    },
    search: {
      search_mode: 'cohort',
      coordinator_enabled: false,
      lanes: [lane('lane-a'), lane('lane-b')],
    },
    roles,
    execution: {
      runner_adapter: component('runner'),
      hosts: [{ host_id: 'local', runner_target: 'local' }],
      gpu_pool: [],
      max_parallel_gpu_attempts: 0,
      contract: {
        protocol: {
          id: 'split-v1',
          dataset: 'dataset-v1',
          model: 'model-v1',
          environment: 'environment-v1',
          run_slots: [{ slot_id: 'primary' }],
        },
        experiment_command: 'node experiment.js',
        checkpoint_contract: 'exact checkpoint',
        progress_contract: 'immutable receipts',
      },
    },
    evidence: {
      contract: {
        evaluator: component('evaluator'),
        metric_parser: component('parser'),
        comparator: component('comparator'),
        control_policy: 'frozen baseline',
        observation_lens: 'score',
        query_target: 'formal score',
        evidence_contract: 'evaluator is authoritative',
      },
    },
    communication: {
      topology: 'lane_isolated',
      acl_revision: 3,
      coordinator_visibility: 'disabled',
      role_permissions: roles.map(value => ({
        role_id: value.role_id,
        send: value.role_id !== 'lane-a-coder',
        receive: value.role_id !== 'lane-b-postflight',
      })),
      text_method_coder_within_lane: 'allowed',
      text_pair_blocks: [
        { role_ids: ['lane-a-method', 'lane-a-coder'], active_when: 'before_reveal' },
        { role_ids: ['lane-a-method', 'ops'], active_when: 'after_reveal' },
        { role_ids: ['lane-b-coder', 'ops'], active_when: 'always' },
      ],
      reveal_policy: {
        initial_state: 'sealed',
        trigger: 'cohort_barrier',
        text_cross_lane_before_reveal: 'blocked',
        text_cross_lane_after_reveal: 'allowed',
      },
      api_recovery: 'retry transport only',
      attempt_recovery: 'adopt exact process identity',
      stop_pause_policy: 'Controller controls stop',
    },
    provenance: { '/research/objective': 'user' },
  }, {
    lab_id: 'lab-communication',
    revision: 1,
    controller_session_id: 'session-controller',
    dialogue_head_sha256: hash('1'),
    lab_spec_sha256: hash('2'),
    lab_yaml_sha256: hash('3'),
    lab_directory: '/tmp/autolab/lab-communication',
    autolab_plugin_version: '0.1.0',
    dsh_version: '0.1.0-rc.6',
    repository_base_sha: gitSha('a'),
    lane_base_shas: { 'lane-a': gitSha('b'), 'lane-b': gitSha('c') },
    role_prompt_sha256: Object.fromEntries(roles.map(value => [value.role_id, hash('4')])),
  })
}

function role(
  roleId: string,
  roleKind: RoleBinding['role_kind'],
  laneId?: string,
): Record<string, unknown> {
  const common = {
    role_id: roleId,
    role_kind: roleKind,
    model_route: { route_id: 'primary', provider: 'provider', model: 'model', config: {} },
    fallback_routes: [],
    dsh_preset: roleKind === 'controller' ? 'read-only' : 'workspace-write',
    reasoning: { mode: 'default', config: {} },
    allowed_tools: [],
  }
  if (roleKind === 'controller') return { ...common, max_goal_rounds: 64 }
  const prebound_session_id = `session-${roleId}`
  if (roleKind === 'ops') {
    return { ...common, max_goal_rounds: 8, resource_domain: 'local', prebound_session_id }
  }
  if (roleKind === 'method' || roleKind === 'coder') {
    return { ...common, max_goal_rounds: 8, lane_id: laneId, prebound_session_id }
  }
  return { ...common, lane_id: laneId, prebound_session_id }
}

function lane(laneId: string): Record<string, unknown> {
  return {
    lane_id: laneId,
    worktree_path: `/tmp/autolab-worktrees/${laneId}`,
    base_ref: 'main',
    method_role_id: `${laneId}-method`,
    coder_role_id: `${laneId}-coder`,
    preflight_judge_role_id: `${laneId}-preflight`,
    postflight_judge_role_id: `${laneId}-postflight`,
    charter: {
      research_question: `question ${laneId}`,
      method_scope: `scope ${laneId}`,
      initial_hypothesis_family: `hypothesis ${laneId}`,
      inherited_facts: [],
      explicit_exclusions: [],
    },
  }
}

function component(id: string) {
  return { id, version: '1', sha256: hash('7') }
}

function fixtureRoleSessions(manifest: ResolvedManifest): CommunicationRoleSession[] {
  const manifestHash = hashResolvedManifest(manifest)
  return manifest.roles.map(roleValue => {
    const sessionId = roleValue.prebound_session_id ?? `session-${roleValue.role_id}`
    const liveAgent = agent(sessionId)
    if (roleValue.role_kind === 'controller') {
      return { roleId: roleValue.role_id, agent: liveAgent }
    }
    const receiptHash = hash(roleValue.role_id)
    const binding: StoredRoleBinding = {
      path: `/tmp/bindings/${roleValue.role_id}.json`,
      hash: receiptHash,
      receipt: {
        version: 1,
        labId: manifest.lab_id,
        manifestHash,
        roleId: roleValue.role_id,
        roleKind: roleValue.role_kind,
        sessionId,
        agentPresetId: 'default',
        permissionPresetId: roleValue.dsh_preset,
        provider: roleValue.model_route.provider,
        model: roleValue.model_route.model,
        cwd: roleValue.role_kind === 'method' || roleValue.role_kind === 'coder'
          ? roleValue.worktree_path
          : manifest.repository.path,
        runtimeRevision: 1,
        issuedAt: 1,
        receiptHash,
      },
    }
    return { roleId: roleValue.role_id, agent: liveAgent, binding }
  })
}

function agent(sessionId: string): Agent {
  return { id: SessionId(sessionId), session: {} } as Agent
}

function exactAgent(
  roleSessions: readonly CommunicationRoleSession[],
  roleId: string,
): Agent {
  return roleSessions.find(value => value.roleId === roleId)!.agent
}

function findPair(
  plan: ReturnType<typeof compileCommunicationAcl>,
  firstRoleId: string,
  secondRoleId: string,
) {
  return plan.textPairs.find(pair => (
    pair.firstRoleId === firstRoleId && pair.secondRoleId === secondRoleId
    || pair.firstRoleId === secondRoleId && pair.secondRoleId === firstRoleId
  ))
}

function sessionPairKey(first: string, second: string): string {
  return first < second ? `${first}\0${second}` : `${second}\0${first}`
}
