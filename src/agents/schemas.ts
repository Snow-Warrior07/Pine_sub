// A tiny runtime schema validator (no dependencies). Every agent output passes through
// validate() before anything acts on it, so malformed or unsupported values never reach
// the workspace, the gates or the human.

export type Schema =
  | { type: 'string'; minLength?: number; pattern?: RegExp; enum?: readonly string[] }
  | { type: 'number'; min?: number; max?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: Schema; minItems?: number; maxItems?: number }
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; allowExtra?: boolean };

const str = (o: { minLength?: number; pattern?: RegExp; enum?: readonly string[] } = {}): Schema => ({ type: 'string', ...o });
const arr = (items: Schema, o: { minItems?: number; maxItems?: number } = {}): Schema => ({ type: 'array', items, ...o });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object',
  properties,
  required,
});

export function validate(value: unknown, schema: Schema, path = '$'): string[] {
  const errors: string[] = [];
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path}: expected string, got ${typeOf(value)}`];
      if (schema.minLength !== undefined && value.length < schema.minLength)
        errors.push(`${path}: must be at least ${schema.minLength} characters`);
      if (schema.pattern && !schema.pattern.test(value)) errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
      if (schema.enum && !schema.enum.includes(value))
        errors.push(`${path}: unsupported value "${value}" (allowed: ${schema.enum.join(', ')})`);
      return errors;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) return [`${path}: expected number, got ${typeOf(value)}`];
      if (schema.min !== undefined && value < schema.min) errors.push(`${path}: must be >= ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) errors.push(`${path}: must be <= ${schema.max}`);
      return errors;
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: expected boolean, got ${typeOf(value)}`];
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: expected array, got ${typeOf(value)}`];
      if (schema.minItems !== undefined && value.length < schema.minItems)
        errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        errors.push(`${path}: allows at most ${schema.maxItems} item(s)`);
      value.forEach((v, i) => errors.push(...validate(v, schema.items, `${path}[${i}]`)));
      return errors;
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return [`${path}: expected object, got ${typeOf(value)}`];
      const rec = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in rec)) errors.push(`${path}.${key}: missing required field`);
      }
      for (const [key, v] of Object.entries(rec)) {
        const sub = schema.properties[key];
        if (!sub) {
          if (!schema.allowExtra) errors.push(`${path}.${key}: unexpected field`);
          continue;
        }
        errors.push(...validate(v, sub, `${path}.${key}`));
      }
      return errors;
    }
  }
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const ROLES = ['analyst', 'architect', 'developer', 'qa', 'security', 'release'] as const;
const relPath = str({ minLength: 1, pattern: /^(?!\/)(?!.*\.\.)[\w./-]+$/ });

export const SCHEMAS = {
  'analyst.clarify': obj({
    summary: str({ minLength: 10 }),
    acceptance_criteria: arr(
      obj({ id: str({ pattern: /^AC-\d+$/ }), given: str({ minLength: 3 }), when: str({ minLength: 3 }), then: str({ minLength: 3 }) }),
      { minItems: 1, maxItems: 12 },
    ),
    tasks: arr(
      obj({ id: str({ pattern: /^T-\d+$/ }), title: str({ minLength: 3 }), owner_agent: str({ enum: ROLES }), depends_on: arr(str()) }),
      { minItems: 1, maxItems: 20 },
    ),
    assumptions: arr(str()),
    open_questions: arr(str()),
    out_of_scope: arr(str()),
  }),
  'architect.design': obj({
    impacted_components: arr(
      obj({ path: relPath, change_type: str({ enum: ['create', 'modify', 'read_only'] }), reason: str({ minLength: 3 }) }),
      { minItems: 1 },
    ),
    approach: str({ minLength: 10 }),
    api_contract: arr(str()),
    allowed_files: arr(relPath, { minItems: 1, maxItems: 10 }),
    forbidden_files: arr(obj({ path: relPath, reason: str() })),
    decisions: arr(obj({ id: str({ pattern: /^ADR-\d+$/ }), decision: str(), rationale: str() })),
    risks: arr(str()),
  }),
  'architect.review_deviation': obj({
    decision: str({ enum: ['accept', 'reject'] }),
    rationale: str({ minLength: 5 }),
    amended_allowed_files: arr(relPath),
  }),
  'qa.generate_tests': obj({
    test_file: str({ pattern: /^test\/acceptance\/[\w.-]+\.test\.js$/ }),
    content: str({ minLength: 20 }),
    criteria_covered: arr(str({ pattern: /^AC-\d+$/ }), { minItems: 1 }),
  }),
  'developer.implement': obj({
    summary: str({ minLength: 5 }),
    changes: arr(obj({ path: relPath, action: str({ enum: ['create', 'modify'] }), content: str() }), { minItems: 1, maxItems: 10 }),
    design_deviations: arr(obj({ path: relPath, proposal: str(), justification: str() })),
    tests_added: arr(str()),
  }),
  'qa.review': obj({
    verdict: str({ enum: ['pass', 'fail'] }),
    failing_criteria: arr(str()),
    feedback_for_developer: str(),
  }),
  'security.review': obj({
    verdict: str({ enum: ['pass', 'block'] }),
    findings: arr(
      obj(
        {
          id: str(),
          severity: str({ enum: ['critical', 'high', 'medium', 'low', 'info'] }),
          file: str(),
          line: { type: 'number', min: 0 },
          title: str(),
          recommendation: str(),
          source: str({ enum: ['sast', 'agent'] }),
        },
        ['id', 'severity', 'file', 'line', 'title', 'recommendation'],
      ),
    ),
    summary: str(),
  }),
  'release.assemble': obj({
    title: str({ minLength: 5 }),
    summary: str({ minLength: 10 }),
    test_evidence: arr(str(), { minItems: 1 }),
    known_risks: arr(str()),
    rollback_plan: str({ minLength: 5 }),
    recommendation: str({ enum: ['approve', 'reject'] }),
  }),
} satisfies Record<string, Schema>;

export type AgentTask = keyof typeof SCHEMAS;
