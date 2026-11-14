

# Modes

### Modelist
- Default: Advisor Agent always advises has to guess
- Design
- Plan
- Goal
	- OMP has "guided-goal" to combine it
	- However, I think all /goals should ask unclear questions before that?


### Architecture
- 

## Decisions: Brainstorm & Planning

### Things They Have in Common

Design Mode (brainstorming) should answer these things, but if it doesn't, Plan Mode should fill the _planning gaps_:

- Double-check user intent:
    - Advice, Design, or implementation?
    - What outcome does the user expect? What is important, and what is out of scope?
- Requirements and Specifications:
    - Requirements: What must the solution accomplish? Include relevant constraints.
    - Specifications: What precisely must happen? Define behavior, interfaces, and contracts where necessary.
    - Acceptance criteria: How will we know that the requirements are satisfied?
- Architectural things:
    - Components and their responsibilities, dependencies, and interfaces.
    - Directory structure: Follow existing structure where possible; introduce new structure only when useful.
    - Naming schemes: Reuse established terminology and extend it consistently.
- Consider alternatives and trade-offs. Record important Design Decisions and their rationale.
- Check existing project decisions, documentation, and code before asking questions or introducing new conventions.

### _Decisions_

#### Every Plan Needs to Cover These Planning Topics:

1. _User Intent_: Advice or implementation? What outcome does the user expect?
2. _Design_: Requirements, Specifications, Architecture, naming schemes, extra validation code, etc.
3. _Change Scope_: What repositories and components may be changed? What must remain unchanged?
4. _Implementation_: Required refactors, Tasks, dependencies, parallelization, worker delegation, implementation order, compatibility layers, migration, cleanup of old code, etc.
5. _Verification & Validation_: Formatting, type-checking, tests, integration tests, real-world use cases, and how to check acceptance criteria.
6. _Integration & Delivery_: Branches, worktrees, commits, PRs, pushing, merging, releasing, deployment, and rollback when necessary.

(1) and (2) are primarily addressed by Design Mode; the rest is primarily addressed by Plan Mode. Plan Mode fills remaining gaps in (1) and (2). A planning topic does not always require a separate Decision.

#### How to Decide:

Each of the following topics must be addressed somehow:

- Most can be covered by runtime control, rules, or skills.
    - Duplication between runtime and rules/skills is allowed, but they must describe the same policy without contradictions.
- The LLM should infer most things from user instructions, existing project decisions, repository conventions, and defaults when possible.
- The LLM should investigate discoverable facts before asking questions.
- The LLM should ask if there is a real ambiguity, conflict, or consequential user preference that cannot be resolved from available information.
- Don't invent user decisions. Record significant Decisions with their rationale and source (user, repository, policy, or inference).
- Don't ask again about Decisions that are already resolved or safely defaulted.

#### Categories:

- _Resolved_: Already established by the user, Design, or repository.
- _Defaulted_: Safely determined using existing policies or conventions.
- _Unresolved_: Requires additional investigation or a user decision.
- _Not applicable_: Irrelevant to the current work.

### Design Decisions

#### Design: User Intent

1. What parts are important for the user? Which outcomes have priority?
2. Does the user want advice, an architectural Design, a Plan, or implementation?
3. What functionality is in or out of scope?
4. What existing functionality must remain unchanged?
5. What constraints or preferences matter? Simplicity, maintainability, performance, platform support, time, etc.

#### Requirements & Specifications

1. What are the functional and non-functional Requirements?
2. What Specifications are necessary?
    - Expected behavior and edge cases?
    - APIs, interfaces, inputs, and outputs?
    - Data structures, formats, and contracts?
    - Error handling?
3. What are the acceptance criteria?
4. Are there existing Requirements or Specifications that must be preserved?
5. Are there conflicting or incomplete Requirements?

#### Architecture

1. Directory structure:
    - Which existing directories and modules are relevant?
    - Are structural changes necessary?
    - Are new modules or abstractions needed?
2. Naming schemes:
    - What is the relevant terminology? APIs, module names, CLI commands, data objects, etc.
    - Are existing naming schemes consistent?
    - Are new naming schemes necessary?
    - Do naming schemes reflect the architecture and component responsibilities?
