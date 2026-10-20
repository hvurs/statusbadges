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

/** a piece of text that the page script swaps for the visitor's Discord ID */
const uid = (placeholder = ':id') => `<span class="uid" data-ph="${placeholder}">${placeholder}</span>`

const code = (text: string) =>
	`<pre><code>${esc(text).replaceAll('YOUR_ID', uid('YOUR_ID'))}</code></pre>`

const endpoint = (method: string, base: string, path: string) =>
	`<div class="endpoint"><span class="method ${method.toLowerCase()}">${method}</span><code>${esc(base)}${esc(path).replace(':id', uid())}</code></div>`

const paramTable = (heads: string[], rows: string[][]) => `
<div class="table-wrap"><table>
	<thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead>
	<tbody>${rows.map(r => `<tr>${r.map((cell, i) => `<td>${i === 0 ? `<code>${cell}</code>` : cell}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`

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

	const errorSample = JSON.stringify({
		success: false,
		error: { code: 'user_not_monitored', message: 'User is not being monitored by this server' }
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

	const toc: [string, string][] = [
		['start', 'Getting started'],
		['rest', 'REST API'],
		['websocket', 'WebSocket'],
		['badges', 'Badges'],
		['extras', 'Extras']
	]

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#5865f2">
<meta name="description" content="Your Discord presence as an API: REST, WebSocket and README badges.">
<title>${esc(SITE_NAME)} · Docs</title>
<link
	rel="icon"
	type="image/png"
	href="https://i.ibb.co/9P55Z60/image.png"
/>
<style>
	:root {
		color-scheme: dark;
		--bg: #0e1014;
		--surface: #151821;
		--surface-2: #1b1f2a;
		--border: #262b37;
		--text: #e8eaee;
		--muted: #98a0ae;
		--accent: #5865f2;
		--accent-soft: #8f9bff;
		--green: #3ba55d;
		--radius: 12px;
		--mono: ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace;
	}
	* { box-sizing: border-box; }
	html { scroll-behavior: smooth; scroll-padding-top: 88px; }
	body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
	a { color: var(--accent-soft); text-decoration: none; }
	a:hover { text-decoration: underline; }
	code { font-family: var(--mono); font-size: 0.88em; }
	p { margin: 0 0 14px; color: #c9cdd6; }

	/* nav */
	.nav { position: sticky; top: 0; z-index: 10; backdrop-filter: blur(12px); background: rgba(14, 16, 20, 0.78); border-bottom: 1px solid var(--border); }
	.nav-inner { max-width: 1120px; margin: 0 auto; padding: 0 20px; height: 60px; display: flex; align-items: center; gap: 24px; }
	.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; color: var(--text); }
	.brand img { width: 26px; height: 26px; border-radius: 7px; }
	.nav-links { display: flex; gap: 20px; margin-left: auto; font-size: 0.93rem; }
	.nav-links a { color: var(--muted); }
	.nav-links a:hover { color: var(--text); text-decoration: none; }
	.btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; font-size: 0.93rem; }
	.btn:hover { background: #4752c4; text-decoration: none; }

	/* hero */
	.hero { position: relative; overflow: hidden; text-align: center; padding: 84px 20px 64px; border-bottom: 1px solid var(--border); }
	.hero::before { content: ''; position: absolute; inset: -40% -10% auto; height: 520px; background: radial-gradient(closest-side, rgba(88, 101, 242, 0.28), transparent); pointer-events: none; }
	.hero > * { position: relative; }
	.eyebrow { display: inline-block; padding: 4px 12px; margin-bottom: 18px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--accent-soft); font-size: 0.8rem; font-weight: 600; letter-spacing: 0.04em; }
	.hero h1 { margin: 0 auto 16px; max-width: 760px; font-size: clamp(2.1rem, 5vw, 3.4rem); line-height: 1.12; letter-spacing: -0.02em; }
	.hero h1 em { font-style: normal; color: var(--accent-soft); }
	.hero p.lead { max-width: 620px; margin: 0 auto 28px; font-size: 1.1rem; color: var(--muted); }
	.try { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; max-width: 520px; margin: 0 auto; }
	.try input { flex: 1 1 280px; padding: 12px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: 0.95rem var(--mono); outline: none; }
	.try input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(88, 101, 242, 0.25); }
	.hint { margin: 12px 0 0; font-size: 0.85rem; color: var(--muted); }

	/* layout */
	.layout { max-width: 1120px; margin: 0 auto; padding: 0 20px; display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 56px; }
	.toc { position: sticky; top: 88px; align-self: start; padding: 40px 0; display: flex; flex-direction: column; gap: 2px; }
	.toc span { margin-bottom: 8px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
	.toc a { padding: 6px 12px; border-left: 2px solid var(--border); color: var(--muted); font-size: 0.93rem; }
	.toc a:hover { color: var(--text); text-decoration: none; }
	.toc a.active { color: var(--text); border-left-color: var(--accent); }
	main { padding: 24px 0 96px; min-width: 0; }
	section { padding-top: 40px; }
	h2 { margin: 0 0 6px; font-size: 1.8rem; letter-spacing: -0.01em; }
	h3 { margin: 0 0 10px; font-size: 1.15rem; }
	h4 { margin: 28px 0 10px; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
	.sub { margin-bottom: 22px; color: var(--muted); }

	/* steps */
	.steps { display: grid; gap: 12px; padding: 0; margin: 0 0 8px; list-style: none; counter-reset: step; }
	.steps li { counter-increment: step; position: relative; padding: 16px 18px 16px 62px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: #c9cdd6; }
	.steps li::before { content: counter(step); position: absolute; left: 18px; top: 16px; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: rgba(88, 101, 242, 0.18); color: var(--accent-soft); font-weight: 700; font-size: 0.9rem; }
	.steps strong { color: var(--text); }
	.note { padding: 12px 16px; margin: 16px 0; border: 1px solid rgba(88, 101, 242, 0.35); border-radius: 10px; background: rgba(88, 101, 242, 0.08); color: #c9cdd6; font-size: 0.93rem; }

	/* endpoints + code */
	.endpoint { position: relative; display: flex; align-items: center; gap: 12px; margin: 0 0 14px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); overflow-x: auto; }
	.endpoint code { white-space: nowrap; color: var(--text); padding-right: 64px; }
	.method { flex: none; padding: 2px 9px; border-radius: 6px; font: 700 0.72rem var(--mono); letter-spacing: 0.04em; background: rgba(59, 165, 93, 0.16); color: #57d37f; }
	.method.ws { background: rgba(88, 101, 242, 0.2); color: var(--accent-soft); }
	pre { position: relative; margin: 0 0 16px; padding: 18px; border: 1px solid var(--border); border-radius: var(--radius); background: #0a0c10; overflow-x: auto; line-height: 1.55; }
	pre code { color: #d5d9e2; font-size: 0.85rem; }
	.copy { position: absolute; top: 8px; right: 8px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--muted); font: 600 0.72rem inherit; cursor: pointer; }
	.copy:hover { color: var(--text); border-color: #3a4152; }
	.uid { color: var(--accent-soft); }

	/* tables */
	.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); margin-bottom: 14px; }
	table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
	th, td { padding: 10px 16px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
	tr:last-child td { border-bottom: 0; }
	th { color: var(--muted); font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; background: var(--surface-2); }
	td { color: #c9cdd6; }
	td code { color: var(--accent-soft); }

	/* badges */
	.badge-card { margin-bottom: 18px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
	.badge-card .endpoint { background: var(--bg); }
	.badge-card .table-wrap { margin: 0; background: transparent; }
	.badge-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
	.badge-head h3 { margin: 0; }
	.badge-head img { display: block; max-width: 100%; }
	.live-note { color: var(--muted); font-size: 0.85rem; }

	footer { padding: 28px 20px 40px; border-top: 1px solid var(--border); text-align: center; color: var(--muted); font-size: 0.85rem; }

	@media (max-width: 900px) {
		.layout { grid-template-columns: minmax(0, 1fr); }
		.toc { display: none; }
		.nav-links a:not(.btn) { display: none; }
		.hero { padding-top: 56px; }
	}
</style>
</head>
<body>
<header class="nav">
	<div class="nav-inner">
		<a class="brand" href="/"><img src="https://i.ibb.co/9P55Z60/image.png" alt="">${esc(SITE_NAME)}</a>
		<nav class="nav-links">
			<a href="#rest">REST</a>
			<a href="#websocket">WebSocket</a>
			<a href="#badges">Badges</a>
			${INVITE_URL ? `<a class="btn" href="${esc(INVITE_URL)}" target="_blank" rel="noopener">Join the server</a>` : ''}
		</nav>
	</div>
</header>

<section class="hero">
	<span class="eyebrow">REST · WEBSOCKET · BADGES</span>
	<h1>Your Discord presence, <em>as an API.</em></h1>
	<p class="lead">Real-time status, activities and Spotify over REST and WebSocket, plus shields-style badges for your README.</p>
	<div class="try">
		<input id="uid-input" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="Paste your Discord user ID to personalise the docs" aria-label="Discord user ID">
	</div>
	<p class="hint">Only used in your browser to fill in the examples and live badges below.</p>
</section>

<div class="layout">
	<aside class="toc">
		<span>On this page</span>
		${toc.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('\n\t\t')}
	</aside>

	<main>
		<section id="start">
			<h2>Getting started</h2>
			<p class="sub">Three steps and you're live.</p>
			<ol class="steps">
				<li><strong>Share a server with the bot.</strong> ${INVITE_URL
					? `Join <a href="${esc(INVITE_URL)}" target="_blank" rel="noopener">the server</a> so the bot can see your presence.`
					: 'The bot can only see your presence in servers it is in. If you are not in one together, you will always show as offline.'}</li>
				<li><strong>Copy your user ID.</strong> In Discord, turn on Developer Mode (Settings → Advanced), then right-click your profile and choose Copy User ID.</li>
				<li><strong>Call an endpoint.</strong> Replace <code>:id</code> with your ID in any endpoint below, or paste it in the box at the top and every example fills itself in.</li>
			</ol>
		</section>

		<section id="rest">
			<h2>REST API</h2>
			<p class="sub">Fetch a user's presence with a single request. CORS is enabled for all origins.</p>
			${endpoint('GET', base, '/v1/users/:id')}
			${code(restSample)}
			<h4>Response fields</h4>
			${paramTable(['Field', 'Type', 'Description'], responseFields.map(([f, t, d]) => [f, t, d]))}
			<h4>Errors</h4>
			<p>Failed requests return <code>success: false</code> with an HTTP status code. An unknown Discord user ID returns <code>404 user_not_monitored</code>, a malformed ID returns <code>400 invalid_user_id</code>.</p>
			${code(errorSample)}
		</section>

		<section id="websocket">
			<h2>WebSocket</h2>
			<p class="sub">Subscribe once and get pushed an update every time a presence changes.</p>
			${endpoint('WS', wsBase, '/socket')}
			<div class="note">The socket speaks the same protocol as Lanyard, so existing Lanyard clients and libraries work by pointing them at this URL.</div>
			${paramTable(['Op', 'Name', 'Direction · description'], [
				['0', 'Event', 'Server → client. Carries <code>t</code> (event name), <code>d</code> (data) and <code>seq</code>.'],
				['1', 'Hello', 'Server → client. Sent on connect with <code>d.heartbeat_interval</code> in milliseconds.'],
				['2', 'Initialize', 'Client → server. Subscribe with <code>{ subscribe_to_id }</code> or <code>{ subscribe_to_ids: [...] }</code> (up to 50 IDs).'],
				['3', 'Heartbeat', 'Client → server. Send one every <code>heartbeat_interval</code> ms or the connection is closed.']
			])}
			<h4>Events</h4>
			${paramTable(['Event', 'Description'], [
				['INIT_STATE', 'Sent right after Initialize. With <code>subscribe_to_id</code> <code>d</code> is the presence object, with <code>subscribe_to_ids</code> it is a map of user ID → presence.'],
				['PRESENCE_UPDATE', 'Sent whenever a subscribed user changes status or activity. <code>d</code> is the full presence object.']
			])}
			<h4>Example</h4>
			${code(wsSample)}
			<h4>Close codes</h4>
			${paramTable(['Code', 'Reason'], [
				['4004', 'unknown_opcode'],
				['4005', 'requires_data_object'],
				['4006', 'invalid_payload (bad JSON, bad IDs, or more than 50 IDs)'],
				['4007', 'user_not_monitored'],
				['4008', 'heartbeat_timeout']
			])}
		</section>

		<section id="badges">
			<h2>Badges</h2>
			<p class="sub">Shields-style SVG badges for READMEs and profiles. All query params are optional, and logos only show on the flat, flat-square and plastic styles.</p>
			<p class="live-note" hidden>Enter your Discord ID at the top of the page to see live previews.</p>
			${code(`![status](${base}/badge/status/YOUR_ID)\n![spotify](${base}/badge/spotify/YOUR_ID?style=for-the-badge)`)}
			${docSections.map(s => `
			<div class="badge-card">
				<div class="badge-head">
					<h3>${s.title}</h3>
					<img class="live" data-src="${s.path}" alt="${s.title} badge" hidden>
				</div>
				${endpoint('GET', base, s.path)}
				${paramTable(['Param', 'Description', 'Default'], s.params)}
			</div>`).join('\n')}
		</section>

		<section id="extras">
			<h2>Extras</h2>
			<p class="sub">A couple of extra endpoints that come with the badges.</p>
			<h3>Open Spotify</h3>
			${endpoint('GET', base, '/openspotify/:id')}
			<p>Redirects to the track page of the song the user is listening to on Spotify.</p>
			<h3>Raw presence</h3>
			${endpoint('GET', base, '/presence/:id')}
			<p>Returns the raw presence object straight from Discord's gateway, without the Lanyard-style wrapping.</p>
		</section>
	</main>
</div>

<footer>${esc(SITE_NAME)} · Presence comes from Discord, so you only appear while the bot shares a server with you.</footer>

<script>
(function () {
	var input = document.getElementById('uid-input')
	var re = /^[0-9]{17,20}$/

	function apply() {
		var v = input.value.trim()
		var ok = re.test(v)
		document.querySelectorAll('.uid').forEach(function (el) {
			el.textContent = ok ? v : el.getAttribute('data-ph')
		})
		document.querySelectorAll('img.live').forEach(function (img) {
			if (ok) {
				img.src = img.getAttribute('data-src').replace(':id', v)
				img.hidden = false
			} else {
				img.hidden = true
				img.removeAttribute('src')
			}
		})
		document.querySelectorAll('.live-note').forEach(function (n) { n.hidden = ok })
		try { if (ok) localStorage.setItem('uid', v) } catch (e) {}
	}

	try { var saved = localStorage.getItem('uid'); if (saved) input.value = saved } catch (e) {}
	input.addEventListener('input', apply)
	apply()

	document.querySelectorAll('pre, .endpoint').forEach(function (el) {
		if (!navigator.clipboard) return
		var b = document.createElement('button')
		b.className = 'copy'
		b.type = 'button'
		b.textContent = 'Copy'
		b.addEventListener('click', function () {
			var c = el.querySelector('code')
			navigator.clipboard.writeText((c || el).textContent).then(function () {
				b.textContent = 'Copied'
				setTimeout(function () { b.textContent = 'Copy' }, 1200)
			})
		})
		el.appendChild(b)
	})

	var links = document.querySelectorAll('.toc a')
	var byId = {}
	links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a })
	var io = new IntersectionObserver(function (entries) {
		entries.forEach(function (e) {
			if (!e.isIntersecting || !byId[e.target.id]) return
			links.forEach(function (l) { l.classList.remove('active') })
			byId[e.target.id].classList.add('active')
		})
	}, { rootMargin: '-20% 0px -70% 0px' })
	document.querySelectorAll('main section[id]').forEach(function (s) { io.observe(s) })
})()
</script>
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
