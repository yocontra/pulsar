import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Usage } from "../src/usage/index.ts";
import {
	isLocalProvider,
	isLocalUrl,
	localOnlyModels,
	type Providers,
	providersFromJson,
	providersFromToml,
	providersFromYaml,
	readProviders,
} from "../src/usage/local.ts";
import { type FileState, parseLine } from "../src/usage/parse.ts";
import {
	isLocalModel,
	modelName,
	priceFor,
	priceTable,
	tagLocal,
} from "../src/usage/prices.ts";
import { rootsIn, write } from "./usage-fixtures.ts";

const HOUR = 3_600_000;
const T = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR + 60_000;

/** Shaped like omp's real models.yml (no keys; ids with `:` and `/`). */
const OMP_YAML = `providers:
    ollama:
        api: openai-responses
        baseUrl: http://127.0.0.1:11434/v1
        discovery:
            type: ollama
        models:
            - contextWindow: 262144
              id: hf.co/acme/gemma-4-31B-it-GGUF:Q4_K_M
              input:
                - text
              name: hf.co/acme/gemma-4-31B-it-GGUF:Q4_K_M
            - contextWindow: 1048576
              id: glm-5.3-flash:cloud
              name: glm-5.3-flash:cloud
            - id: qwen3.8:27b
              name: qwen3.8:27b
    splash:
        api: openai-completions
        baseUrl: "http://127.0.0.1:8000/v1" # local server
        compat:
            streamIdleTimeoutMs: 900000
        models:
            - contextWindow: 262144
              id: local/heretic-pure
              name: Heretic (Splash)
    hosted:
        baseUrl: https://api.example.com/v1
        models:
            - id: shared-model
            - id: local/heretic-pure-hosted
modelRoles:
    default: splash/local/heretic-pure:high
`;

const providers = (o: Record<string, string | null>): Providers =>
	new Map(
		Object.entries(o).map(([k, baseUrl]) => [k, { baseUrl, models: [] }]),
	);

function piLine(provider: string, model: string, t = T, id = "r1") {
	return JSON.stringify({
		type: "message",
		timestamp: new Date(t).toISOString(),
		message: {
			role: "assistant",
			provider,
			model,
			responseId: id,
			usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0 },
		},
	});
}

describe("local endpoints", () => {
	test("loopback, private, link-local, Tailscale and .local hosts are local", () => {
		for (const u of [
			"http://127.0.0.1:11434/v1",
			"http://localhost:1234",
			"http://api.localhost/v1",
			"http://[::1]:8000/v1",
			"http://10.0.0.5/v1",
			"http://172.20.1.1/v1",
			"http://192.168.1.20:8080",
			"http://169.254.10.1",
			"http://100.101.102.103:11434",
			"http://gpu-box.tailnet-abc.ts.net:11434",
			"http://studio.local:1234/v1",
			"http://[fd12:3456::1]:8000",
			"http://[::ffff:192.168.0.2]/v1",
		])
			expect(isLocalUrl(u), u).toBe(true);
	});

	test("public hosts and bad URLs are not local", () => {
		for (const u of [
			"https://api.openai.com/v1",
			"https://opencode.ai/zen/go/v1",
			"http://172.32.0.1",
			"http://100.128.0.1",
			"http://8.8.8.8",
			"https://localhost.example.com",
			"not a url",
			"",
		])
			expect(isLocalUrl(u), u).toBe(false);
	});
});

describe("local providers", () => {
	test("the config's base URL decides, whatever the name", () => {
		const ps = providers({
			splash: "http://127.0.0.1:8000/v1",
			ollama: "https://ollama.example.com",
		});
		expect(isLocalProvider("splash", "local/heretic-pure", ps)).toBe(true);
		// A remote Ollama is not local despite the name.
		expect(isLocalProvider("ollama", "qwen3.8:27b", ps)).toBe(false);
	});

	test("without a URL in the config, known local runtimes by name", () => {
		const none: Providers = new Map();
		for (const p of ["ollama", "lmstudio", "llama.cpp", "mlx", "vllm", "oss"])
			expect(isLocalProvider(p, "some-model", none), p).toBe(true);
		for (const p of ["openai", "opencode-go", "anthropic", "venice", "splash"])
			expect(isLocalProvider(p, "some-model", none), p).toBe(false);
	});

	test("Ollama cloud models run on Ollama's servers", () => {
		const ps = providers({ ollama: "http://127.0.0.1:11434/v1" });
		expect(isLocalProvider("ollama", "glm-5.3-flash:cloud", ps)).toBe(false);
		expect(isLocalProvider("ollama", "gpt-oss:120b-cloud", ps)).toBe(false);
		expect(isLocalProvider("ollama", "kimi-k3.1-pro:cloud", ps)).toBe(false);
		expect(isLocalProvider("ollama", "qwen3.8:27b", ps)).toBe(true);
	});
});

