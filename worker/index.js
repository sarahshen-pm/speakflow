const DEFAULT_SPEECH_REGION = 'eastasia';
const REGION_PATTERN = /^[a-z0-9-]+$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/speech-token') {
      return issueSpeechToken(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

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
