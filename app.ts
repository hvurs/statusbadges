// Reads from real environment variables (Render, Docker, shell).
// Locally you can run: deno run -A --env app.ts   (loads a .env file)
const env = Deno.env.toObject()

if (!env.TOKEN) throw new Error('Missing TOKEN environment variable')

// Optional: SITE_NAME (shown on the docs page) and INVITE_URL (a "join the server" button)
const SITE_NAME = env.SITE_NAME ?? 'hvurs Presence'
const INVITE_URL = 'https://hvurs.cc/to/discord'

import { Hono } from 'https://deno.land/x/hono@v3.3.1/mod.ts'

import { REST } from 'npm:@discordjs/rest@^2.0.0'
import { WebSocketManager } from 'npm:@discordjs/ws@^1.0.0'
import { GatewayDispatchEvents, GatewayIntentBits, Client, GatewayPresenceUpdate, ActivityType, PresenceUpdateStatus } from 'npm:@discordjs/core@^1.0.0'

import 'npm:bufferutil@^4.0.7'

import { makeBadge } from 'npm:badge-maker@^3.3.1'

import logos from './logos.json' assert { type: 'json' }
const { vscode, intellij, spotify, crunchyroll } = logos

const rest = new REST().setToken(env.TOKEN)

const gateway = new WebSocketManager({
	token: env.TOKEN,
	intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildPresences,
	rest
})

const client = new Client({ rest, gateway })

const presences = new Map<string, GatewayPresenceUpdate>()

client.once(GatewayDispatchEvents.Ready, (e) => {
	console.log('Ready!', e.data)
})

client.on(GatewayDispatchEvents.GuildCreate, e => {
	for (const presence of e.data.presences) {
		presences.set(presence.user.id, presence)
	}
})

client.on(GatewayDispatchEvents.PresenceUpdate, e => {
	presences.set(e.data.user.id, e.data)
	broadcast(e.data.user.id)
})

gateway.connect()

/** 
 * Adds a logo and updates positions
 * unfortunately, shields' badge-maker library doesn't support their logo system
 * so I modify the generated svg to inject the logo
 * this only supports the "flat", "flat-square", and "plastic" styles
 * so this is skipped for "social" and "for-the-badge"
 */
