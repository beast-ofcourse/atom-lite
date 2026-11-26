activate = function(pi)
  pi.registerTool({
    name = "exploding",
    label = "Exploding",
    description = "throws on execute",
    execute = function()
      error("tool boom")
    end,
  })
end

test = function(ctx)
  ctx.assert.equal(ctx.tools.length, 1)
  local ok = pcall(function()
    ctx.tools[1].execute("call-1"):await()
  end)
  ctx.assert.equal(ok, false)
  ctx.diagnostic("tool boom")
end
