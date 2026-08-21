/**
 * skill-thinking — per-skill model + thinking-level profiles, with automatic
 * review chaining for the plan → implement → review flow.
 *
 * When you run `/skill:<name> ...`, this extension applies that skill's profile
 * BEFORE the skill content is expanded:
 *   - switches the model (pi.setModel)
 *   - sets the thinking level (pi.setThinkingLevel, clamped to model capabilities)
 *
 * When an `/skill:implement <plan>` run settles and every step in the plan file
 * is `done`, it can automatically start `/skill:review <plan>` ("autoReview").
 *
 * Install (global, all projects):
 *   mkdir -p ~/.pi/agent/extensions
 *   ln -s /path/to/this/repo/pi/extensions/skill-thinking.ts ~/.pi/agent/extensions/
 *
 * ── Configuration ────────────────────────────────────────────────────────────
 * Optional JSON files; later files win (defaults < global < project):
 *   ~/.pi/agent/skill-thinking.json     (global)
 *   <project>/.pi/skill-thinking.json   (project-local)
 *
 * Example:
 * {
 *   "profiles": {
 *     "plan":      { "model": "opencode-go/kimi-k3", "thinking": "max" },
 *     "implement": { "thinking": "low" },
 *     "review":    { "model": null, "thinking": "high" }
 *   },
 *   "autoReview": "ask"
 * }
 *
 * - "model": "provider/modelId" to switch models, null to disable model
 *   switching for that skill (thinking still applies), or omit to inherit.
 * - "thinking": off | minimal | low | medium | high | xhigh | max — clamped to
 *   the model's supported levels; the effective level is reported.
 * - "autoReview": "off" | "ask" | "auto".
 * - New skills can be added freely; a profile for a skill not in the defaults
 *   must specify at least "thinking".
 *
 * ── Behavior notes ───────────────────────────────────────────────────────────
 * - pi persists model/thinking changes to settings.json, so this extension
 *   snapshots your session-start defaults and restores them on shutdown
 *   (best-effort).
 * - Manual model changes (/model, Ctrl+P, or a `pi --model ...` escalation
 *   launch) disable profile model switching for the rest of the session.
 * - Thinking-level clamping example (opencode-go): deepseek-v4-pro supports
 *   high/max, deepseek-v4-flash supports low/high/max, kimi-k3 supports max
 *   only — unsupported requests snap to the nearest supported level.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type AutoReviewMode = "off" | "ask" | "auto";

interface SkillProfile {
	/** "provider/modelId" to switch to before the skill runs. Absent = keep current model. */
	model?: string;
	/** Desired thinking level (clamped to the model's supported levels). */
	thinking: ThinkingLevel;
}

interface FileProfile {
	model?: string | null;
	thinking?: string;
}

interface FileConfig {
	profiles?: Record<string, FileProfile | null>;
	autoReview?: string;
}

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const AUTO_REVIEW_MODES: readonly string[] = ["off", "ask", "auto"];

/** Built-in defaults. Override them via skill-thinking.json (see header comment). */
const DEFAULT_PROFILES: Record<string, SkillProfile> = {
	plan: { model: "opencode-go/kimi-k3", thinking: "max" },
	implement: { model: "opencode-go/deepseek-v4-flash", thinking: "low" },
	review: { model: "opencode-go/deepseek-v4-pro", thinking: "high" },
};
const DEFAULT_AUTO_REVIEW: AutoReviewMode = "ask";

const SKILL_COMMAND_RE = /^\/skill:([a-z0-9-]+)(?:\s+(.*))?$/i;

function configPaths(cwd: string): string[] {
	return [
		join(getAgentDir(), "skill-thinking.json"), // global
		join(cwd, CONFIG_DIR_NAME, "skill-thinking.json"), // project-local (wins)
	];
}

