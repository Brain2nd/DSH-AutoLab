import { createHash, timingSafeEqual } from "node:crypto";

//#region src/domain.ts
/** Stable operational error whose code is safe for integration-layer mapping. */
var MessagingError = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.name = "MessagingError";
		this.code = code;
	}
};
function isMessageStatus(value) {
	return value === "queued" || value === "accepted" || value === "claimed" || value === "failed" || value === "expired";
}
function isMessageChannel(value) {
	return value === "text" || value === "control";
}
/** Stable JSON encoding shared by envelope identity and typed-control hashing. */
function canonicalJson(value) {
	const active = /* @__PURE__ */ new Set();
	const encode = (candidate) => {
		if (candidate === null) return "null";
		if (typeof candidate === "string" || typeof candidate === "boolean") return JSON.stringify(candidate);
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate) || Object.is(candidate, -0)) throw new MessagingError("INVALID_ARGUMENT", "payload contains a non-JSON number");
			return JSON.stringify(candidate);
		}
		if (Array.isArray(candidate)) {
			if (active.has(candidate)) throw new MessagingError("INVALID_ARGUMENT", "payload is cyclic");
			active.add(candidate);
			const parts = [];
			for (let index = 0; index < candidate.length; index += 1) {
				if (!(index in candidate)) throw new MessagingError("INVALID_ARGUMENT", "payload contains a sparse array");
				parts.push(encode(candidate[index]));
			}
			active.delete(candidate);
			return `[${parts.join(",")}]`;
		}
		if (typeof candidate === "object") {
			const prototype = Object.getPrototypeOf(candidate);
			if (prototype !== Object.prototype && prototype !== null) throw new MessagingError("INVALID_ARGUMENT", "payload contains a non-plain object");
			if (active.has(candidate)) throw new MessagingError("INVALID_ARGUMENT", "payload is cyclic");
			active.add(candidate);
			const object = candidate;
			const parts = Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${encode(object[key])}`);
			active.delete(candidate);
			return `{${parts.join(",")}}`;
		}
		throw new MessagingError("INVALID_ARGUMENT", `payload contains unsupported ${typeof candidate}`);
	};
	return encode(value);
}

//#endregion
//#region src/control.ts
const CONTROL_KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PAYLOAD_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
function controlPayloadHash(payload) {
	return `sha256:${createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")}`;
}
function validateControlKind(value) {
	if (typeof value !== "string" || !CONTROL_KIND_PATTERN.test(value)) throw new MessagingError("INVALID_ARGUMENT", "control kind must be 1-128 ASCII letters, digits, dot, underscore, colon, slash, or hyphen");
	return value;
}
function validateControlPayloadHash(value, payload) {
	if (typeof value !== "string" || !PAYLOAD_HASH_PATTERN.test(value)) throw new MessagingError("INVALID_ARGUMENT", "payloadHash must be a lowercase sha256 digest");
	const expected = controlPayloadHash(payload);
	if (!timingSafeEqual(Buffer.from(value, "ascii"), Buffer.from(expected, "ascii"))) throw new MessagingError("INVALID_ARGUMENT", "payloadHash does not match the canonical payload");
	return value;
}
function durableControlPayload(kindInput, payload, payloadHashInput) {
	const kind = validateControlKind(kindInput);
	const payloadHash = validateControlPayloadHash(payloadHashInput, payload);
	canonicalJson(payload);
	return {
		version: 1,
		type: "control",
		kind,
		payload,
		payloadHash
	};
}
function parseDurableControlPayload(value) {
	if (!isRecord(value) || value.version !== 1 || value.type !== "control" || typeof value.kind !== "string" || typeof value.payloadHash !== "string" || !("payload" in value)) throw new MessagingError("INVALID_ARGUMENT", "durable control payload is malformed");
	return durableControlPayload(value.kind, value.payload, value.payloadHash);
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

//#endregion
export { validateControlPayloadHash as a, isMessageChannel as c, validateControlKind as i, isMessageStatus as l, durableControlPayload as n, MessagingError as o, parseDurableControlPayload as r, canonicalJson as s, controlPayloadHash as t };