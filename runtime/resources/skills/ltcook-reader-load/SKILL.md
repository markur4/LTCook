---
name: ltcook-reader-load
description: Use when explicitly asked to assess or improve code that is difficult to follow, including indirection, hidden state, and the cost of tracing behavior.
disable-model-invocation: true
license: MIT
---

# Minimize reader load

Maintainability includes the effort a reader spends finding an answer and
reconstructing what can change it. Consider both the number of layers between a
question and its implementation and the amount of hidden or mutable context the
reader must remember. Lines of code and layer count are clues, not goals by
themselves: a small interface can hide a meaningful decision, while a long flat
routine can still be hard to trace.

Before changing structure, identify the reader's actual task. A refactor helps
when it makes a common question easier to answer without making another question
harder. Prefer explicit names, local invariants, and a visible path from use to
behavior. Do not optimize for a hypothetical reader at the expense of the
project's established conventions.

## Weigh the interface against what it hides

An abstraction earns its interface when it compresses complexity: callers can
use a small, stable concept without learning the details it owns. A wrapper that
only forwards the same arguments and repeats the same operations may add a layer
without reducing what the reader needs to understand. A one-caller helper is not
automatically unnecessary; it can give a meaningful operation a name, isolate a
complex algorithm, or make a boundary explicit. Keep it when that benefit is
real.

When considering inlining, compare both directions of the change. Inlining may
make a short path easier to follow, but can duplicate logic, obscure a domain
operation, enlarge a caller, or couple unrelated concerns. Retain useful module,
class, and object-oriented boundaries when they clarify ownership and change.
Do not mechanically collapse layers or override the repository's architecture
because a helper has one caller.

## Keep mutable state traceable

Prefer state with a clear owner and bounded lifetime. A local variable is usually
easier to trace than mutable module-wide state, and derived values avoid the
need to synchronize duplicate state. But mutation is not inherently harder to
read: a small, explicit update can be clearer than threading many values through
pure wrappers. Keep mutation close to the operation that owns it and make the
invariant visible where state enters or changes.

Fields and shared state can be appropriate when they represent durable object
identity, coordinated ownership, or an established subsystem contract. Before
moving state, ask who can change it, when those changes matter, and whether the
new location makes those answers clearer. Do not convert everything to functions
or replace object state solely to satisfy a hierarchy of preferences.

## Refactor for a concrete reader question

Use a concrete question such as “where does this value come from?” or “what
changes it?” to examine a difficult path. Remove indirection only when the saved
tracing effort exceeds the cost of a larger or less cohesive implementation. Add
an interface only when it hides meaningful complexity or provides a useful
boundary. After a structural change, follow the path again and ensure names,
responsibilities, and state transitions remain understandable.

## Provenance

Independently worded guidance informed by Cursor's
[Minimize Reader Load principle at commit 5866df557357d005b3c0c9d3da0d9e739b4bdde3](https://github.com/cursor/plugins/blob/5866df557357d005b3c0c9d3da0d9e739b4bdde3/pstack/skills/principle-minimize-reader-load/SKILL.md).
The upstream pstack license is included with this skill in `LICENSE`.
