#!/usr/bin/env node
// Keep this bootstrap dependency-free so `--version`/`--help` do not pay for
// loading providers, tools, zod and the TUI.
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("0.4.0\n");
} else if (args.includes("--help")) {
  process.stdout.write(
    "atom-lite [task] [--provider NAME] [--model MODEL] [--continue] [--session ID] [--list-sessions] [--search-sessions QUERY] [--no-tools] [--json] [--debug] [--theme NAME] [--no-color] [--version] [--help]\n",
  );
} else {
  try {
    const { run } = await import("./app.js");
    await run(args);
  } catch (err) {
    process.stderr.write(
      `atom-lite: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