describe("config readers", () => {
	test("omp models.yml: providers, base URLs and model ids", () => {
		const ps = providersFromYaml(OMP_YAML);
		expect([...ps.keys()]).toEqual(["ollama", "splash", "hosted"]);
		expect(ps.get("ollama")?.baseUrl).toBe("http://127.0.0.1:11434/v1");
		expect(ps.get("ollama")?.models).toEqual([
			"hf.co/acme/gemma-4-31B-it-GGUF:Q4_K_M",
			"glm-5.3-flash:cloud",
			"qwen3.8:27b",
		]);
		expect(ps.get("splash")?.baseUrl).toBe("http://127.0.0.1:8000/v1");
		expect(ps.get("splash")?.models).toEqual(["local/heretic-pure"]);
	});

	test("YAML with no providers block, or flow style, gives nothing", () => {
		expect(providersFromYaml("theme: dark\n").size).toBe(0);
		expect(
			providersFromYaml('providers: { ollama: { baseUrl: "x" } }\n').size,
		).toBe(0);
	});

	test("pi/omp models.json", () => {
		const ps = providersFromJson(
			JSON.stringify({
				providers: {
					LMStudio: {
						baseUrl: "http://localhost:1234/v1",
						models: [{ id: "qwen3.8-27b" }, { id: 3 }],
					},
					remote: { baseUrl: "https://api.example.com" },
				},
			}),
		);
		expect(ps.get("lmstudio")).toEqual({
			baseUrl: "http://localhost:1234/v1",
			models: ["qwen3.8-27b"],
		});
		expect(ps.get("remote")?.models).toEqual([]);
		expect(providersFromJson("{not json").size).toBe(0);
	});

	test("Codex config.toml model_providers", () => {
		const ps = providersFromToml(`model = "gpt-6.2-sol"
[model_providers.box]
name = "GPU box"
base_url = "http://192.168.1.50:8080/v1"

[model_providers."hosted"]
base_url = "https://api.example.com/v1"

[profiles.x]
base_url = "http://127.0.0.1"
`);
		expect(ps.get("box")?.baseUrl).toBe("http://192.168.1.50:8080/v1");
		expect(ps.get("hosted")?.baseUrl).toBe("https://api.example.com/v1");
		expect(ps.size).toBe(2);
	});

	test("models listed only under local providers", () => {
		const ps = providersFromYaml(
			`${OMP_YAML.replace("- id: shared-model", "- id: qwen3.8:27b")}`,
		);
		expect([...localOnlyModels(ps)].sort()).toEqual([
			"hf.co/acme/gemma-4-31B-it-GGUF:Q4_K_M",
			"local/heretic-pure",
		]);
	});
});

describe("local prices", () => {
	test("a tagged model costs exactly 0; the tag hides in the name", () => {
		const table = priceTable({});
		const id = tagLocal("qwen3.8:27b");
		expect(isLocalModel(id)).toBe(true);
		expect(tagLocal(id)).toBe(id);
		expect(modelName(id)).toBe("qwen3.8:27b");
		expect(priceFor(id, table)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
		});
		// A tagged id a hosted API also sells still costs 0.
		expect(priceFor(tagLocal("gpt-6.2-sol"), table)?.input).toBe(0);
		// A name alone is not detection.
		expect(priceFor("local/heretic-pure", table)).toBeNull();
		expect(priceFor("qwen3.8:27b", table)).toBeNull();
	});
});

