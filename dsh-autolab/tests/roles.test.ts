import { describe, expect, it } from 'vitest'

import { sha256 } from '../src/artifacts.js'
import type { ResolvedManifest, RoleBinding } from '../src/manifest.js'
import {
  ROLE_KERNEL_VERSION,
  AutoLabRoleError,
  resolveRootRoleSessionSpec,
  roleKernelFor,
  rolePromptFor,
  type AutoLabRoleKind,
} from '../src/roles.js'

const HASH = 'a'.repeat(64)
const GIT_SHA = 'b'.repeat(40)
const REPOSITORY = '/tmp/autolab-repository'
const WORKTREE = '/tmp/autolab-lane-1'

function common(roleKind: RoleBinding['role_kind']) {
  return {
    role_id: `role-${roleKind}`,
    role_kind: roleKind,
    model_route: {
      route_id: 'route-main',
      provider: 'provider-main',
      model: 'model-main',
      config: {},
    },
    fallback_routes: [],
    dsh_preset: 'workspace-write' as const,
    reasoning: { mode: 'default', config: {} },
    allowed_tools: ['read'],
    prompt_sha256: rolePromptFor(roleKind).sha256,
  }
}

function roles(): RoleBinding[] {
  return [
    {
      ...common('controller'),
      role_kind: 'controller',
      max_goal_rounds: 64,
      prebound_session_id: 'controller-session',
    },
    { ...common('method'), role_kind: 'method', max_goal_rounds: 64, lane_id: 'lane-1', worktree_path: WORKTREE },
    { ...common('coder'), role_kind: 'coder', max_goal_rounds: 48, lane_id: 'lane-1', worktree_path: WORKTREE },
    {
      ...common('preflight_judge'),
      role_kind: 'preflight_judge',
      lane_id: 'lane-1',
    },
    {
      ...common('postflight_judge'),
      role_kind: 'postflight_judge',
      lane_id: 'lane-1',
    },
    { ...common('ops'), role_kind: 'ops', max_goal_rounds: 24, resource_domain: 'gpu-host-1' },
    { ...common('coordinator'), role_kind: 'coordinator', max_goal_rounds: 32 },
  ]
}

function manifestView(overrides: Partial<{
  roles: RoleBinding[]
  lanes: ResolvedManifest['lanes']
}> = {}): Pick<ResolvedManifest, 'roles' | 'lanes' | 'repository'> {
  return {
    roles: overrides.roles ?? roles(),
    lanes: overrides.lanes ?? [{
      lane_id: 'lane-1',
      worktree_path: WORKTREE,
      base_ref: 'main',
      base_sha: GIT_SHA,
      method_role_id: 'role-method',
      coder_role_id: 'role-coder',
      preflight_judge_role_id: 'role-preflight_judge',
      postflight_judge_role_id: 'role-postflight_judge',
    }],
    repository: {
      path: REPOSITORY,
      base_ref: 'main',
      base_sha: GIT_SHA,
    },
  }
}

describe('built-in AutoLab role kernels', () => {
  it('provides one short immutable identity and locked hash for every role', () => {
    const expectedHashes: Record<AutoLabRoleKind, string> = {
      controller: '89197606a19d259ae3a75073709099c70552816ad363db4081e7b39dec092b32',
      method: '4d0089ef1ee1444acb959b472f7e7bb332b78b8841c2f36d36d4f517949d3e8e',
      coder: 'bd1cd13263b3391f000e68f240979d727e4502ef02bb15ea9cdf4bb133cfac3c',
      preflight_judge: '2bddaee13a98c6011c0a4900b9e84a2521e5d6cf09f63ec90f6573b00653578d',
      postflight_judge: 'f410e831feec4927ad57aadd7b79627ce152655c54941d5bf1bf18b2645815d5',
      ops: '186f5d3a80eb4285d9a5d680b687a87b8beed26e115f8e74e6f9c16120d1ac5a',
      coordinator: '30fa66af6f0f61591dc38e5784b68807696f46b5aad0a0e31f96bdfd7dec4517',
    }
    const kinds: AutoLabRoleKind[] = [
      'controller',
      'method',
      'coder',
      'preflight_judge',
      'postflight_judge',
      'ops',
      'coordinator',
    ]
    const ids = new Set<string>()
    for (const kind of kinds) {
      const prompt = rolePromptFor(kind)
      expect(prompt).toMatchObject({ roleKind: kind, version: ROLE_KERNEL_VERSION })
      expect(prompt.sha256).toBe(expectedHashes[kind])
      expect(prompt.sha256).toBe(sha256(prompt.text))
      expect(Buffer.byteLength(prompt.text, 'utf8')).toBeLessThan(1_200)
      expect(Object.isFrozen(prompt)).toBe(true)
      ids.add(prompt.id)
    }
    expect(ids.size).toBe(kinds.length)
    expect(roleKernelFor('method').id).toBe('autolab:method-maker:v1')
  })

  it('runs small Coder experiments directly without weakening Lab-owned reviews', () => {
    const coder = rolePromptFor('coder').text
    expect(coder).toContain('run the intended experiment directly')
    expect(coder).toContain('Do not insert a preliminary smoke test')
    expect(coder).toContain('create any new gate, prerequisite, or approval step')
    expect(coder).toContain('This changes only the Coder workflow')
    expect(coder).toContain('reviews owned by other roles remain in force')
  })

  it('makes Coordinator scientific routing an explicit delegated option', () => {
    const coordinator = rolePromptFor('coordinator').text
    expect(coordinator).toContain('only when the current Lab or Assignment delegates that authority')
    expect(coordinator).toContain('otherwise return the original options to the Controller')
    expect(coordinator).toContain('cannot replace the user\'s authority')
  })

  it('does not infer that Controller may select a scientific route for the user', () => {
    const controller = rolePromptFor('controller').text
    expect(controller).toContain('Route selection for the user is optional')
    expect(controller).toContain('Never infer authority')
    expect(controller).toContain('the user may always override')
  })

  it('binds every Lane role to its long-lived Lane worktree', () => {
    const manifest = manifestView()
    for (const roleId of [
      'role-method',
      'role-coder',
      'role-preflight_judge',
      'role-postflight_judge',
    ]) {
      expect(resolveRootRoleSessionSpec(manifest, roleId).cwd).toBe(WORKTREE)
    }
  })

  it('uses the repository cwd for shared Ops and optional Coordinator roles', () => {
    const manifest = manifestView()
    expect(resolveRootRoleSessionSpec(manifest, 'role-ops').cwd).toBe(REPOSITORY)
    expect(resolveRootRoleSessionSpec(manifest, 'role-coordinator').cwd).toBe(REPOSITORY)
  })

  it('keeps the user-owned Controller Session separate from root workers', () => {
    expect(() => resolveRootRoleSessionSpec(manifestView(), 'role-controller')).toThrowError(
      expect.objectContaining({ code: 'DIRECTOR_NOT_ACTIVATABLE' } satisfies Partial<AutoLabRoleError>),
    )
  })

  it('rejects role-kernel drift before Session activation', () => {
    const drifted = roles().map(role => role.role_id === 'role-method'
      ? { ...role, prompt_sha256: HASH }
      : role) as RoleBinding[]
    expect(() => resolveRootRoleSessionSpec(manifestView({ roles: drifted }), 'role-method'))
      .toThrowError(expect.objectContaining({ code: 'PROMPT_HASH_MISMATCH' }))
  })
})
