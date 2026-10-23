// Reads from real environment variables (Render, Docker, shell).
// Locally you can run: deno run -A --unstable-kv --env app.ts   (loads a .env file)
//
// Env:
//   TOKEN        (required) Discord bot token
//   SITE_NAME    shown on the docs page
//   INVITE_URL   "join the server" link, also used as the privacy contact
//   KV_PATH      path of the Deno KV database file. Point this at a persistent disk
//                (e.g. /data/kv.db on Render) or KV data and API keys are lost on redeploy
//   PORT         defaults to 8000
const env = Deno.env.toObject()

if (!env.TOKEN) throw new Error('Missing TOKEN environment variable')

const SITE_NAME = env.SITE_NAME ?? 'hvurs Presence'
const INVITE_URL = env.INVITE_URL ?? 'https://hvurs.cc/to/discord'
const POLICY_UPDATED = 'October 23, 2026'

import { Hono, type Context } from 'https://deno.land/x/hono@v3.3.1/mod.ts'

import { REST } from 'npm:@discordjs/rest@^2.0.0'
import { WebSocketManager } from 'npm:@discordjs/ws@^1.0.0'
import {
	GatewayDispatchEvents, GatewayIntentBits, Client, GatewayPresenceUpdate, ActivityType,
	PresenceUpdateStatus, InteractionType, MessageFlags
} from 'npm:@discordjs/core@^1.0.0'

import 'npm:bufferutil@^4.0.7'

import { makeBadge } from 'npm:badge-maker@^3.3.1'

import logos from './logos.json' with { type: 'json' }
const { vscode, intellij, spotify, crunchyroll } = logos

const rest = new REST().setToken(env.TOKEN)

const gateway = new WebSocketManager({
	token: env.TOKEN,
	// DM message content doesn't need the privileged MessageContent intent
	intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildPresences | GatewayIntentBits.DirectMessages,
	rest
})

const client = new Client({ rest, gateway })

const presences = new Map<string, GatewayPresenceUpdate>()

client.on(GatewayDispatchEvents.GuildCreate, e => {
	for (const presence of e.data.presences) {
		presences.set(presence.user.id, presence)
	}
})

client.on(GatewayDispatchEvents.PresenceUpdate, e => {
	presences.set(e.data.user.id, e.data)
	broadcast(e.data.user.id)
})

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
 * Persistent storage: KV pairs + API keys (Deno KV)
 * ------------------------------------------------------------------ */

const kvdb = await Deno.openKv(env.KV_PATH || undefined)

const KV_KEY_RE = /^[a-zA-Z0-9_]{1,255}$/
const KV_MAX_VALUE = 30_000
const KV_MAX_PAIRS = 512

type KvStore = Record<string, string>

// null-prototype objects so a key called "__proto__" is just a normal key
const newStore = () => Object.create(null) as KvStore

const kvCache = new Map<string, KvStore>()

const getKv = async (id: string): Promise<KvStore> => {
	const cached = kvCache.get(id)
	if (cached) return cached

	const store = newStore()
	for await (const entry of kvdb.list<string>({ prefix: ['kv', id] })) store[entry.key[2] as string] = entry.value

	if (kvCache.size > 5000) kvCache.delete(kvCache.keys().next().value!)
	kvCache.set(id, store)
	return store
}

/** Returns an error message, or null on success */
const kvSet = async (id: string, entries: KvStore): Promise<string | null> => {
	const store = await getKv(id)
	const pairs = Object.entries(entries)

	for (const [key, value] of pairs) {
		if (!KV_KEY_RE.test(key)) return `Invalid key "${key.slice(0, 50)}": keys may only contain letters, numbers and underscores and be up to 255 characters.`
		if (value.length > KV_MAX_VALUE) return `The value for "${key}" is too long (max ${KV_MAX_VALUE} characters).`
	}

	const newKeys = pairs.filter(([key]) => !(key in store)).length
	if (Object.keys(store).length + newKeys > KV_MAX_PAIRS) return `You can have at most ${KV_MAX_PAIRS} key-value pairs.`

	const op = kvdb.atomic()
	for (const [key, value] of pairs) op.set(['kv', id, key], value)
	await op.commit()

	for (const [key, value] of pairs) store[key] = value
	broadcast(id)
	return null
}

const kvDelete = async (id: string, key: string): Promise<boolean> => {
	const store = await getKv(id)
	if (!(key in store)) return false

	await kvdb.delete(['kv', id, key])
	delete store[key]
	broadcast(id)
	return true
}