const injectLogo = (svg: string, logo: string) => {
	svg = svg.replace('<text', `<image x="5" y="3" width="14" height="14" xlink:href="data:image/svg+xml;base64,${logo}"/><text`)

	// add 17 to the svg's full width in all the places it's in
	const fullWidthArr = svg.match(/width="(\d+?)"/)!
	svg = svg.replace(new RegExp(fullWidthArr[0], 'g'), `width="${+fullWidthArr[1]+17}"`)

	// add 17 to gray part width, fallback for flat-square support
	const [,grayWidth] = svg.match(/\)"><rect width="(\d+?)"/) || svg.match(/"><rect width="(\d+?)"/)!
	svg = svg.replace(new RegExp(`="${grayWidth}"`, 'g'), `="${+grayWidth+17}"`)

	// adds 170 to text positions
	svg = svg.replace(/("|xt) x="(\d+?)"/g, (_, start, pos) => `${start} x="${+pos+170}"`)

	return svg
}

const colors = { online: 'brightgreen', idle: 'yellow', dnd: 'red', offline: 'lightgray' }

const resolveStyle = (style?: string) =>
	style === 'plastic' || style === 'flat' || style === 'flat-square' || style === 'for-the-badge' || style === 'social' ? style : 'flat'

const formatter = new Intl.ListFormat()

/* ------------------------------------------------------------------ *
 * Lanyard-style API: REST (/v1/users/:id) + WebSocket (/socket)
 * ------------------------------------------------------------------ */

const SNOWFLAKE = /^\d{17,20}$/

type DiscordUser = Awaited<ReturnType<typeof client.api.users.get>>

// Presence events only carry a user ID, so profile info is fetched over REST and cached
const userCache = new Map<string, { user: DiscordUser | null, expires: number }>()
const USER_TTL = 10 * 60_000

const getUser = async (id: string): Promise<DiscordUser | null> => {
	const cached = userCache.get(id)
	if (cached && cached.expires > Date.now()) return cached.user

	let user: DiscordUser | null = null
	try {
		user = await client.api.users.get(id)
	} catch (err) {
		// 404 = no such user (cache that); anything else (rate limit, outage) is thrown
		if ((err as { status?: number }).status !== 404) throw err
	}

	if (userCache.size > 5000) userCache.delete(userCache.keys().next().value!)
	userCache.set(id, { user, expires: Date.now() + USER_TTL })
	return user
}

const avatarUrl = (user: DiscordUser) => user.avatar
	? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}`
	: null

const bannerUrl = (user: DiscordUser) => user.banner
	? `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${user.banner.startsWith('a_') ? 'gif' : 'png'}?size=600`
	: null

/** Builds a Lanyard-shaped presence object, or null if the Discord user doesn't exist */
const buildPresence = async (id: string) => {
	const user = await getUser(id)
	if (!user) return null

	const presence = presences.get(id)
	const activities = presence?.activities ?? []
	const clientStatus = presence?.client_status ?? {}

	const spotifyActivity = activities.find(a => a.type === ActivityType.Listening && a.name === 'Spotify' && a.sync_id)
	const albumArt = spotifyActivity?.assets?.large_image?.replace('spotify:', '')

	return {
		spotify: spotifyActivity ? {
			track_id: spotifyActivity.sync_id,
			timestamps: spotifyActivity.timestamps ?? {},
			song: spotifyActivity.details ?? null,
			artist: spotifyActivity.state ?? null,
			album_art_url: albumArt ? `https://i.scdn.co/image/${albumArt}` : null,
			album: spotifyActivity.assets?.large_text ?? null
		} : null,
		listening_to_spotify: !!spotifyActivity,
		discord_user: {
			id: user.id,
			username: user.username,
			avatar: user.avatar,
			avatar_url: avatarUrl(user),
			discriminator: user.discriminator,
			bot: user.bot ?? false,
			global_name: user.global_name ?? null,
			display_name: user.global_name ?? null,
			public_flags: user.public_flags ?? 0,
			avatar_decoration_data: user.avatar_decoration_data ?? null,
			banner: user.banner ?? null,
			banner_url: bannerUrl(user),
			accent_color: user.accent_color ?? null
		},
		discord_status: presence?.status ?? PresenceUpdateStatus.Offline,
		active_on_discord_web: !!clientStatus.web,
		active_on_discord_desktop: !!clientStatus.desktop,
		active_on_discord_mobile: !!clientStatus.mobile,
		active_on_discord_embedded: false,
		activities,
		kv: {}
	}
}

const apiError = (code: string, message: string) => ({ success: false, error: { code, message } })

/* WebSocket protocol (same shape as Lanyard):
 *   op 0 Event (server -> client)   { op, seq, t, d }
 *   op 1 Hello (server -> client)   { op, d: { heartbeat_interval } }
 *   op 2 Initialize (client -> server)  d: { subscribe_to_id } | { subscribe_to_ids: [] }
 *   op 3 Heartbeat (client -> server)
 */
const HEARTBEAT_INTERVAL = 30_000
const MAX_SUBSCRIPTIONS = 50

interface Subscriber {
	send: (t: string, d: unknown) => void
}

const subscribers = new Map<string, Set<Subscriber>>()
const lastPayload = new Map<string, string>()

const subscribe = (id: string, sub: Subscriber) => {
	if (!subscribers.has(id)) subscribers.set(id, new Set())
	subscribers.get(id)!.add(sub)
}

const unsubscribe = (id: string, sub: Subscriber) => {
	const subs = subscribers.get(id)
	if (!subs) return
	subs.delete(sub)
	if (!subs.size) {
		subscribers.delete(id)
		lastPayload.delete(id)
	}
}

async function broadcast(id: string) {
	const subs = subscribers.get(id)
	if (!subs?.size) return

	try {
		const data = await buildPresence(id)
		if (!data) return

		// the same presence arrives once per shared server, only forward real changes
		const payload = JSON.stringify(data)
		if (lastPayload.get(id) === payload) return
		lastPayload.set(id, payload)

		for (const sub of subs) sub.send('PRESENCE_UPDATE', data)
	} catch (err) {
		console.error('Failed to broadcast presence update', err)
	}
}

const app = new Hono()

/* ------------------------------------------------------------------ *
 * Docs page
 * ------------------------------------------------------------------ */