3. Components:
    - Which components are involved?
    - What are their responsibilities and boundaries?
    - How do they interact?
4. Dependencies:
    - Which existing libraries and implementations can be reused?
    - Are additional dependencies necessary?
5. Alternatives:
    - What alternative Designs are available?
    - What are their advantages and disadvantages?
    - Which Design was chosen, and why?
6. Write additional Validation scripts?
### Scope Decisions

#### Scope: User Intent

1. Which parts of the Design should be implemented in this Pass?
2. Which parts should be excluded or deferred?
3. What existing functionality must remain unchanged?

#### What Repos?

1. Which repositories are affected?
2. Which repositories actually require changes?
3. Are coordinated changes across repositories necessary?
4. Are any repositories outside the allowed Change Scope?

#### Boundaries

1. Which modules, files, and interfaces are likely to be affected?
2. Are there existing user changes or protected files?
3. Are external services, databases, or data outside Git affected?
4. Are there boundaries or restrictions on what may be modified?

### Implementation Decisions

#### Implementation: User Intent

1. Is the user ready to implement, or does the user still want advice?
2. Is the user going to be available to answer questions or approve actions?
3. Are there time constraints or deadlines?
4. Is uninterrupted autonomous execution expected?

#### Prerequisites

1. Are additional dependencies or tools necessary?
2. Are prior refactors necessary?
3. Are compatibility layers required?
4. Are migrations necessary?
5. Can obsolete code, dependencies, or compatibility layers be removed?
6. Are credentials, services, or additional environments required?
7. Are there dependencies on other repositories or unfinished work?

#### Tasks & Delegation

1. Which Tasks are necessary?
2. What are the dependencies between Tasks?
3. What is the implementation order?
4. Which Tasks can be executed in parallel?
5. Which Tasks have conflicting file ownership?
6. Which Tasks should be delegated to workers?
7. What responsibilities and boundaries should each worker have?
8. How will independently implemented Tasks be integrated?
9. What cleanup or documentation updates are necessary?

### Verification / Validation Decisions

#### Verification: User Intent

1. How much time should verification take?
2. What level of verification does the user expect?
3. Are there limitations on available hardware, services, or environments?
4. Is user participation required for validation?

#### Procedure?

1. Which formatting and linting checks are applicable?
2. Which type-checking and static-analysis tools are applicable?
3. Which existing tests are relevant?
4. Which new unit tests are necessary?
5. Which integration tests are necessary?
6. Which system or end-to-end tests are necessary?
7. Which real-world use cases require validation?
8. Can these use cases be simulated?
9. How frequently should verification run?
    - During implementation?
    - After individual Tasks?
    - After integration?
    - Before delivery?
10. Which checks must pass before the Pass can be considered complete?
11. What verification or validation limitations are expected?

### Integration Decisions

#### Integration: User Intent

1. Is the user going to be available for required approvals or signing?
2. Does signing require user interaction, such as unlocking 1Password?
3. Does the user expect committed code, a PR, a merge, or a release?
4. Are there time constraints on integration or delivery?

#### When to Commit?

1. When should commits be created?
2. What should determine commit boundaries?
3. Should workers commit their Tasks independently?
4. Which commit conventions apply?
5. Which checks are required before committing?
6. How should integration and verification fixes be committed?

#### Push

1. Which remote and branch should receive changes?
2. When should changes be pushed?
3. Is a draft PR required?
4. When should the PR be created?
5. Are authentication or signing requirements expected?
6. Are there restrictions on pushing or publishing changes?

#### Merge / Release

1. What are the conditions for merging?
2. Who or what is authorized to merge?
3. Is a release necessary?
4. Are versioning or changelog updates required?
5. Are database or configuration migrations involved?
6. When should temporary branches and worktrees be cleaned up?

## Design Mode

#### Purpose

0. It is the precursor of Plan Mode, meant to gather Requirements, Specifications, and Design Decisions.
1. The user is roughly 50% active/passive: They come with ideas and want the model to evaluate them in a discussion.
2. Discussion:
    - **We don't want to work with one big-ass Plan from the start!**
    - Explore ideas and alternatives incrementally. Explain trade-offs clearly.
    - Ask questions only when the user's preference or an important ambiguity matters.
