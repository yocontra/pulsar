const decode = new TextDecoder("utf-8", { fatal: true });

export type WireFields = Map<number, number | Uint8Array>;

function* entries(bytes: Uint8Array): Generator<[number, number | Uint8Array]> {
	let offset = 0;
	function varint() {
		let value = 0;
		for (let shift = 0; shift < 70 && offset < bytes.length; shift += 7) {
			const byte = bytes[offset++]!;
			value += (byte & 127) * 2 ** shift;
			if (byte < 128) return value;
		}
		throw new Error("Invalid protobuf varint");
	}
	while (offset < bytes.length) {
		const tag = varint();
		const field = Math.floor(tag / 8);
		const wire = tag % 8;
		if (!field || !Number.isSafeInteger(tag))
			throw new Error("Invalid protobuf field");
		if (wire === 0) yield [field, varint()];
		else if (wire === 2) {
			const length = varint();
			if (length > bytes.length - offset)
				throw new Error("Truncated protobuf bytes");
			yield [field, bytes.subarray(offset, offset + length)];
			offset += length;
		} else if (wire === 1 || wire === 5) {
			offset += wire === 1 ? 8 : 4;
			if (offset > bytes.length) throw new Error("Truncated protobuf field");
		} else throw new Error("Unsupported protobuf field");
	}
}

export function fields(bytes: Uint8Array): WireFields {
	return new Map(entries(bytes));
}

export function repeated(
	bytes: Uint8Array | number | undefined,
	field: number,
) {
	if (!(bytes instanceof Uint8Array)) return [];
	const values: (number | Uint8Array)[] = [];
	for (const [key, value] of entries(bytes)) {
		if (key === field) values.push(value);
	}
	return values;
}

export function utf8(value: Uint8Array | number | undefined) {
	if (!(value instanceof Uint8Array)) return "";
	try {
		return decode.decode(value);
	} catch {
		return "";
	}
}

export function message(raw: number | Uint8Array | undefined) {
	return raw instanceof Uint8Array
		? fields(raw)
		: new Map<number, number | Uint8Array>();
}
