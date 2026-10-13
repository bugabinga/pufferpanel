import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        Blob: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        File: 'readonly',
        FormData: 'readonly',
        Promise: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        TextDecoder: 'readonly',
        Uint8Array: 'readonly',
        WebSocket: 'readonly',
        window: 'readonly'
      }
    }
  },
  prettier
]
