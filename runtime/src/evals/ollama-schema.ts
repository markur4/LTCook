/** Encode coordination-tool schema literals and execution Pass requirements for Ollama. */
export function ollamaCoordinationSchema(schema: unknown): unknown {
  const encode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(encode);
    if (!value || typeof value !== 'object') return value;
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const literals = Array.isArray(input.anyOf) ? input.anyOf : undefined;
    const simpleStrings =
      literals &&
      literals.length > 1 &&
      !('type' in input) &&
      !('enum' in input) &&
      !('const' in input) &&
      literals.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          item.type === 'string' &&
          typeof item.const === 'string' &&
          Object.keys(item).every((key) => key === 'type' || key === 'const'),
      );
    for (const [key, item] of Object.entries(input)) {
      if (key !== 'const' && key !== 'enum' && !(simpleStrings && key === 'anyOf'))
        output[key] = encode(item);
    }
    if (simpleStrings) {
      output.type = 'string';
      output.enum = literals.map((item) => item.const);
    } else if ('const' in input) {
      const allowed =
        !Array.isArray(input.enum) ||
        input.enum.some((item) => JSON.stringify(item) === JSON.stringify(input.const));
      output.enum = allowed ? [input.const] : [];
    } else if ('enum' in input) output.enum = encode(input.enum);
    if (input.type === 'string' && input.minLength === 1) {
      const description = typeof input.description === 'string' ? `${input.description} ` : '';
      output.description = `${description}When provided, this value must not be empty.`;
    }
    return output;
  };
  const result = encode(schema);
  if (!result || typeof result !== 'object') return result;
  const original = schema as { properties?: { command?: { anyOf?: Array<Record<string, any>> } } };
  const originalCreate = original?.properties?.command?.anyOf?.find(
    (branch) => branch.properties?.type?.const === 'task.create',
  );
  const root = result as { properties?: { command?: { anyOf?: Array<Record<string, any>> } } };
  const create = root.properties?.command?.anyOf?.find(
    (branch) => branch.properties?.type?.enum?.[0] === 'task.create',
  );
  const expectedIf = { properties: { workType: { const: 'task.execute' } } };
  const expectedThen = {
    required: ['passId'],
    properties: { passId: { type: 'string', minLength: 1 } },
  };
  if (
    create &&
    JSON.stringify(originalCreate?.if) === JSON.stringify(expectedIf) &&
    JSON.stringify(originalCreate?.then) === JSON.stringify(expectedThen) &&
    !create.anyOf
  ) {
    // > The canonical condition also applies when workType is omitted. Preserve that
    // > behavior using anyOf, which Ollama retains when it renders tool schemas.
    delete create.if;
    delete create.then;
    create.anyOf = [
      {
        required: ['passId'],
        properties: {
          passId: {
            type: 'string',
            minLength: 1,
            description: 'When provided, this value must not be empty.',
          },
        },
      },
      {
        required: ['workType'],
        properties: { workType: { enum: ['design', 'task.investigate'] } },
      },
    ];
  }
  return result;
}

/** Transform only the coordination tool's provider-facing schema, leaving Pi's validator intact. */
export function ollamaCoordinationPayload(payload: unknown): unknown {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('tools' in payload) ||
    !Array.isArray(payload.tools)
  )
    return payload;
  return {
    ...payload,
    tools: payload.tools.map((tool: unknown) => {
      if (!tool || typeof tool !== 'object' || !('function' in tool)) return tool;
      const fn = tool.function;
      if (
        !fn ||
        typeof fn !== 'object' ||
        !('name' in fn) ||
        fn.name !== 'ltcook_team' ||
        !('parameters' in fn)
      )
        return tool;
      return { ...tool, function: { ...fn, parameters: ollamaCoordinationSchema(fn.parameters) } };
    }),
  };
}