type Param = [name: string, description: string, def: string]

const labelP = (def: string): Param => ['label', 'the text on the left side', def]
const labelColorP: Param = ['labelColor', 'the color of the left side', 'gray']
const colorP = (def: string): Param => ['color', 'the color of the right side', def]
const styleP: Param = ['style', 'flat, flat-square, plastic, for-the-badge, or social', 'flat']
const fallbackP = (desc: string): Param => ['fallback', desc, 'nothing rn']
const hideLogoP = (name: string): Param => ['hideLogo', `whether to disable the ${name} logo`, 'false']

const docSections: { title: string, path: string, params: Param[] }[] = [
	{
		title: 'Status',
		path: '/badge/status/:id',
		params: [
			['simple', 'whether to show online for idle and dnd statuses', 'false'],
			labelP('currently'),
			labelColorP,
			colorP('brightgreen if online, yellow if idle, red if dnd, lightgray if offline'),
			styleP
		]
	},
	{
		title: 'Playing',
		path: '/badge/playing/:id',
		params: [
			labelP('playing'),
			fallbackP('text to show on the right side if nothing is being played'),
			labelColorP,
			colorP('#5865f2'),
			styleP
		]
	},
	{
		title: 'Visual Studio Code',
		path: '/badge/vscode/:id',
		params: [
			labelP('coding'),
			fallbackP("text to show on the right side if VS Code isn't in use"),
			labelColorP,
			colorP('#23a7f2'),
			styleP,
			hideLogoP('VS Code')
		]
	},
	{
		title: 'IntelliJ IDEA',
		path: '/badge/intellij/:id',
		params: [
			labelP('coding'),
			fallbackP("text to show on the right side if IntelliJ IDEA isn't in use"),
			labelColorP,
			colorP('#fe315d'),
			styleP,
			hideLogoP('IntelliJ')
		]
	},
	{
		title: 'Spotify',
		path: '/badge/spotify/:id',
		params: [
			labelP('listening to'),
			fallbackP("text to show on the right side if Spotify isn't in use"),
			labelColorP,
			colorP('#1db954'),
			styleP,
			hideLogoP('Spotify')
		]
	},
	{
		title: 'Crunchyroll',
		path: '/badge/crunchyroll/:id',
		params: [
			labelP('watching'),
			fallbackP("text to show on the right side if Crunchyroll isn't in use"),
			labelColorP,
			colorP('#f47521'),
			styleP,
			hideLogoP('Crunchyroll')
		]
	}
]

const responseFields: [string, string, string][] = [
	['discord_status', 'string', 'online, idle, dnd or offline'],
	['discord_user', 'object', 'id, username, avatar, avatar_url, banner, banner_url, accent_color, discriminator, bot, global_name, display_name, public_flags'],
	['activities', 'array', 'every activity Discord reports (games, IDEs, Spotify, custom status...)'],
	['listening_to_spotify', 'boolean', 'whether a Spotify track is currently playing'],
	['spotify', 'object | null', 'track_id, song, artist, album, album_art_url and timestamps (start/end in ms)'],
	['active_on_discord_web', 'boolean', 'online on the web client'],
	['active_on_discord_desktop', 'boolean', 'online on the desktop client'],
	['active_on_discord_mobile', 'boolean', 'online on mobile'],
	['active_on_discord_embedded', 'boolean', 'always false, kept for Lanyard compatibility'],
	['kv', 'object', 'always empty, kept for Lanyard compatibility']
]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const endpoint = (base: string, path: string) => `<code class="endpoint">${esc(base)}${esc(path)}</code>`

const code = (text: string) => `<pre><code>${esc(text)}</code></pre>`

