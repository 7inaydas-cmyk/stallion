// Pins the glue law against the COMMITTED artifact, not the working tree: a resolution recorded
// in a findings register must be true at the commit that carries it. Exit 1 while HEAD's
// guard-reach.mjs still splices the captured streams without a separator.
import { execSync } from "node:child_process";
const src = execSync("git show HEAD:tools/guard-reach.mjs", { encoding: "utf8" });
if (!/separates stdout from stderr \(the glue law/.test(src) || !/\$\{error\.stdout \?\? ""\}\\n\$\{error\.stderr \?\? ""\}/.test(src)) {
  console.error("HEAD lacks the glue law: runGuard still splices stdout and stderr without a separator");
  process.exit(1);
}
console.log("HEAD carries the glue law (separator + call-site pin present)");
