--!strict
-- The TernMeOn pattern language and the editor that writes it.
--
--   # comment                     from # to the end of a line, anywhere
--   60% 200ms                     hold 60 % intensity for 200 ms        (ms or s: 1s, 0.5s)
--   ramp 0% 80% 1s                glide from 0 % to 80 % over 1 s       (becomes 2-20 steps)
--   repeat 3 ... end              run the lines in between 3 times      (blocks nest 4 deep)
-- Keywords and units are case-insensitive. A step lasts 10 ms - 10 s, a ramp 20 ms - 60 s, a program is at
-- most 256 steps and 60 s once expanded.
--
-- HOW A PROGRAM CAN FAIL. This list is the spec; every item is handled in `studio.parse` (one error per line,
-- at most 20 shown, nothing plays while any exists):
--  1. Empty program, or only blank lines and comments ("no steps").
--  2. A first word that is not N%, ramp, repeat or end ("unknown word").
--  3. A percent that is: missing its % ("60"), separated from it ("60 %"), empty ("%"), not a plain decimal
--     ("abc%", "-5%", "+5%", "6,5%", "1.2.3%", "0x10%", "1e2%", "inf%", "nan%"), or above 100.
--  4. A duration that is: missing ("60%"), without a unit ("200"), with another unit ("2min", "1m"), malformed
--     ("200ms2", "ms", "-1s", "1e3s"), outside 10 ms - 10 s (step) or 20 ms - 60 s (ramp); fractions of a ms round.
--  5. Extra words after a complete step or end ("60% 200ms now"), too few or many words for a ramp.
--  6. repeat without a count, with a count that is not a whole number 1-256 ("2.5", "x", "0", "-1"), or with
--     extra words.
--  7. A repeat with no end before the program ends (reported on the repeat line), an end with no repeat, a
--     repeat with nothing inside, repeats nested deeper than 4.
--  8. A "#" glued to a token ("60%#x"): the comment starts at "#", so what is left ("60%") is judged alone.
--  9. Expansion over 256 steps or 60 s (reported on the repeat, or the ramp, that crosses the limit).
-- 10. Text that cannot be a program: non-ASCII characters (also look-alikes such as full-width digits or NBSP),
--     control characters and NUL are "unknown word"/malformed tokens; CR is whitespace, so CRLF files are fine.
-- 11. Size: lines over 200 bytes, more than 400 lines. The editor also refuses non-ASCII input, turns Tab into
--     two spaces and stops growing at 4000 bytes, so offsets are bytes everywhere.

local ui = tern.ui
local studio = {}

local MAX_STEPS, MAX_MS, MAX_DEPTH, MAX_LINES, MAX_LINE, MAX_BYTES, MAX_ERRORS = 256, 60000, 4, 400, 200, 4000, 20
local SLOTS = { "done", "failed", "scratch" }
local DEFAULTS: { [string]: string } = {
	done = "# two gentle pulses\n40% 150ms\n0% 120ms\n40% 150ms",
	failed = "# one long, strong pulse\n100% 700ms",
	scratch = "# a swell, three throbs, a fade\nramp 0% 80% 1s\nrepeat 3\n  100% 200ms\n  20% 150ms\nend\nramp 60% 0% 800ms",
}
local PLACEHOLDER = "60% 200ms · ramp 0% 80% 1s · repeat 3 … end · # comment"

export type Err = { line: number, from: number, to: number, msg: string }
export type Result = { steps: { { number } }?, errors: { Err }, decor: { any }, total: number }
export type Snap = { text: string, cursor: number }
export type Ed = { text: string, cursor: number, undo: { Snap }, redo: { Snap }, typing: boolean }
export type Studio = { slot: string, eds: { [string]: Ed } }

-- A block of lines: a `repeat` (n, items), a ramp (lvl -> to over ms) or a step (lvl for ms).
type Item = { line: number, lvl: number?, to: number?, ms: number?, n: number?, items: { Item }? }
type Tok = { s: number, e: number, t: string } -- 0-based byte span, `e` exclusive

local function num(t: string): number?
	if string.match(t, "^%d+%.?%d*$") or string.match(t, "^%.%d+$") then
		return tonumber(t)
	end
	return nil
end

