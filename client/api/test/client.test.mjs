import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { ApiClient } from '../src/client.js'
import { InMemorySessionStore } from '../src/sessionStore.js'
import { ServerApi } from '../src/servers.js'

function makeAxios(implementation = {}) {
  const calls = []
  const axios = Object.fromEntries(['head', 'get', 'post', 'put', 'delete'].map(method => [
    method,
    async (...args) => {
      calls.push({ method, args })
      return implementation[method] ? implementation[method](...args) : { data: null }
    }
  ]))
  return { axios, calls }
}

function makeClient(axios, sessionStore = new InMemorySessionStore(), errorHandler) {
  return new ApiClient('https://panel.example', sessionStore, errorHandler, axios)
}

const requestMethods = [
  ['head', (client, options) => client.head('/request', undefined, undefined, options)],
  ['get', (client, options) => client.get('/request', undefined, undefined, options)],
  ['post', (client, options) => client.post('/request', undefined, undefined, undefined, options)],
  ['put', (client, options) => client.put('/request', undefined, undefined, undefined, options)],
  ['delete', (client, options) => client.delete('/request', undefined, undefined, options)]
]

afterEach(() => mock.restoreAll())

describe('ApiClient HTTP methods', () => {
  it('preserves each verb signature, Axios options, and bearer auth', async () => {
    const { axios, calls } = makeAxios()
    const store = new InMemorySessionStore()
    store.setToken('secret-token')
    const client = makeClient(axios, store)
    const headers = { 'X-Test': 'yes' }
    const options = { timeout: 1250, responseType: 'arraybuffer' }

    await client.head('/head', { page: 1 }, headers, options)
    await client.get('/get', { page: 2 }, headers, options)
    await client.post('/post', { body: true }, { page: 3 }, headers, options)
    await client.put('/put', { body: false }, { page: 4 }, headers, options)
    await client.delete('/delete', { page: 5 }, headers, options)

    assert.deepEqual(calls, [
      { method: 'head', args: ['https://panel.example/head', { params: { page: 1 }, ...options, headers: { ...headers, Authorization: 'Bearer secret-token' } }] },
      { method: 'get', args: ['https://panel.example/get', { params: { page: 2 }, ...options, headers: { ...headers, Authorization: 'Bearer secret-token' } }] },
      { method: 'post', args: ['https://panel.example/post', { body: true }, { params: { page: 3 }, ...options, headers: { ...headers, Authorization: 'Bearer secret-token' } }] },
      { method: 'put', args: ['https://panel.example/put', { body: false }, { params: { page: 4 }, ...options, headers: { ...headers, Authorization: 'Bearer secret-token' } }] },
      { method: 'delete', args: ['https://panel.example/delete', { params: { page: 5 }, ...options, headers: { ...headers, Authorization: 'Bearer secret-token' } }] }
    ])
    assert.deepEqual(headers, { 'X-Test': 'yes' })
  })

  it('preserves callbacks, unhandled status behavior, and response error shape', async () => {
    const networkResponse = { status: 422, statusText: 'Unprocessable Entity', data: { error: { code: 'ErrInvalid', msg: 'invalid' } } }
    const responseError = Object.assign(new Error('request failed'), { response: networkResponse, config: { url: '/bad' } })
    const { axios } = makeAxios({ get: () => Promise.reject(responseError) })
    const callbackResults = []
    const client = makeClient(axios, undefined, error => callbackResults.push(error))
    const log = mock.method(console, 'error', () => {})

    await assert.rejects(client.get('/bad'), error => {
      assert.deepEqual(error, {
        status: 422,
        statusText: 'Unprocessable Entity',
        response: networkResponse.data,
        request: responseError.config,
        code: 'ErrInvalid',
        msg: 'invalid'
      })
      return true
    })
    assert.deepEqual(callbackResults, [{
      status: 422,
      statusText: 'Unprocessable Entity',
      response: networkResponse.data,
      request: responseError.config,
      code: 'ErrInvalid',
      msg: 'invalid'
    }])

    assert.equal(log.mock.callCount(), 1)
  })

  for (const [method, request] of requestMethods) {
    it(`passes through configured unhandled status callback for ${method}`, async () => {
      const responseError = Object.assign(new Error('not found'), { response: { status: 404 } })
      const { axios } = makeAxios({ [method]: () => Promise.reject(responseError) })
      const client = makeClient(axios)
      let callbackError
      const result = await request(client, {
        unhandledErrors: [404],
        onError: error => { callbackError = error }
      })
      assert.equal(result, undefined)
      assert.equal(callbackError, responseError)

      const recovered = await request(client, {
        unhandledErrors: [404],
        onError: error => {
          assert.equal(error, responseError)
          return { recovered: true }
        }
      })
      assert.deepEqual(recovered, { recovered: true })
    })
  }

  for (const [method, request] of requestMethods) {
    it(`normalizes response-less ${method} failures without replacing them with TypeError`, async () => {
      const requestConfig = { url: 'https://panel.example/offline' }
      const networkError = Object.assign(new Error('offline'), { config: requestConfig })
      const { axios } = makeAxios({ [method]: () => Promise.reject(networkError) })
      const errors = []
      const client = makeClient(axios, undefined, error => errors.push(error))
      const expected = {
        status: undefined,
        statusText: undefined,
        response: undefined,
        request: requestConfig,
        code: 'ErrUnknownError',
        msg: undefined
      }
      mock.method(console, 'error', () => {})

      await assert.rejects(request(client, { unhandledErrors: [404] }), error => {
        assert.deepEqual(error, expected)
        assert.equal(error instanceof TypeError, false)
        return true
      })
      assert.deepEqual(errors, [expected])
    })
  }

  it('propagates errors thrown by unhandled status callbacks', async () => {
    const responseError = Object.assign(new Error('not found'), { response: { status: 404 } })
    const callbackError = new Error('callback failed')
    const { axios } = makeAxios({ get: () => Promise.reject(responseError) })
    const client = makeClient(axios)

    await assert.rejects(client.get('/missing', undefined, undefined, {
      unhandledErrors: [404],
      onError: () => { throw callbackError }
    }), callbackError)
  })

  it('updates session scopes on reauth and sends bearer token from current session', async () => {
    const store = new InMemorySessionStore()
    store.setToken('old-token')
    const { axios, calls } = makeAxios({
      post: async () => ({ status: 200, data: { scopes: ['server.read'] } }),
      get: async () => ({ data: {} })
    })
    const client = makeClient(axios, store)
    await client.auth.reauth()
    assert.equal(client.auth.hasScope('server.read'), true)
    store.setToken('new-token')
    await client.get('/session-check')
    assert.equal(calls[1].args[1].headers.Authorization, 'Bearer new-token')
  })
})

