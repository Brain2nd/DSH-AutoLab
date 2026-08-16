import type { Agent } from '@deepseek-ai/dsh-agent'

import type { StoredRoleBinding } from './binding.js'
import {
  hashResolvedManifest,
  parseResolvedManifest,
  type ResolvedManifest,
  type RoleBinding,
} from './manifest.js'

export type AutoLabRevealState = 'sealed' | 'revealed'

/** The exact live root Agent used by the messaging provider as ACL principal. */
export interface CommunicationRoleSession {
  readonly roleId: string
  readonly agent: Agent
  /** Required for every Controller-created role; Controller is bound by the manifest. */
  readonly binding?: StoredRoleBinding
}

/** A live intended role identity that is not yet safe to admit to the Lab ACL. */
export interface CommunicationQuarantineSession {
  readonly roleId: string
  readonly agent: Agent
}

export interface CommunicationRolePolicy {
  readonly roleId: string
  readonly roleKind: RoleBinding['role_kind']
  readonly sessionId: string
  readonly agent: Agent
  readonly sendAllowed: boolean
  readonly receiveAllowed: boolean
}

export interface CommunicationTextPairPolicy {
  readonly firstRoleId: string
  readonly secondRoleId: string
  readonly firstSessionId: string
  readonly secondSessionId: string
  readonly blocked: boolean
}

export interface CommunicationAclPlan {
  readonly labId: string
  readonly manifestHash: string
  readonly aclRevision: number
  readonly revealState: AutoLabRevealState
  readonly roles: readonly CommunicationRolePolicy[]
  /** Complete Lab-internal free-text matrix. It never grants typed control. */
  readonly textPairs: readonly CommunicationTextPairPolicy[]
}

/** Narrow structural seam implemented by dsh-local-session-messaging. */
export interface CommunicationAclMessaging {
  getPermissions(caller: Agent, signal?: AbortSignal): Promise<{
    readonly sessionId: unknown
    readonly sendAllowed: boolean
    readonly receiveAllowed: boolean
  }>
  setPermissions(caller: Agent, patch: {
    readonly sendAllowed?: boolean
    readonly receiveAllowed?: boolean
  }, signal?: AbortSignal): Promise<{
    readonly sessionId: unknown
    readonly sendAllowed: boolean
    readonly receiveAllowed: boolean
  }>
  listBlockedPeers(caller: Agent, signal?: AbortSignal): Promise<readonly {
    readonly sessionId: unknown
  }[]>
  setPeerBlocked(
    caller: Agent,
    recipient: string,
    blocked: boolean,
    signal?: AbortSignal,
  ): Promise<unknown>
}

export interface ReconcileCommunicationAclInput {
  readonly manifest: ResolvedManifest
  readonly revealState: AutoLabRevealState
  readonly roleSessions: readonly CommunicationRoleSession[]
  readonly messaging: CommunicationAclMessaging
  /**
   * Recovery-only mode. Attached roles are still checked against their exact
   * Manifest/binding identity; omitted live roles are disabled before any
   * permissive mutation. The default remains a complete, strict role set.
   */
  readonly allowPartial?: boolean
  readonly quarantineSessions?: readonly CommunicationQuarantineSession[]
  /**
   * Recovery may run while the user-owned Controller Session is offline. Its
   * direction policy is invariantly enabled by Manifest validation; symmetric
   * Lab pair edges are then reconciled from the live worker endpoint.
   */
  readonly controllerOffline?: boolean
  readonly signal?: AbortSignal
}

export interface CommunicationAclReconcileResult {
  readonly plan: CommunicationAclPlan
  readonly permissionUpdates: number
  readonly textPairUpdates: number
}

export class CommunicationAclError extends Error {
  readonly name = 'CommunicationAclError'

