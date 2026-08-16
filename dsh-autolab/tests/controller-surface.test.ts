import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import {
  CONTROLLER_KERNEL_SECTION,
  installControllerSurface,
  type ControllerSurfaceRuntime,
} from '../src/controller-surface.js'
import type { RuntimeState } from '../src/state.js'

const LAB_ID = 'lab-20260815-120000-89abcdef'

function runtimeState(lifecycle: RuntimeState['lifecycle'] = 'running'): RuntimeState {
  return {
    schemaVersion: 1,
    labId: LAB_ID,
    runtimeRevision: 3,
    ownerEpoch: '00000000-0000-4000-8000-000000000001',
    controllerSessionId: 'controller-session',
    lifecycle,
    config: {
      revision: 1,
      specHash: 'a'.repeat(64),
      configHash: 'b'.repeat(64),
      manifestHash: 'c'.repeat(64),
      dialogueHeadHash: 'd'.repeat(64),
      revisionPath: 'revisions/000001',
    },
    roles: {},
    reviews: {},
    candidates: {},
    retiredCandidates: {},
    trials: {},
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('Controller Agent-local surface', () => {
  it('adds only scoped prompt/tools and disposes them in reverse order', async () => {
    const definitions: ToolDefinition[] = []
    const disposed: string[] = []
    let section: { readonly name: string; readonly text: string | (() => string) } | undefined
    let agent!: Agent
    const agentContext = {
      systemPrompt: {
        section(value: typeof section & { readonly name: string }) {
          section = value
          return () => { disposed.push('prompt') }
        },
      },
      tools: {
        register(definition: ToolDefinition) {
          definitions.push(definition)
          return () => { disposed.push(definition.name) }
        },
      },
      agents: {
        get(id: SessionId) {
          return id === agent.id ? agent : undefined
        },
      },
    } as unknown as Context
    agent = {
      id: SessionId('controller-session'),
      ctx: agentContext,
    } as Agent
    const state = runtimeState()
    const runtime = {
      readForController: vi.fn(async () => ({
        labId: LAB_ID,
        lifecycle: 'running' as const,
        directory: '/tmp/lab',
        revision: '1',
        labSpec: 'complete spec',
        labYaml: 'complete yaml',
      })),
      status: vi.fn(() => state),
      start: vi.fn(async () => state),
      pause: vi.fn(async () => runtimeState('paused')),
      resume: vi.fn(async () => state),
      stop: vi.fn(async () => runtimeState('stopped')),
      reveal: vi.fn(async () => ({
        labId: LAB_ID,
        revealState: 'revealed' as const,
        runtimeRevision: 4,
      })),
      applyPreflight: vi.fn(async (_caller, input) => ({
        labId: input.labId,
        reviewId: input.reviewId,
        coderRoleId: 'lane-a-coder',
        assignmentId: `coder:${input.reviewId}`,
        phase: 'coder_working' as const,
      })),
      assignMethod: vi.fn(async (_caller, input) => ({
        labId: input.labId,
        methodRoleId: input.methodRoleId,
        assignmentId: input.assignmentId,
        ...(input.sourceReviewId === undefined
          ? {}
          : { sourceReviewId: input.sourceReviewId }),
        phase: 'working' as const,
      })),
      assignCoderFix: vi.fn(async (_caller, input) => ({
        labId: input.labId,
        coderRoleId: input.coderRoleId,
        assignmentId: input.assignmentId,
        reviewId: 'review-fix-lineage',
        phase: 'working' as const,
      })),
      registerUserDirective: vi.fn(async (_caller, input) => ({
        labId: input.labId,
        factPath: '/tmp/lab/artifacts/facts.json',
        factSetSha256: 'b'.repeat(64),
        factIndex: 0,
        runtimeRevision: 1,
      })),
      assignRole: vi.fn(async (_caller, input) => ({
        labId: input.labId,
        roleId: input.roleId,
        assignmentId: input.assignmentId,
        phase: 'working' as const,
      })),
      launchAttempt: vi.fn(async () => ({
        labId: LAB_ID,
        trialId: 'trial-a',
        runSlotId: 'slot-a',
        attemptId: 'attempt-a',
        phase: 'launching' as const,
      })),
      retryAttempt: vi.fn(async () => ({
        labId: LAB_ID,
        trialId: 'trial-a',
        runSlotId: 'slot-a',
        attemptId: 'attempt-b',
        phase: 'launching' as const,
      })),
      requestPostflight: vi.fn(async (_caller, input) => ({
        labId: input.labId,
        reviewId: 'postflight-review-a',
        assignmentId: 'postflight:postflight-review-a',
        coderRoleId: 'lane-a-coder',
        judgeRoleId: 'lane-a-postflight',
        phase: 'reviewing' as const,
      })),
      waitController: vi.fn(async () => ({ labId: LAB_ID, outcome: 'paused' as const })),
    } satisfies ControllerSurfaceRuntime

    const dispose = installControllerSurface(agent, runtime, () => 'controller kernel')
    expect(section?.name).toBe(CONTROLLER_KERNEL_SECTION)
    expect(definitions.map(value => value.name)).toEqual([
      'AutoLabRead',
      'AutoLabStatus',
      'AutoLabStart',
      'AutoLabPause',
      'AutoLabResume',
      'AutoLabStop',
      'AutoLabReveal',
      'AutoLabApplyPreflight',
      'AutoLabAssignMethod',
      'AutoLabAssignCoderFix',
      'AutoLabRegisterUserDirective',
      'AutoLabAssignRole',
      'AutoLabLaunchAttempt',
      'AutoLabRetryAttempt',
      'AutoLabRequestPostflight',
      'AutoLabWait',
    ])

    const concludeTurn = vi.fn()
    const execution = {
      agent,
      signal: new AbortController().signal,
      concludeTurn,
    } as unknown as ToolRunContext
    await definitions.at(-1)!.execute({ labId: LAB_ID }, execution)
    expect(runtime.waitController).toHaveBeenCalledWith(agent, LAB_ID, execution.signal)
    expect(concludeTurn).toHaveBeenCalledTimes(1)

    dispose()
    dispose()
    expect(disposed).toEqual([
      'AutoLabWait',
      'AutoLabRequestPostflight',
      'AutoLabRetryAttempt',
      'AutoLabLaunchAttempt',
      'AutoLabAssignRole',
      'AutoLabRegisterUserDirective',
      'AutoLabAssignCoderFix',
      'AutoLabAssignMethod',
      'AutoLabApplyPreflight',
      'AutoLabReveal',
      'AutoLabStop',
      'AutoLabResume',
      'AutoLabPause',
      'AutoLabStart',
      'AutoLabStatus',
      'AutoLabRead',
      'prompt',
    ])
  })
})
