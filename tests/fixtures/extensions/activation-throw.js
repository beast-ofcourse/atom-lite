// Fault-injection fixture (ticket 05): a factory that throws activates nothing.
export const expectErrors = ["activation boom"];

export default () => {
  throw new Error("activation boom");
};

export function test(ctx) {
  const [entry] = ctx.doctor();
  ctx.assert.equal(entry.status, "error");
  ctx.assert.match(entry.error, /activation boom/);
  ctx.assert.equal(ctx.tools.length, 0);
  ctx.assert.ok(
    ctx.errors.some((error) => /activation boom/.test(String(error.error))),
  );
}
