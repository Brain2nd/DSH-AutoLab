import { Context } from "@deepseek-ai/cordis";

//#region src/command.d.ts
declare const name = "command-autolab";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };