/**
 * TanStack Query treats a runtime without `window` as a server and never
 * polls there. The data layer tests need browser behaviour: import this
 * first in their files.
 *
 * Every test file runs in one process with one module registry, and
 * TanStack decides "server" once, when its module first loads. A file
 * without this shim that loads it first (unit.test.ts, through
 * session/streamdown.tsx) would freeze that answer for every later file,
 * so the shim also overrides the check itself, whatever loaded first.
 */
import { environmentManager } from "@tanstack/react-query";

const g = globalThis as { window?: unknown };
g.window ??= globalThis;
environmentManager.setIsServer(() => false);
