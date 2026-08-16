import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Register real DSH tool definitions used by role-scope integration tests. */
export function registerRoleToolFixtures(ctx: Context): void {
  for (const name of [
    'read',
    'exec',
    'SubmitMethodForPreflightReview',
    'SubmitPreflightVerdict',
    'SubmitCoderImplementation',
    'SubmitPostflightResult',
    'SubmitAutoLabRoleResult',
  ]) {
    ctx.tools.register(defineTool({
      name,
      description: `${name} fixture`,
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        return name
      },
    }))
  }
}
