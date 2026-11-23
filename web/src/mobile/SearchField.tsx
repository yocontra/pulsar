/**
 * Konsta's Searchbar for Home's search field, in its own chunk: Home paints
 * a plain input of the same size first (HomeSearch in Home.tsx) and swaps
 * this in once it loads, keeping the text and the focus.
 */
import { Searchbar } from "konsta/react";
import { useEffect, useRef } from "react";

export interface SearchInputProps {
	id: string;
	placeholder: string;
	value: string;
	onText: (text: string) => void;
	/** The plain input has the focus now (keep it on the swap). */
	focused?: () => boolean;
}

export default function KonstaSearch({
	id,
	placeholder,
	value,
	onText,
	focused,
}: SearchInputProps) {
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// The plain input had the focus: the operator keeps typing here.
		if (focused?.()) box.current?.querySelector("input")?.focus();
	}, []);
	return (
		<div ref={box} className="contents">
			<Searchbar
				inputId={id}
				placeholder={placeholder}
				value={value}
				onInput={(e: React.FormEvent<HTMLInputElement>) =>
					onText(e.currentTarget.value)
				}
				onClear={() => onText("")}
			/>
		</div>
	);
}