3. It can build both small and big software Designs.
4. Design Mode is useful on its own. A user asking for advice does not automatically authorize implementation.

#### Implementation

- It maintains a `Design-*.md` in the background (persistent shared state).
    - Summarizes Requirements, Specifications where needed, Architecture, Design Decisions, rationale, and open questions from the brainstorming Session.
    - Update it when meaningful information changes; avoid duplicating the same information in several places.
- Always provide a concise _Design Summary_:
    - The Design Summary is a summary of what was discussed and decided, not an implementation mini-Plan.
    - The full Design can grow over multiple discussions and may later inform multiple Plans.
- Keep unresolved questions visible. Distinguish confirmed decisions from inferred defaults.

#### GUI

- A button appears at the bottom: **Continue to Plan Mode**. The user can click it when finished brainstorming; Plan Mode then continues the workflow.
- An extra GUI element (sidebar) concisely summarizes the _Design_ as bullet points.
    - Group the summary by Requirements, Specifications (when needed), Architecture, Decisions, and Open Questions.
- Each bullet point is clickable. When clicked, a text field appears (pre-filled with "Feedback") where the user can enter feedback. Clicking **Send Feedback** sends an auto-generated feedback message to the agent, referencing the selected point.
- Keep the sidebar in sync with the Design document.



## Plan Mode

#### Purposes of Plan Mode:

1. If no Design document is present, create the minimum necessary Design. If essential Design Decisions are missing and require discussion, switch back to Design Mode. Don't switch modes for small gaps that Plan Mode can resolve itself.
2. The user is roughly 90% passive: They expect the model to investigate, fill gaps, make reasonable decisions, and ask only necessary questions.
3. A complete Plan should anticipate foreseeable issues and be sufficiently clear to execute, without trying to predict _all_ possible issues or prescribe every Action.
4. Clarify procedural issues (push? How to parallelize subagents? What tests are needed?) using established runtime policies wherever possible.
5. Produce one Plan for one Pass, including Tasks, dependencies, verification, and the integration strategy. Present it for user review and approval before implementation.

#### General

- _Analyze_, _identify_, and _clarify_ the gaps (all unresolved decisions) that matter for the user's intent.
- _Analysis_:
    - Check the repository's Git state. The current checkout might be `main` or an existing branch related to the Session; verify instead of assuming.
    - Check for uncommitted changes, relevant branches, and remote divergence. Preserve unrelated user work.
    - Double-check that the discussion, Design, and actual code are in sync. Pull relevant information into context.
    - If the checkout is outdated, record the required synchronization. Don't run a mutating `git pull` as part of read-only Planning; handle it in an authorized preparation or execution step.
    - Inspect relevant source code, existing tests, documentation, dependencies, and project policies.
- _Identify_ all material planning gaps:
    - Distinguish discoverable facts from preferences that require user input.
    - Distinguish blocking questions from matters that can safely be defaulted.
- _Clarify_:
    - Resolve discoverable questions through investigation.
    - Ask user questions only when necessary.
    - Record important Decisions, assumptions, and unresolved questions in the Plan or linked Design.

### Procedure:

1. Check the Request and the existing Design. Create a minimal Design if none exists.
2. Resolve remaining Design gaps. Return to Design Mode only for substantial unresolved Design Decisions.
3. Inspect relevant repositories, Git state, and project conventions.
4. Establish Change Scope: Which repositories and components may be modified?
5. Define Implementation Tasks, dependencies, necessary refactors, delegation, and execution order.
6. Determine Verification & Validation and Integration & Delivery using established defaults and any required exceptions.
7. Write a `Plan-*.md` for one Pass. Reference the Design rather than copying it unnecessarily.
8. Present the Plan for review. The user may approve it, request changes, or remain in Plan Mode.
9. After approval, hand the Plan to Pass execution. Allow controlled Plan revisions during the Pass; changes that materially expand scope require renewed approval.

### Asking Questions
#### General
- For each point under *Decisions*, the agent may ask multiple questions until the important ambiguity is resolved, but it should avoid repeated or unnecessary questions.
- Investigate first. Don't ask questions that the chat history, repository, *Design*, or existing policies already answer.
- Offer meaningful options with a recommended default when useful. Make the consequences of each choice clear.
- Write everything clearly. Reuse established terminology.

