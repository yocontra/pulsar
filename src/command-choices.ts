type Choice = { value: string; label: string };

// Catalogs cross the daemon socket. Leave room within a frame for the
// remaining commands. A model past the display limit can still be typed.
export function boundedArgumentChoices(
	choices: Iterable<Choice>,
	current?: string,
) {
	const result: Choice[] = [];
	const budget = 128 * 1024;
	let bytes = 0;
	for (const choice of choices) {
		if (bytes >= budget && choice.value !== current) continue;
		const size = Buffer.byteLength(JSON.stringify(choice)) + 1;
		if (size > budget) continue;
		if (bytes + size > budget) {
			if (choice.value !== current) continue;
			while (result.length && bytes + size > budget)
				bytes -= Buffer.byteLength(JSON.stringify(result.pop())) + 1;
		}
		bytes += size;
		result.push(choice);
	}
	return result;
}
