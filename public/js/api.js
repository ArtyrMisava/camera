async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => ({})) : {};

  if (!response.ok) {
    const error = new Error(payload.error || `Ошибка запроса (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  session: () => request('/api/session'),
  setup: (body) => request('/api/setup', { method: 'POST', body }),
  login: (body) => request('/api/login', { method: 'POST', body }),
  logout: () => request('/api/logout', { method: 'POST' }),

  cameras: () => request('/api/cameras'),
  status: () => request('/api/status'),
  startStream: (id, { quality = 'main', stream } = {}) =>
    request(`/api/stream/${encodeURIComponent(id)}/start?quality=${quality}${stream !== undefined ? `&stream=${stream}` : ''}`),
  stopStream: (token) => request('/api/stream/stop', { method: 'POST', body: { token } }),
  diagnostics: (id, quality = 'main') => request(`/api/diagnostics/${encodeURIComponent(id)}?quality=${quality}`),

  presets: () => request('/api/presets'),
  savePreset: (body) => request('/api/presets', { method: 'POST', body }),
  deletePreset: (id) => request(`/api/presets/${id}`, { method: 'DELETE' }),

  users: () => request('/api/users'),
  createUser: (body) => request('/api/users', { method: 'POST', body }),
  setUserPassword: (id, password) => request(`/api/users/${id}/password`, { method: 'POST', body: { password } }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),
  changePassword: (body) => request('/api/profile/password', { method: 'POST', body }),
};