const paramTable = (heads: string[], rows: string[][]) => `
	<div class="table-wrap">
	<table>
		<thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead>
		<tbody>
			${rows.map(r => `<tr>${r.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('\n\t\t\t')}
		</tbody>
	</table>
	</div>`

const renderDocs = (host: string, proto: string) => {
	const base = `${proto}://${host}`
	const wsBase = `${proto === 'http' ? 'ws' : 'wss'}://${host}`

	const restSample = JSON.stringify({
		success: true,
		data: {
			spotify: {
				track_id: 'TRACK_ID',
				timestamps: { start: 1726000000000, end: 1726000210000 },
				song: 'Song name',
				artist: 'Artist; Another artist',
				album_art_url: 'https://i.scdn.co/image/ALBUM_ART_ID',
				album: 'Album name'
			},
			listening_to_spotify: true,
			discord_user: {
				id: 'YOUR_ID',
				username: 'example',
				avatar: 'a1b2c3d4e5f6',
				avatar_url: 'https://cdn.discordapp.com/avatars/YOUR_ID/a1b2c3d4e5f6.png',
				banner: 'f6e5d4c3b2a1',
				banner_url: 'https://cdn.discordapp.com/banners/YOUR_ID/f6e5d4c3b2a1.png?size=600',
				accent_color: 5793266,
				discriminator: '0',
				bot: false,
				global_name: 'Example',
				display_name: 'Example',
				public_flags: 0
			},
			discord_status: 'online',
			active_on_discord_web: false,
			active_on_discord_desktop: true,
			active_on_discord_mobile: false,
			active_on_discord_embedded: false,
			activities: [],
			kv: {}
		}
	}, null, 2)

	const wsSample = [
		`const ws = new WebSocket("${wsBase}/socket")`,
		'let heartbeat',
		'',
		'ws.addEventListener("message", ({ data }) => {',
		'  const { op, t, d } = JSON.parse(data)',
		'',
		'  // op 1 = Hello: subscribe, then start heartbeating',
		'  if (op === 1) {',
		'    ws.send(JSON.stringify({ op: 2, d: { subscribe_to_id: "YOUR_ID" } }))',
		'    heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 3 })), d.heartbeat_interval)',
		'  }',
		'',
		'  // op 0 = Event: INIT_STATE once, then PRESENCE_UPDATE on every change',
		'  if (op === 0) console.log(t, d.discord_status, d.activities)',
		'})',
		'',
		'ws.addEventListener("close", () => clearInterval(heartbeat))'
	].join('\n')

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#5865f2">
<title>${esc(SITE_NAME)} Docs</title>
<link
	rel="icon"
	type="image/png"
	href="https://i.ibb.co/9P55Z60/image.png"
