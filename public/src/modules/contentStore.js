async function contentRequest(options = {}) {
  const response = await fetch('/api/content/recent', {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Could not access saved content.');
  }
  return data.content || null;
}

export function loadRecentContent() {
  return contentRequest({ method: 'GET' });
}

export function saveRecentContent(text) {
  return contentRequest({
    method: 'PUT',
    body: JSON.stringify({ text })
  });
}
