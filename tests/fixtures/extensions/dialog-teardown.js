// Fault-injection fixture (ticket 05): tearing down an overlay rejects the
// pending dialog instead of hanging the turn.
export default (pi) => {
  pi.on("turn_end", async () => {
    await pi.ui.select("pick one", ["a", "b"]);
  });
};

export async function test(ctx) {
  ctx.holdDialogs(true);
  ctx.cancelDialogsAfterOpen("overlay closed");
  await ctx.runTurn("open dialog");
  ctx.diagnostic(/overlay closed/);
}