/** Deletes every KV pair and the API key of a user */
const forgetUser = async (id: string) => {
	const op = kvdb.atomic()
	for await (const entry of kvdb.list({ prefix: ['kv', id] })) op.delete(entry.key)
	op.delete(['apikey', id])
	await op.commit()

	kvCache.delete(id)
	broadcast(id)
}

const getApiKey = async (id: string) => (await kvdb.get<string>(['apikey', id])).value

const createApiKey = async (id: string) => {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	const key = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
	await kvdb.set(['apikey', id], key)
	return key
}

const getOrCreateApiKey = async (id: string) => (await getApiKey(id)) ?? createApiKey(id)

const safeEqual = (a: string, b: string) => {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

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

const hexColor = (n?: number | null) => typeof n === 'number' ? `#${n.toString(16).padStart(6, '0')}` : null

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
		kv: await getKv(id),
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
			banner_color: user.banner_color ?? hexColor(user.accent_color),
			accent_color: user.accent_color ?? null
		},
		discord_status: presence?.status ?? PresenceUpdateStatus.Offline,
		active_on_discord_web: !!clientStatus.web,
		active_on_discord_desktop: !!clientStatus.desktop,
		active_on_discord_mobile: !!clientStatus.mobile,
		active_on_discord_embedded: false,
		activities
	}
}

const apiError = (code: string, message: string) => ({ success: false, error: { code, message } })

/** Checks the Authorization header against the API key of :id. Returns a Response to send on failure */
const requireAuth = async (c: Context, id: string): Promise<Response | null> => {
	c.header('Cache-Control', 'no-store')

	if (!SNOWFLAKE.test(id)) return c.json(apiError('invalid_user_id', 'The user ID must be a valid Discord ID'), 400)

	const token = c.req.header('authorization')
	const key = await getApiKey(id)
	if (!token || !key || !safeEqual(token, key))
		return c.json(apiError('unauthorized', 'Missing or invalid API key. DM the bot .apikey or use /apikey to get one'), 401)

	return null
}

/* WebSocket protocol (same shape as Lanyard):
 *   op 0 Event (server -> client)       { op, seq, t, d }
 *   op 1 Hello (server -> client)       { op, d: { heartbeat_interval } }
 *   op 2 Initialize (client -> server)  d: { subscribe_to_id } | { subscribe_to_ids: [] } | { subscribe_to_all: true }
 *   op 3 Heartbeat (client -> server)
 *   op 4 Unsubscribe (client -> server) d: { unsubscribe_from_id } | { unsubscribe_from_ids: [] } | { unsubscribe_from_all: true }
 */
const HEARTBEAT_INTERVAL = 30_000
const MAX_SUBSCRIPTIONS = 50

interface Subscriber {
	send: (t: string, d: unknown) => void
}

const subscribers = new Map<string, Set<Subscriber>>()
const globalSubscribers = new Set<Subscriber>()
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
		if (!globalSubscribers.size) lastPayload.delete(id)
	}
}

async function broadcast(id: string) {
	const subs = subscribers.get(id)
	if (!subs?.size && !globalSubscribers.size) return

	try {
		const data = await buildPresence(id)
		if (!data) return

		// the same presence arrives once per shared server, only forward real changes
		const payload = JSON.stringify(data)
		if (lastPayload.get(id) === payload) return
		lastPayload.set(id, payload)

		for (const sub of new Set([...(subs ?? []), ...globalSubscribers])) sub.send('PRESENCE_UPDATE', data)
	} catch (err) {
		console.error('Failed to broadcast presence update', err)
	}
}

// zlib-wrapped deflate, what Lanyard's ?compression=zlib_json sends
const zlib = async (text: string) =>
	new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())

const app = new Hono()

