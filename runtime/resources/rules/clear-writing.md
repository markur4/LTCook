---
alwaysApply: true
---

# Clear Writing

Prioritize clarity over conciseness and avoid terseness. Write so the
reader understands the answer and why the conclusion follows. Shorten
the writing by choosing relevant information, not by removing the
details that make it understandable.

## Scope

- Apply this rule to all prose you write or revise, including progress updates
  and code comments. Follow the requested genre and format. Keep required output
  schemas and project conventions; this rule does not define tool use or agent
  responsibilities.

- Match the requested tone. When editing, keep the author's meaning and
  recognizable voice. Use humor or personal opinion when the task calls for it,
  not as a way to make the writing seem human.

- Examples in this rule illustrate writing choices. Their scenarios and
  identifiers are not facts or requirements for the current task.

## Start with the Reader's Question

Identify the question the writing must answer. Use the context already
established, and add background only when the reader needs it to understand the
answer. In an explanatory reply, give the answer early. For a complex reply,
start with a brief answer that includes any condition or limitation needed to
interpret it, then develop the explanation.

Let the question determine the amount of detail. A tutorial needs the steps that
help the reader learn; a status update usually does not need to explain those
steps. A one-sentence answer can remain one sentence when it answers the
question without leaving a necessary connection unstated.

## Develop an Answer within Each Paragraph

Choose one question for the paragraph to answer. You do not need to state the
question explicitly. Start with the information the reader needs to understand
that question, then develop the answer. Each sentence should connect to
something already established and help answer the same question.

For a paragraph explaining a solution, describe the problem and show how the
method addresses it. After presenting the result, return to the problem and
explain what was resolved and what remains unresolved. Mention a new problem
when the result introduces one. This is what interpretation adds to the result:
it explains what the result means for the original problem.

Not every paragraph needs this problem-to-interpretation structure. A paragraph
supporting a claim can state the claim, explain the reason, and provide an
example. Use only the stages the explanation needs. Start a new paragraph when
the question changes, not after an arbitrary number of sentences.

Within the paragraph, explain the relationship between statements. When
describing a cause, show how it leads to the result. Keep the intermediate step
that explains the connection. A word such as "therefore" can make that connection
explicit, but it cannot replace the explanation.

**Example: Explain why faster analysis mattered**

> During development of the V-Well assay, I needed results soon enough to adjust
> the protocol between measurements. I analyzed the data while a technical
> assistant prepared samples for the next measurement. Semi-automation made the
> analysis fast enough to finish before those samples were ready. That timing
> let me adjust the protocol during the experiment instead of discovering
> problems only after it ended.

The timing connects faster analysis to protocol corrections during the
experiment. Without that step, the reader would have to infer why faster
analysis allowed corrections before the next measurement.

## Connect Each Paragraph to the next

Order paragraphs so the reader understands why the next question appears. A
result may leave a limitation that the next paragraph examines. A proposed
solution may raise a question about how it works. State the connection when the
reader would otherwise have to reconstruct it. For independent topics, use a
section break rather than inventing a connection.

**Example: Move from a test result to its limits**

> In the unit test, `config.toml` contains a negative `timeout`. The parser
> rejects the configuration before the client sends a request.
>
> Because no request is sent, this test does not show what happens when a real
> request exceeds `timeout`. I have not tested that behavior, so the unit-test
> result does not establish that request timeouts work.

The first paragraph describes what the test shows. The second explains what the
test leaves untested. It develops a limitation of the result rather than
introducing another topic merely associated with testing.

Continue using an existing example when it can explain the next concept. Keep
its terms and circumstances consistent so the reader can focus on the new
information. Use a different example when the existing one no longer fits.
Introduce each substantial example with a label that names the point it
demonstrates, so the reader knows why the example appears.

## Use the Same Term for the Same Thing

Use the established term throughout the explanation. This applies to ordinary
words as well as technical terms. Repeat a term when it helps the reader follow
what is being discussed; do not replace it with a synonym merely to avoid
repetition. Use a different term when it identifies a difference in meaning,
and explain that difference.

**Example: Repeat an ordinary term while developing the explanation**

> A worker unfamiliar with the repository needs to read the relevant code
> before making an edit. That preparation may take longer than the edit itself.
> Preparation therefore matters when estimating the time needed for a small
> edit.

"Preparation" refers to the same activity throughout. The paragraph repeats the
term while adding information about how that activity affects the time estimate.

- When introducing a term, choose a familiar word if it expresses the meaning
  precisely. Keep a technical term when a more familiar word would make the
  meaning less precise. If the reader is unfamiliar with the technical term,
  first describe what it refers to, then introduce the term. Explain only what
  that reader needs; familiar technical terms do not need repeated definitions.

- Keep exact identifiers when the reader needs to identify the thing being
  discussed. Use a pronoun or a phrase such as "that setting" only when the
  reader can tell what it refers to. When two settings could fit, repeat the
  identifier instead of making the reader guess.

- When another term is necessary, explain its relationship to the established
  term. If it is an alias, state that both terms refer to the same thing. If it
  corrects an earlier term, identify the correction rather than leaving the
  reader to treat the terms as interchangeable.

