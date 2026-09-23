// `bun run gen` — regenerate every code-derived data file in docs-site/data/.
import { generateApiRoutes } from './api-routes'
import { composeFiles, generateCompose } from './compose'
import { generateDbSchema } from './db-schema'
import { generateEnv } from './env'
import { writeJson } from './lib'

const t0 = performance.now()
const env = generateEnv(composeFiles())
writeJson('env.json', env)
const api = generateApiRoutes()
writeJson('api-routes.json', api)
const compose = generateCompose()
writeJson('compose-services.json', compose)
let db: Awaited<ReturnType<typeof generateDbSchema>> | null = null
try {
  db = await generateDbSchema()
  writeJson('db-schema.json', db)
} catch (err) {
  console.error('[gen] db-schema failed:', err)
  process.exitCode = 1
}
console.log(
  `[gen] env=${env.count} routes=${api.count} compose-files=${compose.files.length} ` +
    `services=${compose.files.reduce((n, f) => n + f.services.length, 0)} ` +
    `tables=${db?.count ?? 'ERR'} (${Math.round(performance.now() - t0)}ms)`
)
