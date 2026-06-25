import "dotenv/config";
import fs from "fs";
import path from "path";

const customConfigPath = path.resolve(import.meta.dirname, "../config.ts");
const configModule = fs.existsSync(customConfigPath) ? "../config.ts" : "../config.default.ts";

await import(configModule);
