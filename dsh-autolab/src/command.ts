import { resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

import type { DraftSnapshot, FrozenRevision } from './artifacts.js'
import type { CreateLabResult, ShowLabResult } from './index.js'
import type { RuntimeState } from './state.js'

export const name = 'command-autolab'
export const inject = ['commands', 'autolab']

const USAGE = 'Usage: /autolab create [config-path] | show <lab-id> | commit <lab-id> | start <lab-id> | status <lab-id> | pause <lab-id> | resume <lab-id> | stop <lab-id>'

type ParsedInput =
  | { readonly subcommand: 'create'; readonly argument?: string }
  | { readonly subcommand: 'show' | 'commit' | 'start' | 'status' | 'pause' | 'resume' | 'stop'; readonly argument: string }

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'autolab',
    description: 'create, inspect, commit, start, status, pause, resume, or stop one directed AutoLab',
    input: {
      hint: 'create [config-path] | show <lab-id> | commit <lab-id> | start <lab-id> | status <lab-id> | pause <lab-id> | resume <lab-id> | stop <lab-id>',
    },
    // The exact human command is part of the Lab configuration provenance and
    // is copied from the durable Session log into dialogue/creation.jsonl.
    recordInput: true,
    async handler(invocation: CommandInvocation) {
      const input = parseInput(invocation.rawInput)
      if (input === undefined) return { kind: 'error', text: USAGE }

      try {
        switch (input.subcommand) {
          case 'create': {
            const result = await ctx.autolab.create(
              invocation.agent,
              input.argument,
              invocation.signal,
            )
            return {
              kind: 'success',
              text: formatCreate(result),
            }
          }
          case 'show':
            return {
              kind: 'success',
              text: formatLabDocuments(
                'AutoLab',
                await ctx.autolab.show(invocation.agent, input.argument, invocation.signal),
              ),
            }
          case 'commit':
            return {
              kind: 'success',
              text: formatLabDocuments(
                'Committed AutoLab',
                await ctx.autolab.commit(invocation.agent, input.argument, invocation.signal),
              ),
            }
          case 'start':
            return {
              kind: 'success',
              text: formatRuntimeState(
                await ctx.autolab.start(invocation.agent, input.argument, invocation.signal),
              ),
            }
          case 'status':
            return {
              kind: 'success',
              // `status()` is the Controller's in-memory materialized view.
              // The command does no artifact or Session-log read here.
              text: formatRuntimeState(ctx.autolab.status(invocation.agent, input.argument)),
            }
          case 'pause':
            return {
              kind: 'success',
              text: formatRuntimeState(
                await ctx.autolab.pause(invocation.agent, input.argument, invocation.signal),
              ),
            }
          case 'resume':
            return {
              kind: 'success',
              text: formatRuntimeState(
                await ctx.autolab.resume(invocation.agent, input.argument, invocation.signal),
              ),
            }
          case 'stop':
            return {
              kind: 'success',
              text: formatRuntimeState(
                await ctx.autolab.stop(invocation.agent, input.argument, invocation.signal),
              ),
            }
        }
      } catch (error) {
        return {
          kind: 'error',
          text: `AutoLab ${input.subcommand} failed: ${renderError(error)}`,
        }
      }
    },
  })
}

/** Parse only the first token; the create path remains one verbatim remainder. */
function parseInput(rawInput: string): ParsedInput | undefined {
  const input = rawInput.trim()
  if (input.length === 0) return undefined
  const separator = input.search(/\s/u)
  const subcommand = separator < 0 ? input : input.slice(0, separator)
  const argument = separator < 0 ? undefined : input.slice(separator).trim()
  if (subcommand === 'create') {
    return argument === undefined || argument.length === 0
      ? { subcommand }
      : { subcommand, argument }
  }
  if ((subcommand === 'show'
      || subcommand === 'commit'
      || subcommand === 'start'
      || subcommand === 'status'
      || subcommand === 'pause'
      || subcommand === 'resume'
      || subcommand === 'stop')
    && argument !== undefined
    && argument.length > 0
    && !/\s/u.test(argument)) {
    return { subcommand, argument }
  }
  return undefined
}

