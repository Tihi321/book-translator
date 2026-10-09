/** The agents of the pipeline. Kept apart from schemas.ts so the renderer can use them without bundling zod. */
export const AGENTS = ['glossary', 'translator', 'proofreader', 'qa'] as const
export type AgentName = (typeof AGENTS)[number]
