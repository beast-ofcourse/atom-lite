// Fault-injection fixture (ticket 05): a rejecting event handler is contained
// and attributed without breaking the turn.
export const expectErrors = ["event boom"];

export default (pi) => {
  pi.on("session_end", async () => {
    throw new Error("event boom");
  });
};

export async function test(ctx) {
  await ctx.dispatch("session_end");
  ctx.assert.ok(
    ctx.errors.some((error) => /event boom/.test(String(error.error))),
  );
  // The harness remains usable after the failure.
  const turn = await ctx.runTurn("still here");
  ctx.assert.match(turn.text, /echo:still here/);
}
