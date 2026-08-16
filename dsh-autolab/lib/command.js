import { resolve } from "node:path";

//#region src/command.ts
const name = "command-autolab";
const inject = ["commands", "autolab"];
const USAGE = "Usage: /autolab create [config-path] | show <lab-id> | commit <lab-id> | start <lab-id> | status <lab-id> | pause <lab-id> | resume <lab-id> | stop <lab-id>";
function apply(ctx) {
	ctx.commands.register({
		name: "autolab",
		description: "create, inspect, commit, start, status, pause, resume, or stop one directed AutoLab",
		input: { hint: "create [config-path] | show <lab-id> | commit <lab-id> | start <lab-id> | status <lab-id> | pause <lab-id> | resume <lab-id> | stop <lab-id>" },
		recordInput: true,
		async handler(invocation) {
			const input = parseInput(invocation.rawInput);
			if (input === void 0) return {
				kind: "error",
				text: USAGE
			};
			try {
				switch (input.subcommand) {
					case "create": return {
						kind: "success",
						text: formatCreate(await ctx.autolab.create(invocation.agent, input.argument, invocation.signal))
					};
					case "show": return {
						kind: "success",
						text: formatLabDocuments("AutoLab", await ctx.autolab.show(invocation.agent, input.argument, invocation.signal))
					};
					case "commit": return {
						kind: "success",
						text: formatLabDocuments("Committed AutoLab", await ctx.autolab.commit(invocation.agent, input.argument, invocation.signal))
					};
					case "start": return {
						kind: "success",
						text: formatRuntimeState(await ctx.autolab.start(invocation.agent, input.argument, invocation.signal))
					};
					case "status": return {
						kind: "success",
						text: formatRuntimeState(ctx.autolab.status(invocation.agent, input.argument))
					};
					case "pause": return {
						kind: "success",
						text: formatRuntimeState(await ctx.autolab.pause(invocation.agent, input.argument, invocation.signal))
					};
					case "resume": return {
						kind: "success",
						text: formatRuntimeState(await ctx.autolab.resume(invocation.agent, input.argument, invocation.signal))
					};
					case "stop": return {
						kind: "success",
						text: formatRuntimeState(await ctx.autolab.stop(invocation.agent, input.argument, invocation.signal))
					};
				}
			} catch (error) {
				return {
					kind: "error",
					text: `AutoLab ${input.subcommand} failed: ${renderError(error)}`
				};
			}
		}
	});
}
/** Parse only the first token; the create path remains one verbatim remainder. */
function parseInput(rawInput) {
	const input = rawInput.trim();
	if (input.length === 0) return void 0;
	const separator = input.search(/\s/u);
	const subcommand = separator < 0 ? input : input.slice(0, separator);
	const argument = separator < 0 ? void 0 : input.slice(separator).trim();
	if (subcommand === "create") return argument === void 0 || argument.length === 0 ? { subcommand } : {
		subcommand,
		argument
	};
	if ((subcommand === "show" || subcommand === "commit" || subcommand === "start" || subcommand === "status" || subcommand === "pause" || subcommand === "resume" || subcommand === "stop") && argument !== void 0 && argument.length > 0 && !/\s/u.test(argument)) return {
		subcommand,
		argument
	};
}
function formatCreate(result) {
	const directory = resolve(result.directory);
	const lines = [
		`Created AutoLab ${result.state.labId}.`,
		`Lifecycle: ${result.state.lifecycle.toUpperCase()}`,
		`Lab directory: ${directory}`,
		`Draft directory: ${resolve(directory, "draft")}`
	];
	if (result.state.lifecycle === "draft_ready") lines.push(...formatDraft(result.draft, directory));
	lines.push("The Lab was not started. Continue the directed configuration conversation, then use /autolab commit <lab-id> to create a revision.");
	return lines.join("\n");
}
function formatLabDocuments(lead, result) {
	const directory = resolve(result.directory);
	if (result.frozen === void 0) {
		if (result.draft === void 0) throw new Error(`Lab ${result.state.labId} has no documents`);
		return [
			`${lead} ${result.state.labId}.`,
			`Lifecycle: ${result.state.lifecycle.toUpperCase()}`,
			`Lab directory: ${directory}`,
			...formatDraft(result.draft, directory)
		].join("\n");
	}
	const frozen = result.frozen;
	const revisionDirectory = resolve(directory, frozen.ref.revisionPath);
	return [
		`${lead} ${result.state.labId}.`,
		`Lifecycle: ${result.state.lifecycle.toUpperCase()}`,
		`Lab directory: ${directory}`,
		`Revision: ${frozen.ref.revision}`,
		`Revision directory: ${revisionDirectory}`,
		`LAB_SPEC.md path: ${resolve(revisionDirectory, "LAB_SPEC.md")}`,
		`LAB_SPEC.md SHA-256: ${frozen.ref.specHash}`,
		`lab.yaml path: ${resolve(revisionDirectory, "lab.yaml")}`,
		`lab.yaml SHA-256: ${frozen.ref.configHash}`,
		`RESOLVED_MANIFEST.json path: ${resolve(revisionDirectory, "RESOLVED_MANIFEST.json")}`,
		`RESOLVED_MANIFEST.json SHA-256: ${frozen.ref.manifestHash}`,
		`Dialogue head SHA-256: ${frozen.ref.dialogueHeadHash}`,
		`VALIDATION.json path: ${resolve(revisionDirectory, "VALIDATION.json")}`,
		verbatimDocument("LAB_SPEC.md", frozen.spec),
		verbatimDocument("lab.yaml", frozen.config)
	].join("\n");
}
function formatDraft(draft, directory) {
	return [
		`LAB_SPEC.md path: ${resolve(directory, "draft", "LAB_SPEC.md")}`,
		`LAB_SPEC.md SHA-256: ${draft.specHash}`,
		`lab.yaml path: ${resolve(directory, "draft", "lab.yaml")}`,
		`lab.yaml SHA-256: ${draft.configHash}`,
		verbatimDocument("LAB_SPEC.md", draft.spec),
		verbatimDocument("lab.yaml", draft.config)
	];
}
function verbatimDocument(name$1, content) {
	return `----- BEGIN ${name$1} (verbatim) -----\n${content}${content.endsWith("\n") ? "" : "\n"}----- END ${name$1} -----`;
}
function formatRuntimeState(state) {
	return [
		`AutoLab ${state.labId}.`,
		`Lifecycle: ${state.lifecycle.toUpperCase()}`,
		"RuntimeState:",
		JSON.stringify(state, null, 2)
	].join("\n");
}
function renderError(value) {
	if (value instanceof Error) return `${"code" in value && typeof value.code === "string" ? `${value.code}: ` : ""}${value.message}`;
	return String(value);
}

//#endregion
export { apply, inject, name };