import { GoalId, type GoalView } from '@deepseek-ai/dsh-goal'
import { describe, expect, it } from 'vitest'

import { sha256 } from '../src/integrity.js'
import {
  projectRoleGoalRevision,
  roleOwnsExactAssignmentGoal,
} from '../src/role-goal-revision.js'
import type { RoleState } from '../src/state.js'

const OBJECTIVE = 'exact opaque Ops Assignment Goal'

function role(overrides: Partial<RoleState> = {}): RoleState {
  return {
    sessionId: 'ops-session',
    phase: 'working',
    binding: { path: '/tmp/binding', hash: 'a'.repeat(64) },
    packet: { path: '/tmp/packet', hash: 'b'.repeat(64) },
    goalInstall: {
      installId: 'ops-assignment:install:1',
      assignmentId: 'ops-assignment',
      objectiveHash: sha256(OBJECTIVE),
      maxGoalRounds: 16,
      status: 'applied',
      goalId: 'goal-ops',
      goalRevision: 4,
    },
    ...overrides,
  }
}

function resumedGoal(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: GoalId('goal-ops'),
    revision: 5,
    objective: OBJECTIVE,
    phase: 'active',
    activation: 'armed',
    maxGoalRounds: 16,
    roundsStarted: 3,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('AutoLab role Goal revision projection', () => {
  it('keeps result submission exact after a native API-recovery resume edge', () => {
    const resumed = resumedGoal()
    const current = role()
    expect(roleOwnsExactAssignmentGoal(current, resumed)).toBe(false)

    const projected = projectRoleGoalRevision({ roles: { ops: current } }, {
      sessionId: 'ops-session',
      goalId: String(resumed.id),
      goalRevision: resumed.revision,
      objectiveHash: sha256(resumed.objective),
    })

    expect(projected?.roleId).toBe('ops')
    expect(projected?.roles.ops?.goalInstall?.goalRevision).toBe(5)
    expect(roleOwnsExactAssignmentGoal(projected!.roles.ops!, resumed)).toBe(true)
  })

  it('ignores stale, ambiguous, wrong-Session, and wrong-objective edges', () => {
    const current = role()
    const exact = {
      sessionId: 'ops-session',
      goalId: 'goal-ops',
      goalRevision: 5,
      objectiveHash: sha256(OBJECTIVE),
    }
    expect(projectRoleGoalRevision({ roles: { ops: current } }, {
      ...exact,
      goalRevision: 4,
    })).toBeUndefined()
    expect(projectRoleGoalRevision({ roles: { ops: current } }, {
      ...exact,
      sessionId: 'another-session',
    })).toBeUndefined()
    expect(projectRoleGoalRevision({ roles: { ops: current } }, {
      ...exact,
      objectiveHash: sha256('different objective'),
    })).toBeUndefined()
    expect(projectRoleGoalRevision({ roles: { ops: current, duplicate: current } }, exact))
      .toBeUndefined()
  })
})
