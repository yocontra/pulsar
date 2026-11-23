/** Settings → "Diagnostics" on the phone: a row that opens the page. */
import { StethoscopeIcon } from "lucide-react";
import { navigate } from "../../lib/router.ts";
import { LinkRow, RowIcon } from "../../mobile/ui/rows.tsx";

export default function PhoneSection() {
	return (
		<LinkRow
			icon={
				<RowIcon tone="blue">
					<StethoscopeIcon />
				</RowIcon>
			}
			title="Check Every Machine"
			onClick={() => navigate({ view: "page", name: "diagnostics" })}
			setting="diagnostics"
		/>
	);
}
