# Google reviews: manual, free setup

The site reads reviews from `data/google-reviews.json` and displays them in the testimonials carousel. This workflow uses no Google API, serverless service, credentials, or scheduled job. The JSON file is the source of truth; new reviews appear after you edit the file and redeploy the static site.

## Update the reviews

1. Open `data/google-reviews.json` in the project.
2. Copy a review's public display name and text from Google into an object in the `reviews` array. Include its star rating if visible.
3. Save the file and redeploy the site.

Keep the JSON valid: strings need double quotes, objects need commas between them, and the final object must not have a trailing comma. Preserve the existing field names (`author`, `authorUrl`, `rating`, `text`, `publishTime`, `googleMapsUri`). You can leave `authorUrl` empty. The carousel safely displays ordinary text and the overall rating/count at the top of the file are optional display metadata.

The displayed reviews are a manually selected sample, not a live or automatic Google sync. Review text should be copied faithfully; do not rewrite a review in a way that changes what the customer said. If the site is opened directly as a `file://` URL, the browser may block loading JSON; use your normal site host or a local HTTP server for preview.