describe("scanner", () => {
	let dir: string;
	let store: Store;
	let usage: Usage;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-usage-local-"));
		store = new Store(join(dir, "pulsar.db"));
		usage = new Usage(store, { roots: () => rootsIn(dir) });
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const models = () =>
		[...new Set(usage.local("7d", 0).rows.map((r) => r.model))].sort();

	test("pi/omp: a record from a local provider is tagged and priced at $0", async () => {
		mkdirSync(join(dir, "omp"), { recursive: true });
		writeFileSync(join(dir, "omp", "models.yml"), OMP_YAML);
		write(join(dir, "omp", "sessions", "-work", "1_a.jsonl"), [
			piLine("splash", "local/heretic-pure", T, "a1"),
			piLine("ollama", "glm-5.3-flash:cloud", T, "a2"),
			piLine("ollama", "qwen3.8:27b", T, "a3"),
			piLine("opencode-go", "deepseek-v4.1-flash", T, "a4"),
		]);
		// pi has no config: Ollama counts by name.
		write(join(dir, "pi", "sessions", "-work", "1_b.jsonl"), [
			piLine("ollama", "gemma4:12b", T, "b1"),
			piLine("hosted", "shared-model", T, "b2"),
		]);
		await usage.scanner.scan();
		expect(models()).toEqual([
			"deepseek-v4.1-flash",
			"gemma4:12b[local]",
			"glm-5.3-flash:cloud",
			"local/heretic-pure[local]",
			"qwen3.8:27b[local]",
			"shared-model",
		]);
		const report = await usage.report("7d", 0, { id: "m", name: "m" }, null);
		const cost = (m: string) => report.rows.find((r) => r.model === m)?.cost;
		expect(cost("local/heretic-pure[local]")).toBe(0);
		expect(cost("gemma4:12b[local]")).toBe(0);
		expect(cost("glm-5.3-flash:cloud")).toBeNull();
		expect(cost("deepseek-v4.1-flash")).toBeGreaterThan(0);
	});

	test("Codex: the session's model_provider", async () => {
		mkdirSync(join(dir, "codex"), { recursive: true });
		writeFileSync(
			join(dir, "codex", "config.toml"),
			'[model_providers.box]\nbase_url = "http://192.168.1.50:8080/v1"\n',
		);
		const lines = (provider: string, model: string) => [
			JSON.stringify({
				timestamp: new Date(T).toISOString(),
				type: "session_meta",
				payload: { id: "x", cwd: "/w", model_provider: provider },
			}),
			JSON.stringify({
				timestamp: new Date(T).toISOString(),
				type: "turn_context",
				payload: { cwd: "/w", model },
			}),
			JSON.stringify({
				timestamp: new Date(T + 1000).toISOString(),
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							input_tokens: 1000,
							cached_input_tokens: 0,
							output_tokens: 100,
						},
					},
				},
			}),
		];
		const [y, m, d] = new Date(T).toISOString().slice(0, 10).split("-");
		const day = join(dir, "codex", "sessions", y!, m!, d!);
		const uuid = (n: number) => `0000000${n}-0000-0000-0000-000000000000`;
		write(join(day, `rollout-a-${uuid(1)}.jsonl`), lines("box", "qwen3.8-27b"));
		write(join(day, `rollout-b-${uuid(2)}.jsonl`), lines("oss", "gpt-oss:20b"));
		write(
			join(day, `rollout-c-${uuid(3)}.jsonl`),
			lines("openai", "gpt-6.2-sol"),
		);
		await usage.scanner.scan();
		const rows = store.db
			.prepare("SELECT DISTINCT model FROM usage_hourly ORDER BY model")
			.all() as { model: string }[];
		expect(rows.map((r) => r.model)).toEqual([
			"gpt-6.2-sol",
			"gpt-oss:20b[local]",
			"qwen3.8-27b[local]",
		]);
	});

	test("history stored before tagging is retagged once, merging rows", async () => {
		mkdirSync(join(dir, "omp"), { recursive: true });
		writeFileSync(join(dir, "omp", "models.yml"), OMP_YAML);
		const hour = Math.floor(T / HOUR) * HOUR;
		const ins = store.db.prepare(
			`INSERT INTO usage_hourly (hour, harness, model, project, session, input, cache_read, cache_write_5m, cache_write_1h, output, records)
VALUES (?, ?, ?, '/w', 's', ?, 0, 0, 0, 0, 1)`,
		);
		ins.run(hour, "omp", "local/heretic-pure", 100);
		ins.run(hour, "omp", "local/heretic-pure[local]", 5);
		ins.run(hour, "omp", "glm-5.3-flash:cloud", 7);
		ins.run(hour, "omp", "deepseek-v4.1-flash", 9);
		ins.run(hour, "pi", "local/heretic-pure", 11);
		await usage.scanner.scan();
		const rows = store.db
			.prepare(
				"SELECT harness, model, input, records FROM usage_hourly ORDER BY harness, model",
			)
			.all();
		expect(rows).toEqual([
			{ harness: "omp", model: "deepseek-v4.1-flash", input: 9, records: 1 },
			{ harness: "omp", model: "glm-5.3-flash:cloud", input: 7, records: 1 },
			{
				harness: "omp",
				model: "local/heretic-pure[local]",
				input: 105,
				records: 2,
			},
			// pi's config (none here) does not vouch for it.
			{ harness: "pi", model: "local/heretic-pure", input: 11, records: 1 },
		]);
		// Once only: a later untagged row stays as stored.
		ins.run(hour + HOUR, "omp", "local/heretic-pure", 1);
		await usage.scanner.scan();
		const again = store.db
			.prepare(
				"SELECT count(*) AS n FROM usage_hourly WHERE model = 'local/heretic-pure'",
			)
			.get() as { n: number };
		expect(again.n).toBe(2);
	});

	test("config is read next to the sessions folder", async () => {
		mkdirSync(join(dir, "pi"), { recursive: true });
		writeFileSync(
			join(dir, "pi", "models.json"),
			JSON.stringify({
				providers: { lab: { baseUrl: "http://10.1.2.3:8000/v1" } },
			}),
		);
		expect(
			(await readProviders("pi", join(dir, "pi", "sessions"))).get("lab")
				?.baseUrl,
		).toBe("http://10.1.2.3:8000/v1");
		expect(
			(await readProviders("omp", join(dir, "omp", "sessions"))).size,
		).toBe(0);
	});

	test("the parser keeps the provider", () => {
		const s: FileState = {};
		const r = parseLine("omp", piLine("splash", "local/heretic-pure"), s);
		expect(r?.provider).toBe("splash");
		expect(r?.model).toBe("local/heretic-pure");
	});
});
