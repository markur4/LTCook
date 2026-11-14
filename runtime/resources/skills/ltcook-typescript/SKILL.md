---
name: ltcook-typescript
description: Design or review TypeScript types and code, especially domain models, external-data boundaries, control-flow narrowing, and derived types.
license: MIT
---

# TypeScript best practices

Use types to make domain distinctions and control flow clearer, not to encode every
runtime invariant in a type. Follow the repository's existing schema, naming, and
module conventions. Keep runtime validation where data enters; internal types do
not validate values at runtime.

## Model real domain alternatives

Use a discriminated union when values have meaningfully different variants and
the discriminator determines which fields are available. This lets control flow
narrow naturally and prevents combinations that do not make sense. Do not turn
every optional property set into a union if consumers do not benefit from the
distinction.

**Example: model loading states and handle every variant.**

```ts
type LoadState<T> =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; value: T };

function describe<T>(state: LoadState<T>): string {
  switch (state.status) {
    case "loading":
      return "Loading";
    case "failed":
      return state.message;
    case "ready":
      return "Ready";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
```

A `never` assignment at an exhaustive branch makes a newly added variant visible
to the compiler. Use exhaustive handling where all alternatives require a
meaningful decision, rather than adding boilerplate to every switch.

Prefer the simplest type that supports the operations at hand. A `T[]` is often
the right choice until a particular operation needs a non-empty guarantee. Use a
non-empty tuple or another stronger type when construction and API boundaries
can preserve that invariant without scattered assertions.

## Treat incoming values as untrusted

Values from JSON, storage, network responses, environment variables, and other
untyped interfaces should enter as `unknown`, not `any`. At an established input
boundary, use the repository's schema or parser library if one exists. Parse once,
report useful validation failures, and pass the resulting domain type inward.
Do not add a schema dependency just to follow this guidance.

When no suitable schema exists and a small manual guard is appropriate, check the
properties and value constraints the claim actually requires. A type predicate
such as `value is User` promises that every successful return satisfies `User`;
name it accurately and make its implementation truthful. Prefer built-in
narrowing and discriminants where they express the check directly. A type
assertion can silence the compiler but cannot validate external data.

Do not repeat validation deep inside code after a boundary has established the
invariant. Keep `unknown` or a narrow wire-format type until conversion is
complete; do not cast arbitrary records to a domain model.

## Choose useful, honest abstractions

Let the compiler infer local values when the initializer already communicates
the type. Derive related types from their source when that prevents drift, using
utilities such as `Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, or
`typeof` where they make the relationship clearer. Add explicit annotations at
public boundaries or where inference obscures intent.

Use `satisfies` to check a value against a contract while retaining useful literal
information. Assertions are sometimes appropriate when the type system cannot
express a fact established by nearby code or an external API contract. Examples
include `as const` for intentional literal data, a DOM lookup after checking its
element, or a well-understood library boundary. Keep the reason local and narrow;
never imply that every assertion crashes at runtime. Prefer a checked conversion
or guard when data is genuinely uncertain.

Use branded primitive types only when confusing two otherwise identical
primitives is a plausible bug, such as mixing account identifiers with invoice
identifiers. Construct brands through a validation/conversion function that
establishes the distinction. Do not brand every string or number by default.

Choose positional parameters for small, unambiguous operations and object
parameters when optional or similarly typed arguments would be difficult to
read. Neither form is universally required.

A `number` represents any JavaScript number; naming it `duration` does not make it
nonnegative. Enforce nonnegativity with runtime validation at the relevant
boundary if the domain requires it, or use a domain constructor/type when the
invariant is important and can be maintained consistently.

## Keep types connected to behavior

Use discriminant switches and ordinary control-flow checks before custom guards
or assertions when possible. Avoid widening a precise value prematurely. Keep
runtime tests focused on behavior and boundary validation, not on restating
compiler inference. Update types and their consumers together when a domain
variant changes.

## Provenance

Independently worded guidance informed by Cursor's
[TypeScript best practices skill at commit 5866df557357d005b3c0c9d3da0d9e739b4bdde3](https://github.com/cursor/plugins/blob/5866df557357d005b3c0c9d3da0d9e739b4bdde3/pstack/skills/typescript-best-practices/SKILL.md).
The upstream pstack license is included with this skill in `LICENSE`.