/>
<style>
	:root { color-scheme: dark; }
	* { box-sizing: border-box; }
	body { margin: 0; background: #14161a; color: #e6e8eb; font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
	main { max-width: 860px; margin: 0 auto; padding: 48px 20px 96px; }
	h1 { text-align: center; font-size: 2.5rem; margin: 0 0 32px; }
	h2 { font-size: 1.75rem; margin: 48px 0 8px; }
	h3 { font-size: 1.25rem; margin: 32px 0 8px; }
	p { margin: 0 0 12px; }
	a { color: #8f9bff; }
	code.endpoint, pre { display: block; padding: 10px 14px; margin: 0 0 12px; background: #1d2026; border-radius: 6px; color: #8f9bff; overflow-x: auto; }
	code.endpoint { white-space: nowrap; }
	pre { margin: 0 0 16px; line-height: 1.5; }
	pre code { color: #d5d9e2; font-size: 0.85rem; }
	.table-wrap { overflow-x: auto; margin-bottom: 12px; }
	table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
	th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2b2f36; vertical-align: top; }
	th { color: #aab0b8; font-weight: 600; }
	td:first-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
	<h1>Docs</h1>
	<p>Badges and an API showing what you're doing on Discord. Replace <code>:id</code> in each endpoint with your Discord user ID. The bot has to share a server with you for presence to show up${INVITE_URL ? `, <a href="${esc(INVITE_URL)}" target="_blank" rel="noopener">join the server here</a>` : ''}.</p>
	<p>Badges are generated with <a href="https://shields.io" target="_blank" rel="noopener">Shields.io</a>'s badge-maker library, so the query params follow the Shields format.</p>
	<p>All query params are optional. Logos only display on the flat, flat-square, and plastic styles.</p>

	<h2>REST API</h2>
	<p>Returns a user's presence as JSON. CORS is enabled for all origins.</p>
	${endpoint(base, '/v1/users/:id')}
	${code(restSample)}
	<p>Fields in <code>data</code></p>
	${paramTable(['Field', 'Type', 'Description'], responseFields.map(([f, t, d]) => [f, t, d]))}
	<p>Failed requests return <code>success: false</code> with an <code>error</code> object. An unknown Discord user ID returns <code>404 user_not_monitored</code> and a malformed ID returns <code>400 invalid_user_id</code>.</p>

	<h2>WebSocket</h2>
	<p>Subscribe once and get pushed an update every time a presence changes. Uses the same protocol as Lanyard.</p>
	${endpoint(wsBase, '/socket')}
	${paramTable(['Op', 'Name', 'Description'], [
		['0', 'Event', 'Server to client. Carries <code>t</code> (event name), <code>d</code> (data) and <code>seq</code>.'],
		['1', 'Hello', 'Server to client. Sent on connect with <code>d.heartbeat_interval</code> in milliseconds.'],
		['2', 'Initialize', 'Client to server. Subscribe with <code>{ subscribe_to_id }</code> or <code>{ subscribe_to_ids: [...] }</code> (up to 50 IDs).'],
		['3', 'Heartbeat', 'Client to server. Send one every <code>heartbeat_interval</code> ms or the connection is closed.']
	])}
	${paramTable(['Event', 'Description'], [
		['INIT_STATE', 'Sent right after Initialize. With <code>subscribe_to_id</code> <code>d</code> is the presence object, with <code>subscribe_to_ids</code> it is a map of user ID to presence.'],
		['PRESENCE_UPDATE', 'Sent whenever a subscribed user changes status or activity. <code>d</code> is the full presence object.']
	])}
	${code(wsSample)}
	<p>Close codes: <code>4004</code> unknown_opcode, <code>4005</code> requires_data_object, <code>4006</code> invalid_payload, <code>4007</code> user_not_monitored, <code>4008</code> heartbeat_timeout.</p>

	<h2>Badges</h2>
	${docSections.map(s => `
	<h3>${s.title}</h3>
	${endpoint(base, s.path)}
	<p>Query Params</p>
	${paramTable(['Param', 'Description', 'Default'], s.params)}`).join('\n')}

	<h2>Open Spotify</h2>
	${endpoint(base, '/openspotify/:id')}
	<p>Redirects to the track page of the song you're listening to on Spotify.</p>

	<h2>Presence</h2>
	${endpoint(base, '/presence/:id')}
	<p>Returns the raw presence object from Discord so you can integrate it another way.</p>
</main>
</body>
</html>`
}

const requestOrigin = (c: { req: { header: (n: string) => string | undefined, url: string } }) => ({
	host: c.req.header('host') ?? new URL(c.req.url).host,
	proto: c.req.header('x-forwarded-proto') ?? 'https'
})

app.get('/', c => {
	const { host, proto } = requestOrigin(c)
	return c.html(renderDocs(host, proto))
})

app.get('/health', c => c.text('ok'))

/* ------------------------------------------------------------------ *
 * Lanyard-style REST + WebSocket routes
 * ------------------------------------------------------------------ */

app.use('/v1/*', async (c, next) => {
	await next()
	c.header('Access-Control-Allow-Origin', '*')
	c.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
	c.header('Access-Control-Allow-Headers', 'Content-Type')
})

app.options('/v1/*', c => c.body(null, 204))

app.get('/v1/users/:id', async c => {
	const id = c.req.param('id')
	c.header('Cache-Control', 'no-store')

	if (!SNOWFLAKE.test(id)) return c.json(apiError('invalid_user_id', 'The user ID must be a valid Discord ID'), 400)

	try {
		const data = await buildPresence(id)
		if (!data) return c.json(apiError('user_not_monitored', 'User is not being monitored by this server'), 404)
		return c.json({ success: true, data })
	} catch (err) {
		console.error(err)
		return c.json(apiError('discord_unavailable', 'Could not reach Discord, try again in a moment'), 502)
	}
})

app.get('/socket', c => {
	if (c.req.header('upgrade')?.toLowerCase() !== 'websocket')
		return c.json(apiError('upgrade_required', 'This endpoint requires a WebSocket connection'), 426)

	const { socket, response } = Deno.upgradeWebSocket(c.req.raw)

	let seq = 0
	let lastHeartbeat = Date.now()
	let heartbeatCheck: number | undefined
	let subscribedIds: string[] = []

	const subscriber: Subscriber = {
		send: (t, d) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 0, seq: ++seq, t, d }))
		}
	}

	const clearSubscriptions = () => {
		for (const id of subscribedIds) unsubscribe(id, subscriber)
		subscribedIds = []
	}

	const closeWith = (code: number, reason: string) => {
		if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
	}

	socket.onopen = () => {
		socket.send(JSON.stringify({ op: 1, d: { heartbeat_interval: HEARTBEAT_INTERVAL } }))
		heartbeatCheck = setInterval(() => {
			if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL * 2) closeWith(4008, 'heartbeat_timeout')
		}, HEARTBEAT_INTERVAL)
	}

	socket.onmessage = async event => {
		let message: { op?: number, d?: Record<string, unknown> }
		try {
			message = JSON.parse(String(event.data))
		} catch {
			return closeWith(4006, 'invalid_payload')
		}

		if (message.op === 3) {
			lastHeartbeat = Date.now()
			return
		}

		if (message.op !== 2) return closeWith(4004, 'unknown_opcode')
		if (!message.d || typeof message.d !== 'object') return closeWith(4005, 'requires_data_object')

		const single = typeof message.d.subscribe_to_id === 'string'
		const ids = single ? [message.d.subscribe_to_id as string] : message.d.subscribe_to_ids

		if (!Array.isArray(ids) || !ids.length || ids.length > MAX_SUBSCRIPTIONS || !ids.every(id => typeof id === 'string' && SNOWFLAKE.test(id)))
			return closeWith(4006, 'invalid_payload')

		try {
			const unique = [...new Set(ids as string[])]
			const results = await Promise.all(unique.map(async id => [id, await buildPresence(id)] as const))
			const found = results.filter(([, presence]) => presence)

			if (single && !found.length) return closeWith(4007, 'user_not_monitored')
			if (socket.readyState !== WebSocket.OPEN) return

			clearSubscriptions()
			for (const [id] of found) {
				subscribe(id, subscriber)
				subscribedIds.push(id)
			}

			subscriber.send('INIT_STATE', single ? found[0][1] : Object.fromEntries(found))
		} catch (err) {
			console.error(err)
			closeWith(1011, 'internal_error')
		}
	}

	socket.onclose = () => {
		clearInterval(heartbeatCheck)
		clearSubscriptions()
	}

	socket.onerror = () => socket.close()

	return response
})

app.get('/badge/status/:id', c => {
	const realStatus = presences.get(c.req.param('id'))?.status ?? PresenceUpdateStatus.Offline

	const status = c.req.query('simple') === 'true'
		? [PresenceUpdateStatus.Idle, PresenceUpdateStatus.DoNotDisturb].includes(realStatus)
			? PresenceUpdateStatus.Online
			: realStatus
		: realStatus

	c.header('Content-Type', 'image/svg+xml; charset=utf-8')
	c.header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate')

	return c.body(makeBadge({
		label: c.req.query('label') ?? 'currently',
		message: status,
		labelColor: c.req.query('labelColor') ?? 'gray',
		color: c.req.query('color') ?? colors[status],
		style: resolveStyle(c.req.query('style'))
	}))
})

app.get('/badge/playing/:id', c => {
	const activities = presences.get(c.req.param('id'))?.activities
		?.filter(a => a.type === ActivityType.Playing && !['Visual Studio Code', 'IntelliJ IDEA Ultimate'].includes(a.name)) ?? []

	c.header('Content-Type', 'image/svg+xml; charset=utf-8')
	c.header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate')

	return c.body(makeBadge({
		label: c.req.query('label') ?? 'playing',
		message: formatter.format(activities.map(a => a.name)) || c.req.query('fallback') || 'nothing rn',
		labelColor: c.req.query('labelColor') ?? 'gray',
		color: c.req.query('color') ?? '#5865f2',
		style: resolveStyle(c.req.query('style'))
	}))
})

app.get('/badge/vscode/:id', c => {
	const activity = presences.get(c.req.param('id'))?.activities?.find(a => a.name === 'Visual Studio Code' && a.details && a.state)

	c.header('Content-Type', 'image/svg+xml; charset=utf-8')
	c.header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate')

	const style = resolveStyle(c.req.query('style'))

	let badge = makeBadge({
		label: c.req.query('label') ?? 'coding',
		message: activity && activity.details && activity.state
			? `${activity.details.replace('Editing ', '')} in ${activity.state.replace(/(Workspace: | \(Workspace\))/g, '').replace('Glitch:', '🎏')}`
			: c.req.query('fallback') ?? 'nothing rn',
		labelColor: c.req.query('labelColor') ?? 'gray',
		color: c.req.query('color') ?? '#23a7f2',
		style
	})

	if (!['social', 'for-the-badge'].includes(style) && c.req.query('hideLogo') !== 'true')
		badge = injectLogo(badge, vscode)

	return c.body(badge)
})

app.get('/badge/intellij/:id', c => {
	const activity = presences.get(c.req.param('id'))?.activities?.find(a => a.name === 'IntelliJ IDEA Ultimate' && a.details && a.state && a.state !== 'Idling')

	c.header('Content-Type', 'image/svg+xml; charset=utf-8')
	c.header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate')

	const style = resolveStyle(c.req.query('style'))

	let badge = makeBadge({
		label: c.req.query('label') ?? 'coding',
		message: activity && activity.details && activity.state
			? `${activity.details.replace('Editing ', '')} in ${activity.state}`
			: c.req.query('fallback') ?? 'nothing rn',
		labelColor: c.req.query('labelColor') ?? 'gray',
		color: c.req.query('color') ?? '#fe315d',
		style
	})

	if (!['social', 'for-the-badge'].includes(style) && c.req.query('hideLogo') !== 'true')
		badge = injectLogo(badge, intellij)

	return c.body(badge)
})

app.get('/badge/spotify/:id', c => {
	const activity = presences.get(c.req.param('id'))?.activities?.find(a => a.type === ActivityType.Listening && a.name === 'Spotify' && a.details && a.state)

	c.header('Content-Type', 'image/svg+xml; charset=utf-8')
	c.header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate')

	const style = resolveStyle(c.req.query('style'))

	let badge = makeBadge({
		label: c.req.query('label') ?? 'listening to',
		message: activity && activity.details && activity.state
			? `${activity.details.replace(/\(.*\)/g, '')} by ${formatter.format(activity.state.split('; '))}`
			: c.req.query('fallback') ?? 'nothing rn',
		labelColor: c.req.query('labelColor') ?? 'gray',
		color: c.req.query('color') ?? '#1db954',
		style
	})

	if (!['social', 'for-the-badge'].includes(style) && c.req.query('hideLogo') !== 'true')
		badge = injectLogo(badge, spotify)

	return c.body(badge)
})

app.get('/badge/crunchyroll/:id', c => {
	const activity = presences.get(c.req.param('id'))?.activities?.find(a => a.type === ActivityType.Watching && a.name === 'Crunchyroll' && a.details)

	c.header('Content-Type', 'image/svg+xml; charset=utf-8')
	c.header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate')

	const style = resolveStyle(c.req.query('style'))

	let badge = makeBadge({
		label: c.req.query('label') ?? 'watching',
		message: activity && activity.details
			? activity.details
			: c.req.query('fallback') ?? 'nothing rn',
		labelColor: c.req.query('labelColor') ?? 'gray',
		color: c.req.query('color') ?? '#f47521',
		style
	})

	if (!['social', 'for-the-badge'].includes(style) && c.req.query('hideLogo') !== 'true')
		badge = injectLogo(badge, crunchyroll)

	return c.body(badge)
})

app.get('/presence/:id', c => {
	c.header('Access-Control-Allow-Origin', '*')
	const presence = presences.get(c.req.param('id'))
	if (!presence) return c.json({ status: PresenceUpdateStatus.Offline, client_status: {}, activities: [] })
	return c.json({ ...presence, user: undefined })
})

app.get('/openspotify/:id', c => {
	const presence = presences.get(c.req.param('id'))
	const spotifyActivity = presence?.activities?.find(a => a.name === 'Spotify' && a.type === ActivityType.Listening && a.sync_id)
	if (!spotifyActivity) return c.text("This user isn't listening to Spotify.")

	return c.redirect(`https://open.spotify.com/track/${spotifyActivity.sync_id}`)
})

// Render provides PORT; falls back to 8000 locally
Deno.serve({ port: +(env.PORT ?? 8000) }, app.fetch)
