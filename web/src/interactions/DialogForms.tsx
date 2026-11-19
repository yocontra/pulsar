import { ScanFaceIcon } from "lucide-react";
import { useState } from "react";
import { faceIdLabel, useAsksFaceId } from "../approval/faceid.ts";
import { btn } from "./buttons.ts";
import type { InteractionRendererProps, PromptOf } from "./types.ts";

/**
 * The small host dialogs (pi/omp `ctx.ui.confirm/select/input/editor`),
 * relayed by the pulsar extension. Each can be dismissed (`cancel`), which
 * the host reads as the person closing its dialog.
 */

export function ConfirmForm({
	approval,
	prompt,
	mobile,
	disabled,
	submit,
}: InteractionRendererProps<PromptOf<"confirm">>) {
	const asks = useAsksFaceId(approval);
	return (
		<div className="ix-confirm">
			<p className="ix-title">{prompt.title}</p>
			{prompt.message && <p className="ix-message">{prompt.message}</p>}
			<div className="ix-actions">
				<button
					type="button"
					className={btn(mobile, "secondary")}
					disabled={disabled}
					onClick={() => submit({ kind: "confirm", confirmed: false })}
				>
					No
				</button>
				<button
					type="button"
					className={btn(mobile, "primary")}
					disabled={disabled}
					aria-label={faceIdLabel("Yes", asks)}
					onClick={() => submit({ kind: "confirm", confirmed: true })}
				>
					{mobile && asks && <ScanFaceIcon className="size-5 faceid-mark" />}{" "}
					Yes
				</button>
			</div>
		</div>
	);
}

export function SelectForm({
	prompt,
	mobile,
	disabled,
	submit,
}: InteractionRendererProps<PromptOf<"select">>) {
	return (
		<div className="ix-select">
			<p className="ix-title">{prompt.title}</p>
			<div className="ix-choices" role="group" aria-label={prompt.title}>
				{prompt.options.map((o) => (
					<button
						key={o.label}
						type="button"
						className={`ix-choice${mobile ? " mobile" : ""}`}
						disabled={disabled}
						onClick={() => submit({ kind: "select", value: o.label })}
					>
						<span className="ix-opt-label">{o.label}</span>
						{o.description && (
							<span className="ix-opt-desc">{o.description}</span>
						)}
					</button>
				))}
			</div>
			<div className="ix-actions">
				<button
					type="button"
					className={btn(mobile, "secondary")}
					disabled={disabled}
					onClick={() => submit({ kind: "cancel" })}
				>
					Dismiss
				</button>
			</div>
		</div>
	);
}

export function InputForm({
	approval,
	prompt,
	mobile,
	disabled,
	submit,
}: InteractionRendererProps<PromptOf<"input">>) {
	const asks = useAsksFaceId(approval);
	const [value, setValue] = useState(prompt.prefill ?? "");
	return (
		<form
			className="ix-input"
			onSubmit={(e) => {
				e.preventDefault();
				submit({ kind: "input", value });
			}}
		>
			<label className="ix-title" htmlFor="ix-input-field">
				{prompt.title}
			</label>
			{prompt.multiline ? (
				<textarea
					id="ix-input-field"
					className="ix-text"
					rows={6}
					placeholder={prompt.placeholder}
					value={value}
					disabled={disabled}
					onChange={(e) => setValue(e.target.value)}
				/>
			) : (
				<input
					id="ix-input-field"
					className="ix-text"
					type={prompt.secret ? "password" : "text"}
					autoComplete="off"
					placeholder={prompt.placeholder}
					value={value}
					disabled={disabled}
					onChange={(e) => setValue(e.target.value)}
				/>
			)}
			<div className="ix-actions">
				<button
					type="button"
					className={btn(mobile, "secondary")}
					disabled={disabled}
					onClick={() => submit({ kind: "cancel" })}
				>
					Dismiss
				</button>
				<button
					type="submit"
					className={btn(mobile, "primary")}
					disabled={disabled}
					aria-label={faceIdLabel("Send", asks)}
				>
					{mobile && asks && <ScanFaceIcon className="size-5 faceid-mark" />}{" "}
					Send
				</button>
			</div>
		</form>
	);
}