function loadConfig(
	cwd: string,
	warn: (msg: string) => void,
): { profiles: Record<string, SkillProfile>; autoReview: AutoReviewMode } {
	// Deep-copy defaults so file overrides never mutate them.
	const profiles: Record<string, SkillProfile> = Object.fromEntries(
		Object.entries(DEFAULT_PROFILES).map(([name, p]) => [name, { ...p }]),
	);
	let autoReview: AutoReviewMode = DEFAULT_AUTO_REVIEW;

	for (const path of configPaths(cwd)) {
		if (!existsSync(path)) continue;

		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch (err) {
			warn(`skill-thinking: failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
			continue;
		}
		if (typeof raw !== "object" || raw === null) {
			warn(`skill-thinking: ${path} must contain a JSON object — ignored`);
			continue;
		}
		const cfg = raw as FileConfig;

		if (cfg.profiles !== undefined) {
			if (typeof cfg.profiles !== "object" || cfg.profiles === null) {
				warn(`skill-thinking: ${path}: "profiles" must be an object — ignored`);
			} else {
				for (const [skill, entry] of Object.entries(cfg.profiles)) {
					if (entry === null || typeof entry !== "object") {
						warn(`skill-thinking: ${path}: profile "${skill}" must be an object — ignored`);
						continue;
					}
					const existing = profiles[skill];
					if (!existing && entry.thinking === undefined) {
						warn(`skill-thinking: ${path}: new profile "${skill}" needs at least "thinking" — ignored`);
						continue;
					}
					const next: SkillProfile = { ...(existing ?? { thinking: "medium" as ThinkingLevel }) };
					if (entry.thinking !== undefined) {
						if (THINKING_LEVELS.includes(entry.thinking)) {
							next.thinking = entry.thinking as ThinkingLevel;
						} else {
							warn(`skill-thinking: ${path}: invalid thinking level "${entry.thinking}" for "${skill}" — ignored`);
						}
					}
					if ("model" in entry) {
						if (entry.model === null) delete next.model; // explicit opt-out of model switching
						else if (typeof entry.model === "string") next.model = entry.model;
						else warn(`skill-thinking: ${path}: "model" for "${skill}" must be a string or null — ignored`);
					}
					profiles[skill] = next;
				}
			}
		}

		if (cfg.autoReview !== undefined) {
			if (AUTO_REVIEW_MODES.includes(cfg.autoReview)) {
				autoReview = cfg.autoReview as AutoReviewMode;
			} else {
				warn(`skill-thinking: ${path}: invalid autoReview "${cfg.autoReview}" — expected off | ask | auto`);
			}
		}
	}

	return { profiles, autoReview };
}

export default function (pi: ExtensionAPI) {
	let profiles: Record<string, SkillProfile> = { ...DEFAULT_PROFILES };
	let autoReview: AutoReviewMode = DEFAULT_AUTO_REVIEW;

	// Flow state
	let lastImplementPlan: string | undefined;
	let reviewTriggered = false;

	// User's session-start model/thinking, restored on shutdown because
	// pi.setModel() / pi.setThinkingLevel() persist to settings.json.
	let originalModel: Model<Api> | undefined;
	let originalThinking: ThinkingLevel | undefined;
	let snapshotTaken = false;

	// Manual model changes by the user disable profile model switching for the
	// session (so escalation runs with `pi --model <strong>` are respected).
	let manualModelOverride = false;
	let applyingProfile = false;

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	async function applyProfile(skillName: string, ctx: ExtensionContext): Promise<void> {
		const profile = profiles[skillName];
		if (!profile) return;

		const changes: string[] = [];

		// Model first: switching models re-clamps the thinking level, so thinking
		// must be applied afterwards.
		if (profile.model && !manualModelOverride) {
			const slash = profile.model.indexOf("/");
			const provider = profile.model.slice(0, slash);
			const modelId = profile.model.slice(slash + 1);
			const current = ctx.model;
			if (current && (current.provider !== provider || current.id !== modelId)) {
				const model = ctx.modelRegistry.find(provider, modelId);
				if (!model) {
					notify(ctx, `skill-thinking: model ${profile.model} not found in registry`, "warning");
				} else {
					try {
						applyingProfile = true;
						const ok = await pi.setModel(model);
						if (ok === false) throw new Error("no auth");
						changes.push(`model → ${provider}/${modelId}`);
					} catch {
						notify(ctx, `skill-thinking: cannot switch to ${profile.model} (no API key?)`, "warning");
					} finally {
						applyingProfile = false;
					}
				}
			}
		}

		const before = pi.getThinkingLevel();
		if (before !== profile.thinking) {
			pi.setThinkingLevel(profile.thinking);
			const effective = pi.getThinkingLevel();
			changes.push(
				effective === profile.thinking
					? `thinking → ${effective}`
					: `thinking → ${effective} (requested "${profile.thinking}", clamped to model limits)`,
			);
		}

		if (changes.length > 0) {
			notify(ctx, `skill:${skillName} — ${changes.join(", ")}`);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// (Re)load config on startup, /reload, and session switches.
		const loaded = loadConfig(ctx.cwd, (msg) => notify(ctx, msg, "warning"));
		profiles = loaded.profiles;
		autoReview = loaded.autoReview;

		if (!snapshotTaken) {
			snapshotTaken = true;
			originalModel = ctx.model;
			originalThinking = pi.getThinkingLevel();
		}
	});

	// A user-initiated model change means: hands off the model for this session.
	pi.on("model_select", async (event) => {
		if (applyingProfile) return; // our own switch
		if (event.source === "set" || event.source === "cycle") {
			manualModelOverride = true;
		}
	});

	pi.on("input", async (event, ctx) => {
		const match = event.text.match(SKILL_COMMAND_RE);
		if (!match) return { action: "continue" };

		const skillName = match[1].toLowerCase();
		const args = (match[2] ?? "").trim();

		// Track the plan file so agent_settled can detect completion.
		if (skillName === "implement" && args) {
			lastImplementPlan = args.split(/\s+/)[0];
			reviewTriggered = false; // a fresh implement run re-arms the review offer
		}

		await applyProfile(skillName, ctx);
		return { action: "continue" }; // pass through to skill expansion
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (autoReview === "off" || !lastImplementPlan || reviewTriggered) return;

		const planFile = lastImplementPlan;
		let content: string;
		try {
			content = await readFile(resolve(ctx.cwd, planFile), "utf-8");
		} catch {
			return; // plan file not readable from this cwd — stay quiet
		}

		const pending = (content.match(/\*\*Status:\*\*\s*pending/g) ?? []).length;
		const done = (content.match(/\*\*Status:\*\*\s*done/g) ?? []).length;
		if (pending > 0 || done === 0) return; // plan not complete

		reviewTriggered = true;
		const runReview = () =>
			pi.sendUserMessage(`/skill:review ${planFile}`, { expandPromptTemplates: true });

		if (autoReview === "auto") {
			await runReview();
			return;
		}

		// autoReview === "ask" — only possible with a UI
		if (ctx.hasUI) {
			const yes = await ctx.ui.confirm(
				"Plan complete",
				`All ${done} step(s) in ${planFile} are done. Run the holistic review now?`,
			);
			if (yes) await runReview();
		}
	});

	// Best-effort restore of the user's default model/thinking on exit.
	pi.on("session_shutdown", async () => {
		try {
			if (originalModel) await pi.setModel(originalModel);
			if (originalThinking) pi.setThinkingLevel(originalThinking);
		} catch {
			// ignore — shutdown restore is best-effort
		}
	});
}
