--!strict
-- TernMeOn Studio, host half: keeps the bridge process running while a block is open, draws its three tabs
-- (Devices, Studio, Wire) and buzzes with the user's "done"/"failed" patterns when a long command ends.

local art = require("./art")
local link = require("./link")
local studio = require("./studio")
local ui = tern.ui

local POLL_MS, FAST_MS = 1000, 150 -- the fast poll follows a playing pattern's playhead
local NOTIFY_AFTER_MS = 10000
local WIRE_SHOWN = 24 -- newest frames shown: the pane does not follow the end
local TABS = { { id = "devices", label = "Devices" }, { id = "studio", label = "Studio" }, { id = "wire", label = "Wire" } }
local TONES: { [string]: string } = { connected = "accent", connecting = "warning", reconnecting = "warning" }
type Help = { keys: string, label: string }
local HELP: { [string]: { Help } } = {
	devices = { { keys = "up down", label = "select" }, { keys = "left right", label = "adjust" }, { keys = "space", label = "toggle" }, { keys = "tab", label = "view" }, { keys = "n", label = "buzz" } },
	studio = { { keys = "enter", label = "edit" }, { keys = "tab", label = "view" }, { keys = "n", label = "buzz" } },
	editing = { { keys = "ctrl enter", label = "play" }, { keys = "esc", label = "stop" }, { keys = "ctrl left", label = "slot" }, { keys = "ctrl z", label = "undo" } },
	wire = { { keys = "tab", label = "view" }, { keys = "x", label = "stop" } },
}
local LEGEND = "RequestServerInfo → ServerInfo → RequestDeviceList → DeviceList → OutputCmd / StopCmd"

-- An open block. `sel` is the selected output's key.
type Block = {
	cx: BlockCx, since: number, sel: string?, tab: string, editing: boolean, st: studio.Studio,
	blobs: { [string]: string }, nblobs: number,
}
type Row = { key: string, device: link.Device, feature: link.Feature, out: link.Output }

