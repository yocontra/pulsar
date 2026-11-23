import { describe, expect, test } from "bun:test";
import { decidedHow } from "../src/service/approvals.ts";
import { proverLabel, proverMethod } from "../src/service/passkeys.ts";

describe("the device that proved a decision", () => {
	test("named from the request's tailnet node and OS", () => {
		expect(proverLabel({ node: "contra-m2-mbp", os: "macOS" })).toBe(
			"Mac (contra-m2-mbp)",
		);
		expect(proverLabel({ node: "erics-iphone", os: "iOS" })).toBe(
			"iOS (erics-iphone)",
		);
		// A forwarded decision carries the browser's node but no OS.
		expect(proverLabel({ node: "erics-iphone" })).toBe("erics-iphone");
		expect(proverLabel({ node: "", os: "macOS" })).toBe("Mac");
		expect(proverLabel({ node: "  " })).toBeNull();
		expect(proverLabel({ node: "box\u0007", os: "plan9" })).toBe("box");
	});

	test("the method follows the OS, not the passkey's label", () => {
		expect(proverMethod("macOS")).toBe("Touch ID");
		expect(proverMethod("iOS")).toBe("Face ID");
		expect(proverMethod("windows")).toBe("passkey");
		expect(proverMethod(undefined)).toBe("passkey");
	});

	test("stored rows: the prover's device when known; app rows from before show none", () => {
		expect(
			decidedHow({
				answered_by: "app",
				decided_method: "passkey session",
				decided_device: "iPhone",
				decided_on: "Mac (contra-m2-mbp)",
			}),
		).toEqual({
			method: " · passkey session",
			device: " on Mac (contra-m2-mbp)",
		});
		expect(
			decidedHow({
				answered_by: "app",
				decided_method: "passkey session",
				decided_device: "iPhone",
				decided_on: null,
			}),
		).toEqual({ method: " · passkey session", device: "" });
		expect(
			decidedHow({
				answered_by: "app",
				decided_method: "Face ID",
				decided_device: "iPhone",
			}),
		).toEqual({ method: " · passkey", device: "" });
		// Touch ID on this machine (native): its own name was always right.
		expect(
			decidedHow({
				answered_by: "native",
				decided_method: "Touch ID",
				decided_device: "studio",
			}),
		).toEqual({ method: " · Touch ID", device: " on studio" });
	});
});
