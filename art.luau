--!strict
-- Pure SVG string builders. Tern's sanitizer keeps svg g defs linearGradient stop path circle line rect mask
-- text, `class` and presentation attributes. The warm gradient (magenta -> coral -> amber) lives here, in
-- the image blobs; ternmeon.css only styles the classes (pulsing rings) and the HTML around them.

local art = {}
local f, add = string.format, table.insert

local DEFS = '<defs><linearGradient id="hot" x1="0" y1="1" x2="1" y2="0">'
	.. '<stop offset="0" stop-color="#ff2d78"/><stop offset=".55" stop-color="#ff6a3d"/><stop offset="1" stop-color="#ffbe3b"/>'
	.. "</linearGradient></defs>"

local function open(w: number, h: number, class: string?, extra: string?): string
	return f('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d"%s%s>%s', w, h, if class then ` class="{class}"` else "", extra or "", DEFS)
end

-- The thin gradient line under the wordmark.
function art.rule(): string
	return open(600, 2, nil, ' preserveAspectRatio="none"') .. '<rect width="600" height="2" fill="url(#hot)"/></svg>'
end

-- A level as a 270 degree arc opening at the bottom. `sel` adds a soft halo; a selected control that is on
-- also gets rings, pulsing faster (`tmo-l1`..`tmo-l5` on the root) and wider as `level` (0..1) rises.
local function point(deg: number): string
	local a = math.rad(deg)
	return f("%.2f %.2f", 70 + 42 * math.cos(a), 70 + 42 * math.sin(a))
end

function art.arc(level: number, sel: boolean): string
	local p = { open(140, 140, if sel and level > 0 then `tmo-l{math.ceil(level * 5)}` else nil) }
	if sel then
		for i = 1, if level > 0 then math.ceil(level * 2) else 0 do
			add(p, f('<circle class="tmo-ring tmo-r%d" cx="70" cy="70" r="%d" fill="none" stroke="url(#hot)" stroke-width="2"/>', i, 52 + 6 * i))
		end
	end
	add(p, f('<path d="M%s A42 42 0 1 1 %s" fill="none" stroke="#888" stroke-opacity=".13" stroke-width="9" stroke-linecap="round"/>', point(135), point(405)))
	if level > 0 then
		add(p, f('<path d="M%s A42 42 0 %d 1 %s" fill="none" stroke="url(#hot)" stroke-width="9" stroke-linecap="round"/>', point(135), if level > 2 / 3 then 1 else 0, point(135 + 270 * level)))
	end
	add(p, "</svg>")
	return table.concat(p)
end

-- A pattern's levels over time; `cur` is the index of the step playing now.
function art.wave(steps: { { number } }, cur: number?): string
	local total = 0
	for _, s in steps do
		total += s[2]
	end
	local p = { open(600, 56) }
	local t = 0
	for i, s in steps do
		local h = math.max(1, 52 * s[1])
		add(p, f('<rect class="tmo-bar%s" x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="1" fill="url(#hot)"/>',
			if i - 1 == cur then " tmo-cur" else "", 600 * t / total, 54 - h, math.max(1, 600 * s[2] / total - 1), h))
		t += s[2]
	end
	add(p, "</svg>")
	return table.concat(p)
end

return art
