import { build } from "esbuild";
import { readdirSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
const assets = {};
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
function collect(dir, prefix = "") {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) collect(path, name);
    else {
      const type = types[extname(item.name)];
      if (!type) throw new Error(`Unsupported embedded asset: ${name}`);
      assets[name] = { content: readFileSync(path, "utf8"), type };
    }
  }
}
collect("dist/web");
await build({
  entryPoints: ["apps/api/src/worker.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  define: { __STATIC_ASSETS__: JSON.stringify(assets) },
  minify: true,
});
mkdirSync("dist/.openai", { recursive: true });
copyFileSync(".openai/hosting.json", "dist/.openai/hosting.json");
