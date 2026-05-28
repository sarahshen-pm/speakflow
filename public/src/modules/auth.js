async function requestAuth(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Authentication request failed.');
  }
  return data.user || null;
}

export function getCurrentUser() {
  return requestAuth('/api/auth/me', { method: 'GET' });
}

export function register(email, password) {
  return requestAuth('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

export function login(email, password) {
  return requestAuth('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

export function logout() {
  return requestAuth('/api/auth/logout', { method: 'POST' });
}
