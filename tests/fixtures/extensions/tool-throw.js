// Fault-injection fixture (ticket 05): a tool that rejects stays contained and
// attributed, and the harness can assert on the tool result.
export default (pi) => {
  pi.registerTool({
    name: "exploding",
    label: "Exploding",
    description: "throws on execute",
    execute: async () => {
      throw new Error("tool boom");
    },
  });
};

export async function test(ctx) {
  ctx.assert.equal(ctx.tools.length, 1);
  await ctx.assert.rejects(() => ctx.tools[0].execute("call-1"), /tool boom/);
  ctx.diagnostic(/tool boom/);
}
