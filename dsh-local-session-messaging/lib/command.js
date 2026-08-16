import "./control-nVzhVCO9.js";
import "./service-D6Vwsad_.js";
import { t as listAgentContacts } from "./contacts-BfSyzLZh.js";
import { SessionTitleInvalidError } from "@deepseek-ai/dsh-session-title";

//#region src/command.ts
const name = "command-local-session-messaging";
const inject = [
	"commands",
	"sessionMessaging",
	"sessionTitle",
	"subagents"
];
const PERMISSIONS_USAGE = "Usage: /message-permissions [status | send on|off | receive on|off | block <id|name> | unblock <id|name> | blocks]";
function apply(ctx) {
	ctx.commands.register({
		name: "list-agents",
		description: "list known local Sessions and direct subagents with current sendability",
		recordInput: false,
		async handler(invocation) {
			try {
				const contacts = await listAgentContacts(ctx, invocation.agent, invocation.signal);
				if (contacts.length === 0) return {
					kind: "success",
					text: "No other local Sessions or direct subagents are currently known."
				};
				return {
					kind: "success",
					text: contacts.map((contact) => {
						const detail = contact.kind === "session" ? [
							contact.status,
							contact.sendable ? "sendable" : "not sendable",
							contact.cwd
						].filter((value) => value !== void 0).join(", ") : [
							contact.status,
							contact.mode,
							contact.sendable ? "sendable" : "not sendable"
						].join(", ");
						return `- ${contact.name} — ${contact.kind} — ${contact.sessionId} — ${detail}`;
					}).join("\n")
				};
			} catch (error) {
				return {
					kind: "error",
					text: `Unable to list agents: ${error instanceof Error ? error.message : String(error)}`
				};
			}
		}
	});
	ctx.commands.register({
		name: "message-permissions",
		description: "inspect or change human-owned local Session messaging permissions",
		input: { hint: "[status | send on|off | receive on|off | block <id|name> | unblock <id|name> | blocks]" },
		recordInput: false,
		async handler(invocation) {
			try {
				const input = splitCommandInput(invocation.rawInput);
				if (input.action === "" || input.action === "status") {
					if (input.argument !== "") return {
						kind: "error",
						text: PERMISSIONS_USAGE
					};
					const permissions = await ctx.sessionMessaging.getPermissions(invocation.agent, invocation.signal);
					return {
						kind: "success",
						text: [
							`Local Session messaging for ${String(permissions.sessionId)}:`,
							`- send: ${permissions.sendAllowed ? "on" : "off"}`,
							`- receive: ${permissions.receiveAllowed ? "on" : "off"}`
						].join("\n")
					};
				}
				if (input.action === "send" || input.action === "receive") {
					if (input.argument !== "on" && input.argument !== "off") return {
						kind: "error",
						text: PERMISSIONS_USAGE
					};
					const enabled = input.argument === "on";
					const permissions = await ctx.sessionMessaging.setPermissions(invocation.agent, input.action === "send" ? { sendAllowed: enabled } : { receiveAllowed: enabled }, invocation.signal);
					const actual = input.action === "send" ? permissions.sendAllowed : permissions.receiveAllowed;
					return {
						kind: "success",
						text: `${input.action === "send" ? "Sending" : "Receiving"} local Session messages is ${actual ? "on" : "off"}.`
					};
				}
				if (input.action === "blocks") {
					if (input.argument !== "") return {
						kind: "error",
						text: PERMISSIONS_USAGE
					};
					const blocked = await ctx.sessionMessaging.listBlockedPeers(invocation.agent, invocation.signal);
					if (blocked.length === 0) return {
						kind: "success",
						text: "No local Sessions are blocked."
					};
					return {
						kind: "success",
						text: blocked.map((peer) => `- ${peer.name} — ${String(peer.sessionId)} — blocked ${new Date(peer.blockedAt).toISOString()}`).join("\n")
					};
				}
				if (input.action === "block" || input.action === "unblock") {
					if (input.argument === "") return {
						kind: "error",
						text: PERMISSIONS_USAGE
					};
					const blocked = input.action === "block";
					const peer = await ctx.sessionMessaging.setPeerBlocked(invocation.agent, input.argument, blocked, invocation.signal);
					return {
						kind: "success",
						text: `${blocked ? "Blocked" : "Unblocked"} ${JSON.stringify(peer.name)} (${String(peer.sessionId)}).`
					};
				}
				return {
					kind: "error",
					text: PERMISSIONS_USAGE
				};
			} catch (error) {
				return {
					kind: "error",
					text: `Unable to manage messaging permissions: ${error instanceof Error ? error.message : String(error)}`
				};
			}
		}
	});
	ctx.commands.register({
		name: "rename",
		description: "rename the current Session",
		input: { hint: "<name>" },
		recordInput: false,
		handler(invocation) {
			try {
				const accepted = ctx.sessionTitle.rename(invocation.agent.session, invocation.rawInput);
				return {
					kind: "success",
					text: `Session renamed to ${JSON.stringify(accepted.title)}.`,
					sourceEventSeq: accepted.eventSeq
				};
			} catch (error) {
				return {
					kind: "error",
					text: `${error instanceof SessionTitleInvalidError ? "Invalid Session name" : "Unable to rename Session"}: ${error instanceof Error ? error.message : String(error)}`
				};
			}
		}
	});
}
function splitCommandInput(rawInput) {
	const input = rawInput.trim();
	if (input === "") return {
		action: "",
		argument: ""
	};
	const separator = input.search(/\s/u);
	if (separator < 0) return {
		action: input.toLowerCase(),
		argument: ""
	};
	return {
		action: input.slice(0, separator).toLowerCase(),
		argument: input.slice(separator).trim()
	};
}

//#endregion
export { apply, inject, name };