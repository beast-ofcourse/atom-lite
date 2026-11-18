// Fault-injection fixture (ticket 05): a factory that throws activates nothing.
export default () => {
  throw new Error("activation boom");
};

export function test(ctx) {
  const [entry] = ctx.doctor();
  ctx.assert.equal(entry.status, "error");
  ctx.assert.match(entry.error, /activation boom/);
  ctx.assert.equal(ctx.tools.length, 0);
  ctx.diagnostic(/activation boom/);
}
