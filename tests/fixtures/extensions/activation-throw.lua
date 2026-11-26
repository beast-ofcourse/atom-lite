activate = function(pi)
  error("activation boom")
end

test = function(ctx)
  local entry = ctx.doctor()[1]
  ctx.assert.equal(entry.status, "error")
  ctx.assert.match(tostring(entry.error), "activation boom")
  ctx.assert.equal(ctx.tools.length, 0)
  ctx.diagnostic("activation boom")
end
