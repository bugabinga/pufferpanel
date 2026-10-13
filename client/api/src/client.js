import ax from 'axios'
import { InMemorySessionStore } from './sessionStore.js'
import { AuthApi } from './auth.js'
import { SelfApi } from './self.js'
import { UserApi } from './users.js'
import { NodeApi } from './nodes.js'
import { ServerApi } from './servers.js'
import { TemplateApi } from './templates.js'
import { SettingsApi } from './settings.js'

export class ApiClient {
  _axios = null
  _host = null
  _errorHandler = null
  auth = null
  self = null
  server = null
  node = null
  user = null
  template = null

  constructor(
    host,
    sessionStore = new InMemorySessionStore(),
    errorHandler,
    axios = ax.create()
  ) {
    this._axios = axios
    this._host = host
    this._errorHandler = errorHandler
    this.auth = new AuthApi(this, sessionStore)
    this.self = new SelfApi(this)
    this.server = new ServerApi(this)
    this.node = new NodeApi(this)
    this.user = new UserApi(this)
    this.template = new TemplateApi(this)
    this.settings = new SettingsApi(this)
  }

  _handleError(e) {
    console.error(e)
    const status = ((e || {}).response || {}).status
    const statusText = ((e || {}).response || {}).statusText
    const response = ((e || {}).response || {}).data
    const request = (e || {}).config
    let code = 'ErrUnknownError'
    let msg
    const error = (((e || {}).response || {}).data || {}).error
    if ((error || {}).code) code = error.code
    if ((error || {}).msg) msg = error.msg
    const result = { status, statusText, response, request, code, msg }
    if (this._errorHandler) this._errorHandler(
      result
    )
    throw result
  }

  _handleRequestError(e, options) {
    if (typeof options.onError === 'function') {
      const res = options.onError(e)
      if (res) return res
    }
    const status = ((e || {}).response || {}).status
    if (!Array.isArray(options.unhandledErrors) || options.unhandledErrors.indexOf(status) === -1) this._handleError(e)
  }

  _enhanceHeaders(headers) {
    const token = this.auth.getToken()
    if (token) {
      return {
        ...headers,
        Authorization: 'Bearer ' + token
      }
    }
    return headers
  }

  async head(url, params = {}, headers = {}, options = {}) {
    try {
      return await this._axios.head(this._host + url, { params, ...options, headers: this._enhanceHeaders(headers) })
    } catch (e) {
      return this._handleRequestError(e, options)
    }
  }

  async get(url, params = {}, headers = {}, options = {}) {
    try {
      return await this._axios.get(this._host + url, { params, ...options, headers: this._enhanceHeaders(headers) })
    } catch (e) {
      return this._handleRequestError(e, options)
    }
  }

  async post(url, data, params = {}, headers = {}, options = {}) {
    try {
      return await this._axios.post(this._host + url, data, { params, ...options, headers: this._enhanceHeaders(headers) })
    } catch (e) {
      return this._handleRequestError(e, options)
    }
  }

  async put(url, data, params = {}, headers = {}, options = {}) {
    try {
      return await this._axios.put(this._host + url, data, { params, ...options, headers: this._enhanceHeaders(headers) })
    } catch (e) {
      return this._handleRequestError(e, options)
    }
  }

  async delete(url, params = {}, headers = {}, options = {}) {
    try {
      return await this._axios.delete(this._host + url, { params, ...options, headers: this._enhanceHeaders(headers) })
    } catch (e) {
      return this._handleRequestError(e, options)
    }
  }

  async getConfig() {
    const res = await this.get('/api/config')
    return res.data
  }

  async getTheme(name) {
    const res = await this.get(
      `/theme/${name}.tar`,
      undefined,
      undefined,
      { responseType: 'arraybuffer' }
    )
    return res.data
  }
}
