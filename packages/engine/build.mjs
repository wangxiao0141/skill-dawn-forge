import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "bin/dawn.mjs",
  format: "esm",
  platform: "node",
  bundle: true,
  minify: false,
  banner: {
    js: `#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);`,
  },
});

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const skillDirectory = resolve(
  packageDirectory,
  "..",
  "..",
  "skills",
  "dawn-forge",
);
const skillBinDirectory = join(skillDirectory, "bin");
const skillCatalogDirectory = join(skillDirectory, "catalog");
await mkdir(skillBinDirectory, { recursive: true });
await mkdir(skillCatalogDirectory, { recursive: true });
await copyFile(
  join(packageDirectory, "bin", "dawn.mjs"),
  join(skillBinDirectory, "dawn.mjs"),
);
for (const file of ["catalog.schema.json", "v1.json"]) {
  await copyFile(
    resolve(packageDirectory, "..", "..", "catalog", file),
    join(skillCatalogDirectory, file),
  );
}

if (process.platform !== "win32") {
  await chmod("bin/dawn.mjs", 0o755);
  await chmod(join(skillBinDirectory, "dawn.mjs"), 0o755);
}
