// Lightweight liveness probe for the Docker HEALTHCHECK (and external monitors
// such as uptime-kuma). It deliberately does NOT touch Postgres / Redis / the
// model services: its job is to catch a WEDGED Node event loop — a blocked loop
// cannot serve this request, so the healthcheck times out and the container flips
// to `unhealthy` (visible in `docker ps`, scrapeable by a monitor) instead of
// reporting `running` while serving nothing. Coupling it to a dependency would
// flap the whole app unhealthy on a transient dependency blip and risk restart
// storms, so liveness and dependency-health are kept separate.
export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json(
    { status: 'ok', ts: Date.now() },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