## Show what the Evidence Supports

State what was observed or established, then explain what follows from it. Say
when you are drawing a conclusion rather than reporting an observation. Keep
the conclusion within what the evidence supports. When a necessary causal
connection is unknown, state what is unknown instead of inventing a mechanism
to complete the explanation.

- Keep uncertainty next to the claim it qualifies. Explain the specific
  limitation, including how it limits the conclusion. In the `timeout` example,
  the limitation is not that testing is generally imperfect. It is that no
  request was sent, so the test cannot establish what happens during a request.

- When the conclusion compares two cases, use the same relevant criteria for
  both. State what differs and why that difference matters to the reader's
  question. Keep conditions that limit the comparison, especially when removing
  a condition would imply that the cases are mutually exclusive or that one is
  always better.

- When editing source-based writing, keep the source's meaning and degree of
  certainty. Keep attribution and place citations next to the claims they
  support. Flag missing or contradictory information instead of changing the
  source's claim to make the explanation read smoothly.

## Shorten without Making the Explanation Vague

Choose the details that answer the reader's question, then describe those
details precisely. Keep a specific name when the reader needs to identify the
operation being discussed. Describe what the operation does rather than
replacing it with a broad claim about its value.

**Positive example: Name the operation and its effect**

> `DataAnalysis.switch()` can exchange the dimensions assigned to `x` and `hue`.
> This changes which categories appear on the x-axis and which are represented
> by color.

**Negative example: Replace the operation with a broad claim**

> The interface enables flexible data exploration.

The negative example removes the method name and does not explain what changes
in the plot. The reader cannot identify the operation from that sentence. A
broad description can summarize an explanation after its meaning is clear; it
should not replace the explanation the reader needs.

- Remove repeated claims when they do not help the reader understand or use the
  answer. Keep repeated terms when they make a reference clear. A brief reminder
  of an earlier result can also help explain a new consequence, even though the
  reminder adds no new fact. Judge repetition by what it contributes to the
  explanation, not just by whether it introduces information.

- In a summary, keep the main conclusion and the information needed to interpret
  it. To shorten the summary, remove secondary examples when the reader can
  understand the conclusion without them. Do not remove a distinction needed to
  interpret the conclusion correctly. Keep a condition when removing it would
  change the conclusion or the reader's decision.

## Keep Sentences Easy to Follow

Write complete sentences in explanations. Keep the grammatical subject and its
verb close enough that the reader can follow the sentence without rereading it.
Split a sentence when it changes focus or places several dependent clauses
between the subject and verb. Put secondary details in a separate sentence when
they interrupt the main explanation.

Keep related clauses together when that makes their relationship easier to
understand. A sentence that connects a cause to its result can be clearer than
several short statements that leave the connection unstated. Let the explanation
determine sentence length rather than forcing every sentence to be short.

**Example: Keep the cause and result connected**

> Because `config.toml` contains a negative `timeout`, the parser rejects the
> configuration before the client sends a request.

- Name the actor when the reader needs to know who performed an action. When the
  actor is unknown or does not matter to the explanation, passive voice can keep
  the focus on the action.

- Short status fragments are acceptable when the surrounding format makes their
  meaning clear. Use complete sentences when a status update needs to explain a
  result or a blocker; the reader should not have to supply the missing
  connection.

## Use Formatting to Make the Structure Visible

- Use headings to mark meaningful changes of question or topic. Group the
  paragraphs that develop the same explanation under the same heading. Within
  those paragraphs, use emphasis to help the reader locate an important point,
  not to decorate every technical term.

- Use a list when the reader needs to inspect its items separately. Keep each
  item focused on why it belongs in that list. When the items are steps in a
  process, explain how one step affects the next. A list of step names alone
  does not explain how the process works.

- Use numbered steps when their order matters. Numbering shows the order, but
  the explanation must still show how the steps connect. Converting the steps
  into a comma-separated sentence does not supply a missing explanation. Choose
  the format after deciding what the reader needs to understand.

- Use a table when the reader needs to compare the same criteria across options.
  Give each criterion a consistent place so the reader can compare the options
  directly. Explain any condition needed to interpret the comparison rather than
  shortening a table entry until that condition disappears.

## Review the Explanation before Polishing the Wording

First check whether the writing answers the reader's question and whether the
conclusion follows. Repair missing connections before polishing individual
words. Then check whether the wording or formatting makes the explanation
harder to follow.

- Can the reader identify the answer and the conditions under which it holds?
- Does each paragraph answer one question, with sentences that develop that
  answer? Can the reader understand why the next paragraph follows?
- Does the writing use the same term for the same thing, including ordinary
  words? Are exact identifiers and pronoun references clear?
- Has shortening removed a necessary step, condition, or distinction? Does any
  remaining repetition help the reader understand or use the answer?
- Are observations, conclusions, and uncertainty distinguishable? Does
  source-based writing keep the source's meaning and attribution?
- Is each substantial example clearly identified as an example, and does it
  demonstrate the point it is meant to explain?

Stop when the question is answered. Add a concluding sentence only when it
resolves the question or states a useful consequence that is not already clear.
