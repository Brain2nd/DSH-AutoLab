import { Context, Service } from "@deepseek-ai/cordis";

//#region src/service.ts
/** Stable provider errors translated by every model/human surface. */
var SessionMessagingError = class extends Error {
	name = "SessionMessagingError";
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
	}
};
/**
* Abstract DSH capability seam. Implementations subclass and load themselves as
* `ctx.sessionMessaging`; Cordis' duplicate-service fence permits one provider.
*/
var SessionMessaging = class SessionMessaging extends Service {
	constructor(ctx) {
		if (new.target === SessionMessaging) throw new Error("dsh-local-session-messaging is an abstract service seam; load dsh-local-session-messaging/local");
		super(ctx, "sessionMessaging");
	}
};
var service_default = SessionMessaging;

//#endregion
export { SessionMessagingError as n, service_default as r, SessionMessaging as t };