function formatCreate(result: CreateLabResult): string {
  const directory = resolve(result.directory)
  const lines = [
    `Created AutoLab ${result.state.labId}.`,
    `Lifecycle: ${result.state.lifecycle.toUpperCase()}`,
    `Lab directory: ${directory}`,
    `Draft directory: ${resolve(directory, 'draft')}`,
  ]
  if (result.state.lifecycle === 'draft_ready') {
    lines.push(...formatDraft(result.draft, directory))
  }
  lines.push('The Lab was not started. Continue the directed configuration conversation, then use /autolab commit <lab-id> to create a revision.')
  return lines.join('\n')
}

function formatLabDocuments(
  lead: 'Committed AutoLab' | 'AutoLab',
  result: ShowLabResult,
): string {
  const directory = resolve(result.directory)
  if (result.frozen === undefined) {
    if (result.draft === undefined) throw new Error(`Lab ${result.state.labId} has no documents`)
    return [
      `${lead} ${result.state.labId}.`,
      `Lifecycle: ${result.state.lifecycle.toUpperCase()}`,
      `Lab directory: ${directory}`,
      ...formatDraft(result.draft, directory),
    ].join('\n')
  }
  const frozen = result.frozen
  const revisionDirectory = resolve(directory, frozen.ref.revisionPath)
  return [
    `${lead} ${result.state.labId}.`,
    `Lifecycle: ${result.state.lifecycle.toUpperCase()}`,
    `Lab directory: ${directory}`,
    `Revision: ${frozen.ref.revision}`,
    `Revision directory: ${revisionDirectory}`,
    `LAB_SPEC.md path: ${resolve(revisionDirectory, 'LAB_SPEC.md')}`,
    `LAB_SPEC.md SHA-256: ${frozen.ref.specHash}`,
    `lab.yaml path: ${resolve(revisionDirectory, 'lab.yaml')}`,
    `lab.yaml SHA-256: ${frozen.ref.configHash}`,
    `RESOLVED_MANIFEST.json path: ${resolve(revisionDirectory, 'RESOLVED_MANIFEST.json')}`,
    `RESOLVED_MANIFEST.json SHA-256: ${frozen.ref.manifestHash}`,
    `Dialogue head SHA-256: ${frozen.ref.dialogueHeadHash}`,
    `VALIDATION.json path: ${resolve(revisionDirectory, 'VALIDATION.json')}`,
    verbatimDocument('LAB_SPEC.md', frozen.spec),
    verbatimDocument('lab.yaml', frozen.config),
  ].join('\n')
}

function formatDraft(draft: DraftSnapshot, directory: string): string[] {
  return [
    `LAB_SPEC.md path: ${resolve(directory, 'draft', 'LAB_SPEC.md')}`,
    `LAB_SPEC.md SHA-256: ${draft.specHash}`,
    `lab.yaml path: ${resolve(directory, 'draft', 'lab.yaml')}`,
    `lab.yaml SHA-256: ${draft.configHash}`,
    verbatimDocument('LAB_SPEC.md', draft.spec),
    verbatimDocument('lab.yaml', draft.config),
  ]
}

function verbatimDocument(name: 'LAB_SPEC.md' | 'lab.yaml', content: string): string {
  const separator = content.endsWith('\n') ? '' : '\n'
  return `----- BEGIN ${name} (verbatim) -----\n${content}${separator}----- END ${name} -----`
}

function formatRuntimeState(state: RuntimeState): string {
  return [
    `AutoLab ${state.labId}.`,
    `Lifecycle: ${state.lifecycle.toUpperCase()}`,
    'RuntimeState:',
    JSON.stringify(state, null, 2),
  ].join('\n')
}

function renderError(value: unknown): string {
  if (value instanceof Error) {
    const code = 'code' in value && typeof value.code === 'string' ? `${value.code}: ` : ''
    return `${code}${value.message}`
  }
  return String(value)
}
