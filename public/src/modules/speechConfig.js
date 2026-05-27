export async function getSpeechCredentials() {
  const diagnostics = {
    tokenEndpoint: 'not tried'
  };

  const tokenResponse = await fetch('/api/speech-token', { method: 'POST' }).catch(() => null);
  if (tokenResponse?.ok) {
    const data = await tokenResponse.json();
    if (data.token && data.region) {
      return { token: data.token, region: data.region };
    }
    diagnostics.tokenEndpoint = 'missing token or region';
  } else {
    diagnostics.tokenEndpoint = tokenResponse ? `HTTP ${tokenResponse.status}` : 'unavailable';
  }

  return {
    key: '',
    region: '',
    diagnostics
  };
}
