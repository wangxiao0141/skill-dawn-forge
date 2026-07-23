import { chmod } from "node:fs/promises";

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

if (process.platform !== "win32") {
  await chmod("bin/dawn.mjs", 0o755);
}