/* ------------------------------------------------------------------ *
 * Pages (docs + privacy policy)
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
	['discord_user', 'object', 'id, username, avatar, avatar_url, banner, banner_url, banner_color, accent_color, avatar_decoration_data, discriminator, bot, global_name, display_name, public_flags'],
	['activities', 'array', 'every activity Discord reports (games, IDEs, Spotify, custom status...)'],
	['listening_to_spotify', 'boolean', 'whether a Spotify track is currently playing'],
	['spotify', 'object | null', 'track_id, song, artist, album, album_art_url and timestamps (start/end in ms). null if listening_to_spotify is false'],
	['active_on_discord_web', 'boolean', 'online on the web client'],
	['active_on_discord_desktop', 'boolean', 'online on the desktop client'],
	['active_on_discord_mobile', 'boolean', 'online on mobile'],
	['active_on_discord_embedded', 'boolean', 'always false, kept for Lanyard compatibility'],
	['kv', 'object', 'your key-value store, see the KV section']
]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const endpoint = (base: string, path: string, method = 'GET') =>
	`<code class="endpoint"><b>${method}</b> ${esc(base)}${esc(path)}</code>`

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

const shell = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#5865f2">
<title>${esc(title)}</title>
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
	p, ul { margin: 0 0 12px; }
	li { margin-bottom: 6px; }
	a { color: #8f9bff; }
	code.endpoint, pre { display: block; padding: 10px 14px; margin: 0 0 12px; background: #1d2026; border-radius: 6px; color: #8f9bff; overflow-x: auto; }
	code.endpoint { white-space: nowrap; }
	code.endpoint b { color: #aab0b8; font-weight: 600; margin-right: 6px; }
	pre { margin: 0 0 16px; line-height: 1.5; }
	pre code { color: #d5d9e2; font-size: 0.85rem; }
	.table-wrap { overflow-x: auto; margin-bottom: 12px; }
	table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
	th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2b2f36; vertical-align: top; }
	th { color: #aab0b8; font-weight: 600; }
	td:first-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
	.muted { color: #aab0b8; font-size: 0.9rem; }
	footer { margin-top: 64px; text-align: center; color: #aab0b8; font-size: 0.9rem; }
	footer a { margin: 0 8px; }
</style>
</head>
<body>
<main>
${body}
	<footer><a href="/">Docs</a><a href="/privacy">Privacy Policy</a>${INVITE_URL ? `<a href="${esc(INVITE_URL)}" target="_blank" rel="noopener">Discord</a>` : ''}</footer>
</main>
</body>
</html>`

const renderDocs = (host: string, proto: string) => {
	const base = `${proto}://${host}`
	const wsBase = `${proto === 'http' ? 'ws' : 'wss'}://${host}`

	const restSample = JSON.stringify({
		success: true,
		data: {
			kv: { location: 'Los Angeles, CA' },
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
				banner_color: '#586bf2',
				accent_color: 5793266,
				avatar_decoration_data: null,
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
			activities: []
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

	const kvSample = [
		`# set one key (the request body is the value)`,
		`curl -X PUT ${base}/v1/users/YOUR_ID/kv/location \\`,
		`  -H "Authorization: YOUR_API_KEY" -d "Los Angeles, CA"`,
		``,
		`# set several keys at once (flat object only)`,
		`curl -X PATCH ${base}/v1/users/YOUR_ID/kv \\`,
		`  -H "Authorization: YOUR_API_KEY" -H "Content-Type: application/json" \\`,
		`  -d '{"location":"Los Angeles, CA","mood":"good"}'`,
		``,
		`# delete a key`,
		`curl -X DELETE ${base}/v1/users/YOUR_ID/kv/location \\`,
		`  -H "Authorization: YOUR_API_KEY"`
	].join('\n')

	return shell(`${SITE_NAME} Docs`, `
	<h1>Docs</h1>
	<p>Badges and an API showing what you're doing on Discord. Replace <code>:id</code> in each endpoint with your Discord user ID. The bot has to share a server with you for presence to show up${INVITE_URL ? `, <a href="${esc(INVITE_URL)}" target="_blank" rel="noopener">join the server here</a>` : ''}.</p>
	<p>The REST API, WebSocket and KV store are a drop-in replacement for <a href="https://github.com/Phineas/lanyard" target="_blank" rel="noopener">Lanyard</a>: swap <code>api.lanyard.rest</code> for <code>${esc(host)}</code> and everything keeps working.</p>
	<p>Badges are generated with <a href="https://shields.io" target="_blank" rel="noopener">Shields.io</a>'s badge-maker library, so the query params follow the Shields format.</p>
	<p>All badge query params are optional. Logos only display on the flat, flat-square, and plastic styles. See the <a href="/privacy">privacy policy</a> for what is collected.</p>

	<h2>REST API</h2>
	<p>Returns a user's presence as JSON. CORS is enabled for all origins.</p>
	${endpoint(base, '/v1/users/:id')}
	${code(restSample)}
	<p>Fields in <code>data</code></p>
	${paramTable(['Field', 'Type', 'Description'], responseFields.map(([f, t, d]) => [f, t, d]))}
	<p>Failed requests return <code>success: false</code> with an <code>error</code> object. An unknown Discord user ID returns <code>404 user_not_monitored</code>, a malformed ID returns <code>400 invalid_user_id</code>, and a missing or wrong API key on a KV request returns <code>401 unauthorized</code>.</p>

	<h2>KV</h2>
	<p>A key-value store that is attached to your presence as <code>kv</code>. Use it for site config, your current location, anything dynamic. Changing a pair pushes a <code>PRESENCE_UPDATE</code> over the WebSocket.</p>
	<h3>Getting an API key</h3>
	<p>Run <code>/apikey</code> anywhere the bot is, or DM the bot <code>.apikey</code>. Send the key in the <code>Authorization</code> header of every KV request. <code>/apikey regenerate:true</code> replaces it.</p>
	<h3>Limits</h3>
	<ul>
		<li>Keys and values are strings</li>
		<li>Values can be 30,000 characters at most (slash commands cap out at 6,000, use the API for more)</li>
		<li>Keys are letters, numbers and underscores only, up to 255 characters</li>
		<li>Up to 512 pairs per user</li>
	</ul>
	<h3>HTTP</h3>
	${endpoint(base, '/v1/users/:id/kv/:key', 'PUT')}
	<p>Sets a key. The request body is the value, any body is stored as a string.</p>
	${endpoint(base, '/v1/users/:id/kv', 'PATCH')}
	<p>Merges a JSON object into your store, overwriting conflicting keys. The object must be flat (no nested objects or arrays).</p>
	${endpoint(base, '/v1/users/:id/kv/:key', 'DELETE')}
	<p>Deletes a key.</p>
	${code(kvSample)}
	<h3>Discord</h3>
	${paramTable(['Slash command', 'Text command (in DMs)', 'Description'], [
		['/kv set key value', '.set &lt;key&gt; &lt;value&gt;', 'Set a key'],
		['/kv get key', '.get &lt;key&gt;', 'Read a key'],
		['/kv delete key', '.del &lt;key&gt;', 'Delete a key'],
		['/kv list', '.list', 'List your keys'],
		['/apikey [regenerate]', '.apikey', 'Get (or regenerate) your API key, only visible to you'],
		['/forget confirm:true', '.forget', 'Delete your API key and every KV pair']
	])}

	<h2>WebSocket</h2>
	<p>Subscribe once and get pushed an update every time a presence changes. Uses the same protocol as Lanyard. Add <code>?compression=zlib_json</code> to the URL to receive zlib-compressed binary frames instead of text.</p>
	${endpoint(wsBase, '/socket', 'WS')}
	${paramTable(['Op', 'Name', 'Description'], [
		['0', 'Event', 'Server to client. Carries <code>t</code> (event name), <code>d</code> (data) and <code>seq</code>.'],
		['1', 'Hello', 'Server to client. Sent on connect with <code>d.heartbeat_interval</code> in milliseconds.'],
		['2', 'Initialize', 'Client to server. Subscribe with <code>{ subscribe_to_id }</code>, <code>{ subscribe_to_ids: [...] }</code> (up to 50 IDs) or <code>{ subscribe_to_all: true }</code>.'],
		['3', 'Heartbeat', 'Client to server. Send one every <code>heartbeat_interval</code> ms or the connection is closed.'],
		['4', 'Unsubscribe', 'Client to server. Stop updates with <code>{ unsubscribe_from_id }</code>, <code>{ unsubscribe_from_ids: [...] }</code> or <code>{ unsubscribe_from_all: true }</code>. Nothing is sent back.']
	])}
	${paramTable(['Event', 'Description'], [
		['INIT_STATE', 'Sent right after Initialize. With <code>subscribe_to_id</code> <code>d</code> is the presence object, with <code>subscribe_to_ids</code> or <code>subscribe_to_all</code> it is a map of user ID to presence.'],
		['PRESENCE_UPDATE', 'Sent whenever a subscribed user changes status, activity or KV. <code>d</code> is the full presence object.']
	])}
	${code(wsSample)}
	<p>Close codes: <code>4004</code> unknown_opcode, <code>4005</code> requires_data_object, <code>4006</code> invalid_payload, <code>4007</code> user_not_monitored, <code>4008</code> heartbeat_timeout.</p>

	<h2>Quicklinks</h2>
	<p>Redirects to a Discord CDN image. <code>file_type</code> is one of png, gif, webp, jpg or jpeg. An optional <code>?size=</code> (for example 256) is passed through.</p>
	${endpoint(base, '/:id.:file_type')}
	<p>The user's avatar (falls back to their default avatar).</p>
	${endpoint(base, '/banner/:id.:file_type')}
	<p>The user's profile banner. Returns 404 if they don't have one.</p>

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
	<p>Returns the raw presence object from Discord so you can integrate it another way.</p>`)
}

const renderPrivacy = (host: string) => shell(`Privacy Policy - ${SITE_NAME}`, `
	<h1>Privacy Policy</h1>
	<p class="muted">Last updated ${esc(POLICY_UPDATED)}</p>
	<p>${esc(SITE_NAME)} (<code>${esc(host)}</code>, "the service") is a small, hobby-run Discord bot and API that shows a Discord user's presence as badges, JSON and a WebSocket feed, and offers an optional key-value store. This page explains what data it handles and what you can do about it.</p>

	<h2>What the service collects</h2>
	<p>When you share a server with the bot, Discord sends it your presence. The service handles:</p>
	<ul>
		<li><b>Account info:</b> your Discord user ID, username, display name, avatar, banner and banner color, profile flags and avatar decoration.</li>
		<li><b>Presence:</b> your status (online, idle, dnd, offline), which clients you're active on (web, desktop, mobile) and your activities. Activities can include game names, what you're listening to on Spotify (song, artist, album, track ID, timestamps), and what you're working on in code editors such as the file name and workspace shown by VS Code or IntelliJ, plus your custom status text.</li>
		<li><b>KV data (optional):</b> if you use the KV store, the keys and values you save and the API key generated for you.</li>
		<li><b>Commands:</b> the content of slash commands and DMs you send the bot, only to carry them out (for example setting a KV key).</li>
		<li><b>Request logs:</b> like any web service, the hosting provider and the server may log requests, including IP addresses, user agents and the URLs requested (which contain Discord user IDs). The service itself does not store these.</li>
	</ul>
	<p>The service does <b>not</b> use cookies, analytics, trackers or ads, and it does not read your messages in servers.</p>

	<h2>This data is public</h2>
	<p>The whole point of the service is to publish your presence. <b>Anyone who knows your Discord user ID can read your account info and presence</b> through the REST API, WebSocket, badges and quicklinks, with no login. Your KV data is included in that same public response, so don't store anything secret in it. Only the API key is private, and it is only needed to write to your KV store.</p>

	<h2>How long data is kept</h2>
	<ul>
		<li><b>Presence and activities</b> are held in memory only, replaced whenever Discord sends an update, and cleared when the service restarts. They are never written to disk.</li>
		<li><b>Profile info</b> (username, avatar, banner) is cached in memory for about 10 minutes.</li>
		<li><b>KV pairs and API keys</b> are stored in a database on the server until you delete them.</li>
	</ul>

	<h2>How the data is used</h2>
	<p>Only to run the service: answering API, WebSocket and badge requests, and handling your commands. The data is not sold, shared for advertising, or used to build profiles. It is shared with nobody except through the public endpoints described above.</p>

	<h2>Third parties</h2>
	<ul>
		<li><b>Discord</b> supplies the data and is governed by its own <a href="https://discord.com/privacy" target="_blank" rel="noopener">privacy policy</a>.</li>
		<li><b>The hosting provider</b> runs the server and may keep infrastructure logs.</li>
		<li>Responses contain links to images on Discord's CDN and Spotify's CDN (<code>i.scdn.co</code>). Loading those images sends your request to them, not to this service.</li>
	</ul>

	<h2>Your choices</h2>
	<ul>
		<li><b>Stop presence sharing:</b> leave every server you share with the bot, or block the bot. It stops receiving your presence. A last-known status may linger in memory until the next restart.</li>
		<li><b>Delete your stored data:</b> run <code>/forget confirm:true</code> (or DM <code>.forget</code>) to delete your API key and every KV pair immediately. You can also delete single keys with <code>/kv delete</code>.</li>
		<li><b>Anything else</b> (questions, removal requests): contact us on <a href="${esc(INVITE_URL)}" target="_blank" rel="noopener">Discord</a>.</li>
	</ul>

	<h2>Children</h2>
	<p>The service only handles accounts that Discord itself allows to exist and is not directed at children. Discord's minimum age requirements apply.</p>

	<h2>Changes</h2>
	<p>If this policy changes, the date at the top will be updated.</p>`)

const requestOrigin = (c: { req: { header: (n: string) => string | undefined, url: string } }) => ({
	host: c.req.header('host') ?? new URL(c.req.url).host,
	proto: c.req.header('x-forwarded-proto') ?? 'https'
})

app.get('/', c => {
	const { host, proto } = requestOrigin(c)
	return c.html(renderDocs(host, proto))
})

app.get('/privacy', c => c.html(renderPrivacy(requestOrigin(c).host)))

app.get('/health', c => c.text('ok'))

/* ------------------------------------------------------------------ *
 * Lanyard-style REST + WebSocket routes
 * ------------------------------------------------------------------ */