#### Mandatory: Ask at least 1 question for these topics:
1) Double-checking user intent(s)
2) Breaking Changes, Compatibility Layers, Auto-Migrations
3) Run available validation/e2e scripts (since they can take long) 

## Templates

### Design & Plan Document Rules

#### General

- Use the Planning Topics to identify missing information, not as a list of questions to ask the user.
- Resolve information from existing context, project decisions, rules, skills, and relevant code or documentation before asking questions.
- Distinguish established facts, user decisions, defaults, and assumptions. Never invent user decisions or silently resolve consequential ambiguities.
- Ask only when necessary, except for explicitly defined Mandatory User Questions.
- Be specific and concise. Include enough detail to explain decisions and guide subsequent work, without unnecessary implementation details.
- Reuse established terminology and reference existing information rather than duplicating it.
- Omit irrelevant fields and sections. Do not fill documents with placeholders or speculative details.

#### Design

- Develop the Design incrementally through discussion and research. Update it when meaningful decisions are made.
- Evaluate alternatives in proportion to their importance. Prefer established solutions when they satisfy the Requirements without unnecessary complexity.
- Investigate architectural uncertainties through targeted research, experiments, or validation scripts when useful. Record the conclusions.
- Record the rationale for important Design Decisions, especially when alternatives have significant trade-offs.
- Consider the Design complete when all decisions necessary to understand and implement the intended solution are resolved.


```
# Design: <Title>

- **Status:** <Draft / Completed>

## Intent

- **Purpose:** <Why is this Design needed?>
- **Requested Outcome:** <Advice, Design, Plan, or implementation>
- **Priorities:** <What matters most to the user?>
- **Functional Scope:** <Which functionality is included?>
- **Exclusions:** <What is out of scope?>
- **Preserved Behavior:** <Existing functionality that must remain unchanged>
- **Constraints & Preferences:** <Simplicity, maintainability, performance, platform support, time, etc.>

## Requirements

### Functional Requirements

- <Required functionality>

### Non-functional Requirements & Constraints

- <Quality requirements, constraints, and compatibility>

### Acceptance Criteria

- <Conditions that define a successful solution>

## Specifications

- **Behavior:** <Expected behavior and relevant edge cases>
- **Interfaces:** <APIs, inputs, outputs, and contracts>
- **Data:** <Data structures, formats, and persistence>
- **Error Handling:** <Expected failure behavior>
- **Compatibility:** <Existing interfaces, formats, or behavior that must remain supported>

## Architecture

### Components & Relationships

- **Components:** <Components and their responsibilities>
- **Boundaries:** <Separation of responsibilities>
- **Relationships:** <Dependencies, interfaces, and data flows>

### Directory Structure

- **Existing Structure:** <Relevant directories and modules>
- **Changes:** <New, modified, or removed directories and modules>

### Naming Schemes

- **Terminology:** <Relevant established terms>
- **Existing Conventions:** <Naming conventions to preserve>
- **New Conventions:** <New naming schemes, if necessary>

### Dependencies

- **Existing:** <Libraries and implementations to reuse>
- **New:** <Additional dependencies, if necessary>

### Design Validation

- **Assumptions:** <Architectural assumptions requiring validation>
- **Experiments:** <Prototypes, scripts, or feasibility checks>
- **Results:** <Findings and their implications for the Design>

## Design Decisions

### <Decision Title>

- **Context:** <Problem or choice that required a Decision>
- **Decision:** <Chosen approach>
- **Rationale:** <Why this approach was chosen>
- **Alternatives:** <Relevant alternatives considered>
- **Trade-offs:** <Advantages, disadvantages, and limitations>
- **Evidence:** <Relevant research, experiments, or validation results>
```

#### Planning

