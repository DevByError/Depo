/**
 * Check that every tag in the model catalog exists in the Ollama registry.
 * Run before a release on a machine with internet access:  bun scripts/verify-catalog.ts
 */
import { DEFAULT_CATALOG } from "../packages/model-gateway/src/catalog";

const tags = DEFAULT_CATALOG.models.flatMap((m) => m.quantizations.map((q) => q.tag));
let missing = 0;
await Promise.all(
  tags.map(async (tag) => {
    const [name, version = "latest"] = tag.split(":");
    const url = `https://registry.ollama.ai/v2/library/${name}/manifests/${version}`;
    try {
      const res = await fetch(url, {
        method: "HEAD",
        headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" },
      });
      if (res.ok) console.log(`ok       ${tag}`);
      else {
        missing++;
        console.log(`MISSING  ${tag} (${res.status})`);
      }
    } catch (err) {
      missing++;
      console.log(`ERROR    ${tag}: ${(err as Error).message}`);
    }
  }),
);
console.log(`\n${tags.length - missing}/${tags.length} tags found.`);
process.exit(missing ? 1 : 0);
