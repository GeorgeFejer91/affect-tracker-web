import { spawnSync } from "node:child_process";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The internal Affect Research alpha is supported only on Windows x64.");
}

const commandProcessor = process.env.ComSpec;
if (!commandProcessor) throw new Error("The Windows command processor is unavailable.");

const result = spawnSync(
  commandProcessor,
  ["/d", "/s", "/c", "pnpm exec tauri build --bundles nsis"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AFFECT_RESEARCH_REQUIRE_LIBVLC_RUNTIME: "1",
    },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