- Ground the Plan in the actual repository state and existing Design. Do not assume that proposed files, interfaces, or dependencies already exist.
- Break work into Tasks with clear outcomes, dependencies, and ownership. Avoid prescribing Steps and Actions that workers can determine themselves.
- Plan delegation according to dependencies, parallelization opportunities, and conflicting file ownership. Avoid unnecessary agents.
- Order the Timeline to provide useful feedback early. Place Verification, Validation, and Integration Tasks where their results can inform subsequent work.
- Choose verification methods based on the changes and their acceptance criteria. Account for available environments and practical limitations.
- Do not anticipate hypothetical failures with additional Tasks or Phases. Revise the Plan when new information requires it.
- Preserve completed work and stable identifiers during revisions. Track routine execution progress in shared state rather than repeatedly rewriting the Plan.
- Require renewed user approval when revisions materially change the Design or Change Scope.

```
# Plan: <Title>

- **Design:** <Reference to design-*.md>
- **Status:** <Draft / Approved / Executing / Completed>

## Overview

### Outcome & Change Scope

- **Outcome:** <What this Pass should accomplish>
- **Included:** <Which parts of the Design are implemented>
- **Excluded:** <Deferred functionality and protected behavior>
- **Repositories:** <Affected repositories and coordinated changes>
- **Boundaries:** <Affected components, protected files, external services, and data>

### Implementation

- **Prerequisites:** <Required dependencies, tools, refactors, or unfinished work>
- **Compatibility:** <Compatibility requirements and migration decisions>
- **Cleanup:** <Obsolete code and dependencies to remove>
- **Constraints:** <Time limits, environment limitations, and other restrictions>

### Verification & Validation

- **Verification:** <Required checks and expected coverage>
- **Validation:** <Required real-world use cases or simulations>
- **Frequency:** <When verification should occur>
- **Limitations:** <Unavailable platforms, hardware, services, or tests>

### Integration & Delivery

- **Git Strategy:** <Branch and worktree strategy>
- **Commits:** <Commit boundaries, conventions, and signing requirements>
- **Push:** <Remote, branch, and push strategy>
- **PR:** <Draft PR and review strategy>
- **Merge:** <Merge conditions and authorization>
- **Release:** <Versioning, changelog, migration, and deployment decisions>
- **User Availability:** <Required approvals, signing, and expected interaction>

## Planned Agents

- **Main:** <Responsibilities>
- **Explorer:** <Responsibilities, if needed>
- **Worker A:** <Responsibilities and ownership>
- **Worker B:** <Responsibilities and ownership>
- **Reviewer:** <Pass-wide review responsibilities>

## Timeline

### Phase 1: <Preparation / Git Setup>

- **Objective:** <Expected intermediate outcome>
- **Agents:** <Assigned agents>
- **Dependencies:** <Prerequisite Tasks or Phases>
- **Status:** <Planned / Active / Completed / Blocked>

#### Tasks

1. **T1 — <Repository Preparation>**
   - Agent: <Agent>
   - Work: <Repository state, synchronization, branches, or worktrees>

2. **T2 — <Prerequisites>**
   - Agent: <Agent>
   - Work: <Dependencies, tools, refactors, or preparation>

3. **T3 — <Initial Integration Setup>**
   - Agent: <Agent>
   - Work: <Git, signing, PR setup, or other integration requirements>

#### Completion Criteria

- <Conditions for proceeding to implementation>

### Phase 2: <Implementation & Verification>

- **Objective:** <Expected intermediate outcome>
- **Agents:** <Assigned agents>
- **Dependencies:** <Prerequisite Tasks or Phases>
- **Status:** <Planned / Active / Completed / Blocked>

#### Tasks

1. **T4 — <Implementation Task>**
   - Agent: <Worker A>
   - Work: <Implementation details>
   - Dependencies: <Prerequisite Tasks>

2. **T5 — <Implementation Task>**
   - Agent: <Worker B>
   - Work: <Implementation details>
   - Dependencies: <Prerequisite Tasks>
   - Parallel with: <T4, if applicable>

3. **T6 — <Verification Task>**
   - Agent: <Agent>
   - Dependencies: <Relevant implementation Tasks>
   - Work: <Formatting, type-checking, unit tests, or other checks>

4. **T7 — <Commit / Integration Task>**
   - Agent: <Agent>
   - Dependencies: <Relevant verified Tasks>
   - Work: <Commits, integration, or pushing as planned>

#### Completion Criteria

- <Expected functionality and required checks>

### Phase 3: <Integration & Validation>

- **Objective:** <Expected intermediate outcome>
- **Agents:** <Assigned agents>
- **Dependencies:** <Prerequisite Tasks or Phases>
- **Status:** <Planned / Active / Completed / Blocked>

#### Tasks

1. **T8 — <Integration Task>**
   - Agent: <Agent>
   - Work: <Integrate independently implemented components or repositories>

2. **T9 — <System Verification>**
   - Agent: <Agent>
   - Dependencies: <Integrated Tasks>
   - Work: <Integration tests, system tests, or E2E tests>

3. **T10 — <Validation Task>**
   - Agent: <Agent>
   - Dependencies: <Relevant verification>
   - Work: <Real-world use cases or simulations>

#### Completion Criteria

- <Integration and validation requirements>

### Phase 4: <Review & Final Verification>

- **Objective:** <Expected intermediate outcome>
- **Agents:** <Assigned agents>
- **Dependencies:** <Prerequisite Tasks or Phases>
- **Status:** <Planned / Active / Completed / Blocked>

#### Tasks

1. **T11 — <Pass-wide Review>**
   - Agent: <Reviewer>
   - Work: <Review the integrated changes and apply necessary fixes>

2. **T12 — <Final Verification>**
   - Agent: <Agent>
   - Dependencies: <Review>
   - Work: <Required checks after review and fixes>

#### Completion Criteria

- <Review and verification requirements>

### Phase 5: <Delivery & Release>

- **Objective:** <Expected final outcome>
- **Agents:** <Assigned agents>
- **Dependencies:** <Prerequisite Tasks or Phases>
- **Status:** <Planned / Active / Completed / Blocked>

#### Tasks

1. **T13 — <Finalize Git Changes>**
   - Agent: <Agent>
   - Work: <Final commits, signing, and pushing>

2. **T14 — <PR / Merge>**
   - Agent: <Agent>
   - Work: <Create or update PR, review status, merge if authorized>

3. **T15 — <Release, if applicable>**
   - Agent: <Agent>
   - Work: <Versioning, changelog, release, deployment, or migrations>

4. **T16 — <Cleanup>**
   - Agent: <Agent>
   - Work: <Temporary worktrees, branches, or obsolete artifacts>

#### Completion Criteria

- <Conditions for considering the Pass complete>
```




