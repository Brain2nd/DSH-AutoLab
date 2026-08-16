import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import {
  apply,
  type AutoLabRoleResultStatus,
  type CoderImplementationStatus,
  type MethodPreflightReviewStatus,
  type PostflightResultStatus,
  type PreflightVerdictStatus,
} from '../src/tool.js'
import { AutoLabRuntimeError } from '../src/index.js'

function caller(id = 'autolab-role-session'): Agent {
  return { id: SessionId(id) } as Agent
}

function execution(agent: Agent | undefined, signal: AbortSignal): ToolRunContext {
  return { agent, signal } as ToolRunContext
}

function mount(service: object): readonly ToolDefinition[] {
  const definitions: ToolDefinition[] = []
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        definitions.push(definition)
        return () => undefined
      },
    },
    autolab: service,
  } as Context
  apply(ctx)
  return definitions
}

describe('AutoLab role submission tools', () => {
  it('registers five zero-parameter, status-only tools', () => {
    const definitions = mount({})

    expect(definitions.map(definition => definition.name)).toEqual([
      'SubmitMethodForPreflightReview',
      'SubmitPreflightVerdict',
      'SubmitCoderImplementation',
      'SubmitPostflightResult',
      'SubmitAutoLabRoleResult',
    ])
    for (const definition of definitions) {
      const parameters = definition.parameters as {
        readonly type: string
        readonly properties: Record<string, unknown>
      }
      expect(parameters).toMatchObject({
        type: 'object',
        properties: {},
      })
      expect(Object.keys(parameters.properties)).toEqual([])
      expect(definition.isConcurrencySafe).toBeUndefined()
    }

    expect(definitions[0]!.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['labId', 'roleId', 'assignmentId', 'reviewId', 'phase'],
      properties: {
        labId: { type: 'string' },
        roleId: { type: 'string' },
        assignmentId: { type: 'string' },
        reviewId: { type: 'string' },
        phase: { type: 'string', const: 'reviewing' },
      },
    })
    expect(definitions[1]!.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['labId', 'roleId', 'assignmentId', 'reviewId', 'phase', 'verdict'],
      properties: {
        labId: { type: 'string' },
        roleId: { type: 'string' },
        assignmentId: { type: 'string' },
        reviewId: { type: 'string' },
        phase: { type: 'string', enum: ['verdict_recorded', 'error'] },
        verdict: {
          type: 'string',
          enum: ['APPROVED', 'REVISION_REQUIRED', 'REJECTED', 'REVIEW_ERROR'],
        },
      },
    })
    expect(definitions[2]!.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: [
        'labId',
        'roleId',
        'assignmentId',
        'candidateId',
        'candidateSha',
        'phase',
      ],
      properties: {
        labId: { type: 'string' },
        roleId: { type: 'string' },
        assignmentId: { type: 'string' },
        candidateId: { type: 'string' },
        candidateSha: { type: 'string' },
        phase: {
          type: 'string',
          const: 'candidate_frozen',
        },
      },
    })
    expect(definitions[3]!.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['labId', 'roleId', 'assignmentId', 'reviewId', 'phase'],
      properties: {
        labId: { type: 'string' },
        roleId: { type: 'string' },
        assignmentId: { type: 'string' },
        reviewId: { type: 'string' },
        phase: { type: 'string', const: 'result_recorded' },
      },
    })
    expect(definitions[4]!.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['labId', 'roleId', 'assignmentId', 'phase'],
      properties: {
        labId: { type: 'string' },
        roleId: { type: 'string' },
        assignmentId: { type: 'string' },
        phase: { type: 'string', const: 'receipt_recorded' },
      },
    })

    for (const forbidden of ['control', 'recipient', 'sessionId', 'path', 'command']) {
      for (const definition of definitions) {
        const parameters = definition.parameters as {
          readonly properties: Record<string, unknown>
        }
        expect(Object.hasOwn(parameters.properties, forbidden)).toBe(false)
      }
    }
  })

  it('passes only the exact Method caller and signal to the Controller', async () => {
    const signal = new AbortController().signal
    const agent = caller('method-session')
    const status: MethodPreflightReviewStatus = {
      labId: 'lab-20260815-050000-1234abcd',
      roleId: 'lane-a-method',
      assignmentId: 'lane-a-method:bootstrap',
      reviewId: 'review-lane-a-0001',
      phase: 'reviewing',
    }
    const submitMethodForPreflightReview = vi.fn(async () => status)
    const definitions = mount({
      submitMethodForPreflightReview,
      submitPreflightVerdict: vi.fn(),
    })

    await expect(definitions[0]!.execute({}, execution(agent, signal))).resolves.toEqual(status)
    expect(submitMethodForPreflightReview).toHaveBeenCalledTimes(1)
    expect(submitMethodForPreflightReview).toHaveBeenCalledWith(agent, signal)
  })

  it('passes only the exact Judge caller and signal to the Controller', async () => {
    const signal = new AbortController().signal
    const agent = caller('preflight-judge-session')
    const status: PreflightVerdictStatus = {
      labId: 'lab-20260815-050000-1234abcd',
      roleId: 'lane-a-preflight',
      assignmentId: 'preflight:review-lane-a-0001',
      reviewId: 'review-lane-a-0001',
      phase: 'verdict_recorded',
      verdict: 'APPROVED',
    }
    const submitPreflightVerdict = vi.fn(async () => status)
    const definitions = mount({
      submitMethodForPreflightReview: vi.fn(),
      submitPreflightVerdict,
    })

    await expect(definitions[1]!.execute({}, execution(agent, signal))).resolves.toEqual(status)
    expect(submitPreflightVerdict).toHaveBeenCalledTimes(1)
    expect(submitPreflightVerdict).toHaveBeenCalledWith(agent, signal)
  })

  it('passes only the exact Coder caller and signal to the Controller', async () => {
    const signal = new AbortController().signal
    const agent = caller('coder-session')
    const status: CoderImplementationStatus = {
      labId: 'lab-20260815-050000-1234abcd',
      roleId: 'lane-a-coder',
      assignmentId: 'coder:review-lane-a-0001',
      candidateId: 'candidate-a-1',
      candidateSha: 'a'.repeat(40),
      phase: 'candidate_frozen',
    }
    const submitCoderImplementation = vi.fn(async () => status)
    const definitions = mount({
      submitMethodForPreflightReview: vi.fn(),
      submitPreflightVerdict: vi.fn(),
      submitCoderImplementation,
    })

    await expect(definitions[2]!.execute({}, execution(agent, signal))).resolves.toEqual(status)
    expect(submitCoderImplementation).toHaveBeenCalledTimes(1)
    expect(submitCoderImplementation).toHaveBeenCalledWith(agent, signal)
  })

  it('passes only the exact Postflight Judge caller and signal to the Controller', async () => {
    const signal = new AbortController().signal
    const agent = caller('postflight-judge-session')
    const status: PostflightResultStatus = {
      labId: 'lab-20260815-050000-1234abcd',
      roleId: 'lane-a-postflight',
      assignmentId: 'postflight:review-lane-a-0001',
      reviewId: 'review-lane-a-0001',
      phase: 'result_recorded',
    }
    const submitPostflightResult = vi.fn(async () => status)
    const definitions = mount({
      submitMethodForPreflightReview: vi.fn(),
      submitPreflightVerdict: vi.fn(),
      submitCoderImplementation: vi.fn(),
      submitPostflightResult,
    })

    await expect(definitions[3]!.execute({}, execution(agent, signal))).resolves.toEqual(status)
    expect(submitPostflightResult).toHaveBeenCalledTimes(1)
    expect(submitPostflightResult).toHaveBeenCalledWith(agent, signal)
  })

  it('passes only the exact Ops or Coordinator caller and signal to the Controller', async () => {
    const signal = new AbortController().signal
    const agent = caller('ops-session')
    const status: AutoLabRoleResultStatus = {
      labId: 'lab-20260815-050000-1234abcd',
      roleId: 'ops',
      assignmentId: 'ops:repair-001',
      phase: 'receipt_recorded',
    }
    const submitAutoLabRoleResult = vi.fn(async () => status)
    const definitions = mount({
      submitMethodForPreflightReview: vi.fn(),
      submitPreflightVerdict: vi.fn(),
      submitCoderImplementation: vi.fn(),
      submitPostflightResult: vi.fn(),
      submitAutoLabRoleResult,
    })

    await expect(definitions[4]!.execute({}, execution(agent, signal))).resolves.toEqual(status)
    expect(submitAutoLabRoleResult).toHaveBeenCalledTimes(1)
    expect(submitAutoLabRoleResult).toHaveBeenCalledWith(agent, signal)
  })

  it('requires an exact calling Agent before invoking either service method', async () => {
    const submitMethodForPreflightReview = vi.fn()
    const submitPreflightVerdict = vi.fn()
    const submitCoderImplementation = vi.fn()
    const submitPostflightResult = vi.fn()
    const submitAutoLabRoleResult = vi.fn()
    const definitions = mount({
      submitMethodForPreflightReview,
      submitPreflightVerdict,
      submitCoderImplementation,
      submitPostflightResult,
      submitAutoLabRoleResult,
    })
    const exec = execution(undefined, new AbortController().signal)

    await expect(definitions[0]!.execute({}, exec)).rejects.toThrow(
      'SubmitMethodForPreflightReview requires an exact calling Agent',
    )
    await expect(definitions[1]!.execute({}, exec)).rejects.toThrow(
      'SubmitPreflightVerdict requires an exact calling Agent',
    )
    await expect(definitions[2]!.execute({}, exec)).rejects.toThrow(
      'SubmitCoderImplementation requires an exact calling Agent',
    )
    await expect(definitions[3]!.execute({}, exec)).rejects.toThrow(
      'SubmitPostflightResult requires an exact calling Agent',
    )
    await expect(definitions[4]!.execute({}, exec)).rejects.toThrow(
      'SubmitAutoLabRoleResult requires an exact calling Agent',
    )
    expect(submitMethodForPreflightReview).not.toHaveBeenCalled()
    expect(submitPreflightVerdict).not.toHaveBeenCalled()
    expect(submitCoderImplementation).not.toHaveBeenCalled()
    expect(submitPostflightResult).not.toHaveBeenCalled()
    expect(submitAutoLabRoleResult).not.toHaveBeenCalled()
  })

  it('rejects every caller-supplied target, path, control, or command field', async () => {
    const submitMethodForPreflightReview = vi.fn()
    const submitPreflightVerdict = vi.fn()
    const submitCoderImplementation = vi.fn()
    const submitPostflightResult = vi.fn()
    const submitAutoLabRoleResult = vi.fn()
    const definitions = mount({
      submitMethodForPreflightReview,
      submitPreflightVerdict,
      submitCoderImplementation,
      submitPostflightResult,
      submitAutoLabRoleResult,
    })
    const exec = execution(caller(), new AbortController().signal)
    const forbiddenInputs = [
      { recipient: 'another-session' },
      { sessionId: 'another-session' },
      { path: '/tmp/substitute.json' },
      { command: '/goal resume' },
      { control: { kind: 'REVIEW_REQUEST', payload: {} } },
    ]

    for (const input of forbiddenInputs) {
      await expect(definitions[0]!.execute(input, exec)).rejects.toThrow(
        'SubmitMethodForPreflightReview does not accept arguments',
      )
      await expect(definitions[1]!.execute(input, exec)).rejects.toThrow(
        'SubmitPreflightVerdict does not accept arguments',
      )
      await expect(definitions[2]!.execute(input, exec)).rejects.toThrow(
        'SubmitCoderImplementation does not accept arguments',
      )
      await expect(definitions[3]!.execute(input, exec)).rejects.toThrow(
        'SubmitPostflightResult does not accept arguments',
      )
      await expect(definitions[4]!.execute(input, exec)).rejects.toThrow(
        'SubmitAutoLabRoleResult does not accept arguments',
      )
    }
    expect(submitMethodForPreflightReview).not.toHaveBeenCalled()
    expect(submitPreflightVerdict).not.toHaveBeenCalled()
    expect(submitCoderImplementation).not.toHaveBeenCalled()
    expect(submitPostflightResult).not.toHaveBeenCalled()
    expect(submitAutoLabRoleResult).not.toHaveBeenCalled()
  })

  it('preserves the stable Controller error code through the real DSH tool pipeline', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
    ctx.provide('autolab', {
      submitMethodForPreflightReview: vi.fn(),
      submitPreflightVerdict: vi.fn(),
      submitCoderImplementation: vi.fn(async () => {
        throw new AutoLabRuntimeError('Coder report is incomplete', 'IMPLEMENTATION_NOT_READY')
      }),
    })
    apply(ctx)
    try {
      const result = await ctx.tools.execute({
        callId: CallId('autolab-tool-error'),
        name: 'SubmitCoderImplementation',
        arguments: {},
        agent: caller('coder-session'),
        signal: new AbortController().signal,
      })
      expect(result).toMatchObject({
        isError: true,
        error: {
          message: 'Coder report is incomplete',
          info: {
            name: 'AutoLabRuntimeError',
            code: 'IMPLEMENTATION_NOT_READY',
          },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
