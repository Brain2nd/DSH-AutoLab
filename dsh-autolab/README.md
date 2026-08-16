# dsh-autolab

`dsh-autolab` is a lightweight, durable autoresearch controller plugin for
DeepSeek Harness. It reuses DSH's native Session, Goal, Agent, command,
permission, subprocess, and storage primitives instead of building a second
agent runtime or workflow engine.

The governing rule is: **lightweight and fast, but robust**.

> Status: this checkout implements the Runtime Kernel, Controller surface,
> role/review flow, local Attempt execution and event-driven recovery described
> below for DSH `0.1.0-rc.6`. The package is currently installed from a local
> checkout rather than published to a registry.

## Architecture

```text
user
  ↕
Controller Session (the current Session that runs /autolab create; LLM owner)
  ↕ DSH-native Session / Goal / tool / event
Runtime Kernel (deterministic plugin layer; no LLM role)
  ├─ Method Session ─ Coder Session ─ independent Lane worktree
  ├─ Preflight Judge Session
  ├─ Postflight Judge Session
  ├─ Ops Session
  └─ optional Coordinator Session
```

The `Controller Session` is the user's existing `/autolab create` conversation.
It remains the Lab owner, user interface, global status/query surface, and the
agent that continues already-authorized research when the user is away. There
is no separate Lab Director, background Controller Agent, or second Controller
Session.

Operational failures are mechanical-first. Known API, Session, process, SSH,
hardware, and environment recovery runs in the Runtime Kernel without an LLM.
Ops or Controller is woken only when no safe mechanical action remains, a
mechanical repair has actually failed, or new credentials, authorization, or a
semantic decision are required.

The non-LLM layer is called the `Runtime Kernel`. It owns only deterministic
plumbing: stable identities, persistence, communication bindings, Goal
operations, minimal execution lineage, idempotent effects, and event-driven
recovery. It does not make scientific decisions.

## Roles

- **Controller** creates and owns the Lab, communicates with the user, sees the
  whole Lab, and coordinates authorized work. Whether it should select research
  routes for the user is an optional Lab decision, never an implied authority.
  User input always has priority.
- **Method** proposes methods while preserving hard constraints and known
  facts, and separates method, feature/lens, implementation, measurement, and
  environment explanations.
- **Coder** implements an approved method in its Lane worktree without silently
  changing it. For a small experiment it runs the target experiment directly;
  it does not insert a preliminary smoke test or invent a new gate, prerequisite,
  or approval. Checks explicitly required by the Lab and reviews owned by other
  roles still apply.
- **Preflight Judge** independently checks a proposed method against the Lab's
  original constraints before implementation or execution.
- **Postflight Judge** independently reads the Lab's raw results and evaluates
  their scientific meaning after execution.
- **Ops** handles environment, hardware, dependency, SSH, process, and recovery
  work so operational context does not pollute scientific roles.
- **Coordinator** is optional. It may coordinate research across allowed
  boundaries, but it is not the owner and cannot bypass ACL or reveal rules.
  It may select a route only when the Lab or a Controller Assignment explicitly
  delegates that choice; otherwise it returns the original options.

## Implemented research flow

The Controller explicitly selects each next responsibility; the Runtime Kernel
never promotes a scientific route itself.

```text
Method Assignment → Method Design Ticket → Preflight review
  ├─ APPROVED → exact Coder Assignment → Candidate
  └─ REVISION_REQUIRED / REJECTED → exact next Method Assignment

Candidate → Trial / RunSlot → Attempt → Postflight review → Controller
```

`AutoLabAssignMethod` keeps the same Method Session. It can start a next
Assignment from a paused Method, or resolve one exact `REVISION_REQUIRED` /
`REJECTED` Preflight review. In the latter case Runtime automatically binds the
original verdict path and hash without reading its scientific contents, installs
the new native Goal, durably records the review resolution, and only then
releases the review hold.

Ops and an enabled Coordinator use opaque Controller-authored Assignments and
return opaque receipts. Method, Coder, and both Judges retain their dedicated
submission protocols. A local technical retry creates a new Attempt in the same
Trial/RunSlot/Candidate lineage and binds its exact host, argv, and environment;
it does not infer checkpoint or scientific resume semantics.

## Durable anchors

The verbatim creation dialogue, `LAB_SPEC.md`, committed configuration,
revisions, decisions, role packets, and current facts are active inputs to
normal operation. They are not merely restart backups.

