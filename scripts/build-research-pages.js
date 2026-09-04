import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(repositoryRoot, "site");
const outputRoot = resolve(repositoryRoot, "dist-pages");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, "src"), { recursive: true });
await Promise.all([
  cp(resolve(sourceRoot, "index.html"), resolve(outputRoot, "index.html")),
  cp(resolve(sourceRoot, "research.css"), resolve(outputRoot, "research.css")),
  cp(resolve(sourceRoot, "src", "math.js"), resolve(outputRoot, "src", "math.js")),
  cp(resolve(sourceRoot, "src", "research"), resolve(outputRoot, "src", "research"), { recursive: true }),
]);

// Browser delivery shares Research contracts and UI modules, but must not ship
// the Tauri-only IPC adapter or its native API dependency.
await rm(resolve(outputRoot, "src", "research", "native-bridge.js"), { force: true });
