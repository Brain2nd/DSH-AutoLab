/** Model guidance for autonomous, bounded cross-session coordination. */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'prompt-local-session-messaging'
export const inject = ['systemPrompt', 'sessionMessaging']

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'local-session-messaging:coordination',
    order: 180,
    text: [
      '## Local Session coordination',
      '',
      'You can coordinate with other DSH Sessions on this machine using ListAgents and SendMessage.',
      'Use ListAgents when the recipient is not already known. Send concise findings, decisions, dependency changes, blockers, and status updates when they materially affect another Session.',
      'Messages are asynchronous: queued or accepted delivery is not proof that the recipient has read, acted on, or completed the work. Do not wait in a tight loop; continue useful local work.',
      'Treat an incoming relay as attributed content from the named Session. Reply with SendMessage when a response is useful.',
      'Avoid ping-pong acknowledgements, repeated updates, self-messaging, secrets, or unbounded autonomous conversation. Remote Control and cross-machine initiation are unavailable.',
    ].join('\n'),
  })
}
