// frontend-jsx.test.mjs — every dashboard source file must compile with no
// warnings (e.g. a bare ">" in JSX text), exactly as the production build
// does with esbuild.
//
// Run:  node --test tests/frontend-jsx.test.mjs   (or npm test in frontend/)

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.join(here, "..", "frontend");
const esbuild = createRequire(path.join(frontend, "package.json"))("esbuild");
const srcDir = path.join(frontend, "src");

const files = fs.readdirSync(srcDir).filter(f => /\.(jsx|js)$/.test(f));

for (const f of files) {
  test(`${f} compiles without warnings`, async () => {
    const code = fs.readFileSync(path.join(srcDir, f), "utf8");
    const r = await esbuild.transform(code, { loader: f.endsWith(".jsx") ? "jsx" : "js", sourcefile: f, jsx: "automatic" });
    const msgs = r.warnings.map(w => `${w.location?.line}:${w.location?.column} ${w.text}`);
    assert.deepStrictEqual(msgs, [], `${f}: ${msgs.join("; ")}`);
  });
}
