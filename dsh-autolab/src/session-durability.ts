import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

export class SessionDurabilityError extends Error {
  readonly name = 'SessionDurabilityError'
}

/** A false DSH flush means no persistence listener accepted the checkpoint. */
export async function flushSessionDurably(
  ctx: Context,
  session: Session,
  label: string,
): Promise<void> {
  if (await ctx.sessions.flush(session) === false) {
    throw new SessionDurabilityError(`${label} has no active Session durability backend`)
  }
}