function studio.parse(text: string): Result
	local errors: { Err } = {}
	local decor: { any } = {}
	local bad: { [number]: boolean } = {}
	local spans: { { number } } = {}
	local root: Item = { line = 0, n = 1, items = {} }
	local stack: { Item } = { root }
	local first_end = (string.find(text, "\n", 1, true) or #text + 1) - 1

	-- One error per line; the first one wins.
	local function fail(line: number, from: number, to: number, msg: string)
		if not bad[line] and #errors < MAX_ERRORS then
			table.insert(errors, { line = line, from = from, to = to, msg = msg })
		end
		bad[line] = true
	end
	local function pct(line: number, t: Tok): number?
		local body = string.match(t.t, "^(.*)%%$")
		local v = if body then num(body) else nil
		if v == nil then
			fail(line, t.s, t.e, if body == nil and num(t.t) then "missing % after the number" else "expected a percent like 60%")
		elseif v > 100 then
			fail(line, t.s, t.e, "percent above 100")
			return nil
		end
		return v
	end
	local function dur(line: number, t: Tok, lo: number, hi: number): number?
		local n, unit = string.match(t.t, "^([%d%.]+)(%a*)$")
		local v = if n then num(n) else nil
		unit = string.lower(unit or "")
		if v == nil then
			fail(line, t.s, t.e, "expected a duration like 200ms or 1.5s")
		elseif unit == "" then
			fail(line, t.s, t.e, "missing unit: write ms or s")
		elseif unit ~= "ms" and unit ~= "s" then
			fail(line, t.s, t.e, `unknown unit '{unit}': use ms or s`)
		else
			local ms = math.floor(v * (if unit == "s" then 1000 else 1) + 0.5)
			if ms >= lo and ms <= hi then
				return ms
			end
			fail(line, t.s, t.e, `duration must be {lo} ms to {hi // 1000} s`)
		end
		return nil
	end

	local line_no, pos = 0, 0
	for raw in string.gmatch(text .. "\n", "([^\n]*)\n") do
		line_no += 1
		local base = pos
		pos += #raw + 1
		if line_no > MAX_LINES then
			fail(line_no, base, base + #raw, `program longer than {MAX_LINES} lines`)
			break
		end
		local hash = string.find(raw, "#", 1, true)
		local code = if hash then string.sub(raw, 1, hash - 1) else raw
		if hash then
			table.insert(decor, { from = base + hash - 1, to = base + #raw, s = "muted" })
		end
		local toks: { Tok } = {}
		for s, t, e in string.gmatch(code, "()(%S+)()") do
			table.insert(toks, { s = base + (s :: number) - 1, e = base + (e :: number) - 1, t = t :: string })
		end
		local lit: { any } = {} -- highlighting, kept only when the line is fine
		local function hl(t: Tok, s: string)
			table.insert(lit, { from = t.s, to = t.e, s = s })
		end
		if #raw > MAX_LINE then
			fail(line_no, base, base + #raw, `line longer than {MAX_LINE} characters`)
		elseif #toks > 0 then
			local last = toks[#toks]
			spans[line_no] = { toks[1].s, last.e }
			local head, top = string.lower(toks[1].t), stack[#stack]
			if head == "ramp" then
				if #toks ~= 4 then
					fail(line_no, toks[1].s, last.e, "usage: ramp 0% 80% 1s")
				else
					local a, b, ms = pct(line_no, toks[2]), pct(line_no, toks[3]), dur(line_no, toks[4], 20, MAX_MS)
					if a and b and ms then
						table.insert((top.items :: { Item }), { line = line_no, lvl = a, to = b, ms = ms })
					end
				end
				hl(toks[1], "accent strong")
				for i = 2, math.min(4, #toks) do
					hl(toks[i], "num")
				end
			elseif head == "repeat" then
				local n = if #toks == 2 and string.match(toks[2].t, "^%d+$") then tonumber(toks[2].t) else nil
				if n == nil or n < 1 or n > MAX_STEPS then
					fail(line_no, toks[1].s, last.e, `usage: repeat N (a whole number, 1-{MAX_STEPS})`)
				elseif #stack > MAX_DEPTH then
					fail(line_no, toks[1].s, last.e, `repeats nested deeper than {MAX_DEPTH}`)
				end
				local block: Item = { line = line_no, n = n or 1, items = {} }
				table.insert((top.items :: { Item }), block)
				table.insert(stack, block)
				hl(toks[1], "accent strong")
				if toks[2] then
					hl(toks[2], "num")
				end
			elseif head == "end" then
				if #toks > 1 then
					fail(line_no, toks[2].s, last.e, "end takes no arguments")
				elseif #stack == 1 then
					fail(line_no, toks[1].s, toks[1].e, "end without a matching repeat")
				end
				if #stack > 1 then
					local block = table.remove(stack) :: Item
					if #(block.items :: { Item }) == 0 then
						local span = spans[block.line]
						fail(block.line, span[1], span[2], "repeat with nothing inside")
					end
				end
				hl(toks[1], "accent strong")
			elseif string.match(head, "^[%a_]") then
				fail(line_no, toks[1].s, toks[1].e, `unknown word '{toks[1].t}': use N% duration, ramp, repeat or end`)
			else
				local lvl = pct(line_no, toks[1])
				if #toks == 1 then
					fail(line_no, toks[1].s, toks[1].e, "missing duration after the percent")
				elseif #toks > 2 then
					fail(line_no, toks[3].s, last.e, `unexpected '{toks[3].t}'`)
				else
					local ms = dur(line_no, toks[2], 10, 10000)
					if lvl and ms then
						table.insert((top.items :: { Item }), { line = line_no, lvl = lvl, ms = ms })
					end
				end
				hl(toks[1], "num")
				if toks[2] then
					hl(toks[2], "num")
				end
			end
		end
		if not bad[line_no] then
			table.move(lit, 1, #lit, #decor + 1, decor)
		end
	end
	for i = 2, #stack do
		local span = spans[stack[i].line]
		fail(stack[i].line, span[1], span[2], "repeat without a matching end")
	end
	if #errors == 0 and #(root.items :: { Item }) == 0 then
		fail(1, 0, first_end, "no steps: try 60% 200ms")
	end

	-- Expansion: the one place the 256-step and 60-second limits can be crossed.
	local steps: { { number } } = {}
	local total = 0
	local function run(items: { Item }, ctx: number?): boolean
		for _, it in items do
			if it.items then
				for _ = 1, it.n :: number do
					if not run(it.items, it.line) then
						return false
					end
				end
			else
				local ms, a = it.ms :: number, it.lvl :: number
				local k = if it.to then math.clamp(ms // 50, 2, 20) else 1
				for i = 0, k - 1 do
					local level = if it.to then a + (it.to - a) * i / (k - 1) else a
					local part = if i == k - 1 then ms - (ms // k) * (k - 1) else ms // k
					table.insert(steps, { level / 100, part })
					total += part
					local over = if #steps > MAX_STEPS then `expands to more than {MAX_STEPS} steps` elseif total > MAX_MS then "plays longer than 60 s" else nil
					if over then
						local at = ctx or it.line
						fail(at, spans[at][1], spans[at][2], over)
						return false
					end
				end
			end
		end
		return true
	end
	if #errors == 0 then
		run(root.items :: { Item })
	end
	for _, e in errors do
		table.insert(decor, { from = e.from, to = e.to, s = "error strong" })
	end
	return { steps = if #errors == 0 then steps else nil, errors = errors, decor = decor, total = total }
end

-- The bridge's `[fraction, ms]` steps for a slot, from what the user saved (else the default).
function studio.steps(slot: string): { { number } }
	local saved = tern.kv.get("patterns")
	local text = if type(saved) == "table" and type(saved[slot]) == "string" then saved[slot] else DEFAULTS[slot]
	return studio.parse(text).steps or studio.parse(DEFAULTS[slot]).steps :: { { number } }
end

-- Printable ASCII and newlines only.
local function clean(s: string): string
	s = string.gsub(s, "\r\n?", "\n")
	s = string.gsub(s, "\t", "  ")
	s = string.gsub(s, "[^\n\32-\126]", "")
	return s
end

function studio.load(): Studio
	local saved = tern.kv.get("patterns")
	local eds: { [string]: Ed } = {}
	for _, slot in SLOTS do
		local text = if type(saved) == "table" and type(saved[slot]) == "string" then saved[slot] else DEFAULTS[slot]
		eds[slot] = { text = string.sub(clean(text), 1, MAX_BYTES), cursor = 0, undo = {}, redo = {}, typing = false }
	end
	return { slot = "scratch", eds = eds }
end

function studio.save(st: Studio)
	local out: { [string]: string } = {}
	for slot, ed in st.eds do
		out[slot] = ed.text
	end
	tern.kv.set("patterns", out)
end

studio.SLOTS = SLOTS

-- The editor node: highlighting, a gutter with line numbers and each line's error as a trailing message.
function studio.node(ed: Ed, res: Result): Node
	local msg: { [number]: string } = {}
	for _, e in res.errors do
		msg[e.line] = msg[e.line] or e.msg
	end
	local _, newlines = string.gsub(ed.text, "\n", "")
	local gutter: { any }, virt: { any } = {}, {}
	for i = 1, newlines + 1 do
		gutter[i] = { ui.span(string.format("%3d ", i), if msg[i] then "error strong" else "dim") }
		virt[i] = if msg[i] then { ui.span("   ✗ " .. (msg[i] :: string), "muted") } else ""
	end
	return ui.node("editor", {
		key = "ed", text = ed.text, cursor = ed.cursor, decor = res.decor, gutter = gutter, virt = virt,
		placeholder = PLACEHOLDER, nowrap = true, maxLines = 14, aria = "Pattern",
	})
end

-- Editing. Every change is an undo step, except a run of typed characters, which is one.
local function put(ed: Ed, text: string, cursor: number, typing: boolean)
	if not (typing and ed.typing) then
		table.insert(ed.undo, { text = ed.text, cursor = ed.cursor })
		if #ed.undo > 100 then
			table.remove(ed.undo, 1)
		end
	end
	ed.redo, ed.text, ed.cursor, ed.typing = {}, text, cursor, typing
end

local function travel(from: { Snap }, to: { Snap }, ed: Ed)
	local snap = table.remove(from)
	if snap then
		table.insert(to, { text = ed.text, cursor = ed.cursor })
		ed.text, ed.cursor, ed.typing = snap.text, snap.cursor, false
	end
end

local function insert(ed: Ed, s: string)
	s = string.sub(clean(s), 1, MAX_BYTES - #ed.text)
	if s == "" then
		return false
	end
	put(ed, string.sub(ed.text, 1, ed.cursor) .. s .. string.sub(ed.text, ed.cursor + 1), ed.cursor + #s, s ~= "\n")
	return true
end

-- Applies a key to the editor; false when it did nothing.
function studio.key(ed: Ed, key: Key): boolean
	local text, c, name = ed.text, ed.cursor, key.name
	local col = #(string.match(string.sub(text, 1, c), "[^\n]*$") :: string)
	local start = c - col
	local eol = (string.find(text, "\n", c + 1, true) or #text + 1) - 1
	local to: number? = nil
	local mod = key.ctrl or key.meta
	if mod and name == "z" and not key.shift then
		travel(ed.undo, ed.redo, ed)
		return true
	elseif mod and (name == "y" or name == "z") then
		travel(ed.redo, ed.undo, ed)
		return true
	elseif mod or key.alt then
		return false
	elseif name == "left" then
		to = math.max(0, c - 1)
	elseif name == "right" then
		to = math.min(#text, c + 1)
	elseif name == "home" then
		to = start
	elseif name == "end" then
		to = eol
	elseif name == "up" and start > 0 then
		local plen = #(string.match(string.sub(text, 1, start - 1), "[^\n]*$") :: string)
		to = start - 1 - plen + math.min(col, plen)
	elseif name == "down" and eol < #text then
		local nend = (string.find(text, "\n", eol + 2, true) or #text + 1) - 1
		to = eol + 1 + math.min(col, nend - eol - 1)
	elseif name == "backspace" and c > 0 then
		put(ed, string.sub(text, 1, c - 1) .. string.sub(text, c + 1), c - 1, false)
		return true
	elseif name == "delete" and c < #text then
		put(ed, string.sub(text, 1, c) .. string.sub(text, c + 2), c, false)
		return true
	elseif name == "enter" then
		return insert(ed, "\n")
	elseif name == "tab" then
		return insert(ed, "  ")
	elseif key.text then
		return insert(ed, key.text)
	end
	if to == nil or to == c then
		return false
	end
	ed.cursor, ed.typing = to, false
	return true
end

return studio