## Goal Mode

#### Purposes:
- A more flexible plan mode
- Finishes upon reaching a goal.
- Still asks question before.

### Procedure:
1) It begins with questions
2) Identify *the algorithm* from the context / user intent:
	- Does it include a loop logic, conditions?
	- Is it a simple sequence of implementation plans?
	- LLM should think about this
3) Split 
4) write `Goal-*.md`
5) write `Goal-Plan-*.md`

For now, keep this simple, will implement later. 



---

# Default-Goals

Some things don't need the user to rewrite again.

Why wrap them into goal mode..?
## Code-Smell Analysis & Refactor (CSAR)

### Algorithm:

**Just check sequentially:**

0) **Ask Mandatory questions:**
	1) Check for edge-case bugs?
	2) Breaking changes allowed for the sake of code clarity?
1) **Mandatory Scans:**
	1) Obvious bugs: Not the edge cases, but main features breaking obviously
	2) Analyse Code-Smells
		1) Any Huge files, god functions?
		2) Inconsistent naming schemes?
		3) Duplicated helper functions?
	3) Check Intuitive traversal of code
		1) Improve naming schemes?
		2) Re-structure file & directory structure to make files more traversible?
		3) This includes test code.
	4) Code Efficiency
		1) Any obvious algorithmic blunders wasting compute?
	5) Documentation
		1) `docs/` outdated? 
		2) Any paragraphs that are unclear, bad style, unnecessarily complex?
	6) Cleanup:
		1) Any unused modules?
		2) Any unnecessary tests?
		3) Any old compatibility layers and migration code to be removed?
2) **Optional Scans**
	1) Check for deeper bugs that are of more edge-case nature
3) **Write a `code-smells.md`**
	1) If available, update Repos `TODO.md` or `BACKLOG.md`
4) **Clarify Emerging Questions**
	1) Ask user questions that arised during analysis
5) **Start the refactor / fixes**


# Lcook-Team Skills


##