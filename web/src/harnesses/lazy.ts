import { type ComponentType, lazy } from "react";
import type { BodyProps } from "../session/tools/bodies.tsx";

type Bodies = typeof import("../session/tools/bodies.tsx");

/** A shared body component, loaded with the other card bodies on first open. */
export function lazyBody(
	name: {
		[K in keyof Bodies]: Bodies[K] extends ComponentType<BodyProps> ? K : never;
	}[keyof Bodies],
): ComponentType<BodyProps> {
	return lazy(() =>
		import("../session/tools/bodies.tsx").then((m) => ({
			default: m[name] as ComponentType<BodyProps>,
		})),
	);
}