app.use('/v1/*', async (c, next) => {
	await next()
	c.header('Access-Control-Allow-Origin', '*')
	c.header('Access-Control-Allow-Methods', 'GET, PUT, PATCH, DELETE, OPTIONS')
	c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
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

app.put('/v1/users/:id/kv/:key', async c => {
	const id = c.req.param('id')
	const denied = await requireAuth(c, id)
	if (denied) return denied

	const value = await c.req.text()
	const error = await kvSet(id, { [c.req.param('key')]: value })
	if (error) return c.json(apiError('invalid_kv', error), 400)

	return c.json({ success: true, data: null })
})

app.patch('/v1/users/:id/kv', async c => {
	const id = c.req.param('id')
	const denied = await requireAuth(c, id)
	if (denied) return denied

	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json(apiError('invalid_body', 'The body must be a JSON object'), 400)
	}

	if (!body || typeof body !== 'object' || Array.isArray(body))
		return c.json(apiError('invalid_body', 'The body must be a JSON object'), 400)

	const entries = newStore()
	for (const [key, value] of Object.entries(body)) {
		if (value === null || typeof value === 'object')
			return c.json(apiError('invalid_body', `"${key.slice(0, 50)}" must be a string, number or boolean (no nested objects)`), 400)
		entries[key] = String(value)
	}

	const error = await kvSet(id, entries)
	if (error) return c.json(apiError('invalid_kv', error), 400)

	return c.json({ success: true, data: null })
})

app.delete('/v1/users/:id/kv/:key', async c => {
	const id = c.req.param('id')
	const denied = await requireAuth(c, id)
	if (denied) return denied

	await kvDelete(id, c.req.param('key'))
	return c.json({ success: true, data: null })
})

app.get('/socket', c => {
	if (c.req.header('upgrade')?.toLowerCase() !== 'websocket')
		return c.json(apiError('upgrade_required', 'This endpoint requires a WebSocket connection'), 426)

	const compress = c.req.query('compression') === 'zlib_json'
	const { socket, response } = Deno.upgradeWebSocket(c.req.raw)

	let seq = 0
	let lastHeartbeat = Date.now()
	let heartbeatCheck: number | undefined
	let subscribedIds: string[] = []
	let subscribedAll = false

	// compression is async, queue sends so frames always go out in order
	let queue: Promise<void> = Promise.resolve()
	const sendRaw = (payload: unknown) => {
		queue = queue.then(async () => {
			if (socket.readyState !== WebSocket.OPEN) return
			const json = JSON.stringify(payload)
			socket.send(compress ? await zlib(json) : json)
		}).catch(err => console.error('Failed to send socket frame', err))
	}

	const subscriber: Subscriber = {
		send: (t, d) => sendRaw({ op: 0, seq: ++seq, t, d })
	}

	const clearSubscriptions = () => {
		for (const id of subscribedIds) unsubscribe(id, subscriber)
		subscribedIds = []

		if (subscribedAll) {
			globalSubscribers.delete(subscriber)
			subscribedAll = false
			if (!globalSubscribers.size) {
				for (const id of lastPayload.keys()) if (!subscribers.has(id)) lastPayload.delete(id)
			}
		}
	}

	const closeWith = (code: number, reason: string) => {
		if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
	}

	socket.onopen = () => {
		sendRaw({ op: 1, d: { heartbeat_interval: HEARTBEAT_INTERVAL } })
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

		if (message.op !== 2 && message.op !== 4) return closeWith(4004, 'unknown_opcode')
		if (!message.d || typeof message.d !== 'object') return closeWith(4005, 'requires_data_object')

		const d = message.d

		// Op 4: Unsubscribe
		if (message.op === 4) {
			if (d.unsubscribe_from_all === true) return clearSubscriptions()

			const ids = typeof d.unsubscribe_from_id === 'string' ? [d.unsubscribe_from_id] : d.unsubscribe_from_ids
			if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) return closeWith(4006, 'invalid_payload')

			// ids we aren't subscribed to are ignored
			for (const id of ids as string[]) {
				if (!subscribedIds.includes(id)) continue
				unsubscribe(id, subscriber)
				subscribedIds = subscribedIds.filter(sub => sub !== id)
			}
			return
		}

		// Op 2: Initialize, subscribe to everyone
		if (d.subscribe_to_all === true) {
			try {
				const results = await Promise.all([...presences.keys()].map(async id => {
					try {
						return [id, await buildPresence(id)] as const
					} catch (err) {
						console.error(err)
						return [id, null] as const
					}
				}))
				if (socket.readyState !== WebSocket.OPEN) return

				clearSubscriptions()
				globalSubscribers.add(subscriber)
				subscribedAll = true

				subscriber.send('INIT_STATE', Object.fromEntries(results.filter(([, presence]) => presence)))
			} catch (err) {
				console.error(err)
				closeWith(1011, 'internal_error')
			}
			return
		}

		// Op 2: Initialize, subscribe to one or more users
		const single = typeof d.subscribe_to_id === 'string'
		const ids = single ? [d.subscribe_to_id as string] : d.subscribe_to_ids

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

/* ------------------------------------------------------------------ *
 * Quicklinks: /:id.png and /banner/:id.png redirect to the Discord CDN
 * ------------------------------------------------------------------ */

const IMAGE_FILE = /^(\d{17,20})\.(png|gif|webp|jpg|jpeg)$/

const quicklink = async (c: Context, kind: 'avatar' | 'banner') => {
	const match = c.req.param('file').match(IMAGE_FILE)
	if (!match) return c.text('Not found', 404)
	const [, id, ext] = match

	let user: DiscordUser | null
	try {
		user = await getUser(id)
	} catch (err) {
		console.error(err)
		return c.json(apiError('discord_unavailable', 'Could not reach Discord, try again in a moment'), 502)
	}
	if (!user) return c.json(apiError('user_not_monitored', 'User is not being monitored by this server'), 404)

	const size = c.req.query('size')
	const query = size && /^\d{2,4}$/.test(size) ? `?size=${size}` : ''
	const hash = kind === 'avatar' ? user.avatar : user.banner

	c.header('Cache-Control', 'public, max-age=300')

	if (!hash) {
		if (kind === 'banner') return c.json(apiError('no_banner', 'This user does not have a banner'), 404)
		return c.redirect(`https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`)
	}

	return c.redirect(`https://cdn.discordapp.com/${kind}s/${id}/${hash}.${ext}${query}`)
}

app.get('/banner/:file{[0-9]+\\.[a-z]+}', c => quicklink(c, 'banner'))
app.get('/:file{[0-9]+\\.[a-z]+}', c => quicklink(c, 'avatar'))

/* ------------------------------------------------------------------ *
 * Badges
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Discord bot side: slash commands + DM text commands
 * ------------------------------------------------------------------ */

const STRING = 3
const SUB_COMMAND = 1
const BOOLEAN = 5

// contexts 0/1/2 = guild, bot DM, private channels. integration_types 0/1 = server install, user install
const commandContexts = { integration_types: [0, 1], contexts: [0, 1, 2] }

const commands = [
	{
		name: 'apikey',
		description: 'Get your API key for the KV store (only visible to you)',
		options: [{ type: BOOLEAN, name: 'regenerate', description: 'Generate a new key and invalidate the old one' }],
		...commandContexts
	},
	{
		name: 'kv',
		description: 'Manage your key-value store',
		options: [
			{
				type: SUB_COMMAND, name: 'set', description: 'Set a key',
				options: [
					{ type: STRING, name: 'key', description: 'Letters, numbers and underscores', required: true, max_length: 255 },
					{ type: STRING, name: 'value', description: 'The value to store', required: true, max_length: 6000 }
				]
			},
			{
				type: SUB_COMMAND, name: 'get', description: 'Read a key',
				options: [{ type: STRING, name: 'key', description: 'The key to read', required: true, max_length: 255 }]
			},
			{
				type: SUB_COMMAND, name: 'delete', description: 'Delete a key',
				options: [{ type: STRING, name: 'key', description: 'The key to delete', required: true, max_length: 255 }]
			},
			{ type: SUB_COMMAND, name: 'list', description: 'List your keys' }
		],
		...commandContexts
	},
	{
		name: 'forget',
		description: 'Delete your API key and all of your KV data',
		options: [{ type: BOOLEAN, name: 'confirm', description: 'Set to true to confirm', required: true }],
		...commandContexts
	}
]

const noMentions = { parse: [] as never[] }

const plain = (text: string) => text.replaceAll('```', "'''")

const cmdApiKey = async (id: string, regenerate = false) => {
	const key = regenerate ? await createApiKey(id) : await getOrCreateApiKey(id)
	return `Your API key, keep it secret:\n||\`${key}\`||\nSend it in the \`Authorization\` header of KV requests.${regenerate ? '\nThe old key no longer works.' : ''}`
}

const cmdSet = async (id: string, key: string, value: string) =>
	(await kvSet(id, { [key]: value })) ?? `Set \`${key}\`.`

const cmdGet = async (id: string, key: string) => {
	const store = await getKv(id)
	if (!(key in store)) return `There is no value for \`${key}\`.`
	return `\`${key}\`:\n\`\`\`\n${plain(store[key]).slice(0, 1800)}\n\`\`\``
}

const cmdDel = async (id: string, key: string) =>
	(await kvDelete(id, key)) ? `Deleted \`${key}\`.` : `There is no value for \`${key}\`.`

const cmdList = async (id: string) => {
	const keys = Object.keys(await getKv(id))
	if (!keys.length) return 'You have no keys yet. Use `/kv set` to add one.'
	return `You have ${keys.length}/${KV_MAX_PAIRS} keys:\n${keys.slice(0, 50).map(k => `\`${k}\``).join(', ')}${keys.length > 50 ? ', ...' : ''}`
}

const cmdForget = async (id: string) => {
	await forgetUser(id)
	return 'Done. Your API key and all KV data have been deleted.'
}

client.once(GatewayDispatchEvents.Ready, async e => {
	console.log('Ready!', e.data)

	try {
		await client.api.applicationCommands.bulkOverwriteGlobalCommands(e.data.application.id, commands as never)
		console.log('Registered slash commands')
	} catch (err) {
		console.error('Failed to register slash commands', err)
	}
})

type OptionValue = string | number | boolean | undefined
interface CommandOption { name: string, value?: OptionValue, options?: CommandOption[] }

client.on(GatewayDispatchEvents.InteractionCreate, async ({ data: interaction, api }) => {
	if (interaction.type !== InteractionType.ApplicationCommand) return

	const userId = (interaction.member?.user ?? interaction.user)?.id
	if (!userId) return

	const data = interaction.data as unknown as { name: string, options?: CommandOption[] }
	let content = ''

	try {
		if (data.name === 'apikey') {
			content = await cmdApiKey(userId, data.options?.find(o => o.name === 'regenerate')?.value === true)
		} else if (data.name === 'forget') {
			content = data.options?.find(o => o.name === 'confirm')?.value === true
				? await cmdForget(userId)
				: 'Nothing was deleted. Run `/forget` with `confirm` set to true to delete your API key and all KV data.'
		} else if (data.name === 'kv') {
			const sub = data.options?.[0]
			const opt = (name: string) => String(sub?.options?.find(o => o.name === name)?.value ?? '')

			if (sub?.name === 'set') content = await cmdSet(userId, opt('key'), opt('value'))
			else if (sub?.name === 'get') content = await cmdGet(userId, opt('key'))
			else if (sub?.name === 'delete') content = await cmdDel(userId, opt('key'))
			else if (sub?.name === 'list') content = await cmdList(userId)
			else return
		} else {
			return
		}
	} catch (err) {
		console.error(err)
		content = 'Something went wrong, try again in a moment.'
	}

	try {
		await api.interactions.reply(interaction.id, interaction.token, {
			content,
			flags: MessageFlags.Ephemeral,
			allowed_mentions: noMentions
		})
	} catch (err) {
		console.error('Failed to reply to interaction', err)
	}
})

// Lanyard-compatible text commands, DMs only: .apikey .set .get .del .list .forget
client.on(GatewayDispatchEvents.MessageCreate, async ({ data: message, api }) => {
	if (message.author.bot || message.guild_id) return

	const text = message.content.trim()
	if (!text.startsWith('.')) return

	const userId = message.author.id
	const [cmd] = text.split(/\s+/)
	let content: string | undefined

	try {
		if (cmd === '.apikey') {
			content = await cmdApiKey(userId)
		} else if (cmd === '.set') {
			const m = text.match(/^\.set\s+(\S+)\s+([\s\S]+)$/)
			content = m ? await cmdSet(userId, m[1], m[2]) : 'Usage: `.set <key> <value>`'
		} else if (cmd === '.get') {
			const m = text.match(/^\.get\s+(\S+)/)
			content = m ? await cmdGet(userId, m[1]) : 'Usage: `.get <key>`'
		} else if (cmd === '.del') {
			const m = text.match(/^\.del\s+(\S+)/)
			content = m ? await cmdDel(userId, m[1]) : 'Usage: `.del <key>`'
		} else if (cmd === '.list') {
			content = await cmdList(userId)
		} else if (cmd === '.forget') {
			content = await cmdForget(userId)
		}
	} catch (err) {
		console.error(err)
		content = 'Something went wrong, try again in a moment.'
	}

	if (!content) return

	try {
		await api.channels.createMessage(message.channel_id, { content, allowed_mentions: noMentions })
	} catch (err) {
		console.error('Failed to reply to message', err)
	}
})

gateway.connect()

// Render provides PORT; falls back to 8000 locally
Deno.serve({ port: +(env.PORT ?? 8000) }, app.fetch)
