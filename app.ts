// Reads from real environment variables (Render, Docker, shell).
// Locally you can run: deno run -A --env app.ts   (loads a .env file)
const env = Deno.env.toObject()

if (!env.TOKEN) throw new Error('Missing TOKEN environment variable')

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

const app = new Hono()

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

const renderDocs = (base: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#5865f2">
<title>Badges Docs</title>
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
	code.endpoint { display: block; padding: 10px 14px; margin: 0 0 12px; background: #1d2026; border-radius: 6px; color: #8f9bff; overflow-x: auto; white-space: nowrap; }
	.table-wrap { overflow-x: auto; }
	table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
	th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2b2f36; vertical-align: top; }
	th { color: #aab0b8; font-weight: 600; }
	td:first-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
	<h1>Docs</h1>
	<p>Badges showing what you're doing on Discord. Replace <code>:id</code> in each endpoint with your Discord user ID. The bot has to share a server with you for presence to show up.</p>
	<p>Badges are generated with <a href="https://shields.io" target="_blank" rel="noopener">Shields.io</a>'s badge-maker library, so the query params follow the Shields format.</p>
	<p>All query params are optional. Logos only display on the flat, flat-square, and plastic styles.</p>

	<h2>Badges</h2>
	${docSections.map(s => `
	<h3>${s.title}</h3>
	<code class="endpoint">${base}${s.path}</code>
	<p>Query Params</p>
	<div class="table-wrap">
	<table>
		<thead><tr><th>Param</th><th>Description</th><th>Default</th></tr></thead>
		<tbody>
			${s.params.map(([name, desc, def]) => `<tr><td>${name}</td><td>${desc}</td><td>${def}</td></tr>`).join('\n\t\t\t')}
		</tbody>
	</table>
	</div>`).join('\n')}

	<h2>Open Spotify</h2>
	<code class="endpoint">${base}/openspotify/:id</code>
	<p>Redirects to the track page of the song you're listening to on Spotify.</p>

	<h2>Presence</h2>
	<code class="endpoint">${base}/presence/:id</code>
	<p>Returns a JSON object of your presence so you can integrate it another way.</p>
</main>
</body>
</html>`

app.get('/', c => {
	const host = c.req.header('host') ?? new URL(c.req.url).host
	const proto = c.req.header('x-forwarded-proto') ?? 'https'
	return c.html(renderDocs(`${proto}://${host}`))
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
