activate = function(pi)
  pi.on("turn_end", function()
    pi.ui.select("pick one", { "a", "b" })
  end)
end

test = function(ctx)
  ctx.holdDialogs(true)
  ctx.cancelDialogsAfterOpen("overlay closed")
  ctx.runTurn("open dialog"):await()
  ctx.diagnostic("overlay closed")
end
