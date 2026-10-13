import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.js'),
      name: 'PufferPanel',
      fileName: (format) => format === 'es' ? 'pufferpanel.mjs' : 'pufferpanel.cjs'
    },
    minify: false,
    rolldownOptions: {
      external: ['axios'],
      output: {
        globals: {
          axios: 'axios'
        }
      }
    }
  }
})
