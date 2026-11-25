import { readHosted, viewHosted } from "./providers.ts";
import { hostedProvider } from "./wire.ts";

export async function hostedCommand(args: string[]): Promise<number> {
	const [name, command = "list", id] = args;
	const provider = hostedProvider.safeParse(name);
	if (
		!provider.success ||
		!(
			(command === "list" && id === undefined) ||
			(command === "view" && id && args.length === 3)
		)
	) {
		console.error(
			"Usage: pulsar hosted <copilot|codex|cursor> [list|view <id>]",
		);
		return 2;
	}
	const result =
		command === "list"
			? await readHosted(provider.data)
			: await viewHosted(provider.data, id!);
	if (
		!result ||
		(typeof result === "object" &&
			"state" in result &&
			result.state === "unavailable")
	) {
		console.error(
			`Could not read ${provider.data} tasks. Check the provider connection and credentials on this machine.`,
		);
		return 1;
	}
	console.log(
		typeof result === "string"
			? result
			: JSON.stringify("tasks" in result ? result.tasks : result, null, 2),
	);
	return 0;
}
