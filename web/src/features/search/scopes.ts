export const savedScopes = {
	local: "Saved conversations on this machine",
	peers: "Saved conversations on other machines",
} as const;
export type SavedScope = keyof typeof savedScopes;
