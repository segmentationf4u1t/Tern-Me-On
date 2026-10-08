--!strict
-- TernMeOn, window half: the command that opens the controls, the one that
-- stops every device, and the panic chord for it.

local link = require("./link")

local BLOCK = "ternmeon.control"
local STOP = "plugin.ternmeon.stop"

tern.command({
	id = "open",
	title = "Open TernMeOn controls",
	icon = "vibrate",
	run = function(cx: WindowCx)
		-- Focus a block this window already shows, else open one.
		for _, pane in cx.session:panes() do
			if pane.block == BLOCK then
				cx.layout:focus(pane.pane)
				return
			end
		end
		if cx:new_block(BLOCK, nil, "beside") == nil then
			cx:toast("error", "TernMeOn is unavailable", "The TernMeOn host half isn't loaded on this host.")
		end
	end,
})

tern.command({
	id = "stop",
	title = "Stop all devices",
	icon = "stop",
	run = function(cx: WindowCx)
		link.request("POST", "/stop", nil, function(_, err, fresh)
			local out = fresh or cx
			if err then
				out:toast("error", "Could not stop the devices", err)
			else
				out:toast("success", "All devices stopped")
			end
		end)
	end,
})

tern.bind(if tern.runtime.os == "macos" then "cmd+alt+shift+x" else "ctrl+alt+shift+x", STOP)
