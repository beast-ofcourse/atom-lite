activate = function(pi)
  pi.on("session_end", function()
    error("event boom")
  end)
end

test = function(ctx)
  ctx.dispatch("session_end", {}):await()
  ctx.diagnostic("event boom")
  local turn = ctx.runTurn("still here"):await()
  ctx.assert.match(turn.text, "echo:still here")
end
