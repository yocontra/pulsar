/**
 * TanStack Query treats a runtime without `window` as a server and never
 * polls there. The data layer tests need browser behaviour: import this
 * first, before anything that loads @tanstack/react-query.
 */
const g = globalThis as { window?: unknown };
g.window ??= globalThis;
