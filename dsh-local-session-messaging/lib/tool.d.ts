import { Context } from "@deepseek-ai/cordis";

//#region src/tool.d.ts
declare const name = "tool-local-session-messaging";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };