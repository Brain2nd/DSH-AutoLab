import { Context } from "@deepseek-ai/cordis";

//#region src/command.d.ts
declare const name = "command-local-session-messaging";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };