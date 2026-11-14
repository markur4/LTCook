import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const WorkStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('blocked'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);
export const TaskPhaseSchema = Type.Union([
  Type.Literal('implementation'),
  Type.Literal('review'),
  Type.Literal('verification'),
  Type.Literal('integration'),
  Type.Literal('integration-fix'),
  Type.Literal('system-fix'),
  Type.Literal('verification-fix'),
  Type.Literal('review-fix'),
]);
export type WorkStatus = Static<typeof WorkStatusSchema>;
export type TaskPhase = Static<typeof TaskPhaseSchema>;

const CoverageSchema = Type.Array(
  Type.Object(
    {
      topic: Type.Union(
        (['intent', 'design', 'scope', 'implementation', 'verification', 'delivery'] as const).map(
          (value) => Type.Literal(value),
        ),
      ),
      disposition: Type.Union(
        (['Resolved', 'Defaulted', 'Unresolved', 'Not applicable'] as const).map((value) =>
          Type.Literal(value),
        ),
      ),
      detail: Type.String(),
    },
    { additionalProperties: false },
  ),
);
const planContext = { planId: Type.String({ minLength: 1 }) };
/** The single command definition used by HTTP, native tools, and public types. */
export const RuntimeCommandSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('planning.start'),
      designPath: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('planning.show'), ...planContext },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('planning.questions'), ...planContext },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('planning.approve'), ...planContext },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('planning.reject'), ...planContext },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('planning.submit'),
      ...planContext,
      assignmentId: Type.String(),
      summary: Type.String(),
      evidence: Type.String(),
      coverage: Type.Optional(CoverageSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('decision.create'),
      ...planContext,
      category: Type.Union(
        (['intent', 'breaking-changes', 'verification', 'other'] as const).map((value) =>
          Type.Literal(value),
        ),
      ),
      prompt: Type.String({ minLength: 1 }),
      blocking: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('decision.answer'),
      ...planContext,
      decisionId: Type.String(),
      answer: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('guidance.inspect'), nativeAgentId: Type.Optional(Type.String()) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('guidance.loaded'),
      inspection: Type.Object(
        {
          resources: Type.Array(
            Type.Object(
              {
                name: Type.String(),
                path: Type.String(),
                scope: Type.Union(
                  (['core', 'team', 'project', 'user'] as const).map((v) => Type.Literal(v)),
                ),
                kind: Type.Union([Type.Literal('rule'), Type.Literal('skill')]),
                applicable: Type.Boolean(),
                loaded: Type.Boolean(),
                explicitOnly: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false },
            ),
          ),
          diagnostics: Type.Array(
            Type.Object(
              {
                source: Type.String(),
                reason: Type.String(),
                conflict: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('pass.create'),
      title: Type.String(),
      planRef: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('pass.update'), passId: Type.String(), status: WorkStatusSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('task.create'),
      workType: Type.Optional(
        Type.Union([
          Type.Literal('design'),
          Type.Literal('task.investigate'),
          Type.Literal('task.execute'),
        ]),
      ),
      passId: Type.Optional(Type.String()),
      title: Type.String(),
      description: Type.String(),
      acceptance: Type.String(),
      phase: Type.Optional(TaskPhaseSchema),
      requestId: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('task.update'),
      taskId: Type.String(),
      status: WorkStatusSchema,
      blocker: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('step.create'),
      taskId: Type.String(),
      title: Type.String(),
      position: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('step.update'), stepId: Type.String(), status: WorkStatusSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('assignment.create'),
      taskId: Type.String(),
      memberKey: Type.Optional(Type.String()),
      message: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('report.create'),
      assignmentId: Type.String(),
      summary: Type.String(),
      evidence: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('review.create'),
      passId: Type.String(),
      outcome: Type.Union([Type.Literal('accepted'), Type.Literal('changes-requested')]),
      summary: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('approval.create'),
      scope: Type.Object(
        { action: Type.String(), resourceId: Type.String(), revision: Type.String() },
        { additionalProperties: false },
      ),
      decision: Type.Union([Type.Literal('approved'), Type.Literal('rejected')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('team.spawn'), memberKey: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('team.message'), memberKey: Type.String(), message: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('team.close'), memberKey: Type.String() },
    { additionalProperties: false },
  ),
]);
export type RuntimeCommand = Static<typeof RuntimeCommandSchema>;
type CommandInput<T extends RuntimeCommand['type']> = Omit<
  Extract<RuntimeCommand, { type: T }>,
  'type'
>;
export type CreatePassInput = CommandInput<'pass.create'>;
export type UpdatePassInput = CommandInput<'pass.update'>;
export type CreateTaskInput = CommandInput<'task.create'>;
export type UpdateTaskInput = CommandInput<'task.update'>;
export type CreateStepInput = CommandInput<'step.create'>;
export type UpdateStepInput = CommandInput<'step.update'>;
export const RuntimeCommandInputSchema = Type.Object(
  { command: RuntimeCommandSchema },
  { additionalProperties: false },
);
export type RuntimeCommandInput = Static<typeof RuntimeCommandInputSchema>;
export type CreateAssignmentInput = CommandInput<'assignment.create'>;
export type CreateReportInput = CommandInput<'report.create'>;
export type CreateReviewInput = CommandInput<'review.create'>;
export type CreateApprovalInput = CommandInput<'approval.create'>;
export function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  return Value.Check(RuntimeCommandSchema, value);
}

/** Agent tool schemas are projected from the authoritative command union. */
export const AgentRuntimeCommandSchema = Type.Union(
  RuntimeCommandSchema.anyOf.filter(
    (schema) =>
      ![
        'planning.start',
        'planning.approve',
        'planning.reject',
        'decision.answer',
        'approval.create',
      ].includes(schema.properties.type.const),
  ),
);
export const AgentRuntimeCommandInputSchema = Type.Object(
  { command: AgentRuntimeCommandSchema },
  { additionalProperties: false },
);
