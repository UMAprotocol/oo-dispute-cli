import { readFileSync, writeFileSync } from "fs";
import { describeSelection, parseSelection, resolveSelection } from "./selection";

// `yarn select resolve <file>`: turns slugs, event slugs and tags into market/question/condition ids through Gamma,
// so the review can later filter with chain data alone. Run it before the incident, while Polymarket's API is up.
export async function resolveSelectionFile(file: string, out?: string) {
    const selection = parseSelection(JSON.parse(readFileSync(file, "utf8")));
    const resolved = await resolveSelection(selection);
    const target = out ?? file.replace(/(\.resolved)?\.json$/, "") + ".resolved.json";
    writeFileSync(target, JSON.stringify(resolved, null, 2) + "\n");

    const summary = describeSelection(resolved);
    console.log(`✅ ${summary.name}: wrote ${target}`);
    console.log(`   include: ${JSON.stringify(summary.include)}`);
    console.log(`   exclude: ${JSON.stringify(summary.exclude)}`);
    console.log(`   protocol: ${JSON.stringify(summary.protocol)}, oracle: ${JSON.stringify(summary.oracle)}`);
    if (summary.unresolved.length) {
        console.warn(`⚠️  Not resolved (left out of the selection):\n   - ${summary.unresolved.join("\n   - ")}`);
        process.exitCode = 1;
    }
}