describe('ServerApi file handling', () => {
  it('returns false for file 404 and handles network failures through the API error path', async () => {
    const notFound = Object.assign(new Error('missing'), { response: { status: 404 } })
    const networkError = Object.assign(new Error('offline'), { config: { url: 'file' } })
    const api = {
      _host: 'https://panel.example',
      _axios: { get: async () => { throw notFound } },
      _handleError: error => { throw error }
    }
    const server = new ServerApi(api)
    assert.equal(await server.fileExists('sid', '/missing'), false)

    api._axios.get = async () => { throw networkError }
    await assert.rejects(server.fileExists('sid', '/offline'), error => {
      assert.equal(error, networkError)
      assert.equal(error instanceof TypeError, false)
      return true
    })
  })

  it('sends normalized archive paths without mutating caller arrays', async () => {
    const calls = []
    const api = { post: async (...args) => { calls.push(args) } }
    const server = new ServerApi(api)
    const files = ['/one.txt', 'two.txt', '/nested/three.txt']
    const original = [...files]

    assert.equal(await server.archiveFile('sid', '/bundle.tar', files), true)
    assert.equal(await server.archiveFile('sid', '/single.txt', '/one.txt'), true)
    assert.equal(await server.archiveFile('sid', '/empty.tar', []), true)
    assert.deepEqual(calls, [
      ['/api/servers/sid/archive/bundle.tar', ['one.txt', 'two.txt', 'nested/three.txt']],
      ['/api/servers/sid/archive/single.txt', ['one.txt']],
      ['/api/servers/sid/archive/empty.tar', []]
    ])
    assert.deepEqual(files, original)
  })
})
