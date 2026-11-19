/**
 * Loads every feature's registrations (`features/<name>/register.ts[x]`,
 * see lib/registry.tsx) before the app renders: imported first by main.tsx.
 * Adding a feature needs no edit here.
 */
import.meta.glob("./features/*/register.{ts,tsx}", { eager: true });
