/**
 * DSH rc.6 contract fixture for the exact Agent primitives used by the local
 * transport. This intentionally drives a real AgentLoop turn. In particular,
 * runMaintenance() is not a substitute for the public `running` boundary.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  CallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

const PROVIDER = 'routing-fixture'
const MODEL = 'deterministic'
const ROOT_A = SessionId('integration-root-a')
const ROOT_B = SessionId('integration-root-b')

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function blockingToolResponse(): StreamChunk[] {
  const id = CallId('integration-block-b')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id,
      name: 'HoldBoundary',
      argumentsDelta: '{}',
    },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id, name: 'HoldBoundary', arguments: '{}' },
    },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A session-routed fake avoids depending on concurrent request ordering. */
class RoutedFakeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly #calls = new Map<string, number>()

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  requestsFor(sessionId: string): GenerateOptions[] {
    return this.requests.filter(request => request.sessionId === sessionId)
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const sessionId = String(options.sessionId)
    const call = this.#calls.get(sessionId) ?? 0
    this.#calls.set(sessionId, call + 1)

    let response: StreamChunk[]
    if (sessionId === ROOT_A && call === 0) {
      response = textResponse('root A complete')
    } else if (sessionId === ROOT_B && call === 0) {
      response = blockingToolResponse()
    } else if (sessionId === ROOT_B && call === 1) {
      response = textResponse('root B addressed steering')
    } else if (sessionId === ROOT_B && call === 2) {
      response = textResponse('root B followup complete')
    } else {
      throw new Error(`unexpected model call ${sessionId}#${call + 1}`)
    }

    for (const chunk of response) {
      if (options.signal?.aborted === true) throw new Error('fixture model call aborted')
      yield chunk
    }
  }
}

function prompt(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function userTexts(agent: Agent): string[] {
  return agent.session.events.flatMap(event =>
    event.type === 'user/message'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [],
  )
}

function count(agent: Agent, type: 'turn/start' | 'step/start'): number {
  return agent.session.events.filter(event => event.type === type).length
}

async function waitForRelease(release: Promise<void>, signal: AbortSignal): Promise<void> {
  let removeAbortListener = (): void => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('blocking tool aborted'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    await Promise.race([release, aborted])
  } finally {
    removeAbortListener()
  }
}

describe('DSH rc.6 multi-root Agent routing contract', () => {
  it('routes running steer and idle followup without cross-session delivery', async () => {
    const ctx = new Context()
    const adapter = new RoutedFakeAdapter()
    const entered = Promise.withResolvers<Agent>()
    const released = Promise.withResolvers<void>()

    try {
      await mountAgentLoopTestDependencies(ctx, {
        systemPrompt: { persona: '' },
      })
      ctx.llm.registerAdapter([PROVIDER], adapter)
      ctx.tools.register(defineContentToolFixture({
        name: 'HoldBoundary',
        description: 'Hold one real tool-call step until the integration test releases it.',
        parameters: {},
        async execute(_args, exec) {
          if (exec.agent === undefined) throw new Error('HoldBoundary requires a calling Agent')
          entered.resolve(exec.agent)
          await waitForRelease(released.promise, exec.signal)
          return [{ type: 'text', text: 'boundary released' }]
        },
      }))
      await ctx.plugin(AgentLoop, { agents: [] })

      const [handleA, handleB] = await Promise.all([
        ctx.agents.create({
          sessionId: ROOT_A,
          agentOptions: { provider: PROVIDER, model: MODEL },
        }),
        ctx.agents.create({
          sessionId: ROOT_B,
          agentOptions: { provider: PROVIDER, model: MODEL },
        }),
      ])
      const rootA = handleA.agent
      const rootB = handleB.agent
      const statuses: string[] = []
      ctx.on('agent/status', ({ agent, status }) => {
        statuses.push(`${agent.id}:${status}`)
      })

      expect(ctx.agents.roots()).toEqual([rootA, rootB])

      rootB.followup(prompt('B: start blocking turn'))
      await expect(entered.promise).resolves.toBe(rootB)

      // This is a live model/tool turn: maintenance tasks deliberately remain idle.
      expect(rootB.status).toBe('running')
      expect(rootA.status).toBe('idle')
      expect(count(rootB, 'turn/start')).toBe(1)
      expect(rootB.session.events.some(event => event.type === 'tool/call')).toBe(true)
      expect(rootB.session.events.some(event => event.type === 'tool/result')).toBe(false)

      rootB.steer(prompt('B: steer at the next step'))
      rootA.followup(prompt('A: independent followup'))
      await rootA.whenIdle()

      expect(rootA.status).toBe('idle')
      expect(rootB.status).toBe('running')
      expect(userTexts(rootA)).toEqual(['A: independent followup'])
      expect(userTexts(rootB)).toEqual(['B: start blocking turn'])
      expect(rootB.inbox.nextStep.map(message => message.content)).toEqual([
        [{ type: 'text', text: 'B: steer at the next step' }],
      ])

      released.resolve()
      await rootB.whenIdle()

      expect(rootB.status).toBe('idle')
      expect(count(rootB, 'turn/start')).toBe(1)
      expect(count(rootB, 'step/start')).toBe(2)
      expect(userTexts(rootB)).toEqual([
        'B: start blocking turn',
        'B: steer at the next step',
      ])

      // followup() from idle opens its own FIFO turn; it is not folded into steering.
      rootB.followup(prompt('B: separate followup turn'))
      expect(rootB.status).toBe('running')
      await rootB.whenIdle()

      expect(count(rootB, 'turn/start')).toBe(2)
      expect(count(rootB, 'step/start')).toBe(3)
      expect(userTexts(rootB)).toEqual([
        'B: start blocking turn',
        'B: steer at the next step',
        'B: separate followup turn',
      ])
      expect(count(rootA, 'turn/start')).toBe(1)

      const requestsA = JSON.stringify(adapter.requestsFor(ROOT_A))
      const requestsB = JSON.stringify(adapter.requestsFor(ROOT_B))
      expect(adapter.requestsFor(ROOT_A)).toHaveLength(1)
      expect(adapter.requestsFor(ROOT_B)).toHaveLength(3)
      expect(requestsA).toContain('A: independent followup')
      expect(requestsA).not.toContain('B:')
      expect(requestsB).toContain('B: start blocking turn')
      expect(requestsB).toContain('B: steer at the next step')
      expect(requestsB).toContain('B: separate followup turn')
      expect(requestsB).not.toContain('A: independent followup')
      expect(statuses).toEqual([
        `${ROOT_B}:running`,
        `${ROOT_A}:running`,
        `${ROOT_A}:idle`,
        `${ROOT_B}:idle`,
        `${ROOT_B}:running`,
        `${ROOT_B}:idle`,
      ])
    } finally {
      // Also makes teardown finite if an assertion above fails while the tool is held.
      released.resolve()
      await ctx.fiber.dispose()
    }
  })
})
