const DEFAULT_SPEECH_REGION = 'eastasia';
const REGION_PATTERN = /^[a-z0-9-]+$/i;
const SESSION_COOKIE = 'speakflow_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = 100000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/speech-token') {
      return issueSpeechToken(request, env);
    }

    if (url.pathname.startsWith('/api/auth/')) {
      return handleAuthRequest(request, env, url.pathname);
    }

    if (url.pathname.startsWith('/api/content/')) {
      return handleContentRequest(request, env, url.pathname);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleAuthRequest(request, env, pathname) {
  if (!env.DB) {
    return json({ error: 'Database binding is not configured.' }, 503);
  }

  try {
    if (pathname === '/api/auth/register' && request.method === 'POST') {
      return registerUser(request, env);
    }
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      return loginUser(request, env);
    }
    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      return logoutUser(request, env);
    }
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      return getCurrentUser(request, env);
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    console.error(JSON.stringify({ event: 'auth_request_failed', pathname, message: error.message }));
    return json({ error: 'Authentication service is temporarily unavailable.' }, 500);
  }
}

async function handleContentRequest(request, env, pathname) {
  if (!env.DB) {
    return json({ error: 'Database binding is not configured.' }, 503);
  }
  if (pathname !== '/api/content/recent') {
    return json({ error: 'Not found' }, 404);
  }

  try {
    const user = await authenticate(request, env);
    if (!user) {
      return json({ error: 'Sign in to save your practice text.' }, 401);
    }
    if (request.method === 'GET') {
      const content = await env.DB.prepare(
        'SELECT text, updated_at AS updatedAt FROM practice_documents WHERE user_id = ?1'
      ).bind(user.id).first();
      return json({ content: content || null });
    }
    if (request.method === 'PUT') {
      return saveRecentContent(request, env, user);
    }
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, PUT' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'content_request_failed', pathname, message: error.message }));
    return json({ error: 'Content storage is temporarily unavailable.' }, 500);
  }
}

async function saveRecentContent(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'A JSON request body is required.' }, 400);
  }
  const text = String(body.text || '');
  if (!text.trim()) {
    return json({ error: 'Practice text cannot be empty.' }, 400);
  }
  if (text.length > 50000) {
    return json({ error: 'Practice text must be 50,000 characters or fewer.' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO practice_documents (user_id, text, updated_at)
     VALUES (?1, ?2, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, updated_at = CURRENT_TIMESTAMP`
  ).bind(user.id, text).run();

  const content = await env.DB.prepare(
    'SELECT text, updated_at AS updatedAt FROM practice_documents WHERE user_id = ?1'
  ).bind(user.id).first();
  return json({ content });
}

async function registerUser(request, env) {
  const credentials = await readCredentials(request);
  if (credentials.error) return json({ error: credentials.error }, 400);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?1')
    .bind(credentials.email)
    .first();
  if (existing) {
    return json({ error: 'An account with this email already exists.' }, 409);
  }

  const userId = crypto.randomUUID();
  const salt = randomToken(16);
  const passwordHash = await hashPassword(credentials.password, salt);
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, password_salt) VALUES (?1, ?2, ?3, ?4)'
  ).bind(userId, credentials.email, passwordHash, salt).run();

  return createSessionResponse(request, env, { id: userId, email: credentials.email }, 201);
}

async function loginUser(request, env) {
  const credentials = await readCredentials(request);
  if (credentials.error) return json({ error: credentials.error }, 400);

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, password_salt FROM users WHERE email = ?1'
  ).bind(credentials.email).first();
  if (!user || !(await verifyPassword(credentials.password, user.password_salt, user.password_hash))) {
    return json({ error: 'Invalid email or password.' }, 401);
  }

  return createSessionResponse(request, env, { id: user.id, email: user.email });
}

async function logoutUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1')
      .bind(await digestToken(token))
      .run();
  }
  return json({ user: null }, 200, {
    'Set-Cookie': sessionCookie('', request, 0)
  });
}

async function getCurrentUser(request, env) {
  const user = await authenticate(request, env);
  return json({ user });
}

async function authenticate(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  return env.DB.prepare(
    `SELECT users.id, users.email
     FROM sessions
     INNER JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ?1 AND sessions.expires_at > CURRENT_TIMESTAMP`
  ).bind(await digestToken(token)).first();
}

async function createSessionResponse(request, env, user, status = 200) {
  const token = randomToken(32);
  const tokenHash = await digestToken(token);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES (?1, ?2, ?3, datetime('now', '+30 days'))`
  ).bind(crypto.randomUUID(), user.id, tokenHash).run();

  return json({ user: { id: user.id, email: user.email } }, status, {
    'Set-Cookie': sessionCookie(token, request, SESSION_SECONDS)
  });
}

async function readCredentials(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: 'A JSON request body is required.' };
  }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { error: 'Enter a valid email address.' };
  }
  if (password.length < 8 || password.length > 128) {
    return { error: 'Password must be between 8 and 128 characters.' };
  }
  return { email, password };
}

async function hashPassword(password, salt) {
  const sourceKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const result = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: base64UrlToBytes(salt),
    iterations: PASSWORD_ITERATIONS
  }, sourceKey, 256);
  return bytesToBase64Url(new Uint8Array(result));
}

async function verifyPassword(password, salt, storedHash) {
  const candidate = base64UrlToBytes(await hashPassword(password, salt));
  const expected = base64UrlToBytes(storedHash);
  if (candidate.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(candidate, expected);
}

async function digestToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomToken(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function readCookie(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  const prefix = `${name}=`;
  const entry = cookies.split(';').map(item => item.trim()).find(item => item.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : '';
}

function sessionCookie(token, request, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function issueSpeechToken(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
  }

  const key = env.AZURE_SPEECH_KEY;
  const region = env.AZURE_SPEECH_REGION || DEFAULT_SPEECH_REGION;
  if (!key) {
    return json({ error: 'AZURE_SPEECH_KEY is not configured' }, 500);
  }
  if (!REGION_PATTERN.test(region)) {
    return json({ error: 'AZURE_SPEECH_REGION is invalid' }, 500);
  }

  const tokenResponse = await fetch(
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Length': '0'
      }
    }
  );

  if (!tokenResponse.ok) {
    return json({ error: 'Azure Speech token request failed' }, tokenResponse.status);
  }

  return json({
    region,
    token: await tokenResponse.text()
  });
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=UTF-8',
      ...extraHeaders
    }
  });
}
