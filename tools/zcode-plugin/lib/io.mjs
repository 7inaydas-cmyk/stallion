/** Read a hook's stdin payload to a string — the one shape both hooks share (a review caught
 *  the accumulate loop duplicated in authoring-gate.mjs and banner.mjs). */
export async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
