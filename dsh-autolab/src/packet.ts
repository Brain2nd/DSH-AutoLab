import { isAbsolute } from 'node:path'

import { z } from 'zod'

import { sha256 } from './artifacts.js'
import {
  canonicalJson,
  resolvedManifestSchema,
  type ResolvedManifest,
  type RoleBinding,
} from './manifest.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const idSchema = z.string().min(1)
const hashSchema = z.string().regex(SHA256_PATTERN)
const absolutePathSchema = z.string().min(1).refine(isAbsolute, 'path must be absolute')

export const verbatimBlockSchema = z.object({
  block_id: idSchema,
  source_path: absolutePathSchema,
  exact_text: z.string(),
  text_sha256: hashSchema,
  byte_range: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict().superRefine((block, context) => {
  if (block.text_sha256 !== sha256(block.exact_text)) {
    context.addIssue({ code: 'custom', path: ['text_sha256'], message: 'text_sha256 does not match exact_text bytes' })
  }
  if (block.byte_range !== undefined && block.byte_range.end < block.byte_range.start) {
    context.addIssue({ code: 'custom', path: ['byte_range', 'end'], message: 'byte range end precedes start' })
  }
})

const verbatimBlocksSchema = z.object({
  universal: z.array(verbatimBlockSchema).min(1),
  role: z.array(verbatimBlockSchema).min(1),
  lane: z.array(verbatimBlockSchema),
  stage: z.array(verbatimBlockSchema),
  assignment: z.array(verbatimBlockSchema).min(1),
}).strict()

const hashedRefSchema = z.object({
  id: idSchema,
  sha256: hashSchema,
}).strict()

const artifactRefSchema = z.object({
  artifact_id: idSchema,
  path: absolutePathSchema,
  sha256: hashSchema,
}).strict()

const incumbentSchema = z.object({
  ref: idSchema,
  sha256: hashSchema,
}).strict()

const outputContractSchema = z.object({
  schema: z.json(),
  receipt_path: absolutePathSchema,
  expected_hash_binding: idSchema,
}).strict()

const compileInputSchema = z.object({
  manifest: resolvedManifestSchema,
  role_id: idSchema,
  session_id: idSchema,
  assignment_id: idSchema,
  issued_at: z.number().int().nonnegative(),
  role_binding_receipt_sha256: hashSchema,
  runtime_revision: z.number().int().nonnegative(),
  fact_set_sha256: hashSchema,
  evidence_index_sha256: hashSchema,
  assignment_contract_sha256: hashSchema,
  reveal_state: z.enum(['sealed', 'revealed']),
  verbatim_blocks: verbatimBlocksSchema,
  incumbent: incumbentSchema.optional(),
  relevant_fact_refs: z.array(hashedRefSchema),
  evidence_refs: z.array(hashedRefSchema),
  open_obligation_refs: z.array(idSchema),
  input_artifact_refs: z.array(artifactRefSchema),
  output_contract: outputContractSchema,
}).strict()

const packetPairBlockSchema = z.object({
  other_role_id: idSchema,
  active_when: z.enum(['before_reveal', 'after_reveal', 'always']),
}).strict()

export const rolePacketSchema = z.object({
  header: z.object({
    packet_schema_version: z.literal(1),
    lab_id: idSchema,
    lane_id: idSchema.nullable(),
    role_id: idSchema,
    role_kind: z.enum([
      'controller',
      'method',
      'coder',
      'preflight_judge',
      'postflight_judge',
      'ops',
      'coordinator',
    ]),
    session_id: idSchema,
    assignment_id: idSchema,
    issued_at: z.number().int().nonnegative(),
  }).strict(),
  anchors: z.object({
    source_revision: z.number().int().positive(),
    dialogue_head_sha256: hashSchema,
    lab_spec_sha256: hashSchema,
    lab_yaml_sha256: hashSchema,
    resolved_manifest_sha256: hashSchema,
    campaign_contract_sha256: hashSchema,
    role_binding_receipt_sha256: hashSchema,
    runtime_revision: z.number().int().nonnegative(),
    fact_set_sha256: hashSchema,
    evidence_index_sha256: hashSchema,
    assignment_contract_sha256: hashSchema,
  }).strict(),
  authority_paths: z.object({
    lab_dir: absolutePathSchema,
    creation_log: absolutePathSchema,
    lab_spec: absolutePathSchema,
    lab_yaml: absolutePathSchema,
    resolved_manifest: absolutePathSchema,
    fact_set: absolutePathSchema,
    evidence_index: absolutePathSchema,
    assignment_root: absolutePathSchema,
    worktree_root: absolutePathSchema,
    repository: absolutePathSchema,
    artifact_root: absolutePathSchema,
    run_root: absolutePathSchema,
  }).strict(),
  role_binding: z.object({
    prompt_sha256: hashSchema,
    lane_charter_sha256: hashSchema.nullable(),
    model_route: z.object({
      route_id: idSchema,
      provider: idSchema,
      model: idSchema,
      config: z.record(z.string(), z.json()),
    }).strict(),
    fallback_routes: z.array(z.object({
      route_id: idSchema,
      provider: idSchema,
      model: idSchema,
      config: z.record(z.string(), z.json()),
    }).strict()),
    reasoning: z.object({
      mode: idSchema,
      config: z.record(z.string(), z.json()),
    }).strict(),
  }).strict(),
  verbatim_blocks: verbatimBlocksSchema,
  runtime_snapshot: z.object({
    reveal_state: z.enum(['sealed', 'revealed']),
    incumbent: incumbentSchema.optional(),
    relevant_fact_refs: z.array(hashedRefSchema),
    evidence_refs: z.array(hashedRefSchema),
    open_obligation_refs: z.array(idSchema),
    input_artifact_refs: z.array(artifactRefSchema),
  }).strict(),
  capability_scope: z.object({
    tools: z.array(idSchema),
    worktree: absolutePathSchema.nullable(),
    dsh_preset_ref: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    communication: z.object({
      acl_revision: z.number().int().nonnegative(),
      topology: z.enum(['lane_isolated', 'coordinated']),
      controller_visibility: z.literal('global'),
      send: z.boolean(),
      receive: z.boolean(),
      text_method_coder_within_lane: z.enum(['allowed', 'blocked']),
      text_cross_lane_before_reveal: z.enum(['blocked', 'allowed']),
      text_cross_lane_after_reveal: z.enum(['blocked', 'allowed']),
      reveal_trigger: z.enum(['manual', 'cohort_barrier', 'immediate']),
      text_pair_blocks: z.array(packetPairBlockSchema),
    }).strict(),
  }).strict(),
  output_contract: outputContractSchema,
}).strict()

export type VerbatimBlock = z.infer<typeof verbatimBlockSchema>
export type RolePacket = z.infer<typeof rolePacketSchema>
export type CompileRolePacketInput = z.input<typeof compileInputSchema>

export interface CompiledRolePacket {
  readonly packet: RolePacket
  readonly canonicalJson: string
  readonly packetHash: string
}

export class PacketValidationError extends Error {
  readonly name = 'PacketValidationError'
  readonly code = 'INVALID_PACKET'

  constructor(message: string, readonly issues: readonly z.core.$ZodIssue[] = []) {
    super(message)
  }
}

export function compileRolePacket(value: CompileRolePacketInput): CompiledRolePacket {
  const parsed = compileInputSchema.safeParse(value)
  if (!parsed.success) {
    throw new PacketValidationError(formatIssues(parsed.error.issues), parsed.error.issues)
  }
  const input = parsed.data
  const role = input.manifest.roles.find(candidate => candidate.role_id === input.role_id)
  if (role === undefined) throw new PacketValidationError(`unknown role ${input.role_id}`)
  if (role.prebound_session_id !== undefined && role.prebound_session_id !== input.session_id) {
    throw new PacketValidationError(
      `role ${role.role_id} is prebound to SessionId ${role.prebound_session_id}, not ${input.session_id}`,
    )
  }

  validateBlocks(input.verbatim_blocks, role, input.manifest)
  const permission = input.manifest.communication.role_permissions.find(
    candidate => candidate.role_id === role.role_id,
  )
  if (permission === undefined) {
    throw new PacketValidationError(`manifest has no communication permission for ${role.role_id}`)
  }

  const packet: RolePacket = {
    header: {
      packet_schema_version: 1,
      lab_id: input.manifest.lab_id,
      lane_id: laneId(role),
      role_id: role.role_id,
      role_kind: role.role_kind,
      session_id: input.session_id,
      assignment_id: input.assignment_id,
      issued_at: input.issued_at,
    },
    anchors: {
      source_revision: input.manifest.source_revision,
      dialogue_head_sha256: input.manifest.anchors.dialogue_head_sha256,
      lab_spec_sha256: input.manifest.anchors.lab_spec_sha256,
      lab_yaml_sha256: input.manifest.anchors.lab_yaml_sha256,
      resolved_manifest_sha256: sha256(canonicalJson(input.manifest)),
      campaign_contract_sha256: input.manifest.campaign_contract_sha256,
      role_binding_receipt_sha256: input.role_binding_receipt_sha256,
      runtime_revision: input.runtime_revision,
      fact_set_sha256: input.fact_set_sha256,
      evidence_index_sha256: input.evidence_index_sha256,
      assignment_contract_sha256: input.assignment_contract_sha256,
    },
    authority_paths: {
      ...input.manifest.authority_paths,
      repository: input.manifest.repository.path,
      artifact_root: input.manifest.evidence.artifact_root,
      run_root: input.manifest.execution.run_root,
    },
    role_binding: {
      prompt_sha256: role.prompt_sha256,
      lane_charter_sha256: roleLaneCharterHash(input.manifest, role),
      model_route: role.model_route,
      fallback_routes: role.fallback_routes,
      reasoning: role.reasoning,
    },
    verbatim_blocks: input.verbatim_blocks,
    runtime_snapshot: {
      ...(input.incumbent === undefined ? {} : { incumbent: input.incumbent }),
      reveal_state: input.reveal_state,
      relevant_fact_refs: input.relevant_fact_refs,
      evidence_refs: input.evidence_refs,
      open_obligation_refs: input.open_obligation_refs,
      input_artifact_refs: input.input_artifact_refs,
    },
    capability_scope: {
      tools: role.allowed_tools,
      worktree: roleWorktree(role),
      dsh_preset_ref: role.dsh_preset,
      communication: {
        acl_revision: input.manifest.communication.acl_revision,
        topology: input.manifest.communication.topology,
        controller_visibility: input.manifest.communication.controller_visibility,
        send: permission.send,
        receive: permission.receive,
        text_method_coder_within_lane: input.manifest.communication.text_method_coder_within_lane,
        text_cross_lane_before_reveal: input.manifest.communication.reveal_policy.text_cross_lane_before_reveal,
        text_cross_lane_after_reveal: input.manifest.communication.reveal_policy.text_cross_lane_after_reveal,
        reveal_trigger: input.manifest.communication.reveal_policy.trigger,
        text_pair_blocks: relevantPairBlocks(input.manifest, role.role_id),
      },
    },
    output_contract: input.output_contract,
  }
  const encoded = canonicalJson(packet)
  return { packet, canonicalJson: encoded, packetHash: sha256(encoded) }
}

export function parseRolePacket(value: unknown): RolePacket {
  const parsed = rolePacketSchema.safeParse(value)
  if (!parsed.success) {
    throw new PacketValidationError(formatIssues(parsed.error.issues), parsed.error.issues)
  }
  return parsed.data
}

export function hashRolePacket(value: unknown): string {
  return sha256(canonicalJson(parseRolePacket(value)))
}

function validateBlocks(
  blocks: z.infer<typeof verbatimBlocksSchema>,
  role: RoleBinding,
  manifest: ResolvedManifest,
): void {
  if ('lane_id' in role && blocks.lane.length === 0) {
    throw new PacketValidationError(`lane role ${role.role_id} requires an exact LaneCharter block`)
  }
  const charterHash = roleLaneCharterHash(manifest, role)
  if (charterHash !== null && !blocks.lane.some(block => block.text_sha256 === charterHash)) {
    throw new PacketValidationError(`lane blocks do not include LaneCharter bytes for ${role.role_id}`)
  }
  if (!blocks.role.some(block => block.text_sha256 === role.prompt_sha256)) {
    throw new PacketValidationError(`role blocks do not include prompt bytes for ${role.role_id}`)
  }
  const ids = new Set<string>()
  for (const group of Object.values(blocks)) {
    for (const block of group) {
      if (ids.has(block.block_id)) {
        throw new PacketValidationError(`duplicate verbatim block id ${block.block_id}`)
      }
      ids.add(block.block_id)
    }
  }
}

function laneId(role: RoleBinding): string | null {
  return 'lane_id' in role ? role.lane_id : null
}

function roleWorktree(role: RoleBinding): string | null {
  return role.role_kind === 'method' || role.role_kind === 'coder'
    ? role.worktree_path
    : null
}

function roleLaneCharterHash(manifest: ResolvedManifest, role: RoleBinding): string | null {
  if (!('lane_id' in role)) return null
  return manifest.search.lane_charters.find(charter => charter.lane_id === role.lane_id)!.charter_sha256
}

function relevantPairBlocks(
  manifest: ResolvedManifest,
  roleId: string,
): Array<{ other_role_id: string; active_when: 'before_reveal' | 'after_reveal' | 'always' }> {
  return manifest.communication.text_pair_blocks.flatMap(block => {
    const [first, second] = block.role_ids
    if (first === roleId) return [{ other_role_id: second, active_when: block.active_when }]
    if (second === roleId) return [{ other_role_id: first, active_when: block.active_when }]
    return []
  }).sort((left, right) => (
    left.other_role_id.localeCompare(right.other_role_id)
    || left.active_when.localeCompare(right.active_when)
  ))
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
}
