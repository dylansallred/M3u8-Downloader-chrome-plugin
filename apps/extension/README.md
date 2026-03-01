# Extension (v1)

Chrome extension that:

- Detects media requests on the current page (including `.m3u8`)
- Shows detected media in popup
- Pairs with desktop app using one-time pairing code
- Sends selected media to desktop queue using `POST /v1/jobs`

## Load Unpacked

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `apps/extension`
