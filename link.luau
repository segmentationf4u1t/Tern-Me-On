--!strict
-- Shared by both halves: finding the bridge process and talking to it.

export type Output = { type: string, min: number, max: number, value: number }
export type Feature = { index: number, description: string, outputs: { Output } }
export type Device = { index: number, name: string, features: { Feature } }
export type Server = { url: string, status: string, name: string?, error: string? }
export type Frame = { dir: string, t: number, msg: string }
export type State = {
	server: Server,
	scanning: boolean,
	pattern: boolean,
	step: number?,
	wire: { Frame }?,
	active: boolean,
	level: number,
	devices: { Device },
}
export type Info = { port: number, token: string }

local link = {}

-- Where the running bridge listens, from the file it writes at startup; nil
-- when there is no such file or it is unreadable.
function link.info(): Info?
	local ok, info = pcall(function(): any
		return tern.json.decode(tern.fs.read(tern.plugin.data .. "/bridge.json"))
	end)
	if ok and type(info) == "table" and type(info.port) == "number" and type(info.token) == "string" then
		return info
	end
	return nil
end

-- One request to the bridge. `cb(state, err, cx)`: `state` is the bridge's
-- answer when it gave one (errors carry it too), `err` why the request
-- failed, `cx` the window's fresh context (nil on the host and when the
-- bridge isn't running, in which case `cb` runs before this returns).
function link.request(
	method: string,
	path: string,
	body: any?,
	cb: (State?, string?, WindowCx?) -> ()
)
	local info = link.info()
	if info == nil then
		cb(nil, "the bridge is not running")
		return
	end
	local opts: FetchOptions = {
		method = method,
		headers = { ["X-TernMeOn-Token"] = info.token, ["Content-Type"] = "application/json" },
		body = if body ~= nil then tern.json.encode(body) elseif method == "POST" then "{}" else nil,
		timeout_ms = 3000,
	}
	tern.fetch(`http://127.0.0.1:{info.port}{path}`, opts, function(r: FetchResult, cx: WindowCx?)
		local ok, env: any = pcall(tern.json.decode, r.body)
		if not ok or type(env) ~= "table" then
			env = {}
		end
		local err = if env.ok == true then nil else env.error or r.error or `HTTP {r.status}`
		cb(env.state, err, cx)
	end)
end

return link
