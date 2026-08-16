import { Context } from "@deepseek-ai/cordis";

//#region src/prompt.d.ts
declare const name = "prompt-local-session-messaging";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };