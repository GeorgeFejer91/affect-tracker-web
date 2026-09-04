import { access, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = process.argv[2];

async function filesBelow(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

async function verifyRelativeModuleClosure(root, files) {
  for (const path of files.filter((entry) => entry.endsWith(".js"))) {
    const source = await readFile(resolve(root, path), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/gu),
      ...source.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/gu),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      const target = resolve(root, dirname(path), specifier);
      try {
        await access(target);
      } catch {
        throw new Error(`${target} is missing; imported by ${path}.`);
      }
    }
  }
}

const rules = {
  pages: {
    root: resolve(repositoryRoot, "dist-pages"),
    allowed: (path) => path === "index.html"
      || path === "research.css"
      || path === "src/math.js"
      || (path.startsWith("src/research/") && path !== "src/research/native-bridge.js"),
  },
  desktop: {
    root: resolve(repositoryRoot, "desktop", "dist"),
    allowed: (path) => path === "index.html" || /^assets\/research-[A-Za-z0-9_-]+\.(?:css|js)$/u.test(path),
  },
};

if (!Object.hasOwn(rules, target)) {
  throw new Error("Usage: node scripts/verify-research-build.js <pages|desktop>");
}

const rule = rules[target];
const files = await filesBelow(rule.root);
const unexpected = files.filter((path) => !rule.allowed(path));
if (unexpected.length > 0) {
  throw new Error(`${target} build contains non-Research files: ${unexpected.join(", ")}`);
}
if (!files.includes("index.html")) throw new Error(`${target} build is missing index.html.`);
await verifyRelativeModuleClosure(rule.root, files);
console.log(`${target} Research-only boundary verified (${files.length} files).`);
