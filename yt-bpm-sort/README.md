# YT BPM Sort

Chrome extension that shows the **BPM and key** of every YouTube search result, and lets you sort and filter by them. Built for finding beats fast.

## Features
- BPM + key badges on search results and video pages
- Sort by BPM, filter by BPM range (half/double tempo) and key (relative included)
- Reads the title, description, tags, BeatStars/Airbit links and the uploader's comments
- If nothing is written, estimates tempo and key from the audio while you watch (⚡ ×2 mode)
- Results are cached locally

## Install
1. Download this repo and unzip it
2. Open `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the `extension` folder

The interface is currently in French.

## Privacy
Everything runs locally. No video is downloaded. Audio analysis only uses what you're playing.

## Tests
`npm install && npm test`

## License
MIT.
