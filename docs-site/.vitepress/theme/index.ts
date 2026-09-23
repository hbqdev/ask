import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'

import ApiRoutes from './components/ApiRoutes.vue'
import ComposeServices from './components/ComposeServices.vue'
import DbSchema from './components/DbSchema.vue'
import EnvFlags from './components/EnvFlags.vue'
import SystemMap from './components/SystemMap.vue'
import TurnWalkthrough from './components/TurnWalkthrough.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('EnvFlags', EnvFlags)
    app.component('ApiRoutes', ApiRoutes)
    app.component('DbSchema', DbSchema)
    app.component('ComposeServices', ComposeServices)
    app.component('SystemMap', SystemMap)
    app.component('TurnWalkthrough', TurnWalkthrough)
  }
} satisfies Theme