local blocks: { [number]: Block } = {}
-- The bridge's last answer; nil while it is unreachable or no block is open.
local snap: link.State? = nil
-- The last error a request reported.
local fault: string? = nil
-- Why the bridge can't be started; blocks further attempts until a block opens.
local dead: string? = nil
local launching = false
-- Requests sent so far (only the newest one's answer is shown) and requests still waiting for theirs.
local seq, pending = 0, 0
-- Each output's last non-zero value, for space to switch it back on.
local last: { [string]: number } = {}
local timer: TimerHandle? = nil
local armed = 0

local function refresh()
	for _, block in blocks do
		block.cx:render()
	end
end

-- Drops blocks whose pane is gone. A block registers in `init`, which can
-- run before the daemon lists its pane, so young entries are kept.
local function prune()
	local live: { [number]: boolean } = {}
	for _, info in tern.pane.list() do
		live[info.pane] = true
	end
	for pane, block in blocks do
		if not live[pane] and tern.now() - block.since > 2000 then
			blocks[pane] = nil
		end
	end
end

-- Starts the bridge with the first runtime that runs: the `node` kv setting,
-- `node`, `bun`. Tern doesn't kill it; it exits on its own once unused.
local function launch()
	if launching or dead then
		return
	end
	-- A stale file would be taken for the new bridge's.
	pcall(tern.fs.remove, tern.plugin.data .. "/bridge.json")
	local runtimes: { any } = { tern.kv.get("node"), "node", "bun" }
	for _, exe in runtimes do
		if type(exe) == "string" then
			local ok = pcall(function()
				tern.process.run({ exe, tern.plugin.dir .. "/bridge/bridge.mjs" }, function(r: ProcessResult)
					launching = false
					if r.status ~= 0 then
						local why = string.match(r.stderr, "^%s*(.-)%s*$") :: string
						dead = if why ~= "" then why else `The bridge exited with status {r.status}.`
						refresh()
					end
				end)
			end)
			if ok then
				launching = true
				return
			end
		end
	end
	dead = "Neither node nor bun could be started."
end

local schedule

-- Sends a request and shows its answer if no newer request was sent since.
local function send(method: string, path: string, body: any?)
	seq, pending = seq + 1, pending + 1
	local n = seq
	link.request(method, path, body, function(state, err)
		pending -= 1
		if n ~= seq then
			return
		end
		local attached = snap == nil and state ~= nil
		snap, fault = state, err
		if state == nil then
			launch()
		elseif attached and state.server.status == "disconnected" then
			local url = tern.kv.get("server_url")
			send("POST", "/connect", if type(url) == "string" then { url = url } else nil)
		end
		schedule()
		refresh()
	end)
end

-- Polls the bridge while a block is open: that is what keeps it alive.
function schedule()
	if next(blocks) == nil then
		return
	end
	local ms = if snap and snap.pattern then FAST_MS else POLL_MS
	if timer and ms == armed then
		return
	end
	if timer then
		timer:cancel()
	end
	armed = ms
	timer = tern.timer(ms, function()
		timer = nil
		prune()
		if next(blocks) == nil then
			snap = nil
			return
		end
		if pending == 0 then
			send("GET", "/state")
		end
		schedule()
	end)
end

local function rows(): { Row }
	local list: { Row } = {}
	local s = snap
	if s then
		for _, device in s.devices do
			for _, feature in device.features do
				for _, out in feature.outputs do
					table.insert(list, { key = `{device.index}.{feature.index}.{out.type}`, device = device, feature = feature, out = out })
				end
			end
		end
	end
	return list
end

-- Position of the selected row; the first when none is selected.
local function at(block: Block, list: { Row }): number
	for i, row in list do
		if row.key == block.sel then
			return i
		end
	end
	return 1
end

-- "Off": zero, or the nearest value when the range excludes it.
local function neutral(out: link.Output): number
	return math.clamp(0, out.min, out.max)
end

local function put(row: Row, value: number)
	local out = row.out
	out.value = math.clamp(math.floor(value + 0.5), out.min, out.max)
	send("POST", "/output", { device = row.device.index, feature = row.feature.index, type = out.type, value = out.value })
end

-- Switches the output off, or back to the value it had.
local function toggle(row: Row)
	local out = row.out
	if out.value ~= neutral(out) then
		last[row.key] = out.value
		put(row, neutral(out))
	else
		put(row, last[row.key] or out.max)
	end
end

local function nudge(row: Row, dir: number)
	put(row, row.out.value + dir * math.max(1, math.ceil((row.out.max - row.out.min) / 20)))
end

local function stop_all()
	for _, row in rows() do
		row.out.value = neutral(row.out)
	end
	send("POST", "/stop")
end

-- How far an output is from neutral, 0..1 (signed ranges show magnitude).
local function frac(out: link.Output): number
	return math.abs(out.value) / math.max(1, math.abs(out.min), math.abs(out.max))
end

-- Views.

local function with(node: Node, props: { [string]: any }): Node
	local p: { [string]: any } = node.p or {}
	for k, v in props do
		p[k] = v
	end
	node.p = p
	return node
end

-- An SVG as an image node; the bytes go over only when they change.
local function pic(block: Block, svg: string, props: { [string]: any }): Node
	local id = block.blobs[svg]
	if id == nil then
		if block.nblobs >= 64 then
			block.blobs, block.nblobs = {}, 0
		end
		id = block.cx:blob(svg, "image/svg+xml")
		block.blobs[svg], block.nblobs = id, block.nblobs + 1
	end
	props.blob = id
	return ui.node("image", props)
end

local function ghost(label: string, act: string, value: string, mark: string?): Node
	return ui.el("button", { key = act .. value, class = "tmo-ghost", text = label, mark = mark, actions = { click = `{act}={value}` } })
end

-- The wordmark and one quiet status line: a dot, the state, the server's name, the last error.
local function header(): Node
	local s = snap
	local dot, text = "dim", dead or "starting the bridge…"
	if s then
		dot = TONES[s.server.status] or "dim"
		text = s.server.status .. (if s.server.name then " · " .. s.server.name else "") .. (if s.scanning then " · scanning" else "")
		local err = s.server.error or fault
		if err then
			text ..= " · " .. err
		end
	end
	return ui.el("div", { key = "head", class = "tmo-head" }, {
		ui.el("span", { class = "tmo-mark", text = "TernMeOn" }),
		ui.text({ ui.span("● ", dot), ui.span(text, "muted") }),
	})
end

-- One output: a level arc, the value in big numerals, and two ghost steppers. Only the selected one glows.
local function control(block: Block, row: Row, selected: boolean): Node
	local out = row.out
	local caption = row.device.name .. " · " .. out.type .. (if row.feature.description ~= "" then " · " .. row.feature.description else "")
	return ui.el("div", { key = row.key, class = "tmo-ctl", mark = if selected then "sel" else nil, actions = { click = "sel=" .. row.key } }, {
		pic(block, art.arc(frac(out), selected), { key = "arc", alt = "Level", w = 124 }),
		ui.el("div", { class = "tmo-info" }, {
			ui.el("div", { class = "tmo-big", text = `{out.value}` }, { ui.el("span", { class = "tmo-of", text = `/{out.max}` }) }),
			ui.el("div", { class = "tmo-cap", text = caption }),
		}),
		ui.el("div", { class = "tmo-step" }, { ghost("−", "dec", row.key), ghost("+", "inc", row.key) }),
	})
end

local function devices_view(block: Block): { Node }
	local list = rows()
	if #list == 0 then
		local s = snap
		local hint = if s == nil then (dead or "Starting the bridge…") elseif s.server.status ~= "connected" then "Start Intiface Central's server" else "Press s to scan"
		return { with(ui.text({ ui.span(hint, "muted") }), { key = "hint" }) }
	end
	local nodes: { Node } = {}
	local selected = list[at(block, list)]
	for _, row in list do
		table.insert(nodes, control(block, row, row == selected))
	end
	return nodes
end

local function studio_view(block: Block): { Node }
	local ed = block.st.eds[block.st.slot]
	local res = studio.parse(ed.text)
	local s = snap
	local playing = s ~= nil and s.pattern
	local bar: { Node } = {}
	for _, slot in studio.SLOTS do
		table.insert(bar, ghost(slot, "slot", slot, if slot == block.st.slot then "on" else nil))
	end
	table.insert(bar, if playing then ghost("■", "stop", "") else ghost("▶", "play", ""))
	table.insert(bar, ui.text({ ui.span(if res.steps then `{#res.steps} steps · {string.format("%.1f", res.total / 1000)} s` else `{#res.errors} line(s) to fix`, "muted") }))
	local nodes = { ui.el("div", { key = "slots", class = "tmo-slots" }, bar), studio.node(ed, res) }
	if res.steps then
		table.insert(nodes, pic(block, art.wave(res.steps, if s and s.pattern then s.step else nil), { key = "wave", alt = "Pattern preview", max = { w = 1 } }))
	end
	return nodes
end

-- A Buttplug frame in one short line: its message name, #Id and the fields worth reading.
local function summary(msg: string): string
	local ok, body: any = pcall(tern.json.decode, msg)
	local name, m = next(if ok and type(body) == "table" then body else {})
	if name == nil or type(m) ~= "table" then
		return string.sub(msg, 1, 60)
	end
	local out = if m.Id then `{name}  #{m.Id}` else tostring(name)
	if name == "OutputCmd" then
		local kind, arg = next(m.Command or {})
		out ..= `  dev {m.DeviceIndex} · feat {m.FeatureIndex} · {kind} {if type(arg) == "table" then arg.Value else arg}`
	elseif name == "StopCmd" and m.DeviceIndex then
		out ..= `  dev {m.DeviceIndex}`
	elseif name == "RequestServerInfo" then
		out ..= `  v{m.ProtocolVersionMajor}.{m.ProtocolVersionMinor}`
	elseif name == "ServerInfo" then
		out ..= `  {m.ServerName} · ping {m.MaxPingTime}`
	elseif name == "DeviceList" then
		local n = 0
		for _ in m.Devices or {} do
			n += 1
		end
		out = `DeviceList  {n} device{if n == 1 then "" else "s"}`
	elseif name == "Error" then
		out ..= `  {m.ErrorMessage}`
	end
	return out
end

local function wire_view(): { Node }
	local frames = if snap then snap.wire else nil
	local nodes = { with(ui.text({ ui.span(LEGEND, "muted") }), { key = "legend" }) }
	if frames == nil or #frames == 0 then
		return nodes
	end
	local lines: { string } = {}
	local first = frames[math.max(1, #frames - WIRE_SHOWN + 1)].t
	for i = math.max(1, #frames - WIRE_SHOWN + 1), #frames do
		local frame = frames[i]
		table.insert(lines, string.format("%s +%.1fs  %s", if frame.dir == "out" then "→" else "←", (frame.t - first) / 1000, summary(frame.msg)))
	end
	table.insert(nodes, ui.node("code", { key = "wire", text = table.concat(lines, "\n") }))
	return nodes
end

-- One line of key hints for what the keys do now.
local function dock(block: Block): Node
	local items: { Node } = {}
	for i, item in HELP[if block.editing then "editing" else block.tab] do
		table.insert(items, with(ui.row({ ui.node("kbd", { keys = string.split(item.keys, " ") }), ui.text({ ui.span(item.label, "muted") }) }), { key = `h{i}` }))
	end
	return ui.col({ ui.el("div", { key = "bar", class = "tmo-dock" }, items) })
end

-- Entering and leaving the editor also moves the caret's focus.
local function edit(block: Block, on: boolean)
	if block.editing == on then
		return
	end
	block.editing = on
	if not on then
		studio.save(block.st)
	end
	local target: any = if on then "main.ed" else tern.json.null
	block.cx:frame({ { "focus", target } })
end

local function go(block: Block, tab: string)
	edit(block, false)
	block.tab = tab
end

local function play(block: Block)
	local res = studio.parse(block.st.eds[block.st.slot].text)
	if res.steps == nil then
		block.cx:toast("error", "The pattern has errors", `{#res.errors} line(s) are marked`)
		return
	end
	studio.save(block.st)
	send("POST", "/pattern", { steps = res.steps })
end

local function editor_key(block: Block, key: Key): boolean
	local n = key.name
	if n == "escape" then
		edit(block, false)
		send("POST", "/stop")
	elseif n == "enter" and (key.ctrl or key.meta) then
		play(block)
	elseif (key.ctrl or key.meta) and (n == "left" or n == "right") then
		local at_slot = table.find(studio.SLOTS, block.st.slot) :: number
		studio.save(block.st)
		block.st.slot = studio.SLOTS[(at_slot - 1 + (if n == "left" then -1 else 1)) % #studio.SLOTS + 1]
	else
		return studio.key(block.st.eds[block.st.slot], key)
	end
	return true
end

local function devices_key(block: Block, key: Key, press: string): boolean
	local s = snap
	if s == nil then
		return false
	elseif press == "s" then
		s.scanning = not s.scanning
		send("POST", "/scan", { on = s.scanning })
		return true
	end
	local list = rows()
	local i = at(block, list)
	local row = list[i]
	if row == nil then
		return false
	end
	local out = row.out
	local digit = tonumber(string.match(press, "^%d$"))
	if key.name == "up" or press == "k" then
		block.sel = list[math.max(1, i - 1)].key
	elseif key.name == "down" or press == "j" then
		block.sel = list[math.min(#list, i + 1)].key
	elseif key.name == "left" or press == "h" or press == "-" then
		nudge(row, -1)
	elseif key.name == "right" or press == "l" or press == "+" or press == "=" then
		nudge(row, 1)
	elseif key.name == "space" then
		toggle(row)
	elseif digit then
		put(row, out.max * digit / 9)
	else
		return false
	end
	return true
end

tern.block.define("control", {
	init = function(cx: BlockCx, _args: { string }, _saved: any): Block
		local block: Block = {
			cx = cx, since = tern.now(), sel = nil, tab = "devices", editing = false, st = studio.load(), blobs = {}, nblobs = 0,
		}
		blocks[cx.pane] = block
		dead = nil
		send("GET", "/state")
		schedule()
		return block
	end,
	view = function(block: Block, _cx: BlockCx): BlockView
		local body = if block.tab == "devices" then devices_view(block) elseif block.tab == "studio" then studio_view(block) else wire_view()
		local main: { Node } = { header(), pic(block, art.rule(), { key = "rule", alt = "", h = 2 }), ui.node("tabs", { key = "tabs", items = TABS, active = block.tab }) }
		table.move(body, 1, #body, #main + 1, main)
		return { main = ui.col(main), dock = dock(block) }
	end,
	key = function(block: Block, key: Key, _cx: BlockCx): boolean?
		local press = key.text or key.name
		if block.editing then
			return editor_key(block, key)
		elseif key.name == "tab" then
			local i = 1
			for j, tab in TABS do
				if tab.id == block.tab then
					i = j
				end
			end
			go(block, TABS[(i - 1 + (if key.shift then -1 else 1)) % #TABS + 1].id)
		elseif press == "n" then
			tern.kv.set("notify", tern.kv.get("notify") ~= true)
		elseif block.tab == "studio" and (key.name == "enter" or press == "i") then
			edit(block, true)
		elseif press == "x" and snap then
			stop_all()
		elseif block.tab == "devices" then
			return devices_key(block, key, press)
		else
			return false
		end
		return true
	end,
	event = function(block: Block, ev: UiEvent, _cx: BlockCx)
		if ev.ev == "select" and ev.item then
			go(block, ev.item)
		elseif ev.ev == "focus" and block.tab == "studio" then
			edit(block, true)
		elseif ev.ev == "action" then
			local act, value = ev.act, tostring(ev.value)
			local row: Row? = nil
			for _, r in rows() do
				if r.key == value then
					row = r
				end
			end
			if act == "sel" then
				block.sel = value
			elseif act == "slot" then
				studio.save(block.st)
				block.st.slot = value
			elseif act == "play" then
				play(block)
			elseif act == "stop" then
				stop_all()
			elseif row and (act == "dec" or act == "inc") then
				block.sel = row.key
				nudge(row, if act == "dec" then -1 else 1)
			end
		end
	end,
})

-- A long command ending is worth feeling: the user's "done" pattern, or their "failed" one. Only while a block
-- keeps the bridge alive.
tern.on("command_finished", function(ev: CommandFinishedEvent, _cx: EffectCx)
	local after = tern.kv.get("notify_after_ms")
	if tern.kv.get("notify") ~= true or snap == nil or ev.took_ms < (if type(after) == "number" then after else NOTIFY_AFTER_MS) then
		return
	end
	link.request("POST", "/pattern", { steps = studio.steps(if ev.status == 0 then "done" else "failed") }, function() end)
end)
