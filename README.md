Kahoot AI Helper
A browser extension that uses AI to answer Kahoot! quizzes in real time. It detects the live question and answer options on kahoot.it, asks an AI provider for the best choice, and marks the correct answer on screen in one of several display modes.

Features
Live quiz detection – reads the current Kahoot question and answer options directly from the page.
Multi-provider AI support – choose between Google AI Studio, OpenRouter, or Puter (free, no API key needed).
Two-phase AI flow – optionally prefetch the question while the answer options are still hidden, then instantly match the AI hint to the numbered options once they appear.
Multiple display modes:
Dot – small marker on the correct answer (stealth)
Highlight – green border on the correct answer
Corner number – shows the correct answer number in a corner badge
Floating panel – on-screen panel with question, options, and AI reasoning status
Notification – system notification with the correct answer(s)
Built-in debug panel – optional draggable log window for troubleshooting.
Works on Kahoot player view (kahoot.it/gameblock) including hashed/styled-component class names, via robust selector + parent-group fallback detection.
How it works
The content script scans the page for the question text and answer buttons.
When a new question is found:
If prefetch is enabled, the question is sent to the AI immediately to get a short answer hint.
Once the answer buttons appear, the AI is asked to pick the matching option number (or the hint is matched fuzzily against the options to save an API call).
The chosen answer is shown using the selected display mode.
Everything is cleared automatically when the next question appears.
Supported AI providers
Provider	Setup required	Notes
Puter	None	Free tier; sign in to Puter once in the browser.
Google AI Studio	API key	Fast, free tier available at aistudio.google.com.
OpenRouter	API key	Free model options available at openrouter.ai.
Installation (developer mode)
Download and unzip the extension package.
Open Chrome/Edge and go to chrome://extensions (or edge://extensions).
Enable Developer mode in the top-right corner.
Click Load unpacked and select the unzipped extension folder.
Open a Kahoot game at kahoot.it and click the extension icon to choose your provider and display mode.
Privacy & safety
The extension only runs on kahoot.it pages.
API keys are stored locally in the browser via chrome.storage and are only sent to the selected provider's API.
Puter credentials are handled by the official Puter.js script injected into the page context; the extension itself never sees them.
License
MIT
