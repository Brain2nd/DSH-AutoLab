import type { GoalView } from '@deepseek-ai/dsh-goal'

import { sha256 } from './integrity.js'
import type { RoleState, RuntimeState } from './state.js'

export interface RoleGoalRevisionEdge {
  readonly sessionId: string
  readonly goalId: string
  readonly goalRevision: number
  readonly objectiveHash: string
}

export interface RoleGoalRevisionProjection {
  readonly roleId: string
  readonly roles: RuntimeState['roles']
}

/**
 * Project one exact native Goal revision edge onto its owning AutoLab role.
 * Goal phase and counters remain owned by DSH; this only keeps the persisted
 * compare-and-set reference current after pause/resume/API-recovery mutations.
 */
export function projectRoleGoalRevision(
  state: Pick<RuntimeState, 'roles'>,
  edge: RoleGoalRevisionEdge,
): RoleGoalRevisionProjection | undefined {
  const matches = Object.entries(state.roles).filter(([, role]) => {
    const install = role.goalInstall
    return role.sessionId === edge.sessionId
      && install?.status === 'applied'
      && install.goalId === edge.goalId
      && install.objectiveHash === edge.objectiveHash
      && install.goalRevision !== undefined
      && edge.goalRevision > install.goalRevision
  })
  if (matches.length !== 1) return undefined

  const [roleId, role] = matches[0]!
  const roles = structuredClone(state.roles)
  roles[roleId] = {
    ...role,
    goalInstall: {
      ...role.goalInstall!,
      goalRevision: edge.goalRevision,
    },
  }
  return { roleId, roles }
}

/** Exact identity check shared by result-bearing role submissions. */
export function roleOwnsExactAssignmentGoal(
  role: RoleState,
  goal: GoalView | undefined,
): boolean {
  const install = role.goalInstall
  return install?.status === 'applied'
    && goal !== undefined
    && String(goal.id) === install.goalId
    && goal.revision === install.goalRevision
    && sha256(goal.objective) === install.objectiveHash
}
