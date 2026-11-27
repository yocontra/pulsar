import { expect, test } from "bun:test";
import { AcpSessionControls } from "../src/harnesses/acp-controls.ts";

test("large ACP model catalogs allow exact selection beyond the menu and keep the current model visible", () => {
	const controls = new AcpSessionControls();
	const options = Array.from({ length: 5000 }, (_, i) => ({
		value: `model-${i}`,
		name: `Provider model ${i}`,
	}));
	controls.install({
		configOptions: [
			{
				id: "model",
				category: "model",
				name: "Model",
				type: "select",
				currentValue: "model-4999",
				options,
			},
		],
	});
	const choices = controls.commandChoices("model");
	expect(choices.some(({ value }) => value === "model-179")).toBe(true);
	expect(choices.some(({ value }) => value === "model-4999")).toBe(true);
	expect(choices.some(({ value }) => value === "model-4998")).toBe(false);
	expect(controls.hasChoice("model", "model-4998")).toBe(true);
	expect(controls.hasChoice("model", "unknown")).toBe(false);
});
