import type {
	CreateElicitationRequest,
	ElicitationContentValue,
	ElicitationPropertySchema,
	RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type { InteractionPrompt, InteractionQuestion } from "../http/wire.ts";

type Choice = { label: string; value: string };
const MAX_QUESTIONS = 20;
const MAX_CHOICES = 50;

function choices(entries: Choice[]): Map<string, string> | null {
	if (!entries.length || entries.length > MAX_CHOICES) return null;
	const mapped = new Map<string, string>();
	for (const { label, value } of entries) {
		if (typeof label !== "string" || typeof value !== "string") return null;
		const text = label.trim().slice(0, 200);
		if (!text || mapped.has(text) || value.length > 4096) return null;
		mapped.set(text, value);
	}
	return mapped;
}

function question(
	id: string,
	title: string,
	options: Map<string, string> | null,
	multiSelect = false,
): InteractionQuestion {
	return {
		id,
		question: title.trim().slice(0, 1000) || id,
		options: [...(options?.keys() ?? [])].map((label) => ({ label })),
		multiSelect,
		allowOther: options === null,
	};
}

export function antigravityQuestion(request: RequestPermissionRequest) {
	const ids = request.options.map(({ optionId }) => optionId);
	if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length)
		return null;
	const options = choices(
		request.options.map(({ name, optionId }) => ({
			label: name.trim() || optionId,
			value: optionId,
		})),
	);
	if (!options) return null;
	const field = question(
		"choice",
		request.toolCall.title ?? "Choose an option",
		options,
	);
	return {
		prompt: {
			kind: "question",
			questions: [field],
		} satisfies InteractionPrompt,
		answer(answers: Record<string, string[]>) {
			return answers.choice?.length === 1
				? options.get(answers.choice[0]!)
				: undefined;
		},
	};
}

type Field = {
	prompt: InteractionQuestion;
	convert: (values: string[]) => ElicitationContentValue | undefined;
};

function formField(
	id: string,
	schema: ElicitationPropertySchema,
): Field | null {
	const title =
		(typeof schema.description === "string" && schema.description.trim()) ||
		(typeof schema.title === "string" && schema.title.trim()) ||
		id;
	const textChoices = (values: string[]) =>
		values.map((value) => ({ label: value, value }));
	const titledChoices = (values: { title: string; const: string }[]) =>
		values.map((option) => ({ label: option.title, value: option.const }));
	if (schema.type === "string") {
		const options = Array.isArray(schema.oneOf)
			? choices(titledChoices(schema.oneOf))
			: Array.isArray(schema.enum)
				? choices(textChoices(schema.enum))
				: null;
		if ((schema.oneOf != null || schema.enum != null) && !options) return null;
		// The question UI does not validate arbitrary patterns or string formats.
		if (!options && (schema.pattern != null || schema.format != null))
			return null;
		return {
			prompt: question(id, title, options),
			convert(values) {
				if (values.length !== 1) return;
				const value = options ? options.get(values[0]!) : values[0];
				if (value === undefined || value.length > 4000) return;
				if (
					typeof schema.minLength === "number" &&
					value.length < schema.minLength
				)
					return;
				if (
					typeof schema.maxLength === "number" &&
					value.length > schema.maxLength
				)
					return;
				return value;
			},
		};
	}
	if (
		schema.type === "array" &&
		typeof schema.items === "object" &&
		schema.items !== null
	) {
		const items = schema.items;
		const options =
			"anyOf" in items && Array.isArray(items.anyOf)
				? choices(titledChoices(items.anyOf))
				: "enum" in items && Array.isArray(items.enum)
					? choices(textChoices(items.enum))
					: null;
		if (!options) return null;
		return {
			prompt: question(id, title, options, true),
			convert(values) {
				if (
					new Set(values).size !== values.length ||
					(typeof schema.minItems === "number" &&
						values.length < schema.minItems) ||
					(typeof schema.maxItems === "number" &&
						values.length > schema.maxItems)
				)
					return;
				const selected = values.map((value) => options.get(value));
				if (selected.every((value) => value !== undefined)) return selected;
			},
		};
	}
	if (schema.type === "boolean") {
		const options = new Map([
			["Yes", "true"],
			["No", "false"],
		]);
		return {
			prompt: question(id, title, options),
			convert(values) {
				if (values.length !== 1 || !options.has(values[0]!)) return;
				return values[0] === "Yes";
			},
		};
	}
	if (schema.type === "number" || schema.type === "integer") {
		return {
			prompt: question(id, title, null),
			convert(values) {
				if (values.length !== 1) return;
				const plain = values[0]!.trim();
				if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(plain))
					return;
				const value = Number(plain);
				if (
					!Number.isFinite(value) ||
					(schema.type === "integer" && !Number.isSafeInteger(value))
				)
					return;
				if (typeof schema.minimum === "number" && value < schema.minimum)
					return;
				if (typeof schema.maximum === "number" && value > schema.maximum)
					return;
				return value;
			},
		};
	}
	return null;
}

function skipOption(field: Field): string {
	const labels = new Set(field.prompt.options.map(({ label }) => label));
	let label = "Skip this field";
	while (labels.has(label)) label += ".";
	field.prompt.options.push({ label });
	return label;
}

export function elicitationQuestions(request: CreateElicitationRequest) {
	if (request.mode !== "form") return null;
	const schema = request.requestedSchema;
	if (!schema || typeof schema !== "object" || !("properties" in schema))
		return null;
	const { properties, required, title } = schema as {
		properties?: Record<string, ElicitationPropertySchema>;
		required?: string[] | null;
		title?: string | null;
	};
	const entries = Object.entries(properties ?? {});
	if (!entries.length || entries.length > MAX_QUESTIONS) return null;
	const mandatory = new Set(required ?? []);
	const fields = new Map<string, Field & { skip?: string }>();
	for (const [id, property] of entries) {
		if (
			!/^[\w.-]{1,120}$/.test(id) ||
			Object.hasOwn(Object.prototype, id) ||
			id === "prototype" ||
			!property ||
			typeof property !== "object"
		)
			return null;
		const field = formField(id, property);
		if (!field) return null;
		if (mandatory.has(id)) fields.set(id, field);
		else {
			if (field.prompt.options.length >= MAX_CHOICES) return null;
			fields.set(id, { ...field, skip: skipOption(field) });
		}
	}
	if ([...mandatory].some((id) => !fields.has(id))) return null;
	return {
		prompt: {
			kind: "question",
			title: (title?.trim() || request.message.trim()).slice(0, 300),
			questions: [...fields.values()].map((field) => field.prompt),
		} satisfies InteractionPrompt,
		answer(answers: Record<string, string[]>) {
			const content: Array<[string, ElicitationContentValue]> = [];
			for (const [id, field] of fields) {
				const values = Object.hasOwn(answers, id) ? answers[id]! : [];
				if (
					field.skip &&
					(!values.length || (values.length === 1 && values[0] === field.skip))
				)
					continue;
				if (field.skip && values.includes(field.skip)) return;
				const value = field.convert(values);
				if (value === undefined) return;
				content.push([id, value]);
			}
			return Object.fromEntries(content);
		},
	};
}