  constructor(
    message: string,
    readonly code:
      | 'ROLE_BINDING_MISMATCH'
      | 'ACL_OBSERVATION_MISMATCH'
      | 'ACL_READ_FAILED'
      | 'ACL_APPLY_FAILED',
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Compile only from one validated, committed Manifest and its frozen role bindings. */
export function compileCommunicationAcl(input: {
  readonly manifest: ResolvedManifest
  readonly revealState: AutoLabRevealState
  readonly roleSessions: readonly CommunicationRoleSession[]
  readonly allowPartial?: boolean
}): CommunicationAclPlan {
  const manifest = parseResolvedManifest(input.manifest)
  const manifestHash = hashResolvedManifest(manifest)
  const sessions = indexRoleSessions(
    manifest,
    manifestHash,
    input.roleSessions,
    input.allowPartial === true,
  )
  const permissions = new Map(
    manifest.communication.role_permissions.map(permission => [permission.role_id, permission]),
  )
  const roles = [...manifest.roles]
    .sort((left, right) => left.role_id.localeCompare(right.role_id))
    .flatMap(role => {
      const session = sessions.get(role.role_id)
      if (session === undefined) return []
      const permission = permissions.get(role.role_id)!
      return [{
        roleId: role.role_id,
        roleKind: role.role_kind,
        sessionId: String(session.agent.id),
        agent: session.agent,
        sendAllowed: permission.send,
        receiveAllowed: permission.receive,
      }]
    })

  const roleById = new Map(manifest.roles.map(role => [role.role_id, role]))
  const textPairs: CommunicationTextPairPolicy[] = []
  for (let firstIndex = 0; firstIndex < roles.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < roles.length; secondIndex += 1) {
      const first = roles[firstIndex]!
      const second = roles[secondIndex]!
      textPairs.push({
        firstRoleId: first.roleId,
        secondRoleId: second.roleId,
        firstSessionId: first.sessionId,
        secondSessionId: second.sessionId,
        blocked: textPairBlocked(
          manifest,
          roleById.get(first.roleId)!,
          roleById.get(second.roleId)!,
          input.revealState,
        ),
      })
    }
  }

  return {
    labId: manifest.lab_id,
    manifestHash,
    aclRevision: manifest.communication.acl_revision,
    revealState: input.revealState,
    roles,
    textPairs,
  }
}

/**
 * Event-driven, idempotent projection onto the existing messaging provider.
 * Tightening finishes before any widening, so a failed run never continues by
 * opening another edge. A later call re-reads provider state and resumes safely.
 */
export async function reconcileCommunicationAcl(
  input: ReconcileCommunicationAclInput,
): Promise<CommunicationAclReconcileResult> {
  input.signal?.throwIfAborted()
  const plan = compileCommunicationAcl(input)
  const quarantine = indexQuarantineSessions(input, plan)
  const managedRoles = input.controllerOffline === true
    ? plan.roles.filter(role => role.roleKind !== 'controller')
    : plan.roles
  let observations: readonly RoleObservation[]
  try {
    observations = await Promise.all(managedRoles.map(async role => {
      const [permission, blockedPeers] = await Promise.all([
        input.messaging.getPermissions(role.agent, input.signal),
        input.messaging.listBlockedPeers(role.agent, input.signal),
      ])
      if (String(permission.sessionId) !== role.sessionId) {
        throw new CommunicationAclError(
          `messaging resolved role ${JSON.stringify(role.roleId)} to Session ${JSON.stringify(String(permission.sessionId))}, not ${JSON.stringify(role.sessionId)}`,
          'ACL_OBSERVATION_MISMATCH',
        )
      }
      return {
        role,
        sendAllowed: permission.sendAllowed,
        receiveAllowed: permission.receiveAllowed,
        blockedPeerIds: new Set(blockedPeers.map(peer => String(peer.sessionId))),
      }
    }))
  } catch (error) {
    if (error instanceof CommunicationAclError) throw error
    throw new CommunicationAclError('failed to read the current messaging ACL', 'ACL_READ_FAILED', {
      cause: error,
    })
  }
  input.signal?.throwIfAborted()

  const observationByRole = new Map(observations.map(value => [value.role.roleId, value]))
  const currentlyBlocked = new Set<string>()
  for (const pair of plan.textPairs) {
    const first = observationByRole.get(pair.firstRoleId)
    const second = observationByRole.get(pair.secondRoleId)
    if (first?.blockedPeerIds.has(pair.secondSessionId) === true
      || second?.blockedPeerIds.has(pair.firstSessionId) === true) {
      currentlyBlocked.add(rolePairKey(pair.firstRoleId, pair.secondRoleId))
    }
  }

  const restrictive: AclMutation[] = []
  const permissive: AclMutation[] = []
  let permissionUpdates = 0
  let textPairUpdates = 0

  let quarantinePermissions: readonly {
    readonly roleId: string
    readonly agent: Agent
    readonly sessionId: string
    readonly sendAllowed: boolean
    readonly receiveAllowed: boolean
  }[]
  try {
    quarantinePermissions = await Promise.all(quarantine.map(async role => {
      const permission = await input.messaging.getPermissions(role.agent, input.signal)
      const sessionId = String(role.agent.id)
      if (String(permission.sessionId) !== sessionId) {
        throw new CommunicationAclError(
          `messaging resolved quarantined role ${JSON.stringify(role.roleId)} to Session ${JSON.stringify(String(permission.sessionId))}, not ${JSON.stringify(sessionId)}`,
          'ACL_OBSERVATION_MISMATCH',
        )
      }
      return {
        roleId: role.roleId,
        agent: role.agent,
        sessionId,
        sendAllowed: permission.sendAllowed,
        receiveAllowed: permission.receiveAllowed,
      }
    }))
  } catch (error) {
    if (error instanceof CommunicationAclError) throw error
    throw new CommunicationAclError(
      'failed to read a live unattached role before ACL quarantine',
      'ACL_READ_FAILED',
      { cause: error },
    )
  }

  for (const role of quarantinePermissions) {
    if (!role.sendAllowed && !role.receiveAllowed) continue
    const patch = { sendAllowed: false, receiveAllowed: false } as const
    restrictive.push({
      label: `quarantine role ${role.roleId}`,
      run: async () => {
        const result = await input.messaging.setPermissions(role.agent, patch, input.signal)
        assertPermissionResult(role, patch, result)
        permissionUpdates += 1
      },
    })
  }

  for (const observation of observations) {
    const restrictivePatch = permissionPatch(observation, observation.role, false)
    if (restrictivePatch !== undefined) {
      restrictive.push({
        label: `restrict role ${observation.role.roleId}`,
        run: async () => {
          const result = await input.messaging.setPermissions(
            observation.role.agent,
            restrictivePatch,
            input.signal,
          )
          assertPermissionResult(observation.role, restrictivePatch, result)
          permissionUpdates += 1
        },
      })
    }
    const permissivePatch = permissionPatch(observation, observation.role, true)
    if (permissivePatch !== undefined) {
      permissive.push({
        label: `enable role ${observation.role.roleId}`,
        run: async () => {
          const result = await input.messaging.setPermissions(
            observation.role.agent,
            permissivePatch,
            input.signal,
          )
          assertPermissionResult(observation.role, permissivePatch, result)
          permissionUpdates += 1
        },
      })
    }
  }

  for (const pair of plan.textPairs) {
    const current = currentlyBlocked.has(rolePairKey(pair.firstRoleId, pair.secondRoleId))
    if (current === pair.blocked) continue
    const caller = observationByRole.get(pair.firstRoleId)?.role
      ?? observationByRole.get(pair.secondRoleId)?.role
    if (caller === undefined) {
      throw new CommunicationAclError(
        `no live ACL principal can reconcile ${JSON.stringify(pair.firstRoleId)}<->${JSON.stringify(pair.secondRoleId)}`,
        'ACL_OBSERVATION_MISMATCH',
      )
    }
    const mutation: AclMutation = {
      label: `${pair.blocked ? 'block' : 'unblock'} text ${pair.firstRoleId}<->${pair.secondRoleId}`,
      run: async () => {
        await input.messaging.setPeerBlocked(
          caller.agent,
          caller.roleId === pair.firstRoleId ? pair.secondSessionId : pair.firstSessionId,
          pair.blocked,
          input.signal,
        )
        textPairUpdates += 1
      },
    }
    if (pair.blocked) restrictive.push(mutation)
    else permissive.push(mutation)
  }

  await applyPhase(restrictive, 'tighten')
  await applyPhase(permissive, 'widen')
  return { plan, permissionUpdates, textPairUpdates }
}

interface RoleObservation {
  readonly role: CommunicationRolePolicy
  readonly sendAllowed: boolean
  readonly receiveAllowed: boolean
  readonly blockedPeerIds: ReadonlySet<string>
}

interface PermissionPatch {
  readonly sendAllowed?: boolean
  readonly receiveAllowed?: boolean
}

interface AclMutation {
  readonly label: string
  readonly run: () => Promise<void>
}

function indexRoleSessions(
  manifest: ResolvedManifest,
  manifestHash: string,
  values: readonly CommunicationRoleSession[],
  allowPartial: boolean,
): Map<string, CommunicationRoleSession> {
  const sessions = new Map<string, CommunicationRoleSession>()
  const sessionOwners = new Map<string, string>()
  for (const value of values) {
    if (sessions.has(value.roleId)) {
      throw bindingMismatch(`duplicate communication binding for role ${JSON.stringify(value.roleId)}`)
    }
    sessions.set(value.roleId, value)
  }
  const controller = manifest.roles.find(role => role.role_kind === 'controller')
  if (controller === undefined || !sessions.has(controller.role_id)) {
    throw bindingMismatch('communication reconciliation requires the Controller role identity')
  }
  for (const role of manifest.roles) {
    const value = sessions.get(role.role_id)
    if (value === undefined) {
      if (allowPartial) continue
      throw bindingMismatch(`missing communication binding for role ${JSON.stringify(role.role_id)}`)
    }
    const sessionId = String(value.agent.id)
    const previousOwner = sessionOwners.get(sessionId)
    if (previousOwner !== undefined) {
      throw bindingMismatch(
        `roles ${JSON.stringify(previousOwner)} and ${JSON.stringify(role.role_id)} share Session ${JSON.stringify(sessionId)}`,
      )
    }
    sessionOwners.set(sessionId, role.role_id)
    if (role.prebound_session_id !== undefined && role.prebound_session_id !== sessionId) {
      throw bindingMismatch(
        `role ${JSON.stringify(role.role_id)} is prebound to Session ${JSON.stringify(role.prebound_session_id)}, not ${JSON.stringify(sessionId)}`,
      )
    }
    if (role.role_kind === 'controller') {
      if (value.binding !== undefined) {
        throw bindingMismatch('Controller communication authority comes from its manifest prebinding')
      }
      continue
    }
    const binding = value.binding
    if (binding === undefined) {
      throw bindingMismatch(`role ${JSON.stringify(role.role_id)} has no frozen RoleBindingReceipt`)
    }
    const receipt = binding.receipt
    if (binding.hash !== receipt.receiptHash
      || receipt.labId !== manifest.lab_id
      || receipt.manifestHash !== manifestHash
      || receipt.roleId !== role.role_id
      || receipt.roleKind !== role.role_kind
      || receipt.sessionId !== sessionId) {
      throw bindingMismatch(`frozen RoleBindingReceipt does not authorize role ${JSON.stringify(role.role_id)} on Session ${JSON.stringify(sessionId)}`)
    }
  }
  for (const roleId of sessions.keys()) {
    if (!manifest.roles.some(role => role.role_id === roleId)) {
      throw bindingMismatch(`communication binding references unknown role ${JSON.stringify(roleId)}`)
    }
  }
  return sessions
}

function indexQuarantineSessions(
  input: ReconcileCommunicationAclInput,
  plan: CommunicationAclPlan,
): readonly CommunicationQuarantineSession[] {
  const values = input.quarantineSessions ?? []
  if (values.length === 0) return []
  if (input.allowPartial !== true) {
    throw bindingMismatch('live role quarantine is only valid during explicit partial recovery')
  }
  const manifestRoles = new Map(input.manifest.roles.map(role => [role.role_id, role]))
  const attachedRoleIds = new Set(plan.roles.map(role => role.roleId))
  const attachedSessionIds = new Set(plan.roles.map(role => role.sessionId))
  const roles = new Set<string>()
  const sessions = new Set<string>()
  for (const value of values) {
    const role = manifestRoles.get(value.roleId)
    const sessionId = String(value.agent.id)
    if (role === undefined
      || role.role_kind === 'controller'
      || attachedRoleIds.has(value.roleId)
      || attachedSessionIds.has(sessionId)
      || roles.has(value.roleId)
      || sessions.has(sessionId)
      || (role.prebound_session_id !== undefined && role.prebound_session_id !== sessionId)) {
      throw bindingMismatch(
        `invalid live quarantine identity for role ${JSON.stringify(value.roleId)} on Session ${JSON.stringify(sessionId)}`,
      )
    }
    roles.add(value.roleId)
    sessions.add(sessionId)
  }
  return values
}

function textPairBlocked(
  manifest: ResolvedManifest,
  first: RoleBinding,
  second: RoleBinding,
  revealState: AutoLabRevealState,
): boolean {
  // This invariant takes precedence over every configurable text rule.
  if (first.role_kind === 'controller' || second.role_kind === 'controller') return false

  if (manifest.communication.text_pair_blocks.some(block => {
    const [left, right] = block.role_ids
    const samePair = left === first.role_id && right === second.role_id
      || left === second.role_id && right === first.role_id
    return samePair && blockActive(block.active_when, revealState)
  })) return true

  if (sameLane(first, second)
    && isMethodCoderPair(first, second)
    && manifest.communication.text_method_coder_within_lane === 'blocked') {
    return true
  }

  const firstLane = laneId(first)
  const secondLane = laneId(second)
  if (firstLane !== undefined && secondLane !== undefined && firstLane !== secondLane) {
    const policy = revealState === 'sealed'
      ? manifest.communication.reveal_policy.text_cross_lane_before_reveal
      : manifest.communication.reveal_policy.text_cross_lane_after_reveal
    if (policy === 'blocked') return true
  }

  const coordinator = first.role_kind === 'coordinator'
    ? first
    : second.role_kind === 'coordinator' ? second : undefined
  const laneRole = coordinator === first ? second : coordinator === second ? first : undefined
  if (coordinator !== undefined && laneRole !== undefined && laneId(laneRole) !== undefined) {
    const visibility = manifest.communication.coordinator_visibility
    if (visibility === 'runtime_only') return true
    if (visibility === 'revealed' && revealState === 'sealed') return true
  }
  return false
}

function blockActive(
  activeWhen: 'before_reveal' | 'after_reveal' | 'always',
  revealState: AutoLabRevealState,
): boolean {
  return activeWhen === 'always'
    || activeWhen === 'before_reveal' && revealState === 'sealed'
    || activeWhen === 'after_reveal' && revealState === 'revealed'
}

function sameLane(first: RoleBinding, second: RoleBinding): boolean {
  const firstLane = laneId(first)
  return firstLane !== undefined && firstLane === laneId(second)
}

function laneId(role: RoleBinding): string | undefined {
  return 'lane_id' in role ? role.lane_id : undefined
}

function isMethodCoderPair(first: RoleBinding, second: RoleBinding): boolean {
  return first.role_kind === 'method' && second.role_kind === 'coder'
    || first.role_kind === 'coder' && second.role_kind === 'method'
}

function permissionPatch(
  current: Pick<RoleObservation, 'sendAllowed' | 'receiveAllowed'>,
  desired: Pick<CommunicationRolePolicy, 'sendAllowed' | 'receiveAllowed'>,
  enabling: boolean,
): PermissionPatch | undefined {
  const patch: { sendAllowed?: boolean; receiveAllowed?: boolean } = {}
  if (current.sendAllowed !== desired.sendAllowed && desired.sendAllowed === enabling) {
    patch.sendAllowed = desired.sendAllowed
  }
  if (current.receiveAllowed !== desired.receiveAllowed && desired.receiveAllowed === enabling) {
    patch.receiveAllowed = desired.receiveAllowed
  }
  return patch.sendAllowed === undefined && patch.receiveAllowed === undefined ? undefined : patch
}

function assertPermissionResult(
  role: Pick<CommunicationRolePolicy, 'roleId' | 'sessionId'>,
  patch: PermissionPatch,
  result: { readonly sessionId: unknown; readonly sendAllowed: boolean; readonly receiveAllowed: boolean },
): void {
  if (String(result.sessionId) !== role.sessionId
    || patch.sendAllowed !== undefined && result.sendAllowed !== patch.sendAllowed
    || patch.receiveAllowed !== undefined && result.receiveAllowed !== patch.receiveAllowed) {
    throw new CommunicationAclError(
      `messaging did not apply the exact permission patch for role ${JSON.stringify(role.roleId)}`,
      'ACL_OBSERVATION_MISMATCH',
    )
  }
}

async function applyPhase(mutations: readonly AclMutation[], phase: 'tighten' | 'widen'): Promise<void> {
  if (mutations.length === 0) return
  const results = await Promise.allSettled(mutations.map(mutation => mutation.run()))
  const failureIndex = results.findIndex(result => result.status === 'rejected')
  if (failureIndex < 0) return
  const result = results[failureIndex] as PromiseRejectedResult
  throw new CommunicationAclError(
    `failed to ${mutations[failureIndex]!.label}; ACL ${phase} phase stopped`,
    'ACL_APPLY_FAILED',
    { cause: result.reason },
  )
}

function rolePairKey(firstRoleId: string, secondRoleId: string): string {
  return firstRoleId < secondRoleId
    ? `${firstRoleId}\0${secondRoleId}`
    : `${secondRoleId}\0${firstRoleId}`
}

function bindingMismatch(message: string): CommunicationAclError {
  return new CommunicationAclError(message, 'ROLE_BINDING_MISMATCH')
}
