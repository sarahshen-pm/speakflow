# SpeakFlow 🎙️

SpeakFlow is a highly interactive, modern English pronunciation trainer. It splits any custom English text into sentence-by-sentence practice cards and evaluates pronunciation in real time using the **Azure Cognitive Services (Speech SDK & REST API)**.

It provides detailed multi-dimensional scores (Accuracy, Completeness, Fluency, Prosody) and word-level visual feedback, helping English learners practice speaking and correct mispronunciations.

---

## 🌟 Key Features

- **Practice Generator**: Paste or type any English text, and SpeakFlow splits it into interactive practice sentence cards.
- **Dual Pronunciation Assessment Modes**:
  - **Continuous SDK Mode (Recommended)**: Utilizes the official **Azure Speech SDK for JavaScript** (`Microsoft.CognitiveServices.SpeechSDK`) to capture microphone streams, display a real-time transcript, and generate an overall Pronunciation Score alongside specific sub-metrics (Accuracy, Completeness, Fluency, Prosody).
  - **REST Fallback Mode**: If the SDK is not used, a high-performance local downsampling system converts standard browser microphone output to 16kHz mono PCM WAV format and sends it to the Azure REST API.
- **Multi-Dimensional Pronunciation Scores**:
  - **Accuracy**: How closely the phonemes in each word match a native speaker's pronunciation.
  - **Completeness**: Evaluates whether any words were omitted during reading.
  - **Fluency**: Rates the rhythm and pacing of speech.
  - **Prosody**: Evaluates the naturalness, including stress, intonation, and pauses.
- **Word-Level Scoring Visualizer**: Color-codes each word based on accuracy:
  - 🟢 **Accurate** (Score >= 80%)
  - 🟡 **Close** (Score 55% - 79%)
  - 🔴 **Needs Work / Wrong** (Score < 55%)
  - ⚪ **Missed / Omitted**
- **System Audio Playback (TTS)**: Synthesizes high-fidelity English reading using Azure Text-to-Speech (`en-US-JennyNeural`) with a local Web Speech API fallback.
- **Interactive Word Lookup**: Click *any* word after scoring to open a rich modal displaying phonetic IPA transcriptions, definitions, and usage examples. It queries a local dictionary first and falls back to a remote API.
- **Voice Recording Playback**: Easily record your voice and replay it at any time to self-compare with the synthesized system voice.
- **Progress Tracking & Analytics**: Displays a visual progress bar, count of completed sentences, and overall session average score.

---

## 📂 Project Architecture

```
├── index.html                  # Main application UI skeleton and external SDK loading
├── wrangler.jsonc              # Cloudflare Worker and Static Assets configuration
├── worker/
│   └── index.js                # Cloudflare Worker that securely issues temporary Speech tokens
├── .assetsignore               # Prevents local/server files from being uploaded as public assets
├── public/                     # Public static assets served by Cloudflare
│   ├── index.html              # Main application UI skeleton and external SDK loading
│   ├── _headers                # Security headers for static assets
│   └── src/
│       ├── styles.css          # Glassmorphic, highly polished responsive interface styling
│       ├── main.js             # Central orchestrator: UI state, recording, assessment and event delegation
│       └── modules/
│           ├── data.js         # Onboarding sample text and local dictionary fallback db
│           └── speechConfig.js # Fetches a short-lived token from the Worker API
├── .dev.vars.example           # Template for local-only Worker secrets
├── package.json                # Wrangler development and deployment commands
```

### 1. The Core UI (`public/index.html`)
The frontend is built as a responsive dual-panel layout.
- **Left Panel**: Handles text input, text processing, sample loading, and dictionary lookup.
- **Right Panel**: Renders practice cards, session progress stats, and active pronunciation legends.
- **Scripts**: Imports the Azure Speech SDK dynamically via CDN and loads `public/src/main.js` as an ES module.

### 2. The Orchestrator (`public/src/main.js`)
This is the heart of the app. It manages:
- **Audio Capturing**: Accesses browser mic stream using `navigator.mediaDevices.getUserMedia`.
- **WAV Downsampling Engine**: The browser typically records in higher rates (e.g. 48kHz). Azure Speech REST API requires 16kHz Mono PCM WAV. `main.js` contains a manual downsampler and binary WAV builder that processes standard float arrays and writes a 44-byte WAV header completely client-side.
- **LCS Alignment Algorithm**: Aligns words returned from Azure STT with reference words using a Levenshtein distance-based similarity metric to accurately highlight exactly which words were pronounced correctly, missed, or inserted.
- **Modal Lookup**: Coordinates lookup events by checking static cache (`wordDB`) before fetching online entries via `api.dictionaryapi.dev`.

### 3. Server-Only Credential Flow (`public/src/modules/speechConfig.js`)
The browser requests a short-lived token from **`POST /api/speech-token`**. The Cloudflare Worker reads `AZURE_SPEECH_KEY` from a secret and never exposes the Azure subscription key to frontend files or browser storage.

---

## 🛠️ Local Development

### 1. Preview Without Server APIs
To preview only the interface, start a lightweight static server:
```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory public
```
Open `http://127.0.0.1:4173` in your browser.

### 2. Run the Cloudflare Worker Locally
To test the production-style token endpoint locally:
```bash
npm install
cp .dev.vars.example .dev.vars
```
Add your new Azure Speech key to `.dev.vars`; it is git-ignored and is read only by the local Worker. If your Speech resource is not in `eastasia`, update `AZURE_SPEECH_REGION` in `wrangler.jsonc`.

Then run:
```bash
npm run dev
```
Open the local URL printed by Wrangler.

---

## 🚀 Production Deployment (Cloudflare Workers)

SpeakFlow deploys as a Cloudflare Worker with Static Assets. The Worker handles `/api/speech-token`, while the frontend files are served as static assets:

1. Install dependencies and authenticate Wrangler:
   ```bash
   npm install
   npx wrangler login
   ```
2. Set your rotated Azure Speech key as an encrypted Cloudflare secret:
   ```bash
   npx wrangler secret put AZURE_SPEECH_KEY
   ```
3. Set `AZURE_SPEECH_REGION` in `wrangler.jsonc` to the region shown for your Azure Speech resource.
4. Deploy:
   ```bash
   npm run deploy
   ```

Only files under `public/` are uploaded as static assets. Do not place a real key in `public/`, `.env.example`, `wrangler.jsonc`, or any committed file.

---

## 📈 Future Refactor Roadmap

- **Componentization**: Move rendering, stats, and modal control code into `src/modules/ui.js` to isolate DOM manipulations.
- **Dedicated Assessment Module**: Encapsulate SDK and REST evaluation processes in `src/modules/azureAssessment.js`.
- **Expanded Dictionary Cache**: Preload a larger dictionary database to optimize mobile/offline experience.
- **Unit Testing**: Add a test suite (e.g., using Vitest or Jest) to validate the LCS alignment and Levenshtein scoring methods in isolation.