Every later Session, Assignment, Role Packet, Goal, review, status query, and
recovery action is derived from those anchors plus current progress. Long or
compacted chat context is never the sole source of goals, constraints, facts,
or decisions. User-facing configuration and revisions remain available in full
original form, not only as summaries.

## Lanes and communication

Each Method/Coder pair belongs to an independent Lane with its own Git
worktree. The number of pairs may exceed the number of GPUs; execution capacity
does not define the research topology.

Send and receive permissions are explicit per role and Lane through
`dsh-local-session-messaging`. ACL and pair blocks can prevent isolated research
directions from communicating until the user-authorized reveal point. The
Controller remains globally visible to the user and can inspect every Lane.

## Review handshake

A review uses one fixed handshake:

```text
review request
  → Judge sends one fixed ACK: received, reviewing
  → reviewed Session is instructed to pause its Goal
  → active-Session freeze is a fallback if it did not stop itself
  → Judge returns the verdict
  → the next responsible Session receives a Goal rebuilt from anchors and
    personalized with current progress
```

The ACK and pause are deterministic protocol actions, not an extra LLM review.
Judges do not keep polling Goals while idle.

## Execution and recovery

The Runtime Kernel preserves only the generic execution lineage:

```text
Trial → RunSlot → Attempt → candidate SHA
```

It may retain technical launch/exit state and raw result paths, but it does not
interpret metrics or scientific evidence. Session, process, tmux, SSH, and
Attempt recovery is **adopt-first**: inspect and reattach to exact existing
identity before considering another launch. Quiet logs, an idle GPU, or a lost
tmux name alone are not failure verdicts.

DSH's native bounded request retry remains responsible for retry within one
LLM turn. After a terminal API error, the Runtime Kernel consumes the real
durable terminal event, records the active incident, and uses at most one
one-shot timer to resume the same Session, Assignment, Packet, Goal or review.
There is no health probe, fixed-frequency scan, or Controller polling loop.

The Controller receives the recovered work result and recovery facts. It is
involved only after the available mechanical path cannot finish, such as when
new credentials, a provider/model choice, or user authorization is required.
Adapter/configuration change events themselves trigger an exact mechanical
continuation before another LLM escalation. Runtime
recovery never compensates Goal rounds, raises `maxGoalRounds`, changes the
scientific conclusion, or silently switches provider/model.

## Installation

Build both this plugin and its messaging dependency, then add both bundles to
the same DSH profile. The messaging bundle must be present; AutoLab does not
mount another transport as a fallback.

```bash
cd /absolute/path/to/dsh-local-session-messaging
pnpm install --ignore-scripts
pnpm verify
dsh plugin --profile web add /absolute/path/to/dsh-local-session-messaging

cd /absolute/path/to/dsh-autolab
pnpm install --ignore-scripts
pnpm verify
dsh plugin --profile web add /absolute/path/to/dsh-autolab

dsh --profile web --dump-config
dsh web
```

The human entry point is `/autolab create [config-path]`. The current Session
becomes the Controller; creation does not start roles or experiments before the
full original configuration is committed.

Research-route delegation is an optional creation choice recorded in `lab.yaml`:

```yaml
search:
  research_route_authority: user # user | autolab; omission also means user
```

`user` keeps the final choice with the user while still allowing suggestions.
`autolab` lets the Controller choose within the accepted Lab contract; it may
delegate a concrete choice to an enabled Coordinator through an Assignment.
This value guides the LLM roles and is not a Runtime Kernel gate or comparator.

## Scientific flexibility

AutoLab fixes the methodology and role boundaries, not a universal scientific
schema. Each Lab decides, in its original contract, what evidence matters and
how logs, checkpoints, metrics, evaluators, controls, or other artifacts should
be examined. The appropriate Session performs and interprets those checks.

The Runtime Kernel does not scan, parse, or hash experiment logs or
checkpoints, does not impose undeclared checks, and does not turn a generic
evaluator result into a core gate.

## Development

```bash
pnpm install
pnpm verify
```

The plugin bundle is declared by `cordis.patch.yml`. AutoLab depends on the
separate `dsh-local-session-messaging` plugin and must not mount a second
transport as a fallback.

A concrete Lab's committed original files remain its authority. This package
README never substitutes for `LAB_SPEC.md` or the Lab's creation record.
