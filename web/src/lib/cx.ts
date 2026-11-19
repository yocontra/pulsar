/** Join class names (no tailwind-merge: keeps the light ds entry small). */
export const cx = (...c: (string | false | null | undefined)[]) =>
	c.filter(Boolean).join(" ");
