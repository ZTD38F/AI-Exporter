# Domain type boundaries

L1 owns provider interpretation: raw JSON/JSPB, source-specific shapes, timestamp
strings and unsupported-payload formatting. `src/l1/parsers/shared/time.ts` converts
source timestamps to safe epoch-millisecond integers. Domain and downstream code
consume those numbers; they do not interpret provider time strings.

L2 does not depend on L1, directly or through runtime helpers. Its admission/read
operations may use L3a persistence ports. The semantic-layer architecture gate
walks those dependencies and rejects paths back into L1.

## Validation and evidence

Persistence and IPC are separate trust boundaries. They cannot preserve an
in-memory proof, so their L2 decoders deliberately accept `unknown`. The authenticated
Background Detail IPC adapter calls the shared `restoreDomainDetail` decoder and
checks the request identity before calling typed L2 admission. The decoder and
reference-closure schema remain owned by L2. Architecture checks authorize this
specific ingress and prohibit type assertions there. Removing those
checks or asserting a raw transport value to a Domain type would weaken the
contract. Semantic variants named `unknown` also remain valid content facts.

`runtimeValidation.ts` describes every Domain field using `Check<T>` and a mapped
`Fields<T>` schema. Required schema entries include optional model fields; a new
field or an incompatible field validator causes a compile error. Recursive AST
variants have individual schemas, and schema checks precede reference closure.

Optional-field canonicalization returns `unknown`, rather than claiming a generic
transformation preserves every possible `T`. Changed graphs are checked before
use. Recovery retains the canonical Index returned by its decoder, omits undefined
optional fields and leaves the input untouched. Canonical Detail graphs retain
their references; the conversation wrapper and decoded Index are rebuilt.

A private WeakSet records validated body identity only after schema, closure and
conversation identity checks. Registration supplies compile-time evidence directly;
a lookup predicate reuses it for validated bodies. Clone/IPC copies must validate again.

## Downstream contracts and gates

L2, L3a, L3b, Application and L4 have no type-cast expressions or non-null assertions.
Compiler-based architecture tests reject their reintroduction, including ordinary
casts unrelated to the Domain brand. Type-aware lint rejects implicit `any` flow
through all five owners as well as explicit `any`.

ChatGPT, Claude and Grok content listeners receive `MessageEvent<unknown>` and
validate the source, origin and capture envelope before queuing its payload.
Provider payloads remain unknown until their existing source decoders run; the
same strict type-aware lint gate covers these three listener owners.

Badge IPC replies are unknown at receipt. Count replies must prove `ok: true`
and a nonnegative integer before updating account-scoped state. Position replies
must prove `ok: true`; only string errors reach presentation. The same strict
type-aware lint gate covers the Badge owner.

Live Save also decodes its Chrome reply before returning an `ExportResult` or
notifying Badge. The Runtime ingress checks counts, cancellation, failed
ConversationKeys and attachment issue fields, reconstructing only the validated
result. Application remains independent of IPC decoding; the coordinator is
covered by the same strict type-aware lint gate.

L2 coverage and detail selection operate on concrete Domain shapes (`PageObservation`
cursor evidence and `DomainConversationDetail`) rather than generic wrappers. L3a maps
each IndexedDB store name to its fixed row type via `StoreValueMap`, eliminating
unbounded store generics and result casts. PDF sandbox IPC, JSZip and Node module
loading narrow unknown values through explicit runtime predicates before use.

Application uses a discriminated pending-export type: JSON has no reading AST;
Markdown, HTML and PDF require one. Composer relationships use typed references,
with explicit failures for violated reference invariants. PDF font mounting is an
optional compiler capability declared in `IPdfCompiler`, not a cast to another
interface. File System Access preserves ordinary byte views and copies shared
memory views only when required by its native write contract.

Compile-time `typeof`, native capability detection, and validation of actual
external input are not interchangeable with unchecked casts. Generated third-party
WASM declarations under `vendor/` are excluded from the owned-source zero-any gate.

The ChatGPT file-download decoder narrows known wire fields directly at ingress,
without a dictionary assertion. Its owner is covered by the existing compiler
assertion/non-null gate and strict type-aware lint.

Claude list decoding likewise narrows each raw member directly, without a
dictionary-returning helper. UUID uniqueness, timestamp admission and wire-order
coverage keys remain at this ingress; strict type-aware lint covers the owner.

ChatGPT list decoding reads its fixed page and item fields once at ingress.
Validated optional metadata feeds pagination directly, including false and nullish
cursor semantics. This decoder uses no record assertion and is covered by both
the compiler assertion/non-null gate and strict type-aware lint.

The ChatGPT Session ingress reads user/workspace/token fields once and returns
precise identity and provider facts. Account-only callers reuse its decoded
observation; no open dictionary or raw Session is cached. The same compiler and
strict lint gates cover this decoder.

DIL object literals start as statically typed empty dictionaries and acquire a
null prototype before any property is written. Operator recognition selects the
validated token and precedence from one readonly table; escape lookup returns an
optional value from a readonly Map. No type assertion is needed in the expression
owner, which is covered by the compiler and strict lint gates.
