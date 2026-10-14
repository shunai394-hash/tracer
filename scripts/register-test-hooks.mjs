import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./module-hooks.mjs", import.meta.url);